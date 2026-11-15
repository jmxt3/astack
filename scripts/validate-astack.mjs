#!/usr/bin/env node
/**
 * Comprehensive structural and Antigravity compliance validator for AStack.
 *
 * Checks `plugin.json`, `skills/` frontmatter & 24KB loader limits, `/swarm`
 * collision avoidance, `agents/` & `rules/` schemas, relative markdown links,
 * Cursor-runtime leak regressions, and optionally runs `agy plugin validate --strict`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { MAX_ANTIGRAVITY_BYTES, parseFrontmatter } from "./sync-upstream.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");

const ALLOWED_SKILL_KEYS = new Set(["name", "description"]);
const ALLOWED_AGENT_KEYS = new Set(["name", "description"]);
const ALLOWED_RULE_TRIGGERS = new Set(["always_on", "model_decision", "glob", "manual"]);

const CURSOR_LEAK_PATTERNS = [
  { id: "cursor-dir", regex: /~?\.cursor\//g },
  { id: "pstack-models-mdc", regex: /\bpstack-models\.mdc\b/g },
  { id: "agent-transcripts", regex: /\bagent-transcripts\//g },
  { id: "poteto-slash", regex: /\/poteto-(?:mode|help)\b/g },
  { id: "setup-pstack-slash", regex: /\/setup-pstack\b/g },
  { id: "cursor-tool-todowrite", regex: /\bTodoWrite\b/g },
  { id: "cursor-tool-strreplace", regex: /\bStrReplace\b/g },
  { id: "cursor-webhook-api", regex: /api2\.cursor\.sh/g },
  { id: "cursor-subagent-type", regex: /\bsubagent_type\b/g },
  { id: "author-typo", regex: /\bMaschi[t]\b/g },
];

function stripFencedCodeBlocks(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "");
}

function stripUrls(text) {
  return text.replace(/https?:\/\/[^\s)\]>'"]+/g, "");
}

function addRelativeTarget(rawTarget, links) {
  const trimmed = rawTarget?.trim();
  if (
    !trimmed ||
    trimmed === "url" ||
    trimmed.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
    trimmed.includes("<") ||
    trimmed.includes(">") ||
    trimmed.includes("${") ||
    trimmed.startsWith("$")
  ) {
    return;
  }
  const cleanTarget = trimmed.split("#")[0].split("?")[0];
  if (cleanTarget) {
    links.push(cleanTarget);
  }
}

function extractRelativeLinks(markdown) {
  const withoutCode = stripFencedCodeBlocks(markdown).replace(/`[^`]*`/g, "");
  const links = [];
  const mdRegex = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = mdRegex.exec(withoutCode)) !== null) {
    addRelativeTarget(match[1], links);
  }
  const htmlRegex = /\b(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((match = htmlRegex.exec(withoutCode)) !== null) {
    const attr = match[1].toLowerCase();
    const rawValue = match[2] ?? match[3] ?? "";
    if (attr === "srcset") {
      for (const candidate of rawValue.split(",")) {
        const urlPart = candidate.trim().split(/\s+/)[0];
        addRelativeTarget(urlPart, links);
      }
    } else {
      addRelativeTarget(rawValue, links);
    }
  }
  return links;
}

function collectFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (!exts || exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function toRel(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).split(path.sep).join("/");
}

/**
 * Validates an AStack plugin tree at `rootDir`. Returns `{ ok, errors, warnings, stats }`.
 */
