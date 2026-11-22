import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PIPELINE_STAGES,
  TOOL_MATCHERS,
  classifyCommandCategory,
  computeFreshness,
  loadRiskPolicy,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  resolveTrustDir,
} from "../../scripts/trust/index.mjs";

import { COMMAND_DOCS, STAGE_COMMAND_CATALOG } from "./command-catalog.mjs";

export { COMMAND_DOCS };

const STAGE_BY_ID = new Map(PIPELINE_STAGES.map((stage) => [stage.id, stage]));

function makeCommandItem(command, state, optional = false) {
  const doc = COMMAND_DOCS[command] ?? {};
  const trimmed = String(command).trim();
  return {
    command,
    copyText: trimmed,
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
    summary: "Agree on a written plan before editing code.",
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
    label: "PR Review",
    summary: "Compile PR proof and run isolated verification.",
    gate: "GATE",
    primaryCommand: "/review-pr",
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
    optionalCommands: ["babysit"],
    pipelineStages: [],
  },
];

const FILE_WRITE_TOOLS = new Set(TOOL_MATCHERS.fileWriteTools);
const FILE_READ_TOOLS = new Set(["read_file", "view_file"]);
const VERIFY_CATEGORIES = new Set(["test", "verify", "lint", "build"]);
const DOC_EXT_RE = /\.(?:md|txt)$/i;
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

function isChildTranscriptFinished(brainDir, childConvId) {
  if (!brainDir || !childConvId) return null;
  const childTranscript = path.join(brainDir, childConvId, ".system_generated", "logs", "transcript.jsonl");
  if (!fs.existsSync(childTranscript)) return null;
  try {
    const lines = fs.readFileSync(childTranscript, "utf8").split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
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
        if (step.status === "DONE" && !hasTools) {
          return step.created_at || true;
        }
        return false;
      }
      if (step.status === "RUNNING") return false;
    }
  } catch {
    return null;
  }
  return null;
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

const BRAIN_OR_GENERATED_RE = /(?:^|\/)(?:\.gemini\/antigravity(?:-cli)?\/brain|\.system_generated)(?:\/|$)/i;
const LOCAL_ARTIFACT_RE = /(?:^|\/)(?:\.system_generated|\.gemini)(?:\/|$)/i;

function isWorkspaceFileTarget(rawPath, workspaceDir, brainConvDir) {
  if (!rawPath) return false;
  const norm = normalizePosix(rawPath);
  if (BRAIN_OR_GENERATED_RE.test(norm)) return false;
  const resolved = workspaceDir ? path.resolve(workspaceDir, rawPath) : path.resolve(rawPath);
  if (brainConvDir) {
    const convNorm = normalizePosix(path.resolve(brainConvDir)).replace(/\/$/, "").toLowerCase();
    const fileNorm = normalizePosix(resolved).toLowerCase();
    if (fileNorm === convNorm || fileNorm.startsWith(`${convNorm}/`)) return false;
  }
  if (workspaceDir) {
    const rel = path.relative(path.resolve(workspaceDir), resolved);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
    return !LOCAL_ARTIFACT_RE.test(normalizePosix(rel));
  }
  return !path.isAbsolute(rawPath) && norm !== ".." && !norm.startsWith("../") && !LOCAL_ARTIFACT_RE.test(norm);
}

