#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROOT_DIR, RESERVED_SKILL_NAMES } from "./catalog.mjs";

const WATCH_USAGE = `Usage: node scripts/upstream-watch.mjs [options]

Options:
  --source-id <id>     Upstream source id: pstack, gstack, security-audit-skill, or all (default: pstack)
  --source <git-dir>   Local git repository checkout to inspect instead of temp cache
  --fetch              Clone or fetch upstream into OS temp dir before diffing
  --since <ref>        Override baseline/lastReviewed git ref for diffing
  --json               Emit machine-readable JSON report
  --out <file>         Write report to an external file path outside the AStack repo
  --fail-on-updates    Exit 1 if any watched source has commits ahead of --since/lastReviewed
  -h, --help           Show this help text and exit 0`;

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const stderr = err.stderr?.toString?.().trim();
    const detail = stderr || err.message;
    const wrapped = new Error(`git ${args.join(" ")} failed: ${detail}`);
    wrapped.exitCode = 1;
    throw wrapped;
  }
}

function normalizeForContainment(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function assertExternalOutPath(outPath, rootDir = DEFAULT_ROOT_DIR) {
  const normRoot = normalizeForContainment(rootDir);
  const normOut = normalizeForContainment(outPath);
  const rel = path.relative(normRoot, normOut);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    const err = new Error(
      `Refusing --out inside rootDir (${outPath}): --out must point outside ${rootDir} (upstream-watch is strictly read-only)`,
    );
    err.exitCode = 2;
    throw err;
  }
  return path.resolve(outPath);
}

/**
 * Maps a relative POSIX path inside an upstream source tree to its AStack
 * counterpart relative POSIX path.
 */
export function mapUpstreamPathToCounterpart(relPosix, sourceConfig) {
  if (sourceConfig.id === "security-audit-skill" && relPosix.startsWith("skills/security-audit/")) {
    const rest = relPosix.slice("skills/security-audit/".length);
    if (rest === "SKILL.md") {
      return relPosix;
    }
    if (rest.endsWith(".md")) {
      return `skills/security-audit/references/${rest}`;
    }
    if (rest.endsWith(".cjs") || rest.endsWith(".json")) {
      return `skills/security-audit/scripts/${rest}`;
    }
    return relPosix;
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
    const mappedSkill = sourceConfig.skillRenames?.[upstreamSkill] ?? upstreamSkill;
    return ["skills", mappedSkill, ...parts.slice(2)].join("/");
  }
  if (relPosix.startsWith("agents/")) {
    const base = path.posix.basename(relPosix, ".md");
    const mappedAgent = sourceConfig.agentRenames?.[base] ?? base;
    return `agents/${mappedAgent}.md`;
  }
  return relPosix;
}

function ensureUpstreamCheckout(sourceConfig, { sourceGitDir, fetch = false } = {}) {
  const gitDir = sourceGitDir
    ? path.resolve(sourceGitDir)
    : path.join(os.tmpdir(), "astack-upstream-watch", sourceConfig.id);

  if (sourceGitDir) {
    if (!fs.existsSync(path.join(gitDir, ".git"))) {
      const err = new Error(`Local upstream git repository not found: ${gitDir}`);
      err.exitCode = 1;
      throw err;
    }
    return gitDir;
  }

  if (fetch) {
    if (fs.existsSync(path.join(gitDir, ".git"))) {
      runGit(["-C", gitDir, "fetch", "origin", "--prune"]);
      runGit(["-C", gitDir, "update-ref", "--no-deref", "HEAD", "FETCH_HEAD"]);
    } else {
      fs.mkdirSync(path.dirname(gitDir), { recursive: true });
      if (sourceConfig.subdir) {
        runGit(["clone", "--filter=blob:none", "--sparse", sourceConfig.repoUrl, gitDir]);
        runGit(["-C", gitDir, "sparse-checkout", "set", sourceConfig.subdir]);
      } else {
        runGit(["clone", "--filter=blob:none", "--no-checkout", sourceConfig.repoUrl, gitDir]);
      }
    }
  } else if (!fs.existsSync(path.join(gitDir, ".git"))) {
    const err = new Error(
      `Upstream cache not found at ${gitDir}. Pass --source <git-dir> or --fetch to inspect ${sourceConfig.id}.`,
    );
    err.exitCode = 1;
    throw err;
  }

  return gitDir;
}

