#!/usr/bin/env node
/**
 * Read-only git worktree prune audit for Windows, macOS, and Linux.
 * Classifies every worktree beyond the primary checkout by disk size, commit
 * age, merge status, dirty state, remote tracking, PR status, and recent
 * Antigravity transcript references. Never deletes any files or worktrees.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HELP_TEXT = `Read-only worktree prune audit.
Usage: node worktree-audit.mjs [-b|--base <ref>] [repo-path]

  repo-path        Git repository path (defaults to current repo).
  -b, --base <ref> Reference branch/commit for MERGED checks (defaults to origin/HEAD, origin/main, origin/master, main, or master).
  -h, --help       Show this help text.
`;

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

function dirSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      try {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(full);
        else total += fs.statSync(full).size;
      } catch {
        // Ignore unreadable transient files
      }
    }
  }
  return total;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T"];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)}${units[idx]}`;
}

export function parseWorktreeList(porcelainOutput) {
  const worktrees = [];
  let current = null;
  for (const rawLine of porcelainOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length).trim(), branch: null, detached: false };
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.detached = true;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

function resolveBaseRef(repoDir, explicitBase) {
  if (explicitBase) {
    if (explicitBase.startsWith("origin/")) {
      const branch = explicitBase.slice("origin/".length);
      git(repoDir, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/${explicitBase}`, "--quiet"], {
        allowFail: true,
      });
    }
    const ok = git(repoDir, ["rev-parse", "--verify", "--quiet", `${explicitBase}^{commit}`], {
      allowFail: true,
    });
    if (!ok) {
      throw new Error(`base ref not found: ${explicitBase}`);
    }
    return { base: explicitBase, warned: false };
  }

  const headRef = git(repoDir, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true });
  const candidates = [headRef, "origin/main", "origin/master", "main", "master"].filter(Boolean);
  for (const cand of candidates) {
    if (git(repoDir, ["rev-parse", "--verify", "--quiet", `${cand}^{commit}`], { allowFail: true })) {
      return { base: cand, warned: true };
    }
  }
  throw new Error("no base ref found (origin/HEAD, origin/main, origin/master, main, master missing); pass -b <ref>");
}

function fetchOpenAndMergedPrs(repoDir) {
  try {
    const raw = execFileSync(
      "gh",
      ["pr", "list", "--author", "@me", "--state", "all", "--limit", "500", "--json", "number,state,headRefName"],
      { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const list = JSON.parse(raw);
    const map = new Map();
    for (const item of list) {
      if (item?.headRefName && !map.has(item.headRefName)) {
        map.set(item.headRefName, `#${item.number}/${String(item.state ?? "").toLowerCase()}`);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function findTranscriptFiles(transcriptsRoot) {
  const files = [];
  if (!fs.existsSync(transcriptsRoot)) return files;
  const stack = [transcriptsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "transcript.jsonl" || entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  return files;
}

function normalizeSlashes(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function addSwapVariant(variants, source, fromPrefix, toPrefix) {
  if (!fromPrefix || !toPrefix || fromPrefix === toPrefix) return;
  const srcNorm = normalizeSlashes(source);
  const fromNorm = normalizeSlashes(fromPrefix);
  const toNorm = normalizeSlashes(toPrefix);
  const matches =
    process.platform === "win32"
      ? srcNorm.toLowerCase().startsWith(`${fromNorm.toLowerCase()}/`) ||
        srcNorm.toLowerCase() === fromNorm.toLowerCase()
      : srcNorm.startsWith(`${fromNorm}/`) || srcNorm === fromNorm;
  if (matches) {
    variants.add(`${toNorm}${srcNorm.slice(fromNorm.length)}`);
  }
}

export function buildPathVariants(wtPath) {
  const variants = new Set([wtPath, normalizeSlashes(wtPath)]);
  try {
    const real = fs.realpathSync.native(wtPath);
    variants.add(real);
    variants.add(normalizeSlashes(real));
  } catch {
    // Ignore unresolved path
  }

  let rawTmp = "";
  let realTmp = "";
  try {
    rawTmp = normalizeSlashes(os.tmpdir());
    realTmp = normalizeSlashes(fs.realpathSync.native(os.tmpdir()));
  } catch {
    // Ignore tmpdir resolution failures
  }

  for (const v of [...variants]) {
    const norm = normalizeSlashes(v);
    if (norm.startsWith("/private/var/")) variants.add(norm.slice("/private".length));
    else if (norm.startsWith("/var/")) variants.add(`/private${norm}`);
    if (norm.startsWith("/private/tmp/")) variants.add(norm.slice("/private".length));
    else if (norm.startsWith("/tmp/")) variants.add(`/private${norm}`);

    if (rawTmp && realTmp && rawTmp.toLowerCase() !== realTmp.toLowerCase()) {
      addSwapVariant(variants, norm, realTmp, rawTmp);
      addSwapVariant(variants, norm, rawTmp, realTmp);
    }
  }

  return [...variants];
}

function lastChatTouchEpochSeconds(wtPath, transcriptFiles) {
  const needleSet = new Set();
  for (const variant of buildPathVariants(wtPath)) {
    const normalized = variant.replace(/\\/g, "/");
    const back = variant.replace(/\//g, "\\");
    const escaped = back.replace(/\\/g, "\\\\");
    for (const needle of [
      `${normalized}/`,
      `${normalized}"`,
      `${back}\\`,
      `${back}/`,
      `${back}"`,
      `${escaped}\\\\`,
      `${escaped}/`,
      `${escaped}"`,
    ]) {
      needleSet.add(process.platform === "win32" ? needle.toLowerCase() : needle);
    }
  }
  const needles = [...needleSet];
  let latestMs = 0;

  for (const file of transcriptFiles) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs <= latestMs) continue;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const content = process.platform === "win32" ? raw.toLowerCase() : raw;
      if (needles.some((needle) => content.includes(needle))) {
        latestMs = mtimeMs;
      }
    } catch {
      // Ignore unreadable transcript
    }
  }
  return latestMs > 0 ? Math.floor(latestMs / 1000) : 0;
}

function classifyWorktree({ wt, repoDir, base, prs, transcriptFiles, nowSec }) {
  const bytes = dirSizeBytes(wt.path);
  const head = git(wt.path, ["rev-parse", "HEAD"], { allowFail: true }) ?? "";
  const tsRaw = git(wt.path, ["log", "-1", "--format=%ct", "HEAD"], { allowFail: true });
  const headTs = tsRaw ? Number(tsRaw) : 0;
  const age = headTs > 0 ? `${Math.floor((nowSec - headTs) / 86400)}d` : "?";

  const isAncestor = head
    ? git(repoDir, ["merge-base", "--is-ancestor", head, base], { allowFail: true }) !== null
    : false;
  const merged = isAncestor ? "YES" : "no";

  const porcelain = git(wt.path, ["status", "--porcelain"], { allowFail: true }) ?? "";
  let dirty = "clean";
  if (porcelain) {
    const lines = porcelain.split(/\r?\n/).filter(Boolean);
    const trackedCount = lines.filter((l) => !l.startsWith("??")).length;
    dirty = trackedCount > 0 ? `wip:${trackedCount}` : `scratch:${lines.length}`;
  }

  let remote = "no-remote";
  if (wt.detached || !wt.branch) {
    remote = "detached";
  } else if (git(wt.path, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${wt.branch}`], { allowFail: true }) !== null) {
    const remoteSha = git(wt.path, ["rev-parse", `origin/${wt.branch}`], { allowFail: true });
    if (remoteSha === head) {
      remote = "pushed";
    } else {
      const ahead = git(wt.path, ["rev-list", "--count", `origin/${wt.branch}..HEAD`], { allowFail: true }) ?? "?";
      remote = `ahead${ahead}`;
    }
  }

  const pr = wt.branch && prs.has(wt.branch) ? prs.get(wt.branch) : "-";
  const lastTs = lastChatTouchEpochSeconds(wt.path, transcriptFiles);
  const last = lastTs > 0 ? new Date(lastTs * 1000).toISOString().slice(0, 10) : "-";
  const recent = lastTs > 0 && Math.floor((nowSec - lastTs) / 86400) <= 4;

  let bucket = "review";
  if (dirty.startsWith("wip:")) {
    bucket = "hold-wip";
  } else if (pr.endsWith("/open") || pr.endsWith("/draft")) {
    bucket = "hold-open-pr";
  } else if (recent) {
    bucket = "verify-recent-chat";
  } else if (merged === "YES" || pr !== "-") {
    bucket = "safe";
  }

  return {
    bytes,
    size: formatBytes(bytes),
    age,
    merged,
    dirty,
    remote,
    pr,
    last,
    bucket,
    path: wt.path,
  };
}

/**
 * Runs worktree audit and returns `{ base, warned, rows, formatted }`.
 */