function analyzeTranscript(transcriptPath, brainConvDir, workspaceDir, brainDir = "") {
  const sig = {
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
    workflow: { active: false, runsCount: 0 },
    backgroundJobs: [],
    sideQuestionsCount: 0,
    changedFiles: new Set(),
    pr: null,
    prs: new Map(),
  };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return sig;

  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  const pendingTestCmds = new Map();
  const pendingSubagentIndices = [];
  const subagentByConvId = new Map();
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

    const order = Number.isFinite(step.step_index) ? step.step_index : i;
    const marker = makeMarker(step.created_at, order);
    if (!sig.startedAt && marker.ts) sig.startedAt = marker.ts;

    if (step.type === "USER_INPUT" || step.source === "USER_EXPLICIT") {
      const rawContent = String(step.content ?? "");
      const cmds = extractInvokedSlashCommands(rawContent);
      const body = extractRequestBody(rawContent).trim();
      for (const cmd of cmds) {
        if (COMMAND_DOCS[cmd]) sig.detected.add(cmd);
        if (cmd === "/setup-astack") sig.setupAt = latestMarker(sig.setupAt, marker);
        else if (cmd === "/grill-me") sig.grillMeAt = latestMarker(sig.grillMeAt, marker);
        else if (cmd === "/plan") sig.planCmdAt = latestMarker(sig.planCmdAt, marker);
        else if (cmd === "/astack-mode") sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        else if (cmd === "/interrogate") sig.interrogateAt = latestMarker(sig.interrogateAt, marker);
        else if (cmd === "/review-pr") sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        else if (cmd === "/boost") {
          sig.boost.detected = true;
          sig.boost.active = true;
        } else if (cmd === "/teamwork") {
          sig.teamwork.detected = true;
          sig.teamwork.active = true;
        } else if (cmd === "/btw") {
          sig.sideQuestionsCount += 1;
        } else if (cmd === "/automation" && sig.automations.length === 0) {
          sig.automations.push({
            id: "auto-0",
            label: summarizeText(body.replace(/^\/automation\s*/i, ""), 44) || "Background automation",
            cadence: "recurring",
            active: true,
          });
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
        if (/\bland\s+(?:the\s+)?stack\b/i.test(body)) sig.detected.add("/astack-mode land the stack");
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
        if (bgJobByTaskId.has(sender)) {
          const job = bgJobByTaskId.get(sender);
          if (job && job.status === "running") {
            const failed = /Command exited with code [1-9]/i.test(step.content);
            if (failed) {
              job.status = "failed";
              job.completedAt = marker.ts;
            } else if (/finished with result:/i.test(step.content) || !job.isCron) {
              job.status = "done";
              job.completedAt = marker.ts;
            }
          }
        }
      }
      continue;
    }

    if (step.type === "GENERIC" && typeof step.content === "string") {
      const shiftedTool = pendingToolQueue.length > 0 ? pendingToolQueue.shift() : null;
      const onlyFileReads = lastToolNames.size > 0 && [...lastToolNames].every((t) => FILE_READ_TOOLS.has(t));
      if (!onlyFileReads) {
        for (const prRef of extractPrReferences(step.content, { urlsOnly: true })) {
          upsertPrEntry(sig.prs, prRef, { ts: marker.ts, title: pendingPrTitle });
          if (pendingPrTitle) pendingPrTitle = null;
        }
      }

      for (const m of step.content.matchAll(/"conversationId"\s*:\s*"([0-9a-f-]{8,})"/gi)) {
        const cid = m[1];
        sig.childConvIds.add(cid);
        if (pendingSubagentIndices.length > 0) {
          const idx = pendingSubagentIndices.shift();
          sig.subagents[idx].childConvId = cid;
          subagentByConvId.set(cid, idx);
        }
      }
      const harnessHeader = step.content.split(/\r?\nCommand output:\r?\n/)[0];
      const taskCreated = harnessHeader.match(/(?:^|\r?\n)(?:Tool is running as a background task with )?task id:\s*([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)\s*(?:\r?\n|$)/i);
      if (taskCreated) {
        const taskId = taskCreated[1];
        const isCommandBg = /Tool is running as a background task/i.test(harnessHeader);
        if (pendingScheduleIndices.length > 0 && (!isCommandBg || shiftedTool?.kind === "schedule")) {
          const idx = pendingScheduleIndices.shift();
          sig.schedules[idx].taskId = taskId;
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
          bgJobByTaskId.set(taskId, {
            id: `bg-${bgJobByTaskId.size}`,
            taskId,
            taskSlug,
            logFile,
            kind: toolMeta?.kind || "command",
            title,
            summary: title,
            command: summarizeText(cmdText, 120),
            startedAt: toolMeta?.ts || marker.ts,
            completedAt: null,
            status: "running",
            isDaemon: Boolean(toolMeta?.isDaemon),
            isCron: Boolean(toolMeta?.isCron),
          });
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
      for (const [cmdOrder, cmdMarker] of pendingTestCmds.entries()) {
        if (order > cmdOrder && order <= cmdOrder + 4) {
          const failed = step.status === "ERROR" || /Command exited with code [1-9]/i.test(step.content);
          if (!failed) sig.verifyRunAt = latestMarker(sig.verifyRunAt, cmdMarker);
          pendingTestCmds.delete(cmdOrder);
          break;
        }
      }
      continue;
    }

    if (step.type !== "PLANNER_RESPONSE") continue;

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
    pendingToolQueue = step.tool_calls.map((tc) => {
      const tName = String(tc?.name ?? "");
      const tArgs = tc?.args && typeof tc.args === "object" ? tc.args : {};
      if (tName === "run_command") {
        const c = unquoteArg(tArgs.CommandLine || tArgs.commandLine || tArgs.command);
        const s = unquoteArg(tArgs.toolSummary || tArgs.Description);
        return {
          kind: "command",
          title: s ? summarizeText(s, 72) : summarizeText(c, 64),
          cmd: c,
          isDaemon: parseBoolArg(tArgs.IsDaemon),
          isCron: false,
          ts: marker.ts,
        };
      }
      if (tName === "schedule") {
        const prm = unquoteArg(tArgs.Prompt);
        const cron = unquoteArg(tArgs.CronExpression);
        return {
          kind: "schedule",
          title: summarizeText(prm, 72) || "Scheduled check",
          cmd: prm,
          isDaemon: parseBoolArg(tArgs.IsDaemon),
          isCron: Boolean(cron),
          ts: marker.ts,
        };
      }
      if (tName === "run_workflow") {
        const desc = unquoteArg(tArgs.Description || tArgs.ScriptPath);
        return {
          kind: "workflow",
          title: summarizeText(desc, 72) || "Workflow run",
          cmd: desc,
          isDaemon: false,
          isCron: false,
          ts: marker.ts,
        };
      }
      return { kind: "other" };
    });

    for (const tc of step.tool_calls) {
      const name = String(tc?.name ?? "");
      const args = tc?.args && typeof tc.args === "object" ? tc.args : {};

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
              active: true,
            });
          }
        }
        const pbRead = p.match(/\/skills\/astack-mode\/playbooks\/([a-z0-9-]+)\.md$/i);
        if (pbRead) {
          const pbName = pbRead[1].toLowerCase();
          if (pbName === "shipping") sig.detected.add("/astack-mode land the stack");
          else if (pbName === "release-and-postmortem") sig.detected.add("release-and-postmortem");
          else if (pbName === "worktree-cleanup") sig.detected.add("/astack-mode prune worktrees");
        }
        if (/\/skills\/setup-astack\/SKILL\.md$/i.test(p)) sig.setupAt = latestMarker(sig.setupAt, marker);
        else if (/\/skills\/astack-mode\/references\/plan-contract\.md$/i.test(p)) sig.planContractAt = latestMarker(sig.planContractAt, marker);
        else if (/\/skills\/astack-mode\/SKILL\.md$/i.test(p)) sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        else if (/\/skills\/interrogate\/SKILL\.md$/i.test(p)) sig.interrogateAt = latestMarker(sig.interrogateAt, marker);
        else if (/\/skills\/(?:deslop|no-comments)\/SKILL\.md$/i.test(p)) sig.cleanAt = latestMarker(sig.cleanAt, marker);
        else if (/\/skills\/(?:control-ui|control-cli)\/SKILL\.md$/i.test(p) || /\/\.agents\/skills\/verify-[^/]+\/SKILL\.md$/i.test(p)) {
          sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        } else if (/\/skills\/review-pr\/SKILL\.md$/i.test(p)) {
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
        } else if (/\/pr-review\.md$/i.test(p)) {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        } else if (isWorkspaceFileTarget(p, workspaceDir, brainConvDir)) {
          sig.latestWorkspaceWriteAt = latestMarker(sig.latestWorkspaceWriteAt, marker);
          sig.earliestWorkspaceWriteAt = earliestMarker(sig.earliestWorkspaceWriteAt, marker);
          sig.changedFiles.add(workspaceDir ? normalizePosix(path.relative(path.resolve(workspaceDir), path.resolve(workspaceDir, p))) : p);
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
        if (subType === "comment-sicko") {
          sig.cleanAt = latestMarker(sig.cleanAt, marker);
          sig.detected.add("/no-comments");
        } else if (subType === "pr-verifier") {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
          sig.detected.add("pr-verifier");
        } else if (subType === "browser") {
          sig.verifyRunAt = latestMarker(sig.verifyRunAt, marker);
          sig.detected.add("/control-ui");
          sig.detected.add("/browser");
        }
        const stageId =
          subType === "pr-verifier"
            ? "review"
            : subType === "research" && !sig.latestWorkspaceWriteAt
              ? "plan"
              : "build";
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
        pendingSubagentIndices.push(sig.subagents.length);
        sig.subagents.push(entry);
      } else if (name === "manage_subagents") {
        const act = unquoteArg(args.Action).toLowerCase();
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
        pendingWorkflowRun = true;
      } else if (name === "schedule") {
        sig.detected.add("/schedule");
        const dur = parseIntArg(args.DurationSeconds);
        const cron = unquoteArg(args.CronExpression);
        const promptText = unquoteArg(args.Prompt);
        const prRefs = extractPrReferences(promptText);
        for (const prRef of prRefs) upsertPrEntry(sig.prs, prRef, { ts: marker.ts });
        const prRef = prRefs[0] ?? null;
        const label = /watch-pr/i.test(promptText)
          ? prRef
            ? `watch-pr.mjs --pr ${prRef.number}`
            : "watch-pr.mjs"
          : summarizeText(promptText, 44) || "Scheduled check";
        const stageId = /watch-pr|\bpr\b|\bci\b/i.test(promptText) ? "ship" : "build";
        pendingScheduleIndices.push(sig.schedules.length);
        sig.schedules.push({
          id: `sch-${sig.schedules.length}`,
          taskId: null,
          label,
          cadence: formatCadenceLabel(dur, cron),
          stageId,
          startedAt: marker.ts,
          nextAt: computeScheduleNextAt(marker, dur, cron),
          durationSeconds: dur,
          cronExpression: cron || null,
          active: true,
        });
      } else if (name === "manage_task") {
        if (unquoteArg(args.Action).toLowerCase() === "kill") {
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
          sig.detected.add("pr-dossier");
        }
        if (/\bwatch-pr\.mjs\b/i.test(cmd)) {
          sig.babysitAt = latestMarker(sig.babysitAt, marker);
          sig.detected.add("watch-pr");
        }
        if (/\bworktree-audit\.mjs\b/i.test(cmd)) sig.detected.add("/astack-mode prune worktrees");
        if (/\bstatechart\.mjs\b/i.test(cmd)) sig.detected.add("/statechart");
        if (/\blog\.mjs\b/i.test(cmd)) sig.detected.add("/show-me-your-work");
        if (/\b(?:gh\s+pr\s+create|git\s+push)\b/i.test(cmd)) sig.pushOrPrAt = latestMarker(sig.pushOrPrAt, marker);
        const category = classifyCommandCategory(cmd);
        if (category === "test" || category === "verify") {
          pendingTestCmds.set(order, marker);
        }
      } else if (name === "call_mcp_tool" && unquoteArg(args.ToolName) === "create_pull_request") {
        sig.pushOrPrAt = latestMarker(sig.pushOrPrAt, marker);
      }
    }
  }

  if (brainConvDir) {
    const tasksDir = path.join(brainConvDir, ".system_generated", "tasks");
    try {
      if (fs.existsSync(tasksDir)) {
        const knownLogs = new Set([...bgJobByTaskId.values()].map((j) => j.logFile).filter(Boolean));
        for (const entry of fs.readdirSync(tasksDir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^task-\d+\.log$/.test(entry.name) || knownLogs.has(entry.name)) continue;
          const slug = entry.name.replace(/\.log$/, "");
          const safeLog = resolveSafeTaskLogPath(brainConvDir, entry.name);
          if (!safeLog) continue;
          const mtime = fs.statSync(safeLog).mtime.toISOString();
          bgJobByTaskId.set(slug, {
            id: `bg-${bgJobByTaskId.size}`,
            taskId: slug,
            taskSlug: slug,
            logFile: entry.name,
            kind: "command",
            title: slug,
            summary: slug,
            command: "",
            startedAt: mtime,
            completedAt: mtime,
            status: "done",
            isDaemon: false,
            isCron: false,
          });
        }
      }
    } catch {
    }
  }
  sig.backgroundJobs = [...bgJobByTaskId.values()];

  for (const sa of sig.subagents) {
    if (sa.status === "running" && sa.childConvId && brainDir) {
      const doneRes = isChildTranscriptFinished(brainDir, sa.childConvId);
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
  const mergeKeys = ["cleanAt", "verifyRunAt", "latestCodeWriteAt", "latestWorkspaceWriteAt"];
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

function buildPlanStage({ hasConv, setupState, sig, planArtifact, planWrittenMarker, latestAnyWrite }) {
  const editsAfterPlan = Boolean(planWrittenMarker && latestAnyWrite && isMarkerAfter(latestAnyWrite, planWrittenMarker));
  const diskPlanApproved = Boolean(!sig.planWrittenAt && planArtifact && sig.approvalIntentAt);
  const planApproved = Boolean(
    (sig.planApprovedAt && (!planWrittenMarker || isMarkerAfter(sig.planApprovedAt, planWrittenMarker))) ||
      diskPlanApproved ||
      editsAfterPlan,
  );
  const grillMe = Boolean(sig.grillMeAt || (sig.planContractAt && sig.askQuestionAt));
  const triggered = Boolean(sig.planCmdAt || sig.planContractAt || planWrittenMarker);

  let status = "pending";
  if (planWrittenMarker && planApproved) status = "done";
  else if (planWrittenMarker) status = "waiting_gate";
  else if (Boolean(latestAnyWrite) && !triggered) status = "skipped";
  else if (triggered || grillMe) status = "active";
  else if (!hasConv) status = setupState.status === "ready" ? "next" : "pending";
  else if (setupState.status !== "needs_setup") status = "next";

  const detail = status === "waiting_gate"
    ? "implementation_plan.md staged. Review comments and click Proceed."
    : status === "done"
      ? "Plan approved and execution started."
      : status === "skipped"
        ? "Skipped for direct edit flow."
        : status === "active"
          ? grillMe
            ? "Clarifying requirements via /grill-me."
            : "Planning in progress — drafting implementation_plan.md."
          : "Write implementation_plan.md before editing code.";

  return {
    ...TIMELINE_STEPS[0],
    status,
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
  buildStale,
  reviewStarted,
  reviewFresh,
  walkthroughArtifact,
}) {
  const planningActive = (planStatus === "active" || planStatus === "waiting_gate") && !hasEdits;
  const astackModeActive = !planningActive && Boolean(sig.astackModeAt || hasEdits);
  const walkthroughComplete = Boolean(walkthroughArtifact);
  const hasBuildableWork = Boolean(hasEdits || walkthroughComplete || (reviewStarted && reviewFresh));
  let status = "pending";
  if (!planningActive) {
    if (buildStale) status = "stale";
    else if (verifyFresh && hasBuildableWork && (!hasCodeEdits || cleanFresh || walkthroughComplete || (reviewStarted && reviewFresh))) status = "done";
    else if (astackModeActive || Boolean(sig.interrogateAt) || cleanDone || (verifyDone && hasEdits)) status = "active";
    else if (planStatus === "done" || planStatus === "skipped") status = "next";
  }

  const editsStatus = hasEdits ? "done" : "pending";
  const cleanStatus = !planningActive && cleanDone ? (cleanFresh ? "done" : "stale") : "pending";
  const verifyStatus = !planningActive && hasBuildableWork && verifyFresh ? "done" : buildStale ? "stale" : "pending";
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
        : cleanStatus === "stale"
          ? "New code edits landed after cleanup. Re-run /deslop or /no-comments."
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
        : verifyStatus === "stale"
          ? "New edits landed after verification. Re-run tests or validation."
          : "Waiting for tests, lint, build, or live verification after edits.",
    },
  ];
  const onlyCleanStale = cleanStatus === "stale" && verifyStatus === "done";
  const detail = status === "stale"
    ? onlyCleanStale
      ? "New code edits landed after cleanup. Re-run /deslop or /no-comments."
      : "New edits landed after verification. Re-run tests or validation before PR review."
    : status === "done"
      ? hasCodeEdits && cleanFresh
        ? "Code edits cleaned and verified on HEAD."
        : hasEdits && !hasCodeEdits
          ? "Documentation edits verified on HEAD."
          : walkthroughComplete
            ? "Edits verified on HEAD with walkthrough recorded."
            : "Changes verified on HEAD for PR review."
      : status === "active"
        ? "Running build, cleanup, and live verification."
        : "Run /astack-mode with your goal and done check.";

  return {
    ...TIMELINE_STEPS[1],
    status,
    commands: [
      makeCommandItem(
        "/astack-mode",
        status === "done" ? "done" : status === "stale" ? "stale" : astackModeActive ? "active" : status === "next" ? "next" : "pending",
      ),
      makeCommandItem("/interrogate", sig.interrogateAt ? "done" : "pending", true),
    ],
    subChecks,
    detail,
    artifact: walkthroughArtifact,
  };
}