function parseCommits(gitDir, rangeOrCountArgs, scopeArgs) {
  const raw = runGit(["-C", gitDir, "log", "--oneline", ...rangeOrCountArgs, ...scopeArgs]);
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(" ");
      return spaceIdx === -1
        ? { sha: line, subject: "" }
        : { sha: line.slice(0, spaceIdx), subject: line.slice(spaceIdx + 1) };
    });
}

function classifyChangedFile(gitStatus, rawPath, sourceConfig, rootDir) {
  const subdir = sourceConfig.subdir ?? "";
  let relPosix = rawPath.replace(/\\/g, "/");
  if (subdir) {
    const prefix = `${subdir}/`;
    if (!relPosix.startsWith(prefix)) {
      return null;
    }
    relPosix = relPosix.slice(prefix.length);
  }

  if ((sourceConfig.ignoredPaths ?? []).some((ignored) => relPosix === ignored || relPosix.startsWith(`${ignored}/`))) {
    return {
      gitStatus,
      upstreamPath: relPosix,
      category: "ignored",
      counterpart: null,
      reservedCollision: false,
    };
  }

  const isInspirationOnly = (sourceConfig.relationship ?? "").startsWith("inspiration");
  const counterpart = isInspirationOnly ? null : mapUpstreamPathToCounterpart(relPosix, sourceConfig);
  const reservedCollision = Boolean(
    counterpart && counterpart.startsWith("skills/") && RESERVED_SKILL_NAMES.has(counterpart.split("/")[1]),
  );

  if (gitStatus.startsWith("D")) {
    return {
      gitStatus,
      upstreamPath: relPosix,
      category: "deleted",
      counterpart,
      reservedCollision: false,
    };
  }

  if (isInspirationOnly) {
    return {
      gitStatus,
      upstreamPath: relPosix,
      category: "inspiration-change",
      counterpart: null,
      reservedCollision: false,
    };
  }

  const existsInRepo = fs.existsSync(path.join(rootDir, ...counterpart.split("/")));
  return {
    gitStatus,
    upstreamPath: relPosix,
    category: existsInRepo ? "has-counterpart" : "new-upstream-file",
    counterpart,
    reservedCollision,
  };
}

/**
 * Inspects one upstream source configuration against its baseline/lastReviewed
 * commit and classifies changed files relative to `rootDir`.
 */
export function watchSource(
  sourceConfig,
  { rootDir = DEFAULT_ROOT_DIR, sourceGitDir, fetch = false, since } = {},
) {
  const gitDir = ensureUpstreamCheckout(sourceConfig, { sourceGitDir, fetch });
  const subdir = sourceConfig.subdir ?? "";
  const scopeArgs = subdir ? ["--", subdir] : [];
  const headCommit = runGit(["-C", gitDir, "rev-parse", "HEAD"]).trim();
  const effectiveSince = since ?? sourceConfig.lastReviewed ?? null;

  const summary = {
    hasCounterpart: 0,
    newUpstreamFile: 0,
    deleted: 0,
    ignored: 0,
    inspirationChange: 0,
  };

  if (!effectiveSince) {
    return {
      id: sourceConfig.id,
      name: sourceConfig.name,
      relationship: sourceConfig.relationship,
      gitDir,
      since: null,
      headCommit,
      status: "baseline-unpinned",
      aheadCount: 0,
      commits: parseCommits(gitDir, ["-n", "5"], scopeArgs),
      changes: [],
      summary,
    };
  }

  const commits = parseCommits(gitDir, [`${effectiveSince}..HEAD`], scopeArgs);
  const diffRaw = runGit([
    "-C",
    gitDir,
    "diff",
    "--name-status",
    "--no-renames",
    `${effectiveSince}..HEAD`,
    ...scopeArgs,
  ]);

  const changes = [];
  for (const line of diffRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const item = classifyChangedFile(parts[0].trim(), parts[parts.length - 1].trim(), sourceConfig, rootDir);
    if (!item) continue;
    changes.push(item);
    if (item.category === "has-counterpart") summary.hasCounterpart++;
    else if (item.category === "new-upstream-file") summary.newUpstreamFile++;
    else if (item.category === "deleted") summary.deleted++;
    else if (item.category === "ignored") summary.ignored++;
    else if (item.category === "inspiration-change") summary.inspirationChange++;
  }

  return {
    id: sourceConfig.id,
    name: sourceConfig.name,
    relationship: sourceConfig.relationship,
    gitDir,
    since: effectiveSince,
    headCommit,
    status: commits.length > 0 ? "updates-available" : "up-to-date",
    aheadCount: commits.length,
    commits,
    changes,
    summary,
  };
}

