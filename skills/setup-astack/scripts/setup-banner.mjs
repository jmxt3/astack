#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");

export const ASTACK_ASCII_LOGO = [
  " █████╗ ███████╗████████╗ █████╗  ██████╗██╗  ██╗",
  "██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝",
  "███████║███████╗   ██║   ███████║██║     █████╔╝",
  "██╔══██║╚════██║   ██║   ██╔══██║██║     ██╔═██╗",
  "██║  ██║███████║   ██║   ██║  ██║╚██████╗██║  ██╗",
  "╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝",
].join("\n");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".tmp",
  ".next",
  "dist",
  "build",
  "coverage",
  "vendor",
  "target",
]);

function findTlaFiles(dir, baseDir = dir, depth = 0, out = []) {
  if (depth > 4 || out.length >= 20 || !fs.existsSync(dir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= 20 || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || rel === "skills/statechart/scripts/test") continue;
      findTlaFiles(full, baseDir, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".tla")) {
      out.push(rel);
    }
  }
  return out;
}

export function inspectWorkspace({
  cwd = process.cwd(),
  homeDir = os.homedir(),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const workspace = path.basename(resolvedCwd) || "workspace";

  const verifySkills = [];
  const formalSkills = [];
  const skillsDir = path.join(resolvedCwd, ".agents", "skills");
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) continue;
      if (entry.name.startsWith("verify-") && entry.name.endsWith("-formal")) {
        formalSkills.push(entry.name);
      } else if (entry.name.startsWith("verify-")) {
        verifySkills.push(entry.name);
      }
    }
  }
  verifySkills.sort();
  formalSkills.sort();

  const tlaFiles = findTlaFiles(resolvedCwd).sort();

  let totalHooks = 0;
  let enabledHooks = 0;
  const hooksPath = path.join(pluginRoot, "hooks.json");
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      for (const value of Object.values(parsed)) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          totalHooks++;
          if (value.enabled === true) enabledHooks++;
        }
      }
    } catch {
      // Ignore malformed hooks.json during read-only inspection
    }
  }

  const modelRules = [];
  const globalRule = path.join(homeDir, ".gemini", "config", "rules", "astack-models.md");
  const repoRule = path.join(resolvedCwd, ".agents", "rules", "astack-models.md");
  if (fs.existsSync(globalRule)) modelRules.push("~/.gemini/config/rules/astack-models.md");
  if (fs.existsSync(repoRule)) modelRules.push(".agents/rules/astack-models.md");

  return {
    workspace,
    cwd: resolvedCwd,
    verifySkills,
    formalSkills,
    tlaFiles,
    hooks: { enabled: enabledHooks, total: totalHooks },
    modelRules,
  };
}

export function formatSetupBanner(status) {
  const verifyText = status.verifySkills.length > 0 ? status.verifySkills.join(", ") : "none";
  const formalParts = [
    ...status.formalSkills,
    ...(status.tlaFiles.length > 0 ? [`${status.tlaFiles.length} .tla spec(s)`] : []),
  ];
  const formalText = formalParts.length > 0 ? formalParts.join(", ") : "none";
  const hooksText =
    status.hooks.total > 0
      ? `opt-in (${status.hooks.enabled}/${status.hooks.total} enabled)`
      : "none";
  const modelText =
    status.modelRules.length > 0
      ? `custom override (${status.modelRules.join(", ")})`
      : "native UI / Orchestrator (zero-config)";

  return [
    ASTACK_ASCII_LOGO,
    "GOOGLE ANTIGRAVITY · PLAN · BUILD · PROVE IT WORKS",
    `> /setup-astack initiated · workspace: ${status.workspace}`,
    `  verify skills : ${verifyText}`,
    `  formal verify : ${formalText}`,
    `  safety hooks  : ${hooksText}`,
    `  model routing : ${modelText}`,
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  const status = inspectWorkspace({ cwd: values.cwd ?? process.cwd() });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSetupBanner(status)}\n`);
  }
}
