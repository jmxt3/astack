#!/usr/bin/env node
/**
 * Audits AStack command-surface drift across plugin skills, native commands,
 * playbooks, timeline sidecar UI catalog, documentation, and verification maps.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const ILLUSTRATIVE_SLASH_ROUTES = new Set(["/health", "/readyz", "/api"]);

const USAGE = `Usage: node .agents/skills/sync-astack-surfaces/scripts/audit-surfaces.mjs [options]

Options:
  --base <ref>    Git base ref for diff comparison (default: origin/main)
  --cwd <dir>     Target repository directory (default: repository root)
  --json          Emit machine-readable JSON output
  -h, --help      Show this help text and exit 0`;

function runGit(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function resolveDiffBase(cwd, requestedBase) {
  const candidates = requestedBase ? [requestedBase, "main", "HEAD~1"] : ["origin/main", "main", "HEAD~1"];
  for (const ref of candidates) {
    if (runGit(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== null) {
      return ref;
    }
  }
  return null;
}

function classifySurfacePath(relPath) {
  const norm = relPath.replace(/\\/g, "/");
  if (/^skills\/[^/]+\/SKILL\.md$/.test(norm)) return "skill";
  if (/^skills\/astack-mode\/playbooks\/[^/]+\.md$/.test(norm)) return "playbook";
  if (norm === "skills/astack-mode/references/native-commands.json") return "native-registry";
  if (/^agents\/[^/]+\.md$/.test(norm)) return "agent";
  if (norm === "hooks.json") return "hooks";
  if (/^sidecars\/astack_timeline\//.test(norm)) return "timeline-ui";
  if (norm === "scripts/catalog.json" || norm === "scripts/catalog.mjs") return "catalog";
  return null;
}

function collectSurfaceChanges(cwd, baseRef) {
  const seen = new Map();
  const addLine = (status, rawPath) => {
    const clean = String(rawPath ?? "").trim().replace(/\\/g, "/");
    if (!clean) return;
    const category = classifySurfacePath(clean);
    if (category) {
      seen.set(clean, { path: clean, status: status || "M", category });
    }
  };

  if (baseRef) {
    const committed = runGit(cwd, ["diff", "--name-status", `${baseRef}...HEAD`]);
    if (committed) {
      for (const line of committed.split(/\r?\n/)) {
        const parts = line.split(/\t+/);
        if (parts.length >= 2) {
          addLine(parts[0], parts[parts.length - 1]);
        }
      }
    }
  }

  const working = runGit(cwd, ["status", "--porcelain"]);
  if (working) {
    for (const line of working.split(/\r?\n/)) {
      if (line.length < 4) continue;
      const status = line.slice(0, 2).trim();
      const rawFile = line.slice(3).replace(/^.* -> /, "");
      addLine(status, rawFile);
    }
  }

  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function collectMarkdownAndCatalogTargets(rootDir) {
  const out = [];
  const pushIfExists = (rel) => {
    const abs = path.join(rootDir, ...rel.split("/"));
    if (fs.existsSync(abs)) out.push({ rel, abs });
  };
  const walkDir = (relDir, exts) => {
    const start = path.join(rootDir, ...relDir.split("/"));
    if (!fs.existsSync(start)) return;
    const stack = [start];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "vendor" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (exts.some((ext) => entry.name.endsWith(ext))) {
          const rel = path.relative(rootDir, full).split(path.sep).join("/");
          out.push({ rel, abs: full });
        }
      }
    }
  };

  pushIfExists("README.md");
  pushIfExists("sidecars/astack_timeline/command-catalog.json");
  walkDir("docs", [".md"]);
  walkDir("rules", [".md"]);
  walkDir("skills/astack-help", [".md"]);
  walkDir("skills/astack-mode", [".md"]);
  walkDir(".agents/skills", [".md"]);
  return out;
}

function scanUnknownSlashCommands(rootDir, knownCommands) {
  const unknown = [];
  const tokenRe = /`(\/[a-z][a-z0-9_-]{1,40})`/g;
  for (const { rel, abs } of collectMarkdownAndCatalogTargets(rootDir)) {
    const text = fs.readFileSync(abs, "utf8");
    const seenInFile = new Set();
    tokenRe.lastIndex = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      const cmd = m[1];
      if (knownCommands.has(cmd) || ILLUSTRATIVE_SLASH_ROUTES.has(cmd) || seenInFile.has(cmd)) continue;
      seenInFile.add(cmd);
      unknown.push({ file: rel, command: cmd });
    }
  }
  return unknown;
}

function gatherTelemetry(rootDir) {
  const skillsDir = path.join(rootDir, "skills");
  const agentsDir = path.join(rootDir, "agents");
  const playbooksDir = path.join(rootDir, "skills", "astack-mode", "playbooks");
  const nativePath = path.join(rootDir, "skills", "astack-mode", "references", "native-commands.json");
  const catalogPath = path.join(rootDir, "scripts", "catalog.json");
  const hooksPath = path.join(rootDir, "hooks.json");
  const pluginPath = path.join(rootDir, "plugin.json");

  const skillDirs = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
  const catalog = fs.existsSync(catalogPath) ? JSON.parse(fs.readFileSync(catalogPath, "utf8")) : {};
  const manualOnly = new Set(catalog.manualOnlySkills ?? []);
  const nativeCmds = fs.existsSync(nativePath)
    ? JSON.parse(fs.readFileSync(nativePath, "utf8")).commands ?? []
    : [];
  const agents = fs.existsSync(agentsDir)
    ? fs.readdirSync(agentsDir).filter((f) => f.endsWith(".md"))
    : [];
  const playbooks = fs.existsSync(playbooksDir)
    ? fs.readdirSync(playbooksDir).filter((f) => f.endsWith(".md"))
    : [];
  const hooksCfg = fs.existsSync(hooksPath) ? JSON.parse(fs.readFileSync(hooksPath, "utf8")) : {};
  const pluginCfg = fs.existsSync(pluginPath) ? JSON.parse(fs.readFileSync(pluginPath, "utf8")) : {};

  const localSkillsDir = path.join(rootDir, ".agents", "skills");
  const localSkills = fs.existsSync(localSkillsDir)
    ? fs.readdirSync(localSkillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

  const knownCommands = new Set([
    ...skillDirs.map((s) => `/${s}`),
    ...localSkills.map((s) => `/${s}`),
    ...nativeCmds.map((c) => c.command),
  ]);

  return {
    knownCommands,
    counts: {
      skills: skillDirs.length,
      manualOnlySkills: manualOnly.size,
      autoInvokeSkills: Math.max(0, skillDirs.length - manualOnly.size),
      playbooks: playbooks.length,
      agents: agents.length,
      hooks: Object.keys(hooksCfg).length,
      nativeCommands: nativeCmds.length,
      pluginVersion: typeof pluginCfg.version === "string" ? pluginCfg.version : null,
    },
  };
}

export async function runSurfaceAudit({ cwd = REPO_DEFAULT_ROOT, base = "origin/main" } = {}) {
  const rootDir = path.resolve(cwd);
  const validatorPath = fs.existsSync(path.join(rootDir, "scripts", "validate-astack.mjs"))
    ? path.join(rootDir, "scripts", "validate-astack.mjs")
    : path.join(REPO_DEFAULT_ROOT, "scripts", "validate-astack.mjs");
  const { validateAStack } = await import(pathToFileURL(validatorPath).href);

  const resolvedBase = resolveDiffBase(rootDir, base);
  const changedSurfaces = collectSurfaceChanges(rootDir, resolvedBase);
  const validation = validateAStack(rootDir, { withAgy: false });
  const { knownCommands, counts } = gatherTelemetry(rootDir);
  const unknownSlashCommands = scanUnknownSlashCommands(rootDir, knownCommands);

  const uiOrDocCategories = new Set(["skill", "playbook", "native-registry", "agent", "hooks", "catalog"]);
  const commandSurfaceChanged = changedSurfaces.some((c) => uiOrDocCategories.has(c.category));

  const ok =
    validation.ok &&
    unknownSlashCommands.length === 0;

  return {
    ok,
    rootDir,
    baseRef: resolvedBase,
    changedSurfaces,
    reviewRequired: {
      timelineUi: commandSurfaceChanged,
      docsAndGuides: commandSurfaceChanged,
    },
    counts,
    validationErrors: validation.errors,
    validationWarnings: validation.warnings,
    unknownSlashCommands,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "origin/main" },
      cwd: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const report = await runSurfaceAudit({
    cwd: values.cwd || REPO_DEFAULT_ROOT,
    base: values.base,
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const c = report.counts;
    process.stdout.write(
      `[sync-astack-surfaces] skills=${c.skills} (${c.manualOnlySkills} manual / ${c.autoInvokeSkills} auto) native=${c.nativeCommands} playbooks=${c.playbooks} agents=${c.agents} hooks=${c.hooks} changedSurfaces=${report.changedSurfaces.length} errors=${report.validationErrors.length} unknownSlash=${report.unknownSlashCommands.length}\n`,
    );
    for (const err of report.validationErrors) {
      process.stderr.write(`ERROR ${err.file}: ${err.message}\n`);
    }
    for (const unk of report.unknownSlashCommands) {
      process.stderr.write(`ERROR ${unk.file}: unrecognized slash command ${unk.command}\n`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}