export function auditWorktrees({
  repoPath = process.cwd(),
  baseRef,
  transcriptsRoot = process.env.ASTACK_TRANSCRIPTS_DIR ?? path.join(os.homedir(), ".gemini", "antigravity", "brain"),
  skipPrLookup = false,
} = {}) {
  const topLevel = git(repoPath, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (!topLevel) {
    throw new Error(`not a git repository: ${repoPath}`);
  }
  const { base, warned } = resolveBaseRef(topLevel, baseRef);
  const listOut = git(topLevel, ["worktree", "list", "--porcelain"]);
  const allWorktrees = parseWorktreeList(listOut);
  const candidates = allWorktrees.slice(1);

  const prs = skipPrLookup ? new Map() : fetchOpenAndMergedPrs(topLevel);
  const transcriptFiles = findTranscriptFiles(transcriptsRoot);
  const nowSec = Math.floor(Date.now() / 1000);

  const rows = candidates
    .map((wt) => classifyWorktree({ wt, repoDir: topLevel, base, prs, transcriptFiles, nowSec }))
    .sort((a, b) => b.bytes - a.bytes);

  const lines = [
    `# base: ${base}`,
    "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE",
    ...rows.map((r) =>
      [r.size, r.age, r.merged, r.dirty, r.remote, r.pr, r.last, r.bucket, r.path].join("\t"),
    ),
  ];

  return { base, warned, rows, formatted: `${lines.join("\n")}\n` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        base: { type: "string", short: "b" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  if (parsed.values.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }
  try {
    const result = auditWorktrees({
      repoPath: parsed.positionals[0] ?? process.cwd(),
      baseRef: parsed.values.base,
    });
    if (result.warned) {
      console.error(`warn: no -b given; MERGED checks against ${result.base}`);
    }
    process.stdout.write(result.formatted);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}
