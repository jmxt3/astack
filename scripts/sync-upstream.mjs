#!/usr/bin/env node
/**
 * Repeatable upstream synchronization & Antigravity porting script for AStack.
 *
 * Reads Lauren Tan's (@poteto) upstream `pstack` plugin tree (from a local
 * checkout or a fresh sparse clone), strips Cursor-specific frontmatter,
 * renames conflicting skills (e.g. `swarm` -> `fanout`, `poteto-mode` ->
 * `astack-mode`), maps Cursor idioms to Google Antigravity idioms, and writes
 * untouched baseline files while protecting native AStack overlay files.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");
export const MAX_ANTIGRAVITY_BYTES = 24000;

const CURSOR_FRONTMATTER_KEYS = new Set([
  "disable-model-invocation",
  "icon",
  "color",
  "paths",
  "is_background",
]);

/**
 * Splits a UTF-8 markdown document with optional YAML frontmatter into
 * `{ rawFrontmatter, keys, body }`.
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { hasFrontmatter: false, entries: [], body: content };
  }
  const [, rawFm, body] = match;
  const lines = rawFm.split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const line of lines) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      if (current) entries.push(current);
      current = { key: keyMatch[1], valueLines: [keyMatch[2]] };
    } else if (current) {
      current.valueLines.push(line);
    }
  }
  if (current) entries.push(current);

  return { hasFrontmatter: true, entries, body };
}

/**
 * Serializes cleaned frontmatter entries back to YAML (Antigravity supports
 * `name` and `description` on SKILL.md / agents).
 */
export function serializeFrontmatter(entries) {
  const rendered = entries.map(({ key, valueLines }) => {
    const [first, ...rest] = valueLines;
    if (rest.length === 0) return `${key}: ${first}`;
    return `${key}: ${first}\n${rest.join("\n")}`;
  });
  return `---\n${rendered.join("\n")}\n---\n`;
}

/**
 * Masks external URLs so global token replacements never corrupt upstream links.
 */
function withProtectedUrls(text, fn) {
  const urls = [];
  const masked = text.replace(/https?:\/\/[^\s)\]>'"]+/g, (url) => {
    const token = `__ASTACK_URL_${urls.length}__`;
    urls.push(url);
    return token;
  });
  const transformed = fn(masked);
  return transformed.replace(/__ASTACK_URL_(\d+)__/g, (_, idx) => urls[Number(idx)]);
}