export function watchUpstream({
  rootDir = DEFAULT_ROOT_DIR,
  sourceId = "pstack",
  sourceDir,
  fetch = false,
  since,
} = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "scripts", "upstream-watch.json"), "utf8"));
  const allSources = manifest.sources ?? {};
  const targetIds = sourceId === "all" ? Object.keys(allSources) : [sourceId];

  for (const id of targetIds) {
    if (!allSources[id]) {
      const err = new Error(`Unknown upstream source id "${id}". Expected one of: ${Object.keys(allSources).join(", ")}, all`);
      err.exitCode = 2;
      throw err;
    }
  }
  if (sourceId === "all" && sourceDir) {
    const err = new Error("--source cannot be combined with --source-id all");
    err.exitCode = 2;
    throw err;
  }

  const sources = targetIds.map((id) =>
    watchSource(allSources[id], {
      rootDir,
      sourceGitDir: sourceDir,
      fetch,
      since,
    }),
  );

  return {
    readOnly: true,
    checkedAt: new Date().toISOString(),
    hasUpdates: sources.some((s) => s.aheadCount > 0),
    sources,
  };
}

function formatWatchReport(report) {
  const lines = [`[upstream-watch] readOnly=${report.readOnly} hasUpdates=${report.hasUpdates}`];
  for (const src of report.sources) {
    lines.push(
      `- ${src.id} (${src.relationship}) status=${src.status} ahead=${src.aheadCount} head=${src.headCommit.slice(0, 7)} since=${src.since ? src.since.slice(0, 7) : "unpinned"}`,
    );
    for (const c of src.commits) {
      lines.push(`  commit ${c.sha} ${c.subject}`);
    }
    for (const ch of src.changes) {
      const dest = ch.counterpart ? ` -> ${ch.counterpart}` : "";
      lines.push(`  [${ch.category}] ${ch.gitStatus} ${ch.upstreamPath}${dest}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        "source-id": { type: "string", default: "pstack" },
        source: { type: "string" },
        fetch: { type: "boolean", default: false },
        since: { type: "string" },
        json: { type: "boolean", default: false },
        out: { type: "string" },
        "fail-on-updates": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  if (values.help) {
    console.log(WATCH_USAGE);
    process.exit(0);
  }

  try {
    const resolvedOut = values.out ? assertExternalOutPath(values.out, DEFAULT_ROOT_DIR) : null;
    const report = watchUpstream({
      rootDir: DEFAULT_ROOT_DIR,
      sourceId: values["source-id"],
      sourceDir: values.source,
      fetch: values.fetch,
      since: values.since,
    });
    const outputText = values.json ? `${JSON.stringify(report, null, 2)}\n` : formatWatchReport(report);
    if (resolvedOut) {
      fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
      fs.writeFileSync(resolvedOut, outputText, "utf8");
    }
    process.stdout.write(outputText);
    process.exit(values["fail-on-updates"] && report.hasUpdates ? 1 : 0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(err.exitCode ?? 1);
  }
}
