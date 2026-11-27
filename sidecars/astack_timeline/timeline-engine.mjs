import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PIPELINE_STAGES,
  TOOL_MATCHERS,
  classifyCommandCategory,
  classifyDominantCategory,
  computeFreshness,
  evaluateRepoTrust,
  loadRiskPolicy,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  resolveBaseRef,
  resolveTrustDir,
  resolveWorkspaceScope,
} from "../../scripts/trust/index.mjs";

import { COMMAND_DOCS, STAGE_COMMAND_CATALOG } from "./command-catalog.mjs";

export { COMMAND_DOCS };

const STAGE_BY_ID = new Map(PIPELINE_STAGES.map((stage) => [stage.id, stage]));

function makeCommandItem(command, state, optional = false) {
  const doc = COMMAND_DOCS[command] ?? {};
  const trimmed = String(command).trim();
  const invocable = doc.invocable !== false;
  return {
    command,
    kind: doc.kind ?? "skill",
    invocable,
    invokedBy: doc.invokedBy ?? null,
    backingPath: doc.backingPath ?? null,
    copyText: invocable ? trimmed : null,
    state,
    optional,
    description: doc.description ?? "",
    docsUrl: doc.docsUrl ?? null,
  };
}

function buildStageSubCommands(stageId, detected, excludeCommands = null) {
  const entry = STAGE_COMMAND_CATALOG[stageId] ?? { autoSubCommands: [], moreCommands: [] };
  const moreIds = excludeCommands
    ? entry.moreCommands.filter((cmd) => !excludeCommands.has(cmd))
    : entry.moreCommands;
  return {
    autoSubCommands: entry.autoSubCommands.map((cmd) => ({
      ...makeCommandItem(cmd, detected.has(cmd) ? "done" : "pending", true),
      ran: detected.has(cmd),
    })),
    moreCommands: moreIds.map((cmd) =>
      makeCommandItem(cmd, detected.has(cmd) ? "done" : "pending", true),
    ),
  };
}

export const TIMELINE_STEPS = [
  {
    id: "plan",
    number: 1,
    label: "Plan",
    summary: "Optional written plan before editing code.",
    gate: "GATE",
    primaryCommand: "/plan",
    optionalCommands: ["/grill-me"],
    pipelineStages: [STAGE_BY_ID.get("understand")?.id, STAGE_BY_ID.get("plan")?.id].filter(Boolean),
  },
  {
    id: "build",
    number: 2,
    label: "Build & Prove",
    summary: "Implement, clean the diff, and prove it works.",
    gate: "AUTO",
    primaryCommand: "/astack-mode",
    optionalCommands: ["/interrogate"],
    pipelineStages: [
      STAGE_BY_ID.get("build")?.id,
      STAGE_BY_ID.get("clean")?.id,
      STAGE_BY_ID.get("verify")?.id,
    ].filter(Boolean),
  },
  {
    id: "review",
    number: 3,
    label: "Pre-PR Check",
    summary: "Verify HEAD independently and compile PR proof.",
    gate: "GATE",
    primaryCommand: "/pre-pr",
    optionalCommands: [],
    pipelineStages: [STAGE_BY_ID.get("pr-review")?.id].filter(Boolean),
  },
  {
    id: "ship",
    number: 4,
    label: "Ship",
    summary: "Open the PR and track CI to merge-ready.",
    gate: "AUTO",
    primaryCommand: "/astack-mode open the pr",
    optionalCommands: ["/astack-mode babysit"],
    pipelineStages: [],
  },
];

const FILE_WRITE_TOOLS = new Set(TOOL_MATCHERS.fileWriteTools);
const FILE_READ_TOOLS = new Set(["read_file", "view_file"]);
const VERIFY_CATEGORIES = new Set(["test", "verify", "lint", "build"]);
const DOC_EXT_RE = /\.(?:md|txt)$/i;
const MAIN_TURN_STALE_MS = 5 * 60 * 1000;
const POLICY_REL_PATHS = [
  [".agents/risk-policy.json", "risk-policy.json"],
  [".agents/boundaries.json", "boundaries.json"],
  ["REVIEW.md", "REVIEW.md"],
  ["GLOSSARY.md", "GLOSSARY.md"],
];

function normalizePosix(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

function parseTimestampMs(raw) {
  if (!raw) return 0;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

function makeMarker(ts, order) {
  return {
    ts: ts || null,
    tsMs: parseTimestampMs(ts),
    wholeSecond: Boolean(ts && !/\.\d+/.test(String(ts))),
    order,
  };
}

function latestMarker(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.tsMs && b.tsMs && a.tsMs !== b.tsMs) {
    return a.tsMs > b.tsMs ? a : b;
  }
  return a.order >= b.order ? a : b;
}

function earliestMarker(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.tsMs && b.tsMs && a.tsMs !== b.tsMs) {
    return a.tsMs < b.tsMs ? a : b;
  }
  return a.order <= b.order ? a : b;
}

function isMarkerAfter(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.tsMs && b.tsMs) {
    if (a.wholeSecond !== b.wholeSecond) {
      const aSec = Math.floor(a.tsMs / 1000);
      const bSec = Math.floor(b.tsMs / 1000);
      if (aSec !== bSec) return aSec > bSec;
      if (!a.wholeSecond && a.order === Number.MAX_SAFE_INTEGER && b.wholeSecond) return false;
      return a.order > b.order;
    }
    if (a.tsMs !== b.tsMs) return a.tsMs > b.tsMs;
  }
  return a.order > b.order;
}

