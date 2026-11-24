import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Walks upward from `startDir` looking for a `.git` directory or worktree pointer file without spawning `git`.
 */
export function findGitEntry(startDir) {
  if (typeof startDir !== "string" || !startDir.trim()) return null;
  let current;
  try {
    current = path.resolve(startDir);
  } catch {
    return null;
  }
  while (true) {
    const candidate = path.join(current, ".git");
    if (fs.existsSync(candidate)) {
      return { repoRoot: current, dotGitPath: candidate };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolves `{ repoRoot, gitDir, commonDir }` via pure filesystem reads without spawning `git`.
 */
export function resolveGitDirs(workspaceDir) {
  const found = findGitEntry(workspaceDir);
  if (!found) return null;
  let stat;
  try {
    stat = fs.statSync(found.dotGitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return {
      repoRoot: found.repoRoot,
      gitDir: found.dotGitPath,
      commonDir: found.dotGitPath,
    };
  }
  if (!stat.isFile()) return null;
  let raw;
  try {
    raw = fs.readFileSync(found.dotGitPath, "utf8");
  } catch {
    return null;
  }
  const match = raw.match(/^gitdir:\s*(.+)$/im);
  if (!match) return null;
  const gitDir = path.resolve(found.repoRoot, match[1].trim());
  const commonFile = path.join(gitDir, "commondir");
  let commonDir = gitDir;
  if (fs.existsSync(commonFile)) {
    try {
      const relCommon = fs.readFileSync(commonFile, "utf8").trim();
      if (relCommon) commonDir = path.resolve(gitDir, relCommon);
    } catch {
      commonDir = gitDir;
    }
  } else {
    const wtMatch = gitDir.match(/^(.+?)[/\\]worktrees[/\\][^/\\]+$/);
    if (wtMatch) commonDir = wtMatch[1];
  }
  return { repoRoot: found.repoRoot, gitDir, commonDir };
}

function extractOriginRemoteUrl(configText) {
  let inOrigin = false;
  for (const rawLine of String(configText ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = line.match(/^url\s*=\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

function normalizeRemoteUrl(rawUrl) {
  const trimmed = String(rawUrl ?? "").trim();
  if (!trimmed) return "";

  const scpMatch = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):([^/\s].*)$/);
  if (scpMatch && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    const host = scpMatch[1].toLowerCase();
    const repoPath = scpMatch[2]
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    return `${host}/${repoPath}`;
  }

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const repoPath = parsed.pathname
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    if (host) {
      return repoPath ? `${host}/${repoPath}` : host;
    }
  } catch {
    // Fall back to path-style normalization for local filesystem remotes.
  }

  return trimmed
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/**
 * Derives a stable repository ID shared across git worktrees by hashing the normalized `origin` URL or `commonDir`.
 */
export function deriveRepoId(commonDir) {
  if (typeof commonDir !== "string" || !commonDir.trim()) return null;
  const resolvedCommon = path.resolve(commonDir);
  let canonical = "";
  const configPath = path.join(resolvedCommon, "config");
  if (fs.existsSync(configPath)) {
    try {
      const originUrl = extractOriginRemoteUrl(fs.readFileSync(configPath, "utf8"));
      if (originUrl) {
        canonical = `remote:${normalizeRemoteUrl(originUrl)}`;
      }
    } catch {
      canonical = "";
    }
  }
  if (!canonical) {
    const posix = resolvedCommon.replace(/\\/g, "/").replace(/\/+$/, "");
    canonical = `local:${process.platform === "win32" ? posix.toLowerCase() : posix}`;
  }
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Classifies a workspace into `non_repo`, `git_unregistered`, or `enrolled_repo` with a sub-1ms zero-spawn fast path.
 */
export function resolveWorkspaceScope(workspaceDir, options = {}) {
  const dirs = resolveGitDirs(workspaceDir);
  if (!dirs) {
    return {
      kind: "non_repo",
      repoRoot: null,
      gitDir: null,
      commonDir: null,
      repoId: null,
    };
  }
  const repoId = deriveRepoId(dirs.commonDir);
  if (options.checkEnrollment === true) {
    if (options.enrolled === true && typeof options.baseRef === "string" && options.baseRef) {
      return {
        kind: "enrolled_repo",
        repoRoot: dirs.repoRoot,
        gitDir: dirs.gitDir,
        commonDir: dirs.commonDir,
        repoId,
        baseRef: options.baseRef,
      };
    }
    if (typeof options.policyLoader === "function") {
      const loaded = options.policyLoader(dirs.repoRoot, options.baseRef);
      if (loaded?.present && !loaded?.error && typeof loaded?.baseRef === "string" && loaded.baseRef) {
        return {
          kind: "enrolled_repo",
          repoRoot: dirs.repoRoot,
          gitDir: dirs.gitDir,
          commonDir: dirs.commonDir,
          repoId,
          baseRef: loaded.baseRef,
        };
      }
    }
  }
  return {
    kind: "git_unregistered",
    repoRoot: dirs.repoRoot,
    gitDir: dirs.gitDir,
    commonDir: dirs.commonDir,
    repoId,
  };
}