export function validateAStack(rootDir = DEFAULT_ROOT_DIR, { withAgy = false } = {}) {
  const errors = [];
  const warnings = [];

  const manifestPath = path.join(rootDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push({ file: "plugin.json", message: "Missing plugin.json at plugin root" });
  } else {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name !== "astack") {
        errors.push({ file: "plugin.json", message: `Expected manifest.name === "astack", got ${manifest.name}` });
      }
      if (!manifest.author?.name?.includes("João Machete")) {
        errors.push({ file: "plugin.json", message: 'manifest.author.name must credit "João Machete"' });
      }
      if (manifest.logo && !fs.existsSync(path.join(rootDir, manifest.logo))) {
        errors.push({ file: "plugin.json", message: `Missing logo file: ${manifest.logo}` });
      }
    } catch (err) {
      errors.push({ file: "plugin.json", message: `Invalid JSON: ${err.message}` });
    }
  }

  const licensePath = path.join(rootDir, "LICENSE");
  if (!fs.existsSync(licensePath)) {
    errors.push({ file: "LICENSE", message: "Missing LICENSE at plugin root" });
  } else {
    const licenseText = fs.readFileSync(licensePath, "utf8");
    if (!licenseText.includes("Lauren Tan") || !licenseText.includes("João Machete")) {
      errors.push({ file: "LICENSE", message: 'LICENSE must credit both "Lauren Tan" and "João Machete"' });
    }
  }

  // Guard against shadowing Antigravity's built-in /swarm slash command
  if (fs.existsSync(path.join(rootDir, "skills", "swarm"))) {
    errors.push({
      file: "skills/swarm",
      message: "skills/swarm must not exist because Priority 3 plugin skills shadow Antigravity's Priority 4 built-in /swarm; use skills/fanout",
    });
  }

  // Validate skills
  const skillsRoot = path.join(rootDir, "skills");
  let skillCount = 0;
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
      const rel = `skills/${entry.name}/SKILL.md`;
      if (!fs.existsSync(skillFile)) {
        errors.push({ file: `skills/${entry.name}`, message: "Skill directory missing SKILL.md" });
        continue;
      }
      skillCount++;
      const content = fs.readFileSync(skillFile, "utf8");
      const { hasFrontmatter, entries, body } = parseFrontmatter(content);
      if (!hasFrontmatter) {
        errors.push({ file: rel, message: "Missing YAML frontmatter" });
        continue;
      }
      const keyMap = Object.fromEntries(entries.map((e) => [e.key, e.valueLines.join("\n").trim()]));
      for (const key of Object.keys(keyMap)) {
        if (!ALLOWED_SKILL_KEYS.has(key)) {
          errors.push({ file: rel, message: `Unsupported frontmatter key "${key}" in Antigravity SKILL.md` });
        }
      }
      if (!keyMap.name) {
        errors.push({ file: rel, message: "Missing required frontmatter field: name" });
      } else if (keyMap.name !== entry.name) {
        errors.push({ file: rel, message: `Frontmatter name "${keyMap.name}" does not match folder "${entry.name}"` });
      }
      if (!keyMap.description) {
        errors.push({ file: rel, message: "Missing required frontmatter field: description" });
      }
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (bodyBytes > MAX_ANTIGRAVITY_BYTES) {
        errors.push({
          file: rel,
          message: `Skill body is ${bodyBytes} bytes, exceeding Antigravity's ${MAX_ANTIGRAVITY_BYTES}-byte truncation limit`,
        });
      }
    }
  }

  // Validate agents
  const agentsRoot = path.join(rootDir, "agents");
  let agentCount = 0;
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      agentCount++;
      const rel = `agents/${entry.name}`;
      const content = fs.readFileSync(path.join(agentsRoot, entry.name), "utf8");
      const { hasFrontmatter, entries } = parseFrontmatter(content);
      if (!hasFrontmatter) {
        errors.push({ file: rel, message: "Agent file missing YAML frontmatter" });
        continue;
      }
      const keyMap = Object.fromEntries(entries.map((e) => [e.key, e.valueLines.join("\n").trim()]));
      for (const key of Object.keys(keyMap)) {
        if (!ALLOWED_AGENT_KEYS.has(key)) {
          errors.push({ file: rel, message: `Unsupported frontmatter key "${key}" in Antigravity agent` });
        }
      }
      const expectedName = path.basename(entry.name, ".md");
      if (keyMap.name !== expectedName) {
        errors.push({ file: rel, message: `Agent name "${keyMap.name}" does not match filename "${expectedName}"` });
      }
      if (!keyMap.description) {
        errors.push({ file: rel, message: "Agent missing description" });
      }
    }
  }

  // Validate rules
  const rulesRoot = path.join(rootDir, "rules");
  let ruleCount = 0;
  if (fs.existsSync(rulesRoot)) {
    for (const entry of fs.readdirSync(rulesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      ruleCount++;
      const rel = `rules/${entry.name}`;
      const content = fs.readFileSync(path.join(rulesRoot, entry.name), "utf8");
      const { hasFrontmatter, entries } = parseFrontmatter(content);
      if (hasFrontmatter) {
        const keyMap = Object.fromEntries(entries.map((e) => [e.key, e.valueLines.join("\n").trim()]));
        if (keyMap.trigger && !ALLOWED_RULE_TRIGGERS.has(keyMap.trigger)) {
          errors.push({ file: rel, message: `Invalid rule trigger "${keyMap.trigger}"` });
        }
      }
      const totalBytes = Buffer.byteLength(content, "utf8");
      if (totalBytes > MAX_ANTIGRAVITY_BYTES) {
        errors.push({ file: rel, message: `Rule exceeds ${MAX_ANTIGRAVITY_BYTES} bytes (${totalBytes})` });
      }
    }
  }

  // Check markdown relative links + Cursor runtime leaks across markdown content
  const mdScanTargets = [
    ...["README.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md"]
      .map((f) => path.join(rootDir, f))
      .filter((p) => fs.existsSync(p)),
    ...collectFiles(path.join(rootDir, "rules"), [".md"]),
    ...collectFiles(path.join(rootDir, "agents"), [".md"]),
    ...collectFiles(path.join(rootDir, "skills"), [".md"]),
    ...collectFiles(path.join(rootDir, "docs"), [".md"]),
  ];

  for (const mdFile of mdScanTargets) {
    const rel = toRel(rootDir, mdFile);
    const content = fs.readFileSync(mdFile, "utf8");

    for (const target of extractRelativeLinks(content)) {
      let decodedTarget = target;
      try {
        decodedTarget = decodeURIComponent(target);
      } catch {
        // Keep raw target if malformed percent-encoding
      }
      const resolved = path.resolve(path.dirname(mdFile), ...decodedTarget.split("/"));
      if (!fs.existsSync(resolved)) {
        errors.push({ file: rel, message: `Broken relative link target: ${target}` });
      }
    }

    const sanitizedForLeakCheck = stripUrls(content);
    for (const { id, regex } of CURSOR_LEAK_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(sanitizedForLeakCheck)) {
        errors.push({ file: rel, message: `Cursor runtime leak matched (${id})` });
      }
    }
  }

  let agyReport = null;
  if (withAgy) {
    try {
      const stdout = execFileSync("agy", ["plugin", "validate", "--strict", "--json", rootDir], {
        encoding: "utf8",
      });
      agyReport = JSON.parse(stdout);
    } catch (err) {
      const stdout = err.stdout?.toString?.() ?? "";
      if (stdout) {
        try {
          agyReport = JSON.parse(stdout);
          for (const finding of agyReport.findings ?? []) {
            const bucket = finding.severity === "error" ? errors : warnings;
            bucket.push({ file: finding.file ?? "plugin", message: `[agy] ${finding.message}` });
          }
        } catch {
          errors.push({ file: "agy", message: `agy plugin validate failed: ${err.message}` });
        }
      } else {
        errors.push({ file: "agy", message: `agy plugin validate failed: ${err.message}` });
      }
    }
  }

  return {
    ok: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
    stats: {
      skills: skillCount,
      agents: agentCount,
      rules: ruleCount,
      markdownFilesChecked: mdScanTargets.length,
    },
    agyReport,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "no-agy": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const rootDir = positionals[0] ? path.resolve(positionals[0]) : DEFAULT_ROOT_DIR;
  const result = validateAStack(rootDir, { withAgy: !values["no-agy"] });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[validate-astack] skills=${result.stats.skills} agents=${result.stats.agents} rules=${result.stats.rules} md=${result.stats.markdownFilesChecked} errors=${result.errors.length} warnings=${result.warnings.length}`,
    );
    for (const err of result.errors) {
      console.error(`ERROR ${err.file}: ${err.message}`);
    }
    for (const warn of result.warnings) {
      console.warn(`WARN ${warn.file}: ${warn.message}`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}