function unquoteArg(v) {
  if (typeof v !== "string") return v == null ? "" : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function targetPathOf(args) {
  return normalizePosix(unquoteArg(args.Path || args.AbsolutePath || args.TargetFile));
}

function isVerifyReceipt(receipt) {
  return receipt.kind === "verifier" || (receipt.kind === "command" && VERIFY_CATEGORIES.has(receipt.category));
}

function isFailedTranscriptVerifyReceipt(receipt, failedVerifyCmds = []) {
  if (!receipt || receipt.kind !== "command" || !receipt.ok || !isVerifyReceipt(receipt)) {
    return false;
  }
  if (!Array.isArray(failedVerifyCmds) || failedVerifyCmds.length === 0) return false;
  const rMs = Date.parse(receipt.ts || "");
  if (!Number.isFinite(rMs)) return false;
  const summaryNorm = String(receipt.summary ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  for (const failed of failedVerifyCmds) {
    const startMs = Number(failed.startMs);
    const endMs = Number(failed.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (rMs < startMs - 5000 || rMs > endMs + 5000) continue;
    const prefixNorm = String(failed.cmdPrefix ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!prefixNorm) {
      if (Math.abs(rMs - endMs) <= 2000) return true;
      continue;
    }
    const probe = prefixNorm.slice(0, Math.min(24, prefixNorm.length));
    const sumProbe = summaryNorm.slice(0, Math.min(24, summaryNorm.length));
    if ((probe && summaryNorm.startsWith(probe)) || (sumProbe && prefixNorm.startsWith(sumProbe))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolves a regular file inside `brainConvDir` to a canonical `file://` URI, rejecting traversal or external symlinks.
 */
export function resolveSafeArtifactUri(brainConvDir, relName) {
  if (!brainConvDir || !relName || typeof relName !== "string") return null;
  if (/[\\/%:\0]/.test(relName) || relName === "." || relName === "..") return null;
  try {
    const rootReal = fs.realpathSync(brainConvDir);
    const candidate = path.join(rootReal, relName);
    if (!fs.existsSync(candidate)) return null;
    const real = fs.realpathSync(candidate);
    const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
    if (!real.startsWith(rootPrefix) || !fs.statSync(real).isFile()) return null;
    return pathToFileURL(real).href;
  } catch {
    return null;
  }
}

/**
 * Resolves a background task log (`task-<N>.log`) inside `<brainConvDir>/.system_generated/tasks` safely.
 */
export function resolveSafeTaskLogPath(brainConvDir, logFile) {
  if (!brainConvDir || typeof logFile !== "string" || !/^task-\d+\.log$/.test(logFile)) return null;
  try {
    const tasksDir = path.join(brainConvDir, ".system_generated", "tasks");
    if (!fs.existsSync(tasksDir)) return null;
    const rootReal = fs.realpathSync(tasksDir);
    const candidate = path.join(rootReal, logFile);
    if (!fs.existsSync(candidate)) return null;
    const real = fs.realpathSync(candidate);
    const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
    if (!real.startsWith(rootPrefix) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

function findGitLocationsFast(workspaceDir) {
  if (!workspaceDir) return null;
  let current = path.resolve(workspaceDir);
  while (true) {
    const dotGit = path.join(current, ".git");
    if (fs.existsSync(dotGit)) {
      try {
        const stat = fs.statSync(dotGit);
        if (stat.isDirectory()) {
          return { rootDir: current, gitDir: dotGit, commonGitDir: dotGit };
        }
        const gitDirRaw = (fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/im)?.[1] ?? "").trim();
        if (!gitDirRaw) return null;
        const gitDir = path.resolve(current, gitDirRaw);
        let commonGitDir = gitDir;
        const commonFile = path.join(gitDir, "commondir");
        if (fs.existsSync(commonFile)) {
          const commonRaw = fs.readFileSync(commonFile, "utf8").trim();
          if (commonRaw) commonGitDir = path.resolve(gitDir, commonRaw);
        } else {
          const wtMatch = gitDir.match(/^(.+?)[/\\]worktrees[/\\][^/\\]+$/);
          if (wtMatch) commonGitDir = wtMatch[1];
        }
        return { rootDir: current, gitDir, commonGitDir };
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readGitBranchFast(workspaceDir) {
  const locs = findGitLocationsFast(workspaceDir);
  if (!locs) return null;
  try {
    const headRaw = fs.readFileSync(path.join(locs.gitDir, "HEAD"), "utf8").trim();
    const m = headRaw.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function resolveWorkspaceRepoName(workspaceDir) {
  if (!workspaceDir) return null;
  const fallback = path.basename(path.resolve(workspaceDir));
  const locs = findGitLocationsFast(workspaceDir);
  if (!locs?.commonGitDir) return fallback;
  const repoRoot = locs.commonGitDir === locs.gitDir ? locs.rootDir : path.dirname(locs.commonGitDir);
  const name = path.basename(repoRoot);
  return name || fallback;
}

function inspectSetupReadiness(workspaceDir) {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) {
    return { workspaceKnown: false, configured: false, verifySkills: [], policies: [], branch: null, headSha: null };
  }
  const verifySkills = [];
  const skillsDir = path.join(workspaceDir, ".agents", "skills");
  let skillsStat = null;
  try {
    skillsStat = fs.statSync(skillsDir);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
  }
  if (skillsStat?.isDirectory()) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("verify-")) continue;
      if (fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
        verifySkills.push(entry.name);
      }
    }
  }
  verifySkills.sort();

  const policies = POLICY_REL_PATHS
    .filter(([rel]) => fs.existsSync(path.join(workspaceDir, ...rel.split("/"))))
    .map(([, label]) => label);

  return {
    workspaceKnown: true,
    configured: verifySkills.length > 0 || policies.length > 0,
    verifySkills,
    policies,
    branch: readGitBranchFast(workspaceDir),
    headSha: readHeadShaFast(workspaceDir),
  };
}

function extractRequestBody(rawContent) {
  return String(rawContent ?? "").match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i)?.[1] ?? String(rawContent ?? "");
}

function extractInvokedSlashCommands(rawContent) {
  const raw = String(rawContent ?? "");
  const found = new Set();
  const stripped = extractRequestBody(raw).replace(/```[\s\S]*?```/g, " ").trim();
  const withoutNewTask = stripped.replace(/^new\s+task\.?\s*/i, "");
  const match = withoutNewTask.match(/^((?:\/[a-z0-9_-]+(?:\s+|$))+)/i);
  if (match) {
    for (const m of match[1].matchAll(/\/([a-z0-9_-]+)/gi)) {
      found.add(`/${m[1].toLowerCase()}`);
    }
  }
  const metaBody = raw.match(/<ADDITIONAL_METADATA>([\s\S]*?)<\/ADDITIONAL_METADATA>/i)?.[1] ?? "";
  for (const m of metaBody.matchAll(/^\s*(\/[a-z0-9_-]+)\s+is\s+a\s+\[Slash Command\]:/gim)) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

function isWorkspaceSourceSkillPath(rawPath, workspaceDir) {
  if (!rawPath || !workspaceDir) return false;
  const resolvedWs = path.resolve(workspaceDir);
  const resolvedFile = path.resolve(workspaceDir, rawPath);
  const rel = normalizePosix(path.relative(resolvedWs, resolvedFile));
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return false;
  return !rel.toLowerCase().startsWith(".agents/skills/");
}

function summarizeText(raw, maxLen = 72) {
  const firstLine = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!firstLine) return "";
  return firstLine.length > maxLen ? `${firstLine.slice(0, maxLen - 1)}…` : firstLine;
}

function formatCadenceLabel(durationSec, cronExpr) {
  if (cronExpr) {
    const everyMin = String(cronExpr).match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (everyMin) return `every ${everyMin[1]} min`;
    return String(cronExpr).trim();
  }
  const sec = Number(durationSec);
  if (!Number.isFinite(sec) || sec <= 0) return "scheduled";
  if (sec >= 60 && sec % 60 === 0) return `every ${sec / 60} min`;
  return `in ${Math.round(sec)}s`;
}

function computeScheduleNextAt(marker, durationSec, cronExpr) {
  if (!marker?.tsMs) return null;
  let deltaMs = 0;
  const sec = Number(durationSec);
  if (Number.isFinite(sec) && sec > 0) {
    deltaMs = sec * 1000;
  } else if (cronExpr) {
    const everyMin = String(cronExpr).match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (everyMin) deltaMs = Number(everyMin[1]) * 60000;
  }
  return deltaMs > 0 ? new Date(marker.tsMs + deltaMs).toISOString() : null;
}

function parseIntArg(val) {
  const n = Number.parseInt(String(val ?? "").replace(/[^0-9-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolArg(val) {
  if (typeof val === "boolean") return val;
  return String(val ?? "").trim().toLowerCase() === "true";
}

function parseStringArrayArg(val) {
  if (Array.isArray(val)) return val.map((x) => unquoteArg(x)).filter(Boolean);
  if (typeof val === "string" && val.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [];
}

function extractPrReferences(text, { urlsOnly = false } = {}) {
  const str = String(text ?? "");
  const out = [];
  const seen = new Set();
  const pushRef = (number, url = null, extra = {}) => {
    if (!Number.isFinite(number) || number <= 0) return;
    const key = `${number}|${url || ""}|${extra.state || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ number, url, ...extra });
  };
  for (const m of str.matchAll(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/(\d+)\b/gi)) {
    pushRef(Number.parseInt(m[1], 10), m[0]);
  }
  if (!urlsOnly) {
    for (const m of str.matchAll(/watch-pr\.mjs[^\r\n]*--pr\s+(\d+)\b/gi)) {
      pushRef(Number.parseInt(m[1], 10), null);
    }
    for (const m of str.matchAll(/(?:^|[;&|\r\n]\s*)gh\s+pr\s+(view|edit|checks|merge|diff|comment|review)\s+#?(\d+)\b/gim)) {
      const action = m[1].toLowerCase();
      pushRef(Number.parseInt(m[2], 10), null, action === "merge" ? { state: "merged" } : {});
    }
  }
  return out;
}

function upsertPrEntry(prsMap, ref, { ts = null, title = null } = {}) {
  if (!ref || !Number.isFinite(ref.number) || ref.number <= 0) return;
  const existing = prsMap.get(ref.number);
  const nextState =
    ref.state === "merged" || existing?.state === "merged"
      ? "merged"
      : ref.state === "closed" || existing?.state === "closed"
        ? "closed"
        : "open";
  prsMap.set(ref.number, {
    number: ref.number,
    url: ref.url || existing?.url || null,
    title: title || ref.title || existing?.title || null,
    state: nextState,
    openedAt: existing?.openedAt || ts || null,
  });
}

function extractGhPrCreateTitle(cmd) {
  const str = String(cmd ?? "");
  if (!/\bgh\s+pr\s+create\b/i.test(str)) return null;
  const m = str.match(/(?:--title|-t)(?:\s+|=)(?:"([^"]+)"|'([^']+)')/);
  const raw = m?.[1] || m?.[2] || "";
  return raw ? summarizeText(raw, 80) : null;
}

const mergedPrCache = new Map();
const WORKSPACE_POLICY_CACHE_TTL_MS = 300_000;
const workspacePolicyCache = new Map();
const MAX_TRANSCRIPT_CACHE_ENTRIES = 64;
const transcriptCache = new Map();

function readFileStatFingerprint(filePath) {
  try {
    const st = fs.statSync(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

function readFileTextFingerprint(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "-";
  }
}

function buildWorkspacePolicyFingerprint(workspaceDir) {
  const resolved = path.resolve(workspaceDir);
  const locs = findGitLocationsFast(resolved);
  const parts = [
    resolved,
    locs?.gitDir ?? "",
    locs?.commonGitDir ?? "",
    readFileStatFingerprint(path.join(resolved, ".agents", "risk-policy.json")),
  ];
  if (locs) {
    parts.push(
      readFileTextFingerprint(path.join(locs.gitDir, "HEAD")),
      readFileStatFingerprint(path.join(locs.commonGitDir, "config")),
      readFileStatFingerprint(path.join(locs.commonGitDir, "packed-refs")),
      readFileTextFingerprint(path.join(locs.commonGitDir, "refs", "remotes", "origin", "HEAD")),
      readFileTextFingerprint(path.join(locs.commonGitDir, "refs", "remotes", "origin", "main")),
      readFileTextFingerprint(path.join(locs.commonGitDir, "refs", "heads", "main")),
      readFileTextFingerprint(path.join(locs.commonGitDir, "refs", "remotes", "origin", "master")),
      readFileTextFingerprint(path.join(locs.commonGitDir, "refs", "heads", "master")),
    );
  }
  return parts.join("|");
}

function resolveWorkspacePolicyCached(workspaceDir) {
  if (!workspaceDir) {
    return {
      workspaceScope: { kind: "non_repo", repoRoot: null, gitDir: null, commonDir: null, repoId: null },
      policyResult: loadRiskPolicy(""),
    };
  }
  const fp = buildWorkspacePolicyFingerprint(workspaceDir);
  const now = Date.now();
  const cached = workspacePolicyCache.get(fp);
  if (cached && now - cached.ts < WORKSPACE_POLICY_CACHE_TTL_MS) {
    return { workspaceScope: cached.workspaceScope, policyResult: cached.policyResult };
  }
  let capturedBaseRef = null;
  let capturedPolicyResult = null;
  const workspaceScope = resolveWorkspaceScope(workspaceDir, {
    policyLoader: (repoRoot, explicitBase) => {
      const baseRef = resolveBaseRef(repoRoot, explicitBase);
      capturedBaseRef = baseRef;
      if (!baseRef) return { present: false, baseRef: null, error: null };
      capturedPolicyResult = loadRiskPolicy(repoRoot, { baseRef });
      return { present: capturedPolicyResult.present, baseRef, error: capturedPolicyResult.error ?? null };
    },
  });
  const policyResult =
    workspaceScope.kind === "enrolled_repo" && capturedPolicyResult && capturedBaseRef === workspaceScope.baseRef
      ? capturedPolicyResult
      : workspaceScope.kind === "enrolled_repo"
        ? loadRiskPolicy(workspaceDir, { baseRef: workspaceScope.baseRef })
        : loadRiskPolicy(workspaceDir);
  if (workspaceScope.kind !== "git_unregistered" || !policyResult.present) {
    if (workspacePolicyCache.size >= 32) {
      workspacePolicyCache.clear();
    }
    workspacePolicyCache.set(fp, { ts: now, workspaceScope, policyResult });
  }
  return { workspaceScope, policyResult };
}

function readMergedPrNumbersFast(workspaceDir) {
  if (!workspaceDir) return new Set();
  const locs = findGitLocationsFast(workspaceDir);
  if (!locs) return new Set();
  let refKey = "";
  for (const refRel of ["refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"]) {
    try {
      const refPath = path.join(locs.commonGitDir, ...refRel.split("/"));
      if (fs.existsSync(refPath)) {
        refKey = `${refRel}:${fs.readFileSync(refPath, "utf8").trim()}`;
        break;
      }
    } catch {
      continue;
    }
  }
  const cacheKey = `${locs.commonGitDir}|${refKey}`;
  if (refKey && mergedPrCache.has(cacheKey)) {
    return mergedPrCache.get(cacheKey);
  }
  const merged = new Set();
  const targetRef = refKey ? refKey.split(":")[0].replace(/^refs\/(?:remotes|heads)\//, "") : "HEAD";
  try {
    const out = execFileSync("git", ["log", "-n", "80", "--format=%s", targetRef], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of out.split(/\r?\n/)) {
      for (const m of line.matchAll(/\(#(\d+)\)|Merge pull request #(\d+)\b/g)) {
        const num = Number.parseInt(m[1] || m[2], 10);
        if (Number.isFinite(num) && num > 0) merged.add(num);
      }
    }
  } catch {
    return merged;
  }
  if (refKey) {
    if (mergedPrCache.size > 32) mergedPrCache.clear();
    mergedPrCache.set(cacheKey, merged);
  }
  return merged;
}

function classifySwarmRole(name, brief) {
  const combined = `${name} ${brief}`;
  if (/\bverifier\b|@verifier/i.test(combined)) return "verifier";
  if (/\bmonitor\b|@monitor/i.test(combined)) return "monitor";
  return "worker";
}

const EXTRA_ARTIFACT_SKIP = new Set([
  "implementation_plan.md",
  "walkthrough.md",
  "pr-review.md",
  "task.md",
  "decisions.tsv",
]);

function formatArtifactLabel(filename) {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function collectExtraBrainArtifacts(brainConvDir) {
  if (!brainConvDir || !fs.existsSync(brainConvDir)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(brainConvDir, { withFileTypes: true });
  } catch {
    return out;
  }
  const names = entries
    .filter((e) => e.isFile() && !e.name.startsWith(".") && !EXTRA_ARTIFACT_SKIP.has(e.name) && /\.(?:md|png|svg|html|pdf)$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const uri = resolveSafeArtifactUri(brainConvDir, name);
    if (!uri) continue;
    out.push({
      id: `extra-${name}`,
      key: name,
      name,
      label: formatArtifactLabel(name),
      uri,
      status: "done",
      badge: "",
      kind: "file",
    });
    if (out.length >= 3) break;
  }
  return out;
}

const BRAIN_OR_GENERATED_RE = /(?:^|\/)(?:\.gemini\/(?:antigravity(?:-cli)?|jetski)\/brain|\.system_generated)(?:\/|$)/i;
const LOCAL_ARTIFACT_RE = /(?:^|\/)(?:\.system_generated|\.gemini)(?:\/|$)/i;
const ANTIGRAVITY_WORKTREE_RE = /(?:^|\/)\.gemini\/antigravity(?:-cli)?\/worktrees(?:\/|$)/i;
const NON_PROJECT_ABS_RE = /(?:^|\/)(?:tmp|temp|var\/folders|appdata\/local\/temp|\.(?:gemini|claude|cursor|vscode|config|cache))(?:\/|$)/i;
const PROJECT_PATH_HINT_RE = /(?:^|\/)(?:worktrees?|src|apps|packages|lib|scripts|tests?|cmd|internal|pkg|services|server|client|web|api|skills|docs|config|helm|charts|infra)\//i;

function isAbsoluteAnyPlatform(rawPath) {
  return path.isAbsolute(rawPath) || /^[a-zA-Z]:[/\\]/.test(String(rawPath ?? ""));
}

function isDirInsideGitRepo(targetPath) {
  if (!targetPath) return false;
  try {
    let dir = path.dirname(targetPath);
    while (dir && !fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
    return Boolean(dir && findGitLocationsFast(dir));
  } catch {
    return false;
  }
}

function isWorkspaceFileTarget(rawPath, workspaceDir, brainConvDir, brainDir = "") {
  if (!rawPath) return false;
  const norm = normalizePosix(rawPath);
  if (BRAIN_OR_GENERATED_RE.test(norm)) return false;
  const isAbs = isAbsoluteAnyPlatform(rawPath);
  if (!isAbs && (norm === ".." || norm.startsWith("../"))) return false;
  const resolved = workspaceDir ? path.resolve(workspaceDir, rawPath) : path.resolve(rawPath);
  const fileNorm = normalizePosix(resolved).toLowerCase();
  for (const excludedDir of [brainConvDir, brainDir]) {
    if (!excludedDir) continue;
    const exNorm = normalizePosix(path.resolve(excludedDir)).replace(/\/$/, "").toLowerCase();
    if (fileNorm === exNorm || fileNorm.startsWith(`${exNorm}/`)) return false;
  }
  if (workspaceDir) {
    const rel = path.relative(path.resolve(workspaceDir), resolved);
    if (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      return !LOCAL_ARTIFACT_RE.test(normalizePosix(rel));
    }
    if (!isAbs) return false;
    if (ANTIGRAVITY_WORKTREE_RE.test(norm)) return true;
    if (LOCAL_ARTIFACT_RE.test(norm)) return false;
    if (isDirInsideGitRepo(resolved)) return true;
    if (NON_PROJECT_ABS_RE.test(norm)) return false;
    const repoName = resolveWorkspaceRepoName(workspaceDir);
    if (repoName && norm.toLowerCase().includes(`/${repoName.toLowerCase()}/`)) return true;
    return PROJECT_PATH_HINT_RE.test(norm);
  }
  if (isAbs) {
    if (ANTIGRAVITY_WORKTREE_RE.test(norm)) return true;
    if (LOCAL_ARTIFACT_RE.test(norm)) return false;
    if (isDirInsideGitRepo(resolved)) return true;
    if (NON_PROJECT_ABS_RE.test(norm)) return false;
    return PROJECT_PATH_HINT_RE.test(norm);
  }
  return !LOCAL_ARTIFACT_RE.test(norm);
}

function formatTrackedChangedFile(rawPath, workspaceDir) {
  if (!workspaceDir) return normalizePosix(rawPath);
  const resolved = path.resolve(workspaceDir, rawPath);
  const rel = normalizePosix(path.relative(path.resolve(workspaceDir), resolved));
  if (rel && rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)) return rel;
  return normalizePosix(rawPath);
}

function inferTaskStageId(text, { hasWorkspaceWrite = false } = {}) {
  const str = String(text ?? "");
  if (/\bwatch-pr\b|\bgh\s+pr\s+(?:create|merge|checks|view|edit|comment)\b|\bgit\s+push\b|\bbabysit\b/i.test(str)) {
    return "ship";
  }
  if (/\bpr-dossier\b|\bpre-pr\b|\bpr-verifier\b/i.test(str)) {
    return "review";
  }
  if (!hasWorkspaceWrite && /\bplan\b|\bgrill-me\b/i.test(str)) {
    return "plan";
  }
  return "build";
}

function inferSubagentStageId(subType, roleText, promptText, hasWorkspaceWrite) {
  const combined = `${subType} ${roleText} ${promptText}`;
  if (subType === "pr-verifier" || /\bpr[- ]?verifier\b|\bpre[- ]?pr\b|\bpr[- ]?dossier\b/i.test(combined)) {
    return "review";
  }
  if (
    /\bshipper\b/i.test(String(roleText ?? "")) ||
    /\b(?:open[- ]?(?:the[- ]?|a[- ]?)?pr|create[- ]?(?:the[- ]?|a[- ]?)?pr|watch[- ]?pr|babysit|merge[- ]?(?:the[- ]?|a[- ]?)?pr|gh\s+pr\b|ship[- ]?(?:the[- ]?|a[- ]?)?pr|land[- ]?(?:the[- ]?)?stack)\b/i.test(combined)
  ) {
    return "ship";
  }
  if (subType === "research" && !hasWorkspaceWrite) {
    return "plan";
  }
  return "build";
}

function makeEmptyTranscriptSignals() {
  return {
    startedAt: null,
    childConvIds: new Set(),
    detected: new Set(),
    setupAt: null,
    grillMeAt: null,
    planCmdAt: null,
    planContractAt: null,
    askQuestionAt: null,
    planWrittenAt: null,
    planApprovedAt: null,
    approvalIntentAt: null,
    walkthroughWrittenAt: null,
    astackModeAt: null,
    interrogateAt: null,
    cleanAt: null,
    verifyRunAt: null,
    latestCodeWriteAt: null,
    latestWorkspaceWriteAt: null,
    earliestWorkspaceWriteAt: null,
    reviewPrAt: null,
    openPrAt: null,
    pushOrPrAt: null,
    babysitAt: null,
    goal: { detected: false, active: false, completed: false, startedAt: null, predicate: "" },
    boost: { detected: false, active: false },
    teamwork: { detected: false, active: false },
    swarm: { active: false, title: "", posts: 0, members: [], sparks: [] },
    subagents: [],
    schedules: [],
    automations: [],
    workflow: { active: false, runsCount: 0, stageId: null },
    colleagueReview: { commands: new Set(), queueReview: false, stackReview: false, targetPrs: new Map() },
    mainTurn: { active: false, waitingOnUser: false, lastActivityMs: 0 },
    backgroundJobs: [],
    failedVerifyCmds: [],
    sideQuestionsCount: 0,
    changedFiles: new Set(),
    pr: null,
    prs: new Map(),
    terminalDoneAt: null,
  };
}

function cloneTranscriptSignals(sig) {
  return {
    ...sig,
    childConvIds: new Set(sig.childConvIds),
    detected: new Set(sig.detected),
    goal: { ...sig.goal },
    boost: { ...sig.boost },
    teamwork: { ...sig.teamwork },
    swarm: {
      ...sig.swarm,
      members: sig.swarm.members.map((m) => ({ ...m })),
      sparks: sig.swarm.sparks.map((s) => ({ ...s })),
    },
    subagents: sig.subagents.map((sa) => ({ ...sa })),
    schedules: sig.schedules.map((s) => ({ ...s, prNumbers: Array.isArray(s.prNumbers) ? [...s.prNumbers] : [] })),
    automations: sig.automations.map((a) => ({ ...a })),
    workflow: { ...sig.workflow },
    colleagueReview: {
      commands: new Set(sig.colleagueReview.commands),
      queueReview: sig.colleagueReview.queueReview,
      stackReview: sig.colleagueReview.stackReview,
      targetPrs: new Map([...sig.colleagueReview.targetPrs.entries()].map(([k, v]) => [k, { ...v }])),
    },
    mainTurn: { ...sig.mainTurn },
    backgroundJobs: sig.backgroundJobs.map((j) => ({
      ...j,
      prNumbers: Array.isArray(j.prNumbers) ? [...j.prNumbers] : j.prNumbers,
    })),
    failedVerifyCmds: (sig.failedVerifyCmds || []).map((f) => ({ ...f })),
    changedFiles: new Set(sig.changedFiles),
    pr: sig.pr ? { ...sig.pr } : null,
    prs: new Map([...sig.prs.entries()].map(([k, v]) => [k, { ...v }])),
  };
}

function parseTranscriptRaw(transcriptPath, brainConvDir, workspaceDir, brainDir = "") {
  const sig = makeEmptyTranscriptSignals();
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return sig;

  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  const pendingTestCmds = new Map();
  const pendingSubagentIndices = [];
  const subagentByConvId = new Map();
  const subagentMarkers = new Map();
  const pendingScheduleIndices = [];
  const scheduleTaskMap = new Map();
  const swarmMemberById = new Map();
  const bgJobByTaskId = new Map();
  let pendingToolQueue = [];
  let pendingWorkflowRun = false;
  let pendingPrTitle = null;
  let lastToolNames = new Set();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let step;
    try {
      step = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!step || typeof step !== "object") continue;

    if (step.type === "PLANNER_RESPONSE") {
      const hasTools = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
      sig.terminalDoneAt = step.status === "DONE" && !hasTools ? (step.created_at || true) : false;
    } else if (step.status === "RUNNING") {
      sig.terminalDoneAt = false;
    }

    const order = Number.isFinite(step.step_index) ? step.step_index : i;
    const marker = makeMarker(step.created_at, order);
    if (!sig.startedAt && marker.ts) sig.startedAt = marker.ts;

    if (step.type === "USER_INPUT" || step.source === "USER_EXPLICIT") {
      sig.mainTurn.active = true;
      sig.mainTurn.waitingOnUser = false;
      if (marker.tsMs) sig.mainTurn.lastActivityMs = Math.max(sig.mainTurn.lastActivityMs, marker.tsMs);
      const rawContent = String(step.content ?? "");
      const cmds = extractInvokedSlashCommands(rawContent);
      const body = extractRequestBody(rawContent).trim();
      let matchedColleaguePrCmd = false;
      for (const cmd of cmds) {
        if (COMMAND_DOCS[cmd]) sig.detected.add(cmd);
        if (cmd === "/setup-astack") sig.setupAt = latestMarker(sig.setupAt, marker);
        else if (cmd === "/grill-me") sig.grillMeAt = latestMarker(sig.grillMeAt, marker);
        else if (cmd === "/plan") sig.planCmdAt = latestMarker(sig.planCmdAt, marker);
        else if (cmd === "/astack-mode") sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        else if (cmd === "/interrogate") {
          sig.interrogateAt = latestMarker(sig.interrogateAt, marker);
          sig.colleagueReview.commands.add("/interrogate");
          matchedColleaguePrCmd = true;
        } else if (cmd === "/teach") {
          sig.colleagueReview.commands.add("/teach");
          matchedColleaguePrCmd = true;
        } else if (cmd === "/blast-radius") {
          sig.colleagueReview.commands.add("/blast-radius");
          matchedColleaguePrCmd = true;
        } else if (cmd === "/security-audit") {
          sig.colleagueReview.commands.add("/security-audit");
          matchedColleaguePrCmd = true;
        } else if (cmd === "/fanout" && /\b(?:pr|prs|pull|review)\b|#\d+/i.test(body)) {
          sig.colleagueReview.commands.add("/fanout");
          sig.colleagueReview.queueReview = true;
          matchedColleaguePrCmd = true;
        } else if (cmd === "/run-workflow" && /\b(?:pr|prs|pull|review)\b|#\d+/i.test(body)) {
          sig.colleagueReview.commands.add("/run-workflow");
          sig.colleagueReview.queueReview = true;
          matchedColleaguePrCmd = true;
        } else if (cmd === "/swarm" && /\b(?:pr|prs|pull|review|stack)\b|#\d+/i.test(body)) {
          sig.colleagueReview.commands.add("/swarm");
          sig.colleagueReview.stackReview = true;
          matchedColleaguePrCmd = true;
        } else if (cmd === "/pre-pr") sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        else if (cmd === "/boost") {
          sig.boost.detected = true;
          sig.boost.active = true;
        } else if (cmd === "/teamwork") {
          sig.teamwork.detected = true;
          sig.teamwork.active = true;
        } else if (cmd === "/btw") {
          sig.sideQuestionsCount += 1;
        } else if (cmd === "/automation" && sig.automations.length === 0) {
          const autoLabel = summarizeText(body.replace(/^\/automation\s*/i, ""), 44) || "Background automation";
          sig.automations.push({
            id: "auto-0",
            label: autoLabel,
            cadence: "recurring",
            stageId: inferTaskStageId(autoLabel, { hasWorkspaceWrite: Boolean(sig.latestWorkspaceWriteAt) }),
            active: true,
          });
        }
      }
      if (matchedColleaguePrCmd) {
        for (const prRef of extractPrReferences(body, { urlsOnly: true })) {
          upsertPrEntry(sig.colleagueReview.targetPrs, prRef, { ts: marker.ts });
        }
        for (const m of body.matchAll(/(?:\bPR\s*#?|#)(\d+)\b/gi)) {
          const num = Number.parseInt(m[1], 10);
          if (Number.isFinite(num) && num > 0 && !sig.colleagueReview.targetPrs.has(num)) {
            upsertPrEntry(sig.colleagueReview.targetPrs, { number: num, url: null }, { ts: marker.ts });
          }
        }
      }
      const isQuestionBody = /\?\s*$/.test(body);
      const hasGoalSignal =
        cmds.includes("/goal") ||
        /\/goal is a \[Slash Command\]:/i.test(rawContent) ||
        (!isQuestionBody && /(?:^|\s)\/goal(?:\s|$)/i.test(body));
      if (hasGoalSignal) {
        sig.detected.add("/goal");
        sig.goal.detected = true;
        sig.goal.active = true;
        sig.goal.completed = false;
        if (!sig.goal.startedAt && marker.ts) sig.goal.startedAt = marker.ts;
        const predMatch = body.match(/\bDone\s+when\s+([^.!?\r\n]+(?:[.!?])?)/i);
        if (predMatch) {
          sig.goal.predicate = summarizeText(predMatch[1], 80);
        } else if (cmds.includes("/goal")) {
          const rest = body.replace(/^\/goal\s*/i, "").trim();
          if (rest) sig.goal.predicate = summarizeText(rest, 80);
        }
      }
      if (cmds.includes("/astack-mode")) {
        if (/\b(?:open\s+(?:the|a)\s+pr|gh\s+pr\s+create)\b/i.test(body)) {
          sig.openPrAt = latestMarker(sig.openPrAt, marker);
          sig.detected.add("/astack-mode open the pr");
        }
        if (/\bbabysit\b/i.test(body)) {
          sig.babysitAt = latestMarker(sig.babysitAt, marker);
          sig.detected.add("/astack-mode babysit");
        }
        if (/\bland\s+(?:the\s+)?stack\b/i.test(body)) sig.detected.add("/astack-mode land the stack");
        if (/\b(?:release-and-postmortem|release\s+notes|postmortem)\b/i.test(body)) {
          sig.detected.add("/astack-mode release-and-postmortem");
        }
        if (/\bprune\s+worktrees?\b/i.test(body)) sig.detected.add("/astack-mode prune worktrees");
      }
      if (/\bProceeded\s+with\b/i.test(body) || /^(?:approved|approve|proceed|do it|go ahead)\b/i.test(body)) {
        if (sig.planWrittenAt && isMarkerAfter(marker, sig.planWrittenAt)) {
          sig.planApprovedAt = latestMarker(sig.planApprovedAt, marker);
        } else if (!sig.planWrittenAt) {
          sig.approvalIntentAt = latestMarker(sig.approvalIntentAt, marker);
        }
      }
      continue;
    }

    if (step.type === "SYSTEM_MESSAGE" && typeof step.content === "string") {
      if (/All your subagents and background tasks have been stopped/i.test(step.content)) {
        sig.mainTurn.active = false;
        sig.mainTurn.waitingOnUser = false;
        for (const sa of sig.subagents) {
          if (sa.status === "running") {
            sa.status = "done";
            sa.completedAt = marker.ts;
          }
        }
        for (const job of bgJobByTaskId.values()) {
          if (job.status === "running") {
            job.status = "stopped";
            job.completedAt = marker.ts;
          }
        }
      }
      const senderMatch = step.content.match(/\bsender=([^\s\]]+)/i);
      if (senderMatch) {
        sig.mainTurn.active = true;
        sig.mainTurn.waitingOnUser = false;
        if (marker.tsMs) sig.mainTurn.lastActivityMs = Math.max(sig.mainTurn.lastActivityMs, marker.tsMs);
        const sender = senderMatch[1];
        if (subagentByConvId.has(sender)) {
          const sa = sig.subagents[subagentByConvId.get(sender)];
          if (sa && sa.status !== "done") {
            sa.status = "done";
            sa.completedAt = marker.ts;
          }
        }
        if (scheduleTaskMap.has(sender)) {
          const sch = sig.schedules[scheduleTaskMap.get(sender)];
          if (sch && !sch.cronExpression) {
            sch.active = false;
          }
        }
        for (const sch of sig.schedules) {
          if (
            sch.active &&
            !sch.cronExpression &&
            sch.timerCondition &&
            (sch.timerCondition === "any" || sch.timerCondition === sender)
          ) {
            sch.active = false;
            if (sch.taskId && bgJobByTaskId.has(sch.taskId)) {
              const linkedJob = bgJobByTaskId.get(sch.taskId);
              if (linkedJob && linkedJob.status === "running") {
                linkedJob.status = "stopped";
                linkedJob.completedAt = marker.ts;
              }
            }
          }
        }
        if (bgJobByTaskId.has(sender)) {
          const job = bgJobByTaskId.get(sender);
          if (job && job.status === "running") {
            const isStillRunning = /still running after/i.test(step.content);
            if (!isStillRunning) {
              const failed = /Command exited with code [1-9]/i.test(step.content);
              const cancelled = /was\s+cancell?ed/i.test(step.content);
              if (failed) {
                job.status = "failed";
                job.completedAt = marker.ts;
                const cmdText = String(job.command || job.title || "").trim();
                const cat = classifyCommandCategory(cmdText);
                if (VERIFY_CATEGORIES.has(cat)) {
                  const startMs = Date.parse(job.startedAt || "") || marker.tsMs;
                  sig.failedVerifyCmds.push({
                    startMs,
                    endMs: marker.tsMs || startMs,
                    cmdPrefix: cmdText.slice(0, 60),
                  });
                }
              } else if (cancelled) {
                job.status = "stopped";
                job.completedAt = marker.ts;
              } else if (/finished with result:/i.test(step.content)) {
                job.status = "done";
                job.completedAt = marker.ts;
                const cat = classifyCommandCategory(String(job.command || job.title || ""));
                if (cat === "test" || cat === "verify") {
                  sig.verifyRunAt = latestMarker(sig.verifyRunAt, marker);
                }
              }
            }
          }
        }
      }
      continue;
    }

    if (step.type === "ERROR_MESSAGE" || step.type === "CHECKPOINT") {
      sig.mainTurn.active = false;
      sig.mainTurn.waitingOnUser = false;
      continue;
    }

    if (step.type === "EPHEMERAL_MESSAGE") {
      if (sig.mainTurn.active && marker.tsMs) {
        sig.mainTurn.lastActivityMs = Math.max(sig.mainTurn.lastActivityMs, marker.tsMs);
      }
      continue;
    }

    if (step.type === "GENERIC" && typeof step.content === "string") {
      sig.mainTurn.active = true;
      sig.mainTurn.waitingOnUser = false;
      if (marker.tsMs) sig.mainTurn.lastActivityMs = Math.max(sig.mainTurn.lastActivityMs, marker.tsMs);
      const shiftedTool = pendingToolQueue.length > 0 ? pendingToolQueue.shift() : null;
      const onlyFileReads = lastToolNames.size > 0 && [...lastToolNames].every((t) => FILE_READ_TOOLS.has(t));
      if (!onlyFileReads) {
        for (const prRef of extractPrReferences(step.content, { urlsOnly: true })) {
          upsertPrEntry(sig.prs, prRef, { ts: marker.ts, title: pendingPrTitle });
          if (pendingPrTitle) pendingPrTitle = null;
        }
      }

      const isSubagentListOutput =
        (shiftedTool?.kind === "manage_subagents" && shiftedTool.action === "list") ||
        /\bYou have \d+ active subagent\(s\):/i.test(step.content);
      const cids = [...step.content.matchAll(/"conversationId"\s*:\s*"([0-9a-f-]{8,})"/gi)].map((m) => m[1]);
      const isStepError = step.status === "ERROR" || /Encountered error in step execution:/i.test(step.content);

      if (cids.length > 0) {
        for (const cid of cids) {
          sig.childConvIds.add(cid);
          if (isSubagentListOutput || subagentByConvId.has(cid)) continue;
          let idx = -1;
          if (
            cids.length === 1 &&
            shiftedTool?.kind === "subagent" &&
            sig.subagents[shiftedTool.subagentIndex] &&
            !sig.subagents[shiftedTool.subagentIndex].childConvId &&
            sig.subagents[shiftedTool.subagentIndex].status !== "failed"
          ) {
            idx = shiftedTool.subagentIndex;
            const pos = pendingSubagentIndices.indexOf(idx);
            if (pos !== -1) pendingSubagentIndices.splice(pos, 1);
          } else {
            while (pendingSubagentIndices.length > 0) {
              const cand = pendingSubagentIndices.shift();
              if (sig.subagents[cand] && !sig.subagents[cand].childConvId && sig.subagents[cand].status !== "failed") {
                idx = cand;
                break;
              }
            }
          }
          if (idx >= 0 && sig.subagents[idx]) {
            sig.subagents[idx].childConvId = cid;
            subagentByConvId.set(cid, idx);
          }
        }
      } else if (isStepError && !isSubagentListOutput) {
        let failedIdx = -1;
        if (shiftedTool?.kind === "subagent" && sig.subagents[shiftedTool.subagentIndex]) {
          failedIdx = shiftedTool.subagentIndex;
          const pos = pendingSubagentIndices.indexOf(failedIdx);
          if (pos !== -1) pendingSubagentIndices.splice(pos, 1);
        } else if (
          pendingSubagentIndices.length > 0 &&
          (/subagent/i.test(step.content) || (lastToolNames.size === 1 && lastToolNames.has("invoke_subagent")))
        ) {
          failedIdx = pendingSubagentIndices.shift();
        }
        if (failedIdx >= 0 && sig.subagents[failedIdx]) {
          sig.subagents[failedIdx].status = "failed";
          sig.subagents[failedIdx].completedAt = marker.ts;
        }
      }

      const isManageTaskList =
        (shiftedTool?.kind === "manage_task" && shiftedTool.action === "list") ||
        (lastToolNames.size === 1 && lastToolNames.has("manage_task"));
      if (
        !isStepError &&
        ((isManageTaskList && /No background tasks are currently running/i.test(step.content)) ||
          /^\s*No background tasks are currently running\.?\s*$/im.test(step.content))
      ) {
        for (const sch of sig.schedules) {
          if (sch.active && !sch.isDaemon) {
            sch.active = false;
          }
        }
        for (const job of bgJobByTaskId.values()) {
          if (job.status === "running" && !job.isDaemon) {
            job.status = "done";
            job.completedAt = marker.ts;
          }
        }
      }
      const harnessHeader = step.content.split(/\r?\nCommand output:\r?\n/)[0];
      const taskCreated = harnessHeader.match(/(?:^|\r?\n)(?:Tool is running as a background task with )?task id:\s*([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)\s*(?:\r?\n|$)/i);
      if (taskCreated) {
        const taskId = taskCreated[1];
        const isCommandBg = /Tool is running as a background task/i.test(harnessHeader);
        let matchedSchedule = null;
        if (pendingScheduleIndices.length > 0 && (!isCommandBg || shiftedTool?.kind === "schedule")) {
          const idx = pendingScheduleIndices.shift();
          matchedSchedule = sig.schedules[idx];
          matchedSchedule.taskId = taskId;
          scheduleTaskMap.set(taskId, idx);
        }
        if (!bgJobByTaskId.has(taskId)) {
          let toolMeta = shiftedTool && shiftedTool.kind !== "other" ? shiftedTool : null;
          if (!toolMeta) {
            const fallbackIdx = pendingToolQueue.findIndex((t) => t.kind !== "other");
            if (fallbackIdx >= 0) toolMeta = pendingToolQueue.splice(fallbackIdx, 1)[0];
          }
          const taskSlug = taskId.split("/").pop() || taskId;
          const descLine = step.content.match(/Task Description:\s*([^\r\n]+)/i)?.[1] ?? "";
          const title = toolMeta?.title || summarizeText(descLine, 68) || taskSlug;
          const cmdText = toolMeta?.cmd || descLine || "";
          const candidateLog = /^task-\d+$/.test(taskSlug) ? `${taskSlug}.log` : null;
          const logFile = candidateLog && resolveSafeTaskLogPath(brainConvDir, candidateLog) ? candidateLog : null;
          const stageId = matchedSchedule?.stageId || inferTaskStageId(`${cmdText} ${title}`, {
            hasWorkspaceWrite: Boolean(sig.latestWorkspaceWriteAt),
          });
          bgJobByTaskId.set(taskId, {
            id: `bg-${bgJobByTaskId.size}`,
            taskId,
            taskSlug,
            logFile,
            kind: toolMeta?.kind || "command",
            stageId,
            title,
            summary: title,
            command: summarizeText(cmdText, 120),
            startedAt: toolMeta?.ts || marker.ts,
            completedAt: null,
            status: "running",
            isDaemon: Boolean(toolMeta?.isDaemon),
            isCron: Boolean(toolMeta?.isCron),
            timerCondition: toolMeta?.timerCondition || matchedSchedule?.timerCondition || null,
            prNumbers: toolMeta?.prNumbers || matchedSchedule?.prNumbers || extractPrReferences(cmdText).map((r) => r.number),
          });
        }
      } else if (isStepError && shiftedTool?.kind === "schedule" && Number.isInteger(shiftedTool.scheduleIndex)) {
        const pos = pendingScheduleIndices.indexOf(shiftedTool.scheduleIndex);
        if (pos !== -1) pendingScheduleIndices.splice(pos, 1);
        if (sig.schedules[shiftedTool.scheduleIndex]) {
          sig.schedules[shiftedTool.scheduleIndex].active = false;
        }
      }
      const taskCancelled = step.content.match(/Task\s+"([^"]+)"\s+(?:was\s+)?cancell?ed/i);
      if (taskCancelled) {
        const cancelledId = taskCancelled[1];
        if (scheduleTaskMap.has(cancelledId)) {
          sig.schedules[scheduleTaskMap.get(cancelledId)].active = false;
        }
        if (bgJobByTaskId.has(cancelledId)) {
          const job = bgJobByTaskId.get(cancelledId);
          job.status = "stopped";
          job.completedAt = marker.ts;
        }
      }
      if (pendingWorkflowRun && (step.status === "DONE" || step.status === "ERROR")) {
        sig.workflow.active = false;
        pendingWorkflowRun = false;
      }
      for (const [cmdOrder, cmdEntry] of pendingTestCmds.entries()) {
        if (order > cmdOrder && order <= cmdOrder + 4) {
          const isBackgrounded = /Tool is running as a background task/i.test(step.content);
          if (!isBackgrounded) {
            const failed = step.status === "ERROR" || /Command exited with code [1-9]/i.test(step.content);
            if (failed) {
              sig.failedVerifyCmds.push({
                startMs: cmdEntry.marker.tsMs || marker.tsMs,
                endMs: marker.tsMs || cmdEntry.marker.tsMs,
                cmdPrefix: String(cmdEntry.cmd || "").trim().slice(0, 60),
              });
            } else {
              sig.verifyRunAt = latestMarker(sig.verifyRunAt, cmdEntry.marker);
            }
          }
          pendingTestCmds.delete(cmdOrder);
          break;
        }
      }
      continue;
    }

    if (step.type !== "PLANNER_RESPONSE") continue;

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const hasTools = toolCalls.length > 0;
    const asksUser = toolCalls.some((tc) => String(tc?.name ?? "") === "ask_question");
    if (step.status === "RUNNING") {
      sig.mainTurn.active = true;
      sig.mainTurn.waitingOnUser = false;
    } else if (asksUser) {
      sig.mainTurn.active = false;
      sig.mainTurn.waitingOnUser = true;
    } else if (hasTools) {
      sig.mainTurn.active = true;
      sig.mainTurn.waitingOnUser = false;
    } else {
      sig.mainTurn.active = false;
      sig.mainTurn.waitingOnUser = false;
    }
    if (marker.tsMs) sig.mainTurn.lastActivityMs = Math.max(sig.mainTurn.lastActivityMs, marker.tsMs);

    if (typeof step.content === "string") {
      if (/<!--\s*GOAL_(?:COMPLETE|CANCELLED)\s*-->/i.test(step.content)) {
        sig.goal.active = false;
        sig.goal.completed = true;
      }
      const proseOnly = step.content.replace(/```[\s\S]*?```/g, " ");
      for (const prRef of extractPrReferences(proseOnly, { urlsOnly: true })) {
        upsertPrEntry(sig.prs, prRef, { ts: marker.ts });
      }
    }

    if (!Array.isArray(step.tool_calls)) {
      lastToolNames = new Set();
      pendingToolQueue = [];
      continue;
    }
    lastToolNames = new Set(step.tool_calls.map((tc) => String(tc?.name ?? "")).filter(Boolean));
    pendingToolQueue = [];

    for (const tc of step.tool_calls) {
      const name = String(tc?.name ?? "");
      const args = tc?.args && typeof tc.args === "object" ? tc.args : {};
      let queuedMeta = { kind: "other" };

      if (FILE_READ_TOOLS.has(name)) {
        const p = targetPathOf(args);
        if (isWorkspaceSourceSkillPath(p, workspaceDir)) continue;
        const skillRead = p.match(/\/skills\/([a-z0-9-]+)\/SKILL\.md$/i);
        if (skillRead) {
          const slug = `/${skillRead[1].toLowerCase()}`;
          if (COMMAND_DOCS[slug]) sig.detected.add(slug);
          if (slug === "/automation" && sig.automations.length === 0) {
            sig.automations.push({
              id: "auto-0",
              label: "App automation",
              cadence: "recurring",
              stageId: "build",
              active: true,
            });
          }
        }
        const pbRead = p.match(/\/skills\/astack-mode\/playbooks\/([a-z0-9-]+)\.md$/i);
        if (pbRead) {
          const pbName = pbRead[1].toLowerCase();
          if (pbName === "shipping") sig.detected.add("/astack-mode land the stack");
          else if (pbName === "babysit") sig.detected.add("/astack-mode babysit");
          else if (pbName === "release-and-postmortem") sig.detected.add("/astack-mode release-and-postmortem");
          else if (pbName === "worktree-cleanup") sig.detected.add("/astack-mode prune worktrees");
        }
        if (/\/skills\/setup-astack\/SKILL\.md$/i.test(p)) sig.setupAt = latestMarker(sig.setupAt, marker);
        else if (/\/skills\/astack-mode\/references\/plan-contract\.md$/i.test(p)) sig.planContractAt = latestMarker(sig.planContractAt, marker);
        else if (/\/skills\/astack-mode\/SKILL\.md$/i.test(p)) sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        else if (/\/skills\/interrogate\/SKILL\.md$/i.test(p)) sig.interrogateAt = latestMarker(sig.interrogateAt, marker);
        else if (/\/skills\/(?:deslop|no-comments)\/SKILL\.md$/i.test(p)) sig.cleanAt = latestMarker(sig.cleanAt, marker);
        else if (/\/skills\/(?:control-ui|control-cli)\/SKILL\.md$/i.test(p) || /\/\.agents\/skills\/verify-[^/]+\/SKILL\.md$/i.test(p)) {
          sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        } else if (/\/skills\/pre-pr\/SKILL\.md$/i.test(p)) {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        } else if (/\/skills\/astack-mode\/playbooks\/opening-a-pr\.md$/i.test(p)) {
          sig.openPrAt = latestMarker(sig.openPrAt, marker);
        } else if (/\/skills\/astack-mode\/playbooks\/babysit\.md$/i.test(p)) {
          sig.babysitAt = latestMarker(sig.babysitAt, marker);
        }
      } else if (FILE_WRITE_TOOLS.has(name)) {
        const p = targetPathOf(args);
        if (/\/implementation_plan\.md$/i.test(p)) {
          sig.planWrittenAt = latestMarker(sig.planWrittenAt, marker);
        } else if (/\/walkthrough\.md$/i.test(p)) {
          sig.walkthroughWrittenAt = latestMarker(sig.walkthroughWrittenAt, marker);
        } else if (/\/pr-review\.md$/i.test(p)) {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        } else if (isWorkspaceFileTarget(p, workspaceDir, brainConvDir, brainDir)) {
          sig.latestWorkspaceWriteAt = latestMarker(sig.latestWorkspaceWriteAt, marker);
          sig.earliestWorkspaceWriteAt = earliestMarker(sig.earliestWorkspaceWriteAt, marker);
          sig.changedFiles.add(formatTrackedChangedFile(p, workspaceDir));
          if (!DOC_EXT_RE.test(p)) {
            sig.latestCodeWriteAt = latestMarker(sig.latestCodeWriteAt, marker);
          }
        }
      } else if (name === "ask_question") {
        sig.askQuestionAt = latestMarker(sig.askQuestionAt, marker);
      } else if (name === "invoke_subagent") {
        const subType = unquoteArg(args.TypeName) || "self";
        const roleText = unquoteArg(args.Role);
        const promptText = unquoteArg(args.Prompt);
        const stageId = inferSubagentStageId(subType, roleText, promptText, Boolean(sig.latestWorkspaceWriteAt));
        const entry = {
          id: `sa-${sig.subagents.length}`,
          type: subType,
          role: roleText || subType,
          task: summarizeText(promptText || roleText || subType, 68),
          stageId,
          childConvId: null,
          startedAt: marker.ts,
          completedAt: null,
          status: "running",
          order,
        };
        const subagentIndex = sig.subagents.length;
        pendingSubagentIndices.push(subagentIndex);
        subagentMarkers.set(entry, marker);
        sig.subagents.push(entry);
        queuedMeta = { kind: "subagent", subagentIndex, ts: marker.ts };
      } else if (name === "manage_subagents") {
        const act = unquoteArg(args.Action).toLowerCase();
        queuedMeta = { kind: "manage_subagents", action: act, ts: marker.ts };
        if (act === "kill_all") {
          for (const sa of sig.subagents) {
            if (sa.status === "running") {
              sa.status = "done";
              sa.completedAt = marker.ts;
            }
          }
        } else if (act === "kill") {
          for (const cid of parseStringArrayArg(args.ConversationIds)) {
            if (subagentByConvId.has(cid)) {
              const sa = sig.subagents[subagentByConvId.get(cid)];
              if (sa) {
                sa.status = "done";
                sa.completedAt = marker.ts;
              }
            }
          }
        }
      } else if (name === "swarm") {
        const action = unquoteArg(args.action).toLowerCase();
        sig.detected.add("/swarm");
        if (action === "title") {
          sig.swarm.title = summarizeText(unquoteArg(args.title), 60);
          sig.swarm.active = true;
        } else if (action === "add") {
          sig.swarm.active = true;
          const baseName = unquoteArg(args.name) || "worker";
          const brief = unquoteArg(args.brief);
          const taskList = parseStringArrayArg(args.tasks);
          const count = parseIntArg(args.n) ?? 1;
          const entries = taskList.length > 0
            ? taskList.map((tItem, idx) => [`${baseName}-${idx + 1}`, `${tItem} ${brief}`.trim()])
            : count > 1
              ? Array.from({ length: count }, (_, idx) => [`${baseName}-${idx + 1}`, brief])
              : [[baseName, brief]];
          for (const [mName, mBrief] of entries) {
            const role = classifySwarmRole(mName, mBrief);
            const member = {
              id: mName,
              name: `@${mName}`,
              role,
              task: summarizeText(mBrief, 64) || role,
              status: role === "verifier" || role === "monitor" ? "waiting" : "working",
            };
            if (swarmMemberById.has(mName)) {
              sig.swarm.members[swarmMemberById.get(mName)] = member;
            } else {
              swarmMemberById.set(mName, sig.swarm.members.length);
              sig.swarm.members.push(member);
            }
          }
        } else if (action === "kill") {
          const targetName = unquoteArg(args.name);
          if (targetName && swarmMemberById.has(targetName)) {
            sig.swarm.members[swarmMemberById.get(targetName)].status = "killed";
          }
          if (sig.swarm.members.every((m) => m.status === "killed")) {
            sig.swarm.active = false;
          }
        }
      } else if (name === "post_message") {
        sig.swarm.posts += 1;
        const fromId = unquoteArg(args.from) || "coord";
        const toId = unquoteArg(args.to) || "coord";
        sig.swarm.sparks.push({ from: fromId, to: toId, ts: marker.ts });
        if (sig.swarm.sparks.length > 8) sig.swarm.sparks.shift();
        if (swarmMemberById.has(toId)) {
          const targetMember = sig.swarm.members[swarmMemberById.get(toId)];
          if (targetMember && targetMember.status !== "killed") targetMember.status = "working";
        }
      } else if (name === "swarm_wait") {
        for (const m of sig.swarm.members) {
          if (m.status === "working") m.status = "waiting";
        }
      } else if (name === "run_workflow") {
        sig.detected.add("/run-workflow");
        sig.workflow.runsCount += 1;
        sig.workflow.active = true;
        const wfText = unquoteArg(args.Description || args.ScriptPath || args.Script);
        if (/\bship\b|\bmerge\b|\bwatch-pr\b|\bbabysit\b/i.test(wfText)) {
          sig.workflow.stageId = "ship";
        } else if (/\breview|\bpr[- ]?verifier|\bdossier\b/i.test(wfText)) {
          sig.workflow.stageId = "review";
        } else if (/\bplan\b|\bdesign\b|\barchitect\b/i.test(wfText) && !sig.latestWorkspaceWriteAt) {
          sig.workflow.stageId = "plan";
        } else {
          sig.workflow.stageId = inferTaskStageId(wfText, { hasWorkspaceWrite: Boolean(sig.latestWorkspaceWriteAt) });
        }
        pendingWorkflowRun = true;
        const wfDesc = unquoteArg(args.Description || args.ScriptPath);
        queuedMeta = {
          kind: "workflow",
          title: summarizeText(wfDesc, 72) || "Workflow run",
          cmd: wfDesc,
          isDaemon: false,
          isCron: false,
          ts: marker.ts,
        };
      } else if (name === "schedule") {
        sig.detected.add("/schedule");
        const dur = parseIntArg(args.DurationSeconds);
        const cron = unquoteArg(args.CronExpression);
        const promptText = unquoteArg(args.Prompt);
        const isDaemon = parseBoolArg(args.IsDaemon);
        const rawTimerCond = unquoteArg(args.TimerCondition).trim();
        const timerCondition = rawTimerCond && rawTimerCond.toLowerCase() !== "never" ? rawTimerCond : null;
        const prRefs = extractPrReferences(promptText);
        for (const prRef of prRefs) upsertPrEntry(sig.prs, prRef, { ts: marker.ts });
        const prRef = prRefs[0] ?? null;
        const prNumbers = prRefs.map((r) => r.number);
        const label = /watch-pr/i.test(promptText)
          ? prRef
            ? `watch-pr.mjs --pr ${prRef.number}`
            : "watch-pr.mjs"
          : summarizeText(promptText, 44) || "Scheduled check";
        const stageId = /watch-pr|\bpr\b|\bci\b/i.test(promptText) ? "ship" : "build";
        const scheduleIndex = sig.schedules.length;
        pendingScheduleIndices.push(scheduleIndex);
        sig.schedules.push({
          id: `sch-${scheduleIndex}`,
          taskId: null,
          label,
          prompt: promptText,
          cadence: formatCadenceLabel(dur, cron),
          stageId,
          startedAt: marker.ts,
          nextAt: computeScheduleNextAt(marker, dur, cron),
          durationSeconds: dur,
          cronExpression: cron || null,
          isDaemon,
          timerCondition,
          prNumbers,
          active: true,
        });
        queuedMeta = {
          kind: "schedule",
          scheduleIndex,
          title: summarizeText(promptText, 72) || "Scheduled check",
          cmd: promptText,
          isDaemon,
          isCron: Boolean(cron),
          timerCondition,
          prNumbers,
          ts: marker.ts,
        };
      } else if (name === "manage_task") {
        const manageAction = unquoteArg(args.Action).toLowerCase();
        queuedMeta = { kind: "manage_task", action: manageAction };
        if (manageAction === "kill") {
          const tid = unquoteArg(args.TaskId);
          if (tid && scheduleTaskMap.has(tid)) {
            sig.schedules[scheduleTaskMap.get(tid)].active = false;
          }
          if (tid && bgJobByTaskId.has(tid)) {
            const job = bgJobByTaskId.get(tid);
            job.status = "stopped";
            job.completedAt = marker.ts;
          }
        }
      } else if (name === "run_command") {
        const cmd = unquoteArg(args.CommandLine || args.commandLine || args.command);
        const cmdSummary = unquoteArg(args.toolSummary || args.Description);
        queuedMeta = {
          kind: "command",
          title: cmdSummary ? summarizeText(cmdSummary, 72) : summarizeText(cmd, 64),
          cmd,
          isDaemon: parseBoolArg(args.IsDaemon),
          isCron: false,
          ts: marker.ts,
        };
        const createdTitle = extractGhPrCreateTitle(cmd);
        if (createdTitle) pendingPrTitle = createdTitle;
        for (const prRef of extractPrReferences(cmd)) {
          upsertPrEntry(sig.prs, prRef, { ts: marker.ts });
        }
        if (/\bsetup-banner\.mjs\b/i.test(cmd)) sig.setupAt = latestMarker(sig.setupAt, marker);
        if (/\barch-audit\.mjs\b/i.test(cmd)) {
          sig.cleanAt = latestMarker(sig.cleanAt, marker);
          sig.detected.add("/audit-architecture");
        }
        if (/\bpr-dossier\.mjs\b/i.test(cmd)) {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
          sig.detected.add("pr-dossier.mjs");
        }
        if (/\bwatch-pr\.mjs\b/i.test(cmd)) {
          sig.babysitAt = latestMarker(sig.babysitAt, marker);
          sig.detected.add("watch-pr.mjs");
        }
        if (/\bworktree-audit\.mjs\b/i.test(cmd)) sig.detected.add("/astack-mode prune worktrees");
        if (/\bstatechart\.mjs\b/i.test(cmd)) sig.detected.add("/statechart");
        if (/\blog\.mjs\b/i.test(cmd)) sig.detected.add("/show-me-your-work");
        if (/\b(?:gh\s+pr\s+create|git\s+push)\b/i.test(cmd)) sig.pushOrPrAt = latestMarker(sig.pushOrPrAt, marker);
        const category = classifyCommandCategory(cmd);
        if (category === "test" || category === "verify") {
          pendingTestCmds.set(order, { marker, cmd });
        }
      } else if (name === "call_mcp_tool") {
        const mcpTool = unquoteArg(args.ToolName);
        if (mcpTool === "create_pull_request") {
          sig.pushOrPrAt = latestMarker(sig.pushOrPrAt, marker);
        } else if (mcpTool === "compile_pr_dossier") {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
          sig.detected.add("pr-dossier.mjs");
        }
      } else if (name === "mcp_astack_trust_compile_pr_dossier") {
        sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        sig.detected.add("pr-dossier.mjs");
      }
      pendingToolQueue.push(queuedMeta);
    }
  }

  for (const sa of sig.subagents) {
    if (sa.status === "failed") continue;
    const saMarker = subagentMarkers.get(sa);
    if (!saMarker) continue;
    if (sa.type === "comment-sicko") {
      sig.cleanAt = latestMarker(sig.cleanAt, saMarker);
      sig.detected.add("/no-comments");
    } else if (sa.type === "pr-verifier") {
      sig.reviewPrAt = latestMarker(sig.reviewPrAt, saMarker);
      sig.detected.add("pr-verifier");
    } else if (sa.type === "browser") {
      sig.verifyRunAt = latestMarker(sig.verifyRunAt, saMarker);
      sig.detected.add("/control-ui");
      sig.detected.add("/browser");
    }
  }

  sig.backgroundJobs = [...bgJobByTaskId.values()];
  return sig;
}

function parseTranscriptCached(transcriptPath, brainConvDir, workspaceDir, brainDir = "") {
  if (!transcriptPath) return makeEmptyTranscriptSignals();
  let st;
  try {
    st = fs.statSync(transcriptPath, { bigint: true });
  } catch {
    return makeEmptyTranscriptSignals();
  }
  const cacheKey = `${transcriptPath}|${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}|${workspaceDir}|${brainConvDir}|${brainDir}`;
  const cached = transcriptCache.get(cacheKey);
  if (cached) {
    return cloneTranscriptSignals(cached);
  }
  const parsed = parseTranscriptRaw(transcriptPath, brainConvDir, workspaceDir, brainDir);
  if (transcriptCache.size >= MAX_TRANSCRIPT_CACHE_ENTRIES) {
    const oldestKey = transcriptCache.keys().next().value;
    if (oldestKey !== undefined) transcriptCache.delete(oldestKey);
  }
  transcriptCache.set(cacheKey, parsed);
  return cloneTranscriptSignals(parsed);
}

function mergeUnreferencedTaskLogs(sig, brainConvDir) {
  if (!brainConvDir) return;
  const tasksDir = path.join(brainConvDir, ".system_generated", "tasks");
  try {
    if (!fs.existsSync(tasksDir)) return;
    const knownLogs = new Set(sig.backgroundJobs.map((j) => j.logFile).filter(Boolean));
    const bySlug = new Map(sig.backgroundJobs.map((j) => [j.taskSlug, j]));
    for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^task-\d+\.log$/.test(entry.name) || knownLogs.has(entry.name)) continue;
      const slug = entry.name.replace(/\.log$/, "");
      const safeLog = resolveSafeTaskLogPath(brainConvDir, entry.name);
      if (!safeLog) continue;
      const existing = bySlug.get(slug);
      if (existing) {
        existing.logFile = entry.name;
        knownLogs.add(entry.name);
        continue;
      }
      const mtime = fs.statSync(safeLog).mtime.toISOString();
      const job = {
        id: `bg-${sig.backgroundJobs.length}`,
        taskId: slug,
        taskSlug: slug,
        logFile: entry.name,
        kind: "command",
        stageId: "build",
        title: slug,
        summary: slug,
        command: "",
        startedAt: mtime,
        completedAt: mtime,
        status: "done",
        isDaemon: false,
        isCron: false,
      };
      sig.backgroundJobs.push(job);
      bySlug.set(slug, job);
      knownLogs.add(entry.name);
    }
  } catch {
  }
}

function analyzeTranscript(transcriptPath, brainConvDir, workspaceDir, brainDir = "") {
  const sig = parseTranscriptCached(transcriptPath, brainConvDir, workspaceDir, brainDir);
  mergeUnreferencedTaskLogs(sig, brainConvDir);

  for (const sa of sig.subagents) {
    if (sa.status === "running" && sa.childConvId && brainDir) {
      const childConvDir = path.join(brainDir, sa.childConvId);
      const childTranscript = path.join(childConvDir, ".system_generated", "logs", "transcript.jsonl");
      const childSig = parseTranscriptCached(childTranscript, childConvDir, workspaceDir, brainDir);
      const doneRes = childSig.terminalDoneAt;
      if (doneRes) {
        sa.status = "done";
        sa.completedAt = typeof doneRes === "string" ? doneRes : sa.startedAt;
      }
    }
  }

  return sig;
}

function mergeChildTranscriptSignals(sig, brainDir, workspaceDir, parentConvId) {
  if (!brainDir || sig.childConvIds.size === 0) return sig;
  const mergeKeys = ["cleanAt", "verifyRunAt", "latestCodeWriteAt", "latestWorkspaceWriteAt", "walkthroughWrittenAt"];
  for (const childId of sig.childConvIds) {
    if (!childId || childId === parentConvId) continue;
    const childConvDir = path.join(brainDir, childId);
    const childTranscript = path.join(childConvDir, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(childTranscript)) continue;
    const childSig = analyzeTranscript(childTranscript, childConvDir, workspaceDir, brainDir);
    for (const key of mergeKeys) {
      sig[key] = latestMarker(sig[key], childSig[key]);
    }
    sig.earliestWorkspaceWriteAt = earliestMarker(sig.earliestWorkspaceWriteAt, childSig.earliestWorkspaceWriteAt);
    for (const d of childSig.detected) {
      sig.detected.add(d);
    }
    for (const f of childSig.changedFiles) {
      sig.changedFiles.add(f);
    }
    for (const childPr of childSig.prs.values()) {
      upsertPrEntry(sig.prs, childPr);
    }
    for (const cmd of childSig.colleagueReview?.commands ?? []) {
      sig.colleagueReview.commands.add(cmd);
    }
    if (childSig.colleagueReview?.queueReview) sig.colleagueReview.queueReview = true;
    if (childSig.colleagueReview?.stackReview) sig.colleagueReview.stackReview = true;
    for (const childTargetPr of childSig.colleagueReview?.targetPrs?.values() ?? []) {
      upsertPrEntry(sig.colleagueReview.targetPrs, childTargetPr);
    }
    for (const failedCmd of childSig.failedVerifyCmds ?? []) {
      sig.failedVerifyCmds.push({ ...failedCmd });
    }
  }
  return sig;
}

function loadConversationTrust(brainConvDir, workspaceDir, conversationId, childConvIds, headSha, sig) {
  const convTrustDir = brainConvDir ? resolveTrustDir({ artifactDir: brainConvDir }) : null;
  const repoTrustDir = workspaceDir ? resolveTrustDir({ workspaceDir }) : null;

  const actorIds = new Set(childConvIds);
  if (conversationId) actorIds.add(conversationId);

  const merged = [];
  const seen = new Set();
  const addReceipts = (list, filterActors) => {
    for (const r of list) {
      if (filterActors && actorIds.size > 0 && !actorIds.has(r.conversationId)) continue;
      const key = `${r.ts}|${r.conversationId}|${r.kind}|${r.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
  };

  if (convTrustDir) addReceipts(readMergedReceipts(convTrustDir), false);
  if (repoTrustDir && repoTrustDir !== convTrustDir) {
    addReceipts(readMergedReceipts(repoTrustDir), Boolean(conversationId));
  }
  merged.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));

  const convEvidence = convTrustDir ? readEvidenceSnapshot(convTrustDir) : null;
  const repoEvidence = repoTrustDir && repoTrustDir !== convTrustDir ? readEvidenceSnapshot(repoTrustDir) : null;
  let evidence = convEvidence;
  if (!evidence && repoEvidence) {
    const sameHead = !headSha || repoEvidence.headSha === headSha;
    const afterStart = !sig.startedAt || !repoEvidence.generatedAt || repoEvidence.generatedAt >= sig.startedAt;
    if (sameHead && (afterStart || Boolean(sig.reviewPrAt))) {
      evidence = repoEvidence;
    }
  }

  return { receipts: merged, evidence };
}

function buildArtifactRef(brainConvDir, filename) {
  const uri = resolveSafeArtifactUri(brainConvDir, filename);
  return uri ? { name: filename, uri } : null;
}

function buildSetupReadiness(setup, sig) {
  const ranInSession = Boolean(sig.setupAt);
  const ready = Boolean(setup.configured || ranInSession);
  const status = ready ? "ready" : setup.workspaceKnown ? "needs_setup" : "unknown";
  const parts = [];
  if (setup.verifySkills.length > 0) parts.push(`verify: ${setup.verifySkills.join(", ")}`);
  if (setup.policies.length > 0) parts.push(`policies: ${setup.policies.join(", ")}`);

  const detail = parts.length > 0
    ? parts.join(" · ")
    : ranInSession
      ? "Setup ran in this session."
      : setup.workspaceKnown
        ? "No verify-<app> skill or repo policy files detected yet."
        : "Open a workspace conversation to check setup readiness.";

  const summary = status === "ready"
    ? detail
    : status === "needs_setup"
      ? "Run /setup-astack once in this repo to scaffold verification skills and guardrails."
      : "Open a workspace conversation to inspect setup readiness.";

  const commands = status === "ready"
    ? [
        makeCommandItem("/setup-astack", "done"),
        makeCommandItem("/maintain-verification-skill", sig.detected.has("/maintain-verification-skill") ? "done" : "pending", true),
      ]
    : [makeCommandItem("/setup-astack", status === "needs_setup" ? "next" : "pending")];

  return {
    workspaceKnown: setup.workspaceKnown,
    configured: ready,
    ranInSession,
    status,
    summary,
    detail,
    verifySkills: setup.verifySkills,
    policies: setup.policies,
    commands,
  };
}

function buildPlanStage({
  hasConv,
  setupState,
  sig,
  planArtifact,
  planWrittenMarker,
  latestAnyWrite,
  planClearedByDownstream,
  downstreamProgressed,
}) {
  const editsAfterPlan = Boolean(planWrittenMarker && latestAnyWrite && isMarkerAfter(latestAnyWrite, planWrittenMarker));
  const diskPlanApproved = Boolean(!sig.planWrittenAt && planArtifact && sig.approvalIntentAt);
  const explicitApproved = Boolean(
    (sig.planApprovedAt && (!planWrittenMarker || isMarkerAfter(sig.planApprovedAt, planWrittenMarker))) ||
      diskPlanApproved ||
      editsAfterPlan,
  );
  const planApproved = Boolean(explicitApproved || planClearedByDownstream);
  const grillMe = Boolean(sig.grillMeAt || (sig.planContractAt && sig.askQuestionAt));
  const triggered = Boolean(sig.planCmdAt || sig.planContractAt || planWrittenMarker);

  let status = "pending";
  let skippedReason = null;
  if (planWrittenMarker && planApproved) status = "done";
  else if (planWrittenMarker) status = "waiting_gate";
  else if ((Boolean(latestAnyWrite) || downstreamProgressed) && !triggered && !grillMe) {
    status = "skipped";
    skippedReason = downstreamProgressed && !latestAnyWrite ? "earlier" : "direct";
  } else if (triggered || grillMe) status = "active";
  else if (!hasConv) status = setupState.status === "ready" ? "next" : "pending";
  else if (setupState.status !== "needs_setup") status = "next";

  const detail = status === "waiting_gate"
    ? "implementation_plan.md staged. Review and click Proceed when ready, or continue directly."
    : status === "done"
      ? explicitApproved
        ? "Plan approved and execution started."
        : "Plan completed; work progressed to later stages."
      : status === "skipped"
        ? skippedReason === "earlier"
          ? "Optional — started directly on an existing PR."
          : "Skipped for direct edit flow."
        : status === "active"
          ? grillMe
            ? "Clarifying requirements via /grill-me."
            : "Planning in progress — drafting implementation_plan.md."
          : "Optional written plan before editing code.";

  return {
    ...TIMELINE_STEPS[0],
    status,
    ...(skippedReason ? { skippedReason } : {}),
    commands: [
      makeCommandItem("/plan", planWrittenMarker ? "done" : status === "active" ? "active" : status === "next" ? "next" : "pending"),
      makeCommandItem("/grill-me", grillMe ? "done" : "pending", true),
    ],
    subChecks: [],
    detail,
    artifact: planArtifact,
  };
}

function buildBuildStage({
  planStatus,
  sig,
  hasEdits,
  hasCodeEdits,
  cleanDone,
  cleanFresh,
  verifyDone,
  verifyFresh,
  reviewStarted,
  reviewFresh,
  walkthroughArtifact,
  shipped,
}) {
  const planningActive = (planStatus === "active" || planStatus === "waiting_gate") && !hasEdits;
  const astackModeActive = !planningActive && Boolean(sig.astackModeAt || hasEdits);
  const walkthroughComplete = Boolean(walkthroughArtifact);
  const hasBuildableWork = Boolean(hasEdits || walkthroughComplete || (reviewStarted && reviewFresh));
  const shippedWalkthroughDone = Boolean(walkthroughComplete && shipped && !hasEdits);
  let status = "pending";
  let skippedReason = null;
  if (!planningActive) {
    if (verifyFresh && hasBuildableWork && (!hasCodeEdits || cleanFresh || walkthroughComplete || (reviewStarted && reviewFresh))) status = "done";
    else if (shippedWalkthroughDone) status = "done";
    else if (astackModeActive || Boolean(sig.interrogateAt) || cleanDone || (verifyDone && hasEdits)) status = "active";
    else if (reviewStarted || shipped) {
      status = "skipped";
      skippedReason = "earlier";
    } else if (planStatus === "done" || planStatus === "skipped") status = "next";
  }

  const editsStatus = hasEdits ? "done" : "pending";
  const cleanStatus = !planningActive && cleanDone && cleanFresh ? "done" : "pending";
  const verifyStatus = !planningActive && hasBuildableWork && verifyFresh ? "done" : "pending";
  const subChecks = [
    {
      id: "edits",
      label: "edits",
      status: editsStatus,
      detail: hasEdits
        ? hasCodeEdits
          ? "Code and workspace edits recorded in this session."
          : "Documentation or non-code edits recorded in this session."
        : "No workspace file edits recorded yet.",
    },
    {
      id: "clean",
      label: "clean",
      status: cleanStatus,
      detail: cleanStatus === "done"
        ? "Cleanup (/deslop or /no-comments) ran after the latest code edit."
        : hasCodeEdits
          ? "Waiting for /deslop or /no-comments on your code diff."
          : "Optional for doc-only changes; runs /deslop or /no-comments on code diffs.",
    },
    {
      id: "verify",
      label: "verify",
      status: verifyStatus,
      detail: verifyStatus === "done"
        ? "Tests, build, or validation passed after the latest edit."
        : "Waiting for tests, lint, build, or live verification after edits.",
    },
  ];
  const detail = status === "done"
    ? hasCodeEdits && cleanFresh
      ? "Code edits cleaned and verified on HEAD."
      : hasEdits && !hasCodeEdits
        ? "Documentation edits verified on HEAD."
        : shippedWalkthroughDone && !verifyFresh
          ? "Walkthrough recorded and PR already shipped."
          : walkthroughComplete
            ? "Edits verified on HEAD with walkthrough recorded."
            : "Changes verified on HEAD for PR review."
    : status === "skipped"
      ? "Optional — reviewing or iterating on an existing PR."
      : status === "active"
        ? "Running build, cleanup, and live verification."
        : "Run /astack-mode with your goal and done check.";

  return {
    ...TIMELINE_STEPS[1],
    status,
    ...(skippedReason ? { skippedReason } : {}),
    commands: [
      makeCommandItem(
        "/astack-mode",
        status === "done" ? "done" : astackModeActive ? "active" : status === "next" ? "next" : "pending",
      ),
      makeCommandItem("/interrogate", sig.interrogateAt ? "done" : "pending", true),
    ],
    subChecks,
    detail,
    artifact: walkthroughArtifact,
  };
}

function buildReviewStage({
  buildStatus,
  reviewStarted,
  staleFromReceipts,
  reviewFresh,
  reviewArtifact,
  evidence,
  maxReviewRounds,
  shipped,
  shipActive,
  prVerifierRunning,
  reviewAfterShip,
}) {
  const roundState = evidence?.roundState ?? "open";
  const reviewRound = evidence?.reviewRound ?? 0;
  const verdict = evidence?.verifier?.verdict ?? null;
  const reviewPass = verdict === "PASS" || verdict === "PASS_WITH_NOTES";

  let status = "pending";
  let skippedReason = null;
  if (roundState === "escalated") status = "error";
  else if (reviewStarted && staleFromReceipts) status = "stale";
  else if (reviewStarted && reviewFresh && (reviewArtifact || reviewPass)) {
    status = shipped || evidence?.autoMergeEligible ? "done" : "waiting_gate";
  } else if (reviewStarted && shipped && reviewFresh && !prVerifierRunning && !reviewAfterShip) {
    status = "done";
  } else if (reviewStarted) status = "active";
  else if (shipped || shipActive) {
    status = "skipped";
    skippedReason = "direct";
  } else if (buildStatus === "done") status = "next";

  const detail = roundState === "escalated"
    ? `Remediation hit ${reviewRound}/${maxReviewRounds} round cap. Human decision required.`
    : status === "stale"
      ? "New changes invalidated prior PR evidence. Re-run /pre-pr."
      : status === "waiting_gate"
        ? `Risk Tier ${evidence?.riskTier ?? 1} (${evidence?.riskLabel ?? "medium"}) · pr-verifier ${verdict ?? "pending"} (${reviewRound}/${maxReviewRounds}). Ready for your visual review.`
        : status === "done"
          ? reviewArtifact || reviewPass
            ? `Pre-PR check passed (Tier ${evidence?.riskTier ?? 1}).`
            : "Pre-PR check ran before push."
          : status === "skipped"
            ? "Skipped — moved directly to Ship."
            : "Compile pr-review.md and run isolated pr-verifier.";

  return {
    ...TIMELINE_STEPS[2],
    status,
    ...(skippedReason ? { skippedReason } : {}),
    commands: [
      makeCommandItem(
        "/pre-pr",
        status === "done" || status === "waiting_gate"
          ? "done"
          : status === "stale" || status === "error"
            ? "stale"
            : status === "active"
              ? "active"
              : status === "next"
                ? "next"
                : "pending",
      ),
    ],
    subChecks: [],
    detail,
    artifact: reviewArtifact,
  };
}

function buildShipStage({ reviewStatus, shipped, shipLive, openPrRequested = false, sig }) {
  let status = "pending";
  if (shipped) status = "done";
  else if (shipLive || openPrRequested) status = "active";
  else if (reviewStatus === "waiting_gate" || reviewStatus === "done") status = "next";

  const detail = shipped
    ? sig.babysitAt
      ? "PR opened or pushed; babysit tracking active."
      : "PR opened or pushed."
    : "Review local commits and open PR when ready.";

  return {
    ...TIMELINE_STEPS[3],
    status,
    commands: [
      makeCommandItem("/astack-mode open the pr", shipped ? "done" : status === "next" ? "next" : "pending"),
      makeCommandItem("/astack-mode babysit", sig.babysitAt ? "done" : "pending", true),
    ],
    subChecks: [],
    detail,
    artifact: null,
  };
}

function selectNextAction(stepViews, setupState) {
  const [plan, build, review, ship] = stepViews;
  if (review.status === "error") {
    return { stageId: "review", stageLabel: "Pre-PR Check", command: "/pre-pr", hint: review.detail };
  }
  if (review.status === "stale") {
    return { stageId: "review", stageLabel: "Pre-PR Check", command: "/pre-pr", hint: "Re-run PR dossier on updated HEAD." };
  }
  if (plan.status === "waiting_gate") {
    return { stageId: "plan", stageLabel: "Plan", command: "Proceed", hint: "Review implementation_plan.md and click Proceed." };
  }
  if (review.status === "waiting_gate") {
    return { stageId: "ship", stageLabel: "Ship", command: "/astack-mode open the pr", hint: "Inspect pr-review.md, then open the PR when ready." };
  }
  if (setupState.status === "needs_setup" && stepViews.every((s) => s.status === "pending")) {
    return {
      stageId: "setup",
      stageLabel: "First-time setup",
      command: "/setup-astack",
      hint: "Run once in this repo to scaffold verification skills and policies.",
    };
  }
  const current = stepViews.find((s) => s.status === "active") || stepViews.find((s) => s.status === "next");
  if (current) {
    return {
      stageId: current.id,
      stageLabel: current.label,
      command: current.primaryCommand,
      hint: current.detail,
      inProgress: current.status === "active",
    };
  }
  if (ship.status === "done" || stepViews.every((s) => s.status === "done" || s.status === "skipped")) {
    return null;
  }
  return {
    stageId: "plan",
    stageLabel: "Start",
    command: "/plan",
    hint: "Start a task with /plan or /astack-mode.",
  };
}

function computeLive(sig) {
  const agents = { plan: 0, build: 0, review: 0, ship: 0 };
  for (const sa of sig.subagents) {
    if (sa.status === "running" && sa.stageId in agents) agents[sa.stageId] += 1;
  }
  const working = sig.swarm.active
    ? sig.swarm.members.filter((m) => m.status === "working").length
    : 0;
  if (working) agents.build += working;
  const live = new Set(Object.keys(agents).filter((id) => agents[id] > 0));
  if (sig.workflow.active) live.add(sig.workflow.stageId ?? "build");
  return { liveStageIds: [...live], liveAgentsByStage: agents };
}

function resolveSuggestedStageId(nextAction, stepViews, liveSet) {
  if (!nextAction || nextAction.stageId === "setup") return null;
  if (!liveSet.has(nextAction.stageId)) return nextAction.stageId;
  const nextNonLive = stepViews.find((s) => s.status === "next" && !liveSet.has(s.id));
  if (nextNonLive) return nextNonLive.id;
  let lastProgIdx = -1;
  stepViews.forEach((s, i) => {
    if (s.status === "done" || s.status === "skipped" || liveSet.has(s.id)) lastProgIdx = i;
  });
  const afterProg = stepViews.find((s, i) => i > lastProgIdx && s.status === "pending");
  return afterProg ? afterProg.id : null;
}

function resolveMainTurnStageId(rawSteps, liveSet) {
  const activeOrStale = rawSteps.find((s) => s.status === "active" || s.status === "stale");
  if (activeOrStale) return activeOrStale.id;
  if (liveSet.size > 0) return null;
  const nextStage = rawSteps.find((s) => s.status === "next");
  return nextStage ? nextStage.id : null;
}

function computeRailState(stage, liveSet, suggestedStageId, { buildQueuedByPlan = false, shipQueuedByEarlier = false } = {}) {
  if (stage.status === "error") return "error";
  if (liveSet.has(stage.id)) return "running";
  switch (stage.status) {
    case "done": return "done";
    case "skipped": return "skipped";
    case "waiting_gate": return "yourturn";
    case "stale": return "stale";
    case "active": return "queued";
  }
  if (stage.id === "build" && buildQueuedByPlan) return "queued";
  if (stage.id === "ship" && shipQueuedByEarlier) return "queued";
  return stage.id === suggestedStageId ? "suggested" : "pending";
}

function buildStageStats(stage, {
  sig,
  activeSwarmMembers,
  workingSwarmCount,
  bgItems,
  unbackedSchedules,
  activeAutomations,
  openPrsCount,
  mergedPrsCount,
  closedPrsCount,
}) {
  const stageSubagents = sig.subagents.filter((a) => (a.stageId || "build") === stage.id);
  const swarmTotal = stage.id === "build" ? activeSwarmMembers.length : 0;
  const swarmRunning = stage.id === "build" ? workingSwarmCount : 0;
  const agents = {
    total: stageSubagents.length + swarmTotal,
    running: stageSubagents.filter((a) => a.status === "running").length + swarmRunning,
  };
  const prs = stage.id === "ship"
    ? { open: openPrsCount, merged: mergedPrsCount, closed: closedPrsCount }
    : { open: 0, merged: 0, closed: 0 };
  const fileArts = (stage.artifacts || []).filter((a) => a.kind !== "pr");
  const artifacts = {
    total: fileArts.length,
    updating: fileArts.filter((a) => a.status === "updating").length,
  };
  const stageBg = bgItems.filter((j) => (j.stageId || "build") === stage.id);
  const stageScheds = unbackedSchedules.filter((s) => (s.stageId || "build") === stage.id);
  const stageAutos = activeAutomations.filter((a) => (a.stageId || "build") === stage.id);
  const tasks = {
    total: stageBg.length + stageScheds.length + stageAutos.length,
    running: stageBg.filter((j) => j.status === "running").length + stageScheds.length + stageAutos.length,
  };
  return { agents, prs, artifacts, tasks };
}

function buildStageArtifacts(stage, { planArtifact, walkthroughArtifact, reviewArtifact, brainConvDir, pr, prs, shipped }) {
  if (stage.id === "plan") {
    if (!planArtifact) return [];
    const badge = stage.status === "done" ? "approved" : stage.status === "waiting_gate" ? "review" : "";
    return [{ id: "plan", key: "plan", name: planArtifact.name, label: "Implementation Plan", uri: planArtifact.uri, status: stage.status === "done" ? "done" : "updating", badge, kind: "file" }];
  }
  if (stage.id === "build") {
    const out = [];
    if (walkthroughArtifact) {
      out.push({
        id: "walk",
        key: "walk",
        name: walkthroughArtifact.name,
        label: "Walkthrough",
        uri: walkthroughArtifact.uri,
        status: stage.status === "done" ? "done" : "updating",
        badge: stage.status === "done" ? "ready" : "updating",
        kind: "file",
      });
    }
    return [...out, ...collectExtraBrainArtifacts(brainConvDir)];
  }
  if (stage.id === "review") {
    if (!reviewArtifact) return [];
    const status = stage.status === "stale" ? "stale" : stage.status === "done" ? "done" : "updating";
    const badge = stage.status === "stale" ? "stale" : stage.status === "waiting_gate" ? "review" : "";
    return [{ id: "review", key: "review", name: reviewArtifact.name, label: "PR review dossier", uri: reviewArtifact.uri, status, badge, kind: "file" }];
  }
  if (stage.id === "ship") {
    const prList = Array.isArray(prs) && prs.length > 0 ? prs : pr?.number ? [pr] : [];
    return prList.slice(0, 5).map((item) => {
      const state = item.state || (shipped ? "open" : "open");
      const status = state === "merged" ? "merged" : state === "closed" ? "stale" : "open";
      const badge = state === "merged" ? "merged" : state === "closed" ? "closed" : shipped ? "open" : "tracked";
      return {
        id: `pr-${item.number}`,
        key: `pr-${item.number}`,
        name: `PR #${item.number}`,
        label: `PR #${item.number}`,
        title: item.title || null,
        uri: item.url || null,
        status,
        badge,
        kind: "pr",
      };
    });
  }
  return [];
}

function buildStageCollapsedSummary(stage, pr, prs, shipped, { railState = null, liveAgents = 0 } = {}) {
  const withLiveAgents = (base) => {
    if (railState !== "running" || liveAgents <= 0) return base;
    const noun = liveAgents === 1 ? "subagent" : "subagents";
    return `${base.replace(/\.$/, "")} · ${liveAgents} ${noun}`;
  };
  if (stage.id === "plan") {
    if (railState === "running") return withLiveAgents("Drafting implementation plan.");
    if (stage.status === "done") return "Plan completed.";
    if (stage.status === "waiting_gate") return "implementation_plan.md ready for review.";
    if (stage.status === "skipped") {
      return stage.skippedReason === "earlier" ? "Not needed — started at PR review." : "Skipped for direct edit flow.";
    }
    if (stage.status === "active") return withLiveAgents("Drafting implementation plan.");
    return withLiveAgents(stage.summary);
  }
  if (stage.id === "build") {
    if (railState === "running") return withLiveAgents("Running build, cleanup, and verification.");
    if (stage.status === "done") return "Cleaned and verified on HEAD.";
    if (stage.status === "skipped") return "Completed earlier or not needed for this flow.";
    return stage.summary;
  }
  if (stage.id === "review") {
    if (railState === "running") {
      return liveAgents > 0 ? withLiveAgents("pr-verifier checking HEAD.") : "Compiling PR dossier and verifying HEAD.";
    }
    if (stage.status === "stale") return "Your latest edits came after the last Pre-PR check.";
    if (stage.status === "waiting_gate") return "Ready for your visual review.";
    if (stage.status === "error") return stage.detail;
    if (stage.status === "done") return "Pre-PR check passed.";
    if (stage.status === "skipped") return "Skipped — moved directly to Ship.";
    return stage.summary;
  }
  if (stage.id === "ship") {
    if (railState === "running") return withLiveAgents("Preparing PR and shipping checks.");
    if (Array.isArray(prs) && prs.length > 1 && shipped) {
      const openN = prs.filter((p) => p.state === "open").length;
      const mergedN = prs.filter((p) => p.state === "merged").length;
      const parts = [];
      if (openN > 0) parts.push(`${openN} open`);
      if (mergedN > 0) parts.push(`${mergedN} merged`);
      return parts.length > 0 ? `${prs.length} PRs (${parts.join(", ")}).` : `${prs.length} PRs tracked.`;
    }
    if (pr?.number && shipped) {
      return pr.state === "merged" ? `PR #${pr.number} merged.` : `PR #${pr.number} opened.`;
    }
    if (shipped) return "PR opened or pushed.";
    return stage.summary;
  }
  return stage.summary;
}

function buildSuggestedReview(reviewStage, changedFilesCount, { shipped = false } = {}) {
  if (reviewStage.status === "done" || reviewStage.status === "skipped") {
    return null;
  }
  if (shipped && reviewStage.status !== "stale" && reviewStage.status !== "active") {
    return null;
  }
  if (reviewStage.status !== "stale" && reviewStage.status !== "next" && changedFilesCount < 2) {
    return null;
  }
  const countPart = changedFilesCount > 0 ? `${changedFilesCount} ` : "";
  return {
    fileCount: changedFilesCount,
    summary: `review the ${countPart}changed files in parallel with`,
    command: "/run-workflow",
    prompt: `/run-workflow Review the ${countPart}changed files on this branch in parallel, one reviewer per file, then run pr-verifier once on HEAD and log a one-line verdict per file.`,
  };
}

const DEFECT_RISK_SIGNALS = new Set([
  "test_regression",
  "deletes_assertions",
  "bundled_sidecar_permissions",
  "scope_drift",
]);

function buildRiskPresentation(riskAssessment, { prItems = [], reviewStage = null } = {}) {
  if (!riskAssessment) return null;
  const scoreNum = Number(riskAssessment.score ?? 0);
  const scoreText = scoreNum.toFixed(2);
  const whyItems = (riskAssessment.signals || []).map((s) => ({
    id: s.id,
    weightPct: Math.round((s.weight ?? 0) * 100),
    evidence: String(s.evidence ?? "").trim(),
    isDefect: DEFECT_RISK_SIGNALS.has(s.id),
    isHard: s.id === "touches_governance" || DEFECT_RISK_SIGNALS.has(s.id),
  }));
  const rollbackCommand =
    riskAssessment.rollback?.kind &&
    riskAssessment.rollback.kind !== "none" &&
    riskAssessment.rollback?.plan
      ? String(riskAssessment.rollback.plan).trim()
      : null;
  const mergedPrs = prItems.filter((p) => p.state === "merged");
  const allMerged =
    prItems.length > 0 &&
    mergedPrs.length === prItems.length &&
    reviewStage?.status === "done";
  const hasDefect = whyItems.some((s) => s.isDefect) || reviewStage?.status === "error";

  if (allMerged) {
    return {
      mode: "resolved_merged",
      tone: "done",
      headerBadge: `Merged · R ${scoreText}`,
      headline:
        mergedPrs.length === 1
          ? `Reviewed & merged (PR #${mergedPrs[0].number})`
          : `Reviewed & merged (${mergedPrs.length} PRs)`,
      nextHint: "No action needed. Checks and human review finished before merge.",
      whyItems,
      rollbackCommand,
    };
  }
  if (
    hasDefect ||
    (riskAssessment.residual === "blocked" && !whyItems.some((s) => s.id === "touches_governance"))
  ) {
    return {
      mode: "defect_blocked",
      tone: "err",
      headerBadge: null,
      headline: `Action needed (R ${scoreText})`,
      nextHint: "Fix the flagged issue above and re-run verification on HEAD.",
      whyItems,
      rollbackCommand,
    };
  }
  if (
    riskAssessment.residual === "blocked" ||
    riskAssessment.residual === "high" ||
    riskAssessment.residual === "medium"
  ) {
    return {
      mode: "human_gate",
      tone: "warn",
      headerBadge: Number(riskAssessment.tier ?? 0) >= 3 ? `Review gate · R ${scoreText}` : null,
      headline: `Human review required (R ${scoreText})`,
      nextHint: "Inspect the PR dossier, then approve or merge when satisfied.",
      whyItems,
      rollbackCommand,
    };
  }
  return {
    mode: "low_ok",
    tone: "neutral",
    headerBadge: null,
    headline: `Low risk (R ${scoreText})`,
    nextHint: null,
    whyItems,
    rollbackCommand,
  };
}

function buildActivitySnapshot({
  sig,
  buildStage,
  reviewStage,
  artifactCount,
  liveInfo,
  suggestedStageId,
  prItems,
  sharedCounts,
  shipped,
}) {
  const {
    activeSubagentsCount,
    doneSubagentsCount,
    activeSwarmMembers,
    workingSwarmCount,
    activeSchedules,
    activeAutomations,
    bgItems,
    unbackedSchedules,
    runningBgCount,
    openPrsCount,
    mergedPrsCount,
    closedPrsCount,
  } = sharedCounts;
  const checksDone = buildStage.subChecks.filter((c) => c.status === "done").length;
  const checksTotal = buildStage.subChecks.length || 3;

  return {
    liveStageIds: liveInfo.liveStageIds,
    liveAgentsByStage: liveInfo.liveAgentsByStage,
    suggestedStageId,
    agentsWorkingCount: activeSubagentsCount + workingSwarmCount,
    agentsTotalCount: sig.subagents.length + activeSwarmMembers.length,
    scheduledCount: activeSchedules.length + activeAutomations.length,
    runningTasksCount: runningBgCount + unbackedSchedules.length + activeAutomations.length,
    tasksTotalCount: bgItems.length + unbackedSchedules.length + activeAutomations.length,
    artifactCount,
    goal: {
      ...sig.goal,
      checksDone,
      checksTotal,
      checkInNextAt: activeSchedules.find((s) => s.stageId === "build")?.nextAt ?? null,
    },
    boost: sig.boost,
    teamwork: sig.teamwork,
    swarm: {
      active: sig.swarm.active,
      title: sig.swarm.title,
      posts: sig.swarm.posts,
      workingCount: workingSwarmCount,
      totalCount: activeSwarmMembers.length,
      members: activeSwarmMembers,
      sparks: sig.swarm.sparks,
    },
    subagents: sig.subagents,
    runningSubagentsCount: activeSubagentsCount,
    totalSubagentsCount: sig.subagents.length,
    doneSubagentsCount,
    schedules: sig.schedules,
    automations: sig.automations,
    backgroundJobs: {
      count: bgItems.length,
      runningCount: runningBgCount,
      items: bgItems,
    },
    workflow: {
      active: sig.workflow.active,
      runsCount: sig.workflow.runsCount,
      stageId: sig.workflow.stageId ?? null,
      suggestedReview: buildSuggestedReview(reviewStage, sig.changedFiles.size, { shipped }),
    },
    sideQuestions: { count: sig.sideQuestionsCount },
    changedFilesCount: sig.changedFiles.size,
    pr: sig.pr,
    prs: {
      totalCount: prItems.length,
      openCount: openPrsCount,
      mergedCount: mergedPrsCount,
      closedCount: closedPrsCount,
      items: prItems,
    },
  };
}

/**
 * Projects workspace readiness, transcript signals, and trust ledger receipts into the 4-step AStack timeline.
 */
export function evaluateTimelineSnapshot({
  conversationId = "",
  brainDir = "",
  workspaceDir = "",
  prMetaByNumber = null,
  dataDir = null,
  nowMs = Date.now(),
} = {}) {
  const hasConv = Boolean(conversationId && brainDir);
  const brainConvDir = hasConv ? path.join(brainDir, conversationId) : "";
  const transcriptPath = hasConv
    ? path.join(brainConvDir, ".system_generated", "logs", "transcript.jsonl")
    : "";

  const setup = inspectSetupReadiness(workspaceDir);
  const { workspaceScope, policyResult } = resolveWorkspacePolicyCached(workspaceDir);
  const sig = mergeChildTranscriptSignals(
    analyzeTranscript(transcriptPath, brainConvDir, workspaceDir, brainDir),
    brainDir,
    workspaceDir,
    conversationId,
  );
  const { receipts, evidence } = loadConversationTrust(
    brainConvDir,
    workspaceDir,
    conversationId,
    sig.childConvIds,
    setup.headSha,
    sig,
  );

  const planArtifact = buildArtifactRef(brainConvDir, "implementation_plan.md");
  const reviewArtifact = buildArtifactRef(brainConvDir, "pr-review.md");
  const walkthroughArtifact = buildArtifactRef(brainConvDir, "walkthrough.md");

  let planWrittenMarker = sig.planWrittenAt;
  if (!planWrittenMarker && planArtifact) {
    try {
      const mtime = fs.statSync(path.join(brainConvDir, "implementation_plan.md")).mtime.toISOString();
      planWrittenMarker = makeMarker(mtime, 0);
    } catch {
      planWrittenMarker = makeMarker(null, 0);
    }
  }

  let walkthroughMarker = sig.walkthroughWrittenAt;
  if (!walkthroughMarker && walkthroughArtifact) {
    try {
      const mtime = fs.statSync(path.join(brainConvDir, "walkthrough.md")).mtime.toISOString();
      walkthroughMarker = makeMarker(mtime, 0);
    } catch {
      walkthroughMarker = makeMarker(null, 0);
    }
  }

  let latestCodeWrite = sig.latestCodeWriteAt;
  let latestAnyWrite = sig.latestWorkspaceWriteAt;
  let earliestAnyWrite = sig.earliestWorkspaceWriteAt;
  let latestReceiptVerify = null;
  let latestReceiptClean = null;
  let hadReceiptWrite = false;
  let hasVerifyReceipt = false;
  let receiptPush = false;
  let receiptPushMarker = null;

  const effectiveReceipts = receipts.filter((r) => !isFailedTranscriptVerifyReceipt(r, sig.failedVerifyCmds));

  for (const r of effectiveReceipts) {
    const m = makeMarker(r.ts, Number.MAX_SAFE_INTEGER);
    if (r.kind === "file_write") {
      const workspacePaths = Array.isArray(r.paths)
        ? r.paths.filter((p) => isWorkspaceFileTarget(p, workspaceDir, brainConvDir, brainDir))
        : [];
      if (Array.isArray(r.paths) && r.paths.length > 0 && workspacePaths.length === 0) continue;
      hadReceiptWrite = true;
      latestAnyWrite = latestMarker(latestAnyWrite, m);
      earliestAnyWrite = earliestMarker(earliestAnyWrite, m);
      for (const wp of workspacePaths) sig.changedFiles.add(normalizePosix(wp));
      const allDocs = workspacePaths.length > 0 && workspacePaths.every((p) => DOC_EXT_RE.test(p));
      if (!allDocs) latestCodeWrite = latestMarker(latestCodeWrite, m);
    } else if (isVerifyReceipt(r)) {
      hasVerifyReceipt = true;
      if (r.ok) latestReceiptVerify = latestMarker(latestReceiptVerify, m);
    } else if (r.kind === "command" && r.ok) {
      for (const prRef of extractPrReferences(r.summary)) {
        upsertPrEntry(sig.prs, prRef, { ts: r.ts });
      }
      if (/\b(?:gh\s+pr\s+create|git\s+push)\b/i.test(r.summary)) {
        receiptPush = true;
        receiptPushMarker = latestMarker(receiptPushMarker, m);
      }
    }
    if (r.kind === "command" && r.ok && /\barch-audit\.mjs\b/i.test(String(r.summary ?? ""))) {
      latestReceiptClean = latestMarker(latestReceiptClean, m);
    }
  }

  const hasEdits = Boolean(hadReceiptWrite || latestAnyWrite);
  const hasCodeEdits = Boolean(latestCodeWrite);
  const receiptFreshness = effectiveReceipts.length > 0
    ? computeFreshness({
        receipts: effectiveReceipts,
        headSha: setup.headSha,
        priorEvidence: evidence,
        requirePostEditVerify: hasEdits,
      })
    : evidence?.freshness ?? "missing_receipts";

  const effectiveCleanAt = latestMarker(sig.cleanAt, latestReceiptClean);
  const cleanDone = Boolean(effectiveCleanAt);
  const cleanFresh = cleanDone && (!latestCodeWrite || !isMarkerAfter(latestCodeWrite, effectiveCleanAt));
  const latestVerify = latestMarker(latestReceiptVerify, sig.verifyRunAt);
  const hasPostEditVerify = Boolean(latestVerify && (!earliestAnyWrite || isMarkerAfter(latestVerify, earliestAnyWrite)));
  const verifyDone = Boolean(latestVerify || (evidence && (evidence.freshness === "fresh" || evidence.freshness === "fresh_rebase_patch_id")));
  const verifyFreshFromReceipts = receiptFreshness === "fresh" || receiptFreshness === "fresh_rebase_patch_id";
  const verifyFreshFromTranscript = Boolean(sig.verifyRunAt && (!latestCodeWrite || !isMarkerAfter(latestCodeWrite, sig.verifyRunAt)));
  const verifyFresh = hasVerifyReceipt
    ? verifyFreshFromReceipts && (!latestCodeWrite || !isMarkerAfter(latestCodeWrite, latestVerify))
    : Boolean(verifyFreshFromTranscript || (evidence && verifyFreshFromReceipts));

  const staleFromReceipts = hasEdits && hasPostEditVerify && (receiptFreshness === "dirty_after_verify" || receiptFreshness === "stale_sha");
  const reviewStarted = Boolean(sig.reviewPrAt || reviewArtifact || evidence?.verifier?.verdict);
  const reviewRound = evidence?.reviewRound ?? 0;
  const maxReviewRounds = evidence?.maxReviewRounds ?? policyResult.policy.maxReviewRounds ?? 3;
  const reviewFresh = !staleFromReceipts && (!evidence?.freshness || evidence.freshness === "fresh" || evidence.freshness === "fresh_rebase_patch_id");
  const reviewPassFresh = Boolean(
    reviewFresh && (evidence?.verifier?.verdict === "PASS" || evidence?.verifier?.verdict === "PASS_WITH_NOTES"),
  );
  const effectiveCleanFresh = cleanDone && (cleanFresh || Boolean(verifyFresh && reviewPassFresh && !staleFromReceipts));
  const shipped = Boolean(sig.pushOrPrAt || receiptPush);
  const latestPushMarker = latestMarker(sig.pushOrPrAt, receiptPushMarker);
  const latestDownstreamMarker = latestMarker(latestMarker(walkthroughMarker, sig.reviewPrAt), latestPushMarker);
  const downstreamProgressed = Boolean(walkthroughArtifact || reviewStarted || shipped);
  const planClearedByDownstream = Boolean(
    downstreamProgressed &&
      (!sig.planWrittenAt || !latestDownstreamMarker || !isMarkerAfter(sig.planWrittenAt, latestDownstreamMarker)),
  );
  const prVerifierRunning = sig.subagents.some((sa) => sa.type === "pr-verifier" && sa.status === "running");
  const reviewAfterShip = Boolean(sig.reviewPrAt && latestPushMarker && isMarkerAfter(sig.reviewPrAt, latestPushMarker));

  const setupState = buildSetupReadiness(setup, sig);
  if (setup.verifySkills.some((s) => !s.endsWith("-formal"))) sig.detected.add("/create-verification-skill");
  if (setup.verifySkills.some((s) => s.endsWith("-formal"))) sig.detected.add("/create-formal-verification-skill");
  if (evidence) sig.detected.add("pr-dossier.mjs");
  if (evidence?.verifier?.verdict) sig.detected.add("pr-verifier");
  Object.assign(
    setupState,
    buildStageSubCommands("setup", sig.detected, new Set((setupState.commands || []).map((c) => c.command))),
  );

  const liveInfo = computeLive(sig);
  const liveSet = new Set(liveInfo.liveStageIds);
  const planStage = buildPlanStage({
    hasConv,
    setupState,
    sig,
    planArtifact,
    planWrittenMarker,
    latestAnyWrite,
    planClearedByDownstream,
    downstreamProgressed,
  });
  const buildStage = buildBuildStage({
    planStatus: planStage.status,
    sig,
    hasEdits,
    hasCodeEdits,
    cleanDone,
    cleanFresh: effectiveCleanFresh,
    verifyDone,
    verifyFresh,
    reviewStarted,
    reviewFresh,
    walkthroughArtifact,
    shipped,
  });
  const buildInProgress = buildStage.status === "active" || buildStage.status === "stale";
  const reviewStage = buildReviewStage({
    buildStatus: buildStage.status,
    reviewStarted,
    staleFromReceipts,
    reviewFresh,
    reviewArtifact,
    evidence,
    maxReviewRounds,
    shipped,
    shipActive: Boolean(liveSet.has("ship") || (sig.openPrAt && !buildInProgress)),
    prVerifierRunning,
    reviewAfterShip,
  });
  const mergedPrNumbers = sig.prs.size > 0 ? readMergedPrNumbersFast(workspaceDir) : new Set();
  const prItems = [...sig.prs.values()].map((item) => {
    const live = prMetaByNumber instanceof Map ? prMetaByNumber.get(item.number) : prMetaByNumber?.[item.number];
    const liveState = typeof live?.state === "string" ? live.state.toLowerCase() : null;
    const state =
      liveState === "merged" || liveState === "open" || liveState === "closed"
        ? liveState
        : mergedPrNumbers.has(item.number)
          ? "merged"
          : item.state || "open";
    return {
      ...item,
      url: live?.url || item.url || null,
      title: live?.title ? summarizeText(live.title, 80) : item.title || null,
      state,
    };
  });
  const STATE_RANK = { open: 0, merged: 1, closed: 2 };
  prItems.sort((a, b) => (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3) || b.number - a.number);
  sig.pr = prItems.length > 0 ? [...prItems].sort((a, b) => b.number - a.number)[0] : null;

  const closedOrMergedPrs = new Set(
    prItems.filter((p) => p.state === "merged" || p.state === "closed").map((p) => p.number),
  );
  const hasOpenPr = prItems.some((p) => p.state === "open");
  if (closedOrMergedPrs.size > 0) {
    const isWatchPrEnded = (text, prNums = []) => {
      if (!/\bwatch-pr\b/i.test(String(text ?? ""))) return false;
      if (Array.isArray(prNums) && prNums.length > 0) {
        return prNums.every((n) => closedOrMergedPrs.has(n));
      }
      return !hasOpenPr;
    };
    for (const sch of sig.schedules) {
      if (sch.active && !sch.cronExpression && isWatchPrEnded(`${sch.label} ${sch.prompt ?? ""}`, sch.prNumbers)) {
        sch.active = false;
      }
    }
    for (const job of sig.backgroundJobs) {
      if (
        job.status === "running" &&
        !job.isDaemon &&
        !job.isCron &&
        isWatchPrEnded(`${job.title} ${job.command}`, job.prNumbers)
      ) {
        job.status = "done";
        job.completedAt = job.completedAt || job.startedAt;
      }
    }
  }

  const reviewInProgress =
    reviewStage.status === "active" ||
    reviewStage.status === "stale" ||
    reviewStage.status === "waiting_gate";
  const shipStage = buildShipStage({
    reviewStatus: reviewStage.status,
    shipped,
    shipLive: liveSet.has("ship"),
    openPrRequested: Boolean(sig.openPrAt && !buildInProgress && !reviewInProgress),
    sig,
  });
  const rawSteps = [planStage, buildStage, reviewStage, shipStage];

  for (const job of sig.backgroundJobs) {
    if (job.kind !== "command" || job.status !== "running" || job.isDaemon || job.isCron || !job.stageId) continue;
    const targetStage = rawSteps.find((s) => s.id === job.stageId);
    if (
      targetStage &&
      targetStage.status !== "done" &&
      targetStage.status !== "skipped" &&
      targetStage.status !== "error" &&
      targetStage.status !== "waiting_gate"
    ) {
      liveSet.add(job.stageId);
    }
  }

  const mainTurnFresh =
    sig.mainTurn.active &&
    !sig.mainTurn.waitingOnUser &&
    sig.mainTurn.lastActivityMs > 0 &&
    nowMs - sig.mainTurn.lastActivityMs <= MAIN_TURN_STALE_MS;
  if (mainTurnFresh) {
    const mainStageId = resolveMainTurnStageId(rawSteps, liveSet);
    if (mainStageId) liveSet.add(mainStageId);
  }

  const effectiveLiveInfo = {
    liveStageIds: [...liveSet],
    liveAgentsByStage: liveInfo.liveAgentsByStage,
  };

  const nextAction = selectNextAction(rawSteps, setupState);
  const suggestedStageId = resolveSuggestedStageId(nextAction, rawSteps, liveSet);
  const buildQueuedByPlan =
    Boolean(sig.astackModeAt) &&
    (planStage.status === "active" || planStage.status === "waiting_gate") &&
    buildStage.status === "pending";
  const shipQueuedByEarlier =
    Boolean(sig.openPrAt) &&
    !shipped &&
    !liveSet.has("ship") &&
    shipStage.status === "pending" &&
    (buildInProgress || reviewInProgress);

  const activeSubagentsCount = sig.subagents.filter((a) => a.status === "running").length;
  const doneSubagentsCount = sig.subagents.filter((a) => a.status === "done").length;
  const activeSwarmMembers = sig.swarm.members.filter((m) => m.status !== "killed");
  const workingSwarmCount = sig.swarm.active
    ? activeSwarmMembers.filter((m) => m.status === "working").length
    : 0;
  const activeSchedules = sig.schedules.filter((s) => s.active);
  const activeAutomations = sig.automations.filter((a) => a.active);
  const bgItems = [...sig.backgroundJobs];
  const bgTaskIds = new Set(bgItems.map((j) => j.taskId).filter(Boolean));
  const unbackedSchedules = activeSchedules.filter((s) => !s.taskId || !bgTaskIds.has(s.taskId));
  const runningBgCount = bgItems.filter((j) => j.status === "running").length;
  const openPrsCount = prItems.filter((p) => p.state === "open").length;
  const mergedPrsCount = prItems.filter((p) => p.state === "merged").length;
  const closedPrsCount = prItems.filter((p) => p.state === "closed").length;

  const sharedCounts = {
    activeSubagentsCount,
    doneSubagentsCount,
    activeSwarmMembers,
    workingSwarmCount,
    activeSchedules,
    activeAutomations,
    bgItems,
    unbackedSchedules,
    runningBgCount,
    openPrsCount,
    mergedPrsCount,
    closedPrsCount,
  };

  const stepViews = rawSteps.map((stage) => {
    const railState = computeRailState(stage, liveSet, suggestedStageId, { buildQueuedByPlan, shipQueuedByEarlier });
    const artifacts = buildStageArtifacts(stage, {
      planArtifact,
      walkthroughArtifact,
      reviewArtifact,
      brainConvDir,
      pr: sig.pr,
      prs: prItems,
      shipped,
    });
    const stageWithArts = { ...stage, artifacts };
    return {
      ...stage,
      railState,
      collapsedSummary: buildStageCollapsedSummary(stage, sig.pr, prItems, shipped, {
        railState,
        liveAgents: effectiveLiveInfo.liveAgentsByStage[stage.id] ?? 0,
      }),
      artifacts,
      stats: buildStageStats(stageWithArts, { sig, ...sharedCounts }),
      ...buildStageSubCommands(stage.id, sig.detected),
    };
  });

  const artifactCount = stepViews.reduce((acc, s) => acc + s.artifacts.filter((a) => a.kind !== "pr").length, 0);
  const activity = buildActivitySnapshot({
    sig,
    buildStage,
    reviewStage,
    artifactCount,
    liveInfo: effectiveLiveInfo,
    suggestedStageId,
    prItems,
    sharedCounts,
    shipped,
  });

  let workflowMode = "standard";
  let workflowLabel = null;
  if (!hasConv) {
    workflowMode = "idle";
  } else if (
    shipped &&
    (buildStage.status === "active" ||
      reviewStage.status === "active" ||
      reviewStage.status === "stale" ||
      reviewStage.status === "error" ||
      (prItems.some((p) => p.state === "open") && (hasEdits || reviewStarted || Boolean(sig.babysitAt))))
  ) {
    workflowMode = "pr_iteration";
    workflowLabel = "PR iteration";
  } else if (
    !shipped &&
    reviewStarted &&
    planStage.status === "skipped" &&
    (buildStage.status === "skipped" || buildStage.status === "pending")
  ) {
    workflowMode = "pr_review";
    workflowLabel = "Pre-PR check";
  } else if (planStage.status === "skipped") {
    workflowMode = "direct_build";
    workflowLabel = "Direct flow";
  }

  let liveState = "ok";
  let liveLabel = hasConv ? "Live" : "Idle";
  if (reviewStage.status === "error") {
    liveState = "error";
    liveLabel = "Escalated";
  } else if (planStage.status === "waiting_gate" || reviewStage.status === "waiting_gate" || reviewStage.status === "stale") {
    liveState = "warn";
    liveLabel = "Review";
  }

  const riskTier = evidence?.riskTier ?? null;
  const riskAssessment = evidence?.riskAssessment ?? null;
  const riskDescription = riskTier !== null ? (policyResult.policy.tiers?.[String(riskTier)]?.description ?? null) : null;
  const riskMatchedGlobs = riskTier !== null && Array.isArray(evidence?.matchedRiskRules)
    ? [...new Set(evidence.matchedRiskRules.filter((r) => r.tier === riskTier && typeof r.glob === "string").map((r) => r.glob))].slice(0, 4)
    : [];

  const activeCategory =
    riskAssessment?.category ??
    (sig.changedFiles.size > 0 ? classifyDominantCategory([...sig.changedFiles]) : "ui");
  const repoTrust =
    workspaceScope.kind === "enrolled_repo"
      ? evaluateRepoTrust({ repoId: workspaceScope.repoId, policy: policyResult.policy, dataDir })
      : null;
  const activeCatState = repoTrust?.categories?.[activeCategory] ?? null;
  let promoBanner = null;
  if (repoTrust && !repoTrust.frozen) {
    if (repoTrust.lastAutoPromo) {
      promoBanner = { kind: "auto", ...repoTrust.lastAutoPromo };
    } else {
      const readyCat =
        (activeCatState?.promoReady ? activeCatState : null) ??
        repoTrust.categoryList.find((c) => c.promoReady);
      if (readyCat) {
        promoBanner = {
          kind: "manual",
          catId: readyCat.id,
          toLvl: readyCat.eligibleNextLevel,
          count: readyCat.clean + readyCat.edited,
          score: readyCat.score,
          brier: readyCat.brier,
        };
      }
    }
  }
  const trustState = {
    scopeKind: workspaceScope.kind,
    repoId: workspaceScope.repoId,
    baseRef: workspaceScope.baseRef ?? null,
    enrolled: workspaceScope.kind === "enrolled_repo",
    activeCategory,
    beastOn: repoTrust?.beastOn ?? false,
    promotionMode: repoTrust?.promotionMode ?? "manual",
    promotionLockedByPolicy: repoTrust?.promotionLockedByPolicy ?? false,
    chainValid: repoTrust?.chainValid ?? true,
    frozen: repoTrust?.frozen ?? false,
    totalOutcomes: repoTrust?.totalOutcomes ?? 0,
    activeCatState,
    categories: repoTrust?.categoryList ?? [],
    promoBanner,
    riskAssessment,
    riskPresentation: buildRiskPresentation(riskAssessment, { prItems, reviewStage }),
  };

  const colleagueCommands = [...(sig.colleagueReview?.commands ?? [])];
  const colleagueReviewDetected = Boolean(
    hasConv &&
      colleagueCommands.length > 0 &&
      !hasEdits &&
      !shipped &&
      !sig.planCmdAt &&
      !sig.planWrittenAt &&
      !sig.reviewPrAt &&
      !sig.astackModeAt,
  );
  const colleagueActiveIntent = !colleagueReviewDetected
    ? null
    : sig.colleagueReview.stackReview || (sig.swarm.active && sig.colleagueReview.commands.has("/swarm"))
      ? "stack"
      : sig.colleagueReview.queueReview
        ? "queue"
        : "single";
  const colleagueTargetPrs = [...(sig.colleagueReview?.targetPrs?.values() ?? [])]
    .map((item) => {
      const live = prMetaByNumber instanceof Map ? prMetaByNumber.get(item.number) : prMetaByNumber?.[item.number];
      const liveState = typeof live?.state === "string" ? live.state.toLowerCase() : null;
      return {
        ...item,
        url: live?.url || item.url || null,
        title: live?.title ? summarizeText(live.title, 80) : item.title || null,
        state: liveState || item.state || "open",
      };
    })
    .sort((a, b) => b.number - a.number);
  const colleagueReview = {
    detected: colleagueReviewDetected,
    activeIntent: colleagueActiveIntent,
    detectedCommands: colleagueCommands,
    running: Boolean(
      colleagueReviewDetected &&
        (effectiveLiveInfo.liveStageIds.length > 0 || mainTurnFresh || sig.swarm.active || sig.workflow.active),
    ),
    targetPrs: colleagueTargetPrs.length > 0 ? colleagueTargetPrs : prItems,
  };
  const panelDefaultMode = colleagueReview.detected ? "review_pr" : "build";

  const snapshot = {
    conversationId: conversationId || null,
    hasConversation: hasConv,
    workspace: workspaceDir || null,
    workspaceName: workspaceDir ? resolveWorkspaceRepoName(workspaceDir) : null,
    branch: setup.branch,
    headSha: setup.headSha ? setup.headSha.slice(0, 7) : null,
    fullHeadSha: setup.headSha ?? null,
    setup: setupState,
    trust: trustState,
    riskTier,
    riskLabel: evidence?.riskLabel ?? null,
    riskDescription,
    riskMatchedGlobs,
    freshness: receipts.length > 0 || evidence ? receiptFreshness : null,
    reviewRound,
    maxReviewRounds,
    workflowMode,
    workflowLabel,
    panelDefaultMode,
    colleagueReview,
    doneCount: stepViews.filter((s) => s.status === "done" || s.status === "skipped").length,
    totalCount: stepViews.length,
    liveState,
    liveLabel,
    nextAction,
    stages: stepViews,
    activity,
  };

  const etag = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
  return { ...snapshot, etag };
}
