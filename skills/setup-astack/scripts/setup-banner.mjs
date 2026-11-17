#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { auditWorktrees } from "../../astack-mode/scripts/worktree-audit.mjs";
import { probeSandboxTier } from "../../security-audit/scripts/sandbox-runner.mjs";

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

const SETUP_BANNER_USAGE = `Usage: node setup-banner.mjs [options]

Options:
  --cwd <dir>  Workspace directory to inspect (defaults to current working directory)
  --doctor     Run extended AStack workspace health diagnostics
  --json       Emit machine-readable JSON output
  -h, --help   Show this help text and exit 0`;

function checkNodeVersion(versionString = process.versions.node) {
  const [major = 0, minor = 0] = versionString.split(".").map((n) => Number.parseInt(n, 10));
  const ok = major > 22 || (major === 22 && minor >= 6);
  return {
    id: "node-version",
    status: ok ? "pass" : "warn",
    detail: `Node ${versionString} (${ok ? "meets >= 22.6.0" : "upgrade to >= 22.6.0 required"})`,
  };
}

function checkVerifyFreshness(cwd, verifySkills) {
  if (verifySkills.length === 0) {
    return {
      id: "verify-freshness",
      status: "warn",
      detail: "No .agents/skills/verify-*/SKILL.md found. Run /create-verification-skill.",
    };
  }
  let latestCodeTs = 0;
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%ct", "--", ".", ":!*.md", ":!.agents/skills"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    latestCodeTs = out ? Number.parseInt(out, 10) : 0;
  } catch {
    return {
      id: "verify-freshness",
      status: "pass",
      detail: `${verifySkills.join(", ")} present (non-git workspace).`,
    };
  }
  let latestSkillTs = 0;
  for (const name of verifySkills) {
    const skillPath = path.join(cwd, ".agents", "skills", name, "SKILL.md");
    try {
      const mtimeSec = Math.floor(fs.statSync(skillPath).mtimeMs / 1000);
      if (mtimeSec > latestSkillTs) latestSkillTs = mtimeSec;
    } catch {
      // Ignore unreadable file
    }
  }
  const stale = latestCodeTs > 0 && latestSkillTs > 0 && latestCodeTs - latestSkillTs > 7 * 86400;
  return {
    id: "verify-freshness",
    status: stale ? "warn" : "pass",
    detail: stale
      ? `${verifySkills.join(", ")} older than recent code commits (>7d). Consider /maintain-verification-skill.`
      : `${verifySkills.join(", ")} active and up to date.`,
  };
}

/**
 * Runs read-only AStack health diagnostics across Node version, verification
 * skill freshness, hooks, model overrides, worktrees, and active sandbox tier.
 */
export async function runWorkspaceDoctor({
  cwd = process.cwd(),
  homeDir = os.homedir(),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  probeDeps = {},
} = {}) {
  const status = inspectWorkspace({ cwd, homeDir, pluginRoot });
  const checks = [
    checkNodeVersion(),
    checkVerifyFreshness(status.cwd, status.verifySkills),
    {
      id: "safety-hooks",
      status: status.hooks.enabled > 0 ? "pass" : "info",
      detail:
        status.hooks.total > 0
          ? `${status.hooks.enabled}/${status.hooks.total} opt-in hooks enabled in hooks.json`
          : "No hooks.json found",
    },
    {
      id: "model-routing",
      status: status.modelRules.length > 0 ? "warn" : "pass",
      detail:
        status.modelRules.length > 0
          ? `Override active (${status.modelRules.join(", ")}); remove to inherit UI/Orchestrator cleanly.`
          : "Zero-config UI / Orchestrator inheritance active.",
    },
  ];

  let staleWorktrees = 0;
  try {
    const wt = auditWorktrees({ repoPath: status.cwd, skipPrLookup: true });
    staleWorktrees = wt.rows.length;
    checks.push({
      id: "worktrees",
      status: staleWorktrees > 0 ? "info" : "pass",
      detail:
        staleWorktrees > 0
          ? `${staleWorktrees} extra git worktree(s) detected; run worktree-audit.mjs to review.`
          : "No extra git worktrees.",
    });
  } catch {
    checks.push({
      id: "worktrees",
      status: "info",
      detail: "Not a git repository; skipped worktree audit.",
    });
  }

  const sandbox = await probeSandboxTier({ homeDir, ...probeDeps });
  checks.push({
    id: "security-sandbox",
    status: sandbox.tier >= 1 ? "pass" : "warn",
    detail:
      sandbox.tier >= 1
        ? `Tier ${sandbox.tier} (${sandbox.mode}) active.`
        : "Tier 0 (unsandboxed-static-only). Enable Antigravity Default/Auto preset or `agy --sandbox` (Tier 1) or OpenSandbox (Tier 2) before running dynamic security checks.",
  });

  return {
    ok: checks.every((c) => c.status !== "warn"),
    workspace: status.workspace,
    cwd: status.cwd,
    sandbox,
    staleWorktrees,
    checks,
  };
}

export function formatDoctorReport(report) {
  const lines = [
    `> /setup-astack --doctor · workspace: ${report.workspace}`,
    ...report.checks.map((c) => `  [${c.status.toUpperCase()}] ${c.id}: ${c.detail}`),
  ];
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      doctor: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${SETUP_BANNER_USAGE}\n`);
    process.exit(0);
  }

  if (values.doctor) {
    const report = await runWorkspaceDoctor({ cwd: values.cwd ?? process.cwd() });
    process.stdout.write(
      values.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctorReport(report)}\n`,
    );
    process.exit(0);
  }

  const status = inspectWorkspace({ cwd: values.cwd ?? process.cwd() });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSetupBanner(status)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