function buildReviewStage({ buildStatus, reviewStarted, staleFromReceipts, reviewFresh, reviewArtifact, evidence, maxReviewRounds, shipped }) {
  const roundState = evidence?.roundState ?? "open";
  const reviewRound = evidence?.reviewRound ?? 0;
  const verdict = evidence?.verifier?.verdict ?? null;
  const reviewPass = verdict === "PASS" || verdict === "PASS_WITH_NOTES";

  let status = "pending";
  if (roundState === "escalated") status = "error";
  else if (reviewStarted && staleFromReceipts) status = "stale";
  else if (reviewStarted && reviewFresh && (reviewArtifact || reviewPass)) {
    status = shipped || evidence?.autoMergeEligible ? "done" : "waiting_gate";
  } else if (reviewStarted) status = "active";
  else if (buildStatus === "done") status = "next";

  const detail = roundState === "escalated"
    ? `Remediation hit ${reviewRound}/${maxReviewRounds} round cap. Human decision required.`
    : status === "stale"
      ? "New changes invalidated prior PR evidence. Re-run /review-pr."
      : status === "waiting_gate"
        ? `Risk Tier ${evidence?.riskTier ?? 1} (${evidence?.riskLabel ?? "medium"}) · pr-verifier ${verdict ?? "pending"} (${reviewRound}/${maxReviewRounds}). Awaiting your visual review.`
        : status === "done"
          ? `PR review passed (Tier ${evidence?.riskTier ?? 1}).`
          : "Compile pr-review.md and run isolated pr-verifier.";

  return {
    ...TIMELINE_STEPS[2],
    status,
    commands: [
      makeCommandItem(
        "/review-pr",
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

function buildShipStage({ reviewStatus, shipped, sig }) {
  let status = "pending";
  if (shipped) status = "done";
  else if (reviewStatus === "waiting_gate" || reviewStatus === "done") status = "next";
  else if (sig.openPrAt) status = "active";

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
      makeCommandItem("babysit", sig.babysitAt ? "done" : "pending", true),
    ],
    subChecks: [],
    detail,
    artifact: null,
  };
}

function selectNextAction(stepViews, setupState) {
  const [plan, build, review, ship] = stepViews;
  if (review.status === "error") {
    return { stageId: "review", stageLabel: "PR Review", command: "/review-pr", hint: review.detail };
  }
  if (build.status === "stale") {
    const onlyClean =
      build.subChecks?.some((c) => c.id === "clean" && c.status === "stale") &&
      build.subChecks?.some((c) => c.id === "verify" && c.status === "done");
    return {
      stageId: "build",
      stageLabel: "Build & Prove",
      command: "/astack-mode",
      hint: onlyClean
        ? "Code edited after cleanup. Re-run /deslop or /no-comments."
        : "Edits landed after verify. Re-clean and re-verify on HEAD.",
    };
  }
  if (review.status === "stale") {
    return { stageId: "review", stageLabel: "PR Review", command: "/review-pr", hint: "Re-run PR dossier on updated HEAD." };
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
  const current = stepViews.find((s) => s.status === "next" || s.status === "active");
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

function selectActiveStageId(stepViews) {
  for (const targetStatus of ["active", "error", "stale", "waiting_gate", "next"]) {
    const match = stepViews.find((s) => s.status === targetStatus);
    if (match) return match.id;
  }
  return "plan";
}

function buildStageArtifacts(stage, { planArtifact, walkthroughArtifact, reviewArtifact, brainConvDir, pr, prs, shipped }) {
  if (stage.id === "plan") {
    if (!planArtifact) return [];
    const badge = stage.status === "done" ? "approved" : stage.status === "waiting_gate" ? "gate" : "";
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
    const badge = stage.status === "stale" ? "stale" : stage.status === "waiting_gate" ? "gate" : "";
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

function buildStageCollapsedSummary(stage, pr, prs, shipped) {
  if (stage.id === "plan") {
    if (stage.status === "done") return "Plan approved.";
    if (stage.status === "waiting_gate") return "implementation_plan.md awaiting approval.";
    if (stage.status === "skipped") return "Skipped for direct edit flow.";
    if (stage.status === "active") return "Drafting implementation plan.";
    return stage.summary;
  }
  if (stage.id === "build") {
    if (stage.status === "stale") {
      const onlyClean =
        stage.subChecks?.some((c) => c.id === "clean" && c.status === "stale") &&
        stage.subChecks?.some((c) => c.id === "verify" && c.status === "done");
      return onlyClean ? "Code edited after cleanup." : "New edits landed after verification.";
    }
    if (stage.status === "done") return "Cleaned and verified on HEAD.";
    return stage.summary;
  }
  if (stage.id === "review") {
    if (stage.status === "stale") return "Your latest edits came after the last review.";
    if (stage.status === "waiting_gate") return "Awaiting your visual review.";
    if (stage.status === "error") return stage.detail;
    if (stage.status === "done") return "PR review passed.";
    return stage.summary;
  }
  if (stage.id === "ship") {
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

function buildSuggestedReview(reviewStage, changedFilesCount) {
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

function buildActivitySnapshot({ sig, buildStage, reviewStage, artifactCount, activeStageId, prItems }) {
  const activeSubagentsCount = sig.subagents.filter((a) => a.status === "running").length;
  const doneSubagentsCount = sig.subagents.filter((a) => a.status === "done").length;
  const activeSwarmMembers = sig.swarm.members.filter((m) => m.status !== "killed");
  const workingSwarmCount = activeSwarmMembers.filter((m) => m.status === "working").length;
  const activeSchedules = sig.schedules.filter((s) => s.active);
  const activeAutomations = sig.automations.filter((a) => a.active);
  const checksDone = buildStage.subChecks.filter((c) => c.status === "done").length;
  const checksTotal = buildStage.subChecks.length || 3;

  const bgItems = [...sig.backgroundJobs];
  const bgTaskIds = new Set(bgItems.map((j) => j.taskId).filter(Boolean));
  const unbackedSchedules = activeSchedules.filter((s) => !s.taskId || !bgTaskIds.has(s.taskId));
  const runningBgCount = bgItems.filter((j) => j.status === "running").length;

  const openPrsCount = prItems.filter((p) => p.state === "open").length;
  const mergedPrsCount = prItems.filter((p) => p.state === "merged").length;
  const closedPrsCount = prItems.filter((p) => p.state === "closed").length;

  return {
    activeStageId,
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
      suggestedReview: buildSuggestedReview(reviewStage, sig.changedFiles.size),
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
} = {}) {
  const hasConv = Boolean(conversationId && brainDir);
  const brainConvDir = hasConv ? path.join(brainDir, conversationId) : "";
  const transcriptPath = hasConv
    ? path.join(brainConvDir, ".system_generated", "logs", "transcript.jsonl")
    : "";

  const setup = inspectSetupReadiness(workspaceDir);
  const policyResult = loadRiskPolicy(workspaceDir);
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

  let latestCodeWrite = sig.latestCodeWriteAt;
  let latestAnyWrite = sig.latestWorkspaceWriteAt;
  let earliestAnyWrite = sig.earliestWorkspaceWriteAt;
  let latestReceiptVerify = null;
  let latestReceiptClean = null;
  let hadReceiptWrite = false;
  let hasVerifyReceipt = false;
  let receiptPush = false;

  for (const r of receipts) {
    const m = makeMarker(r.ts, Number.MAX_SAFE_INTEGER);
    if (r.kind === "file_write") {
      const workspacePaths = Array.isArray(r.paths)
        ? r.paths.filter((p) => isWorkspaceFileTarget(p, workspaceDir, brainConvDir))
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
      if (/\b(?:gh\s+pr\s+create|git\s+push)\b/i.test(r.summary)) receiptPush = true;
    }
    if (r.kind === "command" && r.ok && /\barch-audit\.mjs\b/i.test(String(r.summary ?? ""))) {
      latestReceiptClean = latestMarker(latestReceiptClean, m);
    }
  }

  const hasEdits = Boolean(hadReceiptWrite || latestAnyWrite);
  const hasCodeEdits = Boolean(latestCodeWrite);
  const receiptFreshness = receipts.length > 0
    ? computeFreshness({ receipts, headSha: setup.headSha, priorEvidence: evidence })
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
  const cleanStale = Boolean(cleanDone && !cleanFresh && !(verifyFresh && reviewPassFresh && !staleFromReceipts));
  const effectiveCleanFresh = cleanDone && !cleanStale;
  const buildStale = staleFromReceipts || cleanStale || Boolean(sig.verifyRunAt && hasPostEditVerify && !verifyFresh && hasCodeEdits);
  const shipped = Boolean(sig.pushOrPrAt || receiptPush);

  const setupState = buildSetupReadiness(setup, sig);
  if (setup.verifySkills.some((s) => !s.endsWith("-formal"))) sig.detected.add("/create-verification-skill");
  if (setup.verifySkills.some((s) => s.endsWith("-formal"))) sig.detected.add("/create-formal-verification-skill");
  if (evidence) sig.detected.add("pr-dossier");
  if (evidence?.verifier?.verdict) sig.detected.add("pr-verifier");
  Object.assign(
    setupState,
    buildStageSubCommands("setup", sig.detected, new Set((setupState.commands || []).map((c) => c.command))),
  );

  const planStage = buildPlanStage({ hasConv, setupState, sig, planArtifact, planWrittenMarker, latestAnyWrite });
  const buildStage = buildBuildStage({
    planStatus: planStage.status,
    sig,
    hasEdits,
    hasCodeEdits,
    cleanDone,
    cleanFresh: effectiveCleanFresh,
    verifyDone,
    verifyFresh,
    buildStale,
    reviewStarted,
    reviewFresh,
    walkthroughArtifact,
  });
  const reviewStage = buildReviewStage({
    buildStatus: buildStage.status,
    reviewStarted,
    staleFromReceipts,
    reviewFresh,
    reviewArtifact,
    evidence,
    maxReviewRounds,
    shipped,
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

  const shipStage = buildShipStage({ reviewStatus: reviewStage.status, shipped, sig });
  const stepViews = [planStage, buildStage, reviewStage, shipStage].map((stage) => ({
    ...stage,
    collapsedSummary: buildStageCollapsedSummary(stage, sig.pr, prItems, shipped),
    artifacts: buildStageArtifacts(stage, {
      planArtifact,
      walkthroughArtifact,
      reviewArtifact,
      brainConvDir,
      pr: sig.pr,
      prs: prItems,
      shipped,
    }),
    ...buildStageSubCommands(stage.id, sig.detected),
  }));

  const artifactCount = stepViews.reduce((acc, s) => acc + s.artifacts.filter((a) => a.kind !== "pr").length, 0);
  const activeStageId = selectActiveStageId(stepViews);
  const activity = buildActivitySnapshot({
    sig,
    buildStage,
    reviewStage,
    artifactCount,
    activeStageId,
    prItems,
  });

  const onlyBuildCleanStale =
    buildStage.status === "stale" &&
    reviewStage.status !== "stale" &&
    Boolean(buildStage.subChecks?.some((c) => c.id === "clean" && c.status === "stale")) &&
    Boolean(buildStage.subChecks?.some((c) => c.id === "verify" && c.status === "done"));

  let liveState = "ok";
  let liveLabel = hasConv ? "Live" : "Idle";
  if (reviewStage.status === "error") {
    liveState = "error";
    liveLabel = "Escalated";
  } else if (buildStage.status === "stale" || reviewStage.status === "stale") {
    liveState = "warn";
    liveLabel = onlyBuildCleanStale ? "Re-clean" : "Stale";
  } else if (planStage.status === "waiting_gate" || reviewStage.status === "waiting_gate") {
    liveState = "warn";
    liveLabel = "Gate";
  }

  const riskTier = evidence?.riskTier ?? null;
  const riskDescription = riskTier !== null ? (policyResult.policy.tiers?.[String(riskTier)]?.description ?? null) : null;
  const riskMatchedGlobs = riskTier !== null && Array.isArray(evidence?.matchedRiskRules)
    ? [...new Set(evidence.matchedRiskRules.filter((r) => r.tier === riskTier && typeof r.glob === "string").map((r) => r.glob))].slice(0, 4)
    : [];

  const snapshot = {
    conversationId: conversationId || null,
    hasConversation: hasConv,
    workspace: workspaceDir || null,
    workspaceName: workspaceDir ? resolveWorkspaceRepoName(workspaceDir) : null,
    branch: setup.branch,
    headSha: setup.headSha ? setup.headSha.slice(0, 7) : null,
    setup: setupState,
    riskTier,
    riskLabel: evidence?.riskLabel ?? null,
    riskDescription,
    riskMatchedGlobs,
    freshness: receipts.length > 0 || evidence ? receiptFreshness : null,
    reviewRound,
    maxReviewRounds,
    doneCount: stepViews.filter((s) => s.status === "done" || s.status === "skipped").length,
    totalCount: stepViews.length,
    liveState,
    liveLabel,
    nextAction: selectNextAction(stepViews, setupState),
    stages: stepViews,
    activity,
  };

  const etag = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
  return { ...snapshot, etag };
}