const REGEX_REPLACEMENTS = [
  // Model-config and user-customization paths
  [/~\/\.cursor\/rules\/pstack-models\.mdc/g, "~/.gemini/config/rules/astack-models.md"],
  [/\bpstack-models\.mdc\b/g, "astack-models.md"],
  [/~\/\.cursor\/plugins\/cache\//g, "~/.gemini/config/plugins/"],
  [/~\/\.cursor\/plugins\//g, "~/.gemini/config/plugins/"],
  [/\bplugins\/cache\//g, "~/.gemini/config/plugins/"],
  [/~\/\.cursor\/skills\//g, "~/.gemini/config/skills/"],
  [/~\/\.cursor\/skills\b/g, "~/.gemini/config/skills"],
  [/\.cursor\/skills\//g, ".agents/skills/"],
  [/\.cursor\/skills\b/g, ".agents/skills"],

  // Transcript locations
  [
    /~\/\.cursor\/projects\/<slug>\/agent-transcripts\/<uuid>\/<uuid>\.jsonl/g,
    "<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl",
  ],
  [/\bagent-transcripts\//g, ".system_generated/logs/transcript.jsonl (conversation brain logs) "],

  // Skill and command renames (pstack -> astack, swarm -> fanout so native /swarm stays intact)
  [/\/poteto-mode\b/g, "/astack-mode"],
  [/\bpoteto-mode\b/g, "astack-mode"],
  [/\/poteto-help\b/g, "/astack-help"],
  [/\bpoteto-help\b/g, "astack-help"],
  [/\/setup-pstack\b/g, "/setup-astack"],
  [/\bsetup-pstack\b/g, "setup-astack"],
  [/\bpoteto-agent\b/g, "astack-agent"],
  [/\bskills\/swarm\b/g, "skills/fanout"],
  [/\.\.\/swarm\/SKILL\.md\b/g, "../fanout/SKILL.md"],
  [/\/swarm\b/g, "/fanout"],
  [/\bpstack-guide\b/g, "astack-guide"],
  [/\b02-poteto-mode\.md\b/g, "02-astack-mode.md"],
  [/\.\.\/\.\.\/automations\/benny\//g, "../automations/benny/"],

  // Cursor harness tools -> Antigravity tools
  [/`subagent_type:\s*"?generalPurpose"?`/g, '`TypeName: "self"`'],
  [/`subagent_type:\s*"?astack-agent"?`/g, '`TypeName: "self"` (following `agents/astack-agent.md`)'],
  [/`subagent_type:\s*"?comment-sicko"?`/g, '`TypeName: "self"` (following `agents/comment-sicko.md`)'],
  [/subagent_type:\s*"?generalPurpose"?/g, 'TypeName: "self"'],
  [/subagent_type:\s*"?astack-agent"?/g, 'TypeName: "self" (astack-agent)'],
  [/subagent_type:\s*"?comment-sicko"?/g, 'TypeName: "self" (comment-sicko)'],
  [/`TodoWrite`/g, "task tracking"],
  [/`AskQuestion`/g, "`ask_question`"],
  [/`StrReplace`/g, "`edit_file`"],
  [/`Read`/g, "`read_file`"],
  [/`Write`/g, "`write_file`"],
  [/`Shell`/g, "`run_command`"],
  [/`Glob`/g, "`run_command` file search"],
  [/`Grep`/g, "`run_command` content search (`rg`)"],
  [/\bbun test\b/g, "node --test"],
  [/\bbun run\b/g, "node"],
  [/\bunder bun\b/g, "under Node 22+"],
  [/\bpstack\b/g, "astack"],
  [/\bPStack\b/g, "AStack"],
  [/\bCursor's skills docs\b/g, "Antigravity plugin docs"],
];

/**
 * Rewrites upstream Cursor-specific prose/paths into Antigravity conventions
 * while preserving external URLs.
 */
export function rewriteUpstreamText(text) {
  let out = withProtectedUrls(text, (safe) => {
    let cur = safe
      .replace(/https:\/\/api2\.cursor\.sh\/automations\/webhook\/<id>/g, "<automation-webhook-url>")
      .replace(/https:\/\/cursor\.com\/docs\/skills/g, "https://antigravity.google/docs/build-plugins");
    for (const [pattern, replacement] of REGEX_REPLACEMENTS) {
      cur = cur.replace(pattern, replacement);
    }
    return cur;
  });
  return out.replace(/\r\n/g, "\n");
}

/**
 * Normalizes a ported SKILL.md or agent markdown file: strips Cursor-only
 * frontmatter keys, sets `name` to match its target folder/agent name, and
 * rewrites Cursor-isms.
 */
export function transformPortedMarkdown(rawContent, { targetName, stripExtraFrontmatter = true } = {}) {
  const { hasFrontmatter, entries, body } = parseFrontmatter(rawContent);
  if (!hasFrontmatter) {
    return rewriteUpstreamText(rawContent);
  }

  const cleanedEntries = [];
  for (const entry of entries) {
    if (stripExtraFrontmatter && CURSOR_FRONTMATTER_KEYS.has(entry.key)) {
      continue;
    }
    if (entry.key === "name" && targetName) {
      cleanedEntries.push({ key: "name", valueLines: [targetName] });
      continue;
    }
    cleanedEntries.push({
      key: entry.key,
      valueLines: entry.valueLines.map((l) => rewriteUpstreamText(l)),
    });
  }

  const rewrittenBody = rewriteUpstreamText(body);
  return `${serializeFrontmatter(cleanedEntries)}${rewrittenBody}`;
}

/**
 * Converts an upstream relative POSIX path inside `pstack/` to its destination
 * relative POSIX path inside `astack/`. Returns `null` if ignored.
 */
export function mapUpstreamRelativePath(relPosix, manifest) {
  for (const ignored of manifest.ignoredUpstreamPaths ?? []) {
    if (relPosix === ignored || relPosix.startsWith(`${ignored}/`)) {
      return null;
    }
  }

  if (relPosix.startsWith("automations/")) {
    return `docs/${relPosix}`;
  }

  if (relPosix === "docs/guide/02-poteto-mode.md") {
    return "docs/guide/02-astack-mode.md";
  }

  if (relPosix.startsWith("skills/")) {
    const parts = relPosix.split("/");
    const upstreamSkill = parts[1];
    const mappedSkill = manifest.skillRenames?.[upstreamSkill] ?? upstreamSkill;
    return ["skills", mappedSkill, ...parts.slice(2)].join("/");
  }

  if (relPosix.startsWith("agents/")) {
    const base = path.posix.basename(relPosix, ".md");
    const mappedAgent = manifest.agentRenames?.[base] ?? base;
    return `agents/${mappedAgent}.md`;
  }

  return relPosix;
}

/**
 * Checks whether a destination relative POSIX path belongs to an overlay file or
 * directory customized natively for Antigravity.
 */
export function isOverlayPath(destRelPosix, manifest) {
  for (const prefix of manifest.overlayPaths ?? []) {
    if (destRelPosix === prefix || destRelPosix.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff2",
  ".pdf",
  ".jar",
  ".zip",
]);

function readNormalizedBytes(filePath, relPosix) {
  const ext = path.posix.extname(relPosix).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext) || relPosix.startsWith("docs/guide/images/")) {
    return fs.readFileSync(filePath);
  }
  return Buffer.from(fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n"), "utf8");
}

function walkFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, baseDir));
    } else {
      const rel = path.relative(baseDir, full).split(path.sep).join("/");
      results.push({ full, rel });
    }
  }
  return results;
}

function cloneUpstreamSparse(repoUrl, targetCloneDir, subdir) {
  fs.mkdirSync(path.dirname(targetCloneDir), { recursive: true });
  execFileSync("git", ["clone", "--filter=blob:none", "--sparse", repoUrl, targetCloneDir], {
    stdio: "inherit",
  });
  execFileSync("git", ["-C", targetCloneDir, "sparse-checkout", "set", subdir], {
    stdio: "inherit",
  });
  return path.join(targetCloneDir, subdir);
}

/**
 * Synchronizes files from `sourceDir` (upstream `pstack/`) into `rootDir` (`astack/`).
 */
export function syncUpstream({
  rootDir = DEFAULT_ROOT_DIR,
  sourceDir,
  dryRun = false,
  forceOverlays = false,
} = {}) {
  const manifestPath = path.join(rootDir, "scripts", "UPSTREAM.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const resolvedSource =
    sourceDir ?? path.join(os.tmpdir(), "astack-upstream-pstack", manifest.upstreamSubdir ?? "pstack");

  if (!fs.existsSync(resolvedSource)) {
    throw new Error(
      `Upstream source directory not found: ${resolvedSource}. Pass --source <dir> or --fetch to clone sparsely.`,
    );
  }

  const files = walkFiles(resolvedSource);
  const report = {
    sourceDir: resolvedSource,
    added: [],
    updated: [],
    unchanged: [],
    skippedOverlays: [],
    overlayChanged: [],
    ignored: [],
  };

  for (const { full, rel } of files) {
    const destRel = mapUpstreamRelativePath(rel, manifest);
    if (!destRel) {
      report.ignored.push(rel);
      continue;
    }

    const destFull = path.join(rootDir, ...destRel.split("/"));
    const relToRoot = path.relative(rootDir, destFull);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      throw new Error(`Refusing path traversal outside rootDir: ${destRel}`);
    }
    const exists = fs.existsSync(destFull);
    const isTextTransformTarget =
      destRel.endsWith(".md") && !destRel.startsWith("docs/guide/images/");

    let nextBytes;
    if (isTextTransformTarget) {
      const raw = fs.readFileSync(full, "utf8");
      let targetName;
      if (destRel.startsWith("skills/") && destRel.endsWith("/SKILL.md")) {
        targetName = destRel.split("/")[1];
      } else if (destRel.startsWith("agents/") && destRel.endsWith(".md")) {
        targetName = path.posix.basename(destRel, ".md");
      }
      const stripExtraFrontmatter =
        destRel.endsWith("/SKILL.md") || (destRel.startsWith("agents/") && destRel.endsWith(".md"));
      const transformed = transformPortedMarkdown(raw, {
        targetName,
        stripExtraFrontmatter,
      });
      nextBytes = Buffer.from(transformed, "utf8");
    } else {
      nextBytes = readNormalizedBytes(full, destRel);
    }

    if (exists && isOverlayPath(destRel, manifest) && !forceOverlays) {
      report.skippedOverlays.push(destRel);
      if (Buffer.compare(fs.readFileSync(destFull), nextBytes) !== 0) {
        report.overlayChanged.push(destRel);
      }
      continue;
    }

    if (exists) {
      const prevBytes = fs.readFileSync(destFull);
      if (Buffer.compare(prevBytes, nextBytes) === 0) {
        report.unchanged.push(destRel);
        continue;
      }
      report.updated.push(destRel);
    } else {
      report.added.push(destRel);
    }

    if (!dryRun) {
      fs.mkdirSync(path.dirname(destFull), { recursive: true });
      fs.writeFileSync(destFull, nextBytes);
    }
  }

  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "force-overlays": { type: "boolean", default: false },
      "diff-overlays": { type: "boolean", default: false },
      fetch: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  const manifestPath = path.join(DEFAULT_ROOT_DIR, "scripts", "UPSTREAM.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let sourceDir = values.source;
  if (!sourceDir && values.fetch) {
    const cloneRoot = path.join(os.tmpdir(), "astack-upstream-pstack");
    if (!fs.existsSync(path.join(cloneRoot, manifest.upstreamSubdir ?? "pstack"))) {
      sourceDir = cloneUpstreamSparse(manifest.upstreamRepo, cloneRoot, manifest.upstreamSubdir ?? "pstack");
    }
  }

  const report = syncUpstream({
    rootDir: DEFAULT_ROOT_DIR,
    sourceDir,
    dryRun: values["dry-run"],
    forceOverlays: values["force-overlays"],
  });

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[sync-upstream] source=${report.sourceDir} dryRun=${values["dry-run"]} added=${report.added.length} updated=${report.updated.length} skippedOverlays=${report.skippedOverlays.length} overlayChanged=${report.overlayChanged.length} unchanged=${report.unchanged.length} ignored=${report.ignored.length}`,
    );
    if (values["diff-overlays"]) {
      for (const relPath of report.overlayChanged) {
        console.log(`OVERLAY_CHANGED ${relPath}`);
      }
    }
  }
}
