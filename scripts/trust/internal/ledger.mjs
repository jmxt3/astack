import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ENGINEERING_MCP_SERVERS,
  collectLeafSegments,
  loadRiskPolicy,
  resolveBaseRef,
  tokenizeSimpleWords,
} from "./policy.mjs";
import { validatePrBodyContract } from "./pr-proof.mjs";
import { resolveGitDirs, resolveWorkspaceScope } from "./workspace-scope.mjs";

export { resolveGitDirs, resolveWorkspaceScope };

export const PIPELINE_STAGES = [
  {
    id: "understand",
    number: 1,
    gate: "AUTO",
    title: "Understand & Align",
    tools: ["/how", "/why", "base REVIEW.md", "GLOSSARY.md"],
  },
  {
    id: "plan",
    number: 2,
    gate: "HUMAN GATE",
    title: "Implementation Plan",
    tools: ["implementation_plan.md", "Proceed"],
  },
  {
    id: "build",
    number: 3,
    gate: "AUTO",
    title: "Build & Guard",
    tools: ["astack-agent", "/swarm", "/tdd", "receipt-ledger", "guards"],
  },
  {
    id: "clean",
    number: 4,
    gate: "AUTO",
    title: "Clean & Harden",
    tools: ["/deslop", "/no-comments", "re-verify tests"],
  },
  {
    id: "verify",
    number: 5,
    gate: "AUTO",
    title: "Live Proof & AI Review",
    tools: ["verify-<app>", "control-ui", "control-cli", "pr-dossier", "pr-verifier (<=3 rounds)"],
  },
  {
    id: "pr-review",
    number: 6,
    gate: "HUMAN GATE",
    title: "Visual PR Review & Merge",
    tools: ["pr-review.md", "Antigravity Review pane", "risk-policy"],
  },
];

/**
 * Formats the deterministic 6-stage `/astack-mode` flight rail showing automated stages and human gates.
 */
export function formatPipelineRail({
  playbook = "feature",
  policy = null,
  stageStates = {},
} = {}) {
  const planMode = policy?.humanGates?.planApproval ?? "nontrivial";
  const prMode = policy?.humanGates?.prReview ?? "always";
  const lines = [`AStack Pipeline (${playbook}) | planGate=${planMode} | prGate=${prMode}`];
  for (const stage of PIPELINE_STAGES) {
    let gate = stage.gate;
    if (stage.id === "plan" && planMode === "never") gate = "AUTO";
    if (stage.id === "pr-review" && prMode === "tier0-auto" && policy?.allowTier0AutoMerge) {
      gate = "HUMAN GATE (Tier 0 opt-in auto)";
    }
    const status = stageStates[stage.id] ?? "pending";
    lines.push(`${stage.number}. [${gate}] ${stage.title} (${status}) -> ${stage.tools.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Reads current HEAD SHA directly from `.git/HEAD` without spawning a child process.
 */
export function readHeadShaFast(workspaceDir) {
  try {
    const dirs = resolveGitDirs(workspaceDir);
    if (!dirs) return null;
    const headFile = path.join(dirs.gitDir, "HEAD");
    if (!fs.existsSync(headFile)) return null;
    const headRaw = fs.readFileSync(headFile, "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(headRaw)) return headRaw.toLowerCase();
    const refMatch = headRaw.match(/^ref:\s*(\S+)$/);
    if (!refMatch) return null;
    const refRel = refMatch[1];
    for (const base of [dirs.gitDir, dirs.commonDir]) {
      const refPath = path.join(base, ...refRel.split("/"));
      if (fs.existsSync(refPath)) {
        const sha = fs.readFileSync(refPath, "utf8").trim();
        if (/^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
      }
    }
    const packedPath = path.join(dirs.commonDir, "packed-refs");
    if (fs.existsSync(packedPath)) {
      for (const line of fs.readFileSync(packedPath, "utf8").split(/\r?\n/)) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const [sha, ref] = line.trim().split(/\s+/);
        if (ref === refRel && /^[0-9a-f]{40}$/i.test(sha)) {
          return sha.toLowerCase();
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolves the ephemeral per-session trust directory for receipts and evidence snapshots.
 */
export function resolveTrustDir({ workspaceDir = "", artifactDir = null } = {}) {
  if (typeof artifactDir === "string" && artifactDir.trim()) {
    return path.join(path.resolve(artifactDir), "astack-trust");
  }
  if (workspaceDir) {
    const dirs = resolveGitDirs(workspaceDir);
    if (dirs?.commonDir) {
      return path.join(dirs.commonDir, "astack-trust");
    }
  }
  return null;
}

const TEST_CMD_REGEX =
  /\b(?:node\s+--test|node\s+--run\s+test(?::[\w-]+)?|npm\s+(?:run\s+)?test(?::[\w-]+)?|pnpm\s+test|yarn\s+test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|playwright\s+test)\b/i;
const LINT_CMD_REGEX =
  /\b(?:eslint|oxlint|biome|ruff|tsc\b|mypy|pyright|validate-astack|agy\s+plugin\s+validate|arch-audit)\b/i;
const BUILD_CMD_REGEX =
  /\b(?:tsc\s+-b|vite\s+build|next\s+build|cargo\s+build|go\s+build|npm\s+run\s+build)\b/i;
const VERIFY_CMD_REGEX =
  /\b(?:pr-dossier|statechart|control-ui|control-cli|verify-[\w-]+)\b/i;

/**
 * Classifies a shell command string into a verification receipt category.
 */
export function classifyCommandCategory(command) {
  if (typeof command !== "string" || !command.trim()) return "other";
  if (TEST_CMD_REGEX.test(command)) return "test";
  if (VERIFY_CMD_REGEX.test(command)) return "verify";
  if (LINT_CMD_REGEX.test(command)) return "lint";
  if (BUILD_CMD_REGEX.test(command)) return "build";
  return "other";
}

function redactSummary(text) {
  return String(text ?? "")
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, "[REDACTED_KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|sk-(?:proj|ant)-[A-Za-z0-9_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED_TOKEN]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 200);
}

const EXTERNAL_ARTIFACT_PATH_RE = /(?:^|\/)(?:\.gemini|\.system_generated)(?:\/|$)/i;
const BRAIN_OR_GENERATED_RE = /(?:^|\/)(?:\.gemini\/(?:antigravity(?:-cli)?|jetski)\/brain|\.system_generated)(?:\/|$)/i;

function isSameGitCommonRepo(workspaceDir, targetFile) {
  if (!workspaceDir || !targetFile) return false;
  try {
    const wsDirs = resolveGitDirs(workspaceDir);
    if (!wsDirs?.commonDir) return false;
    let dir = path.dirname(targetFile);
    while (dir && !fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
    const targetDirs = resolveGitDirs(dir);
    if (!targetDirs?.commonDir) return false;
    return path.resolve(wsDirs.commonDir).toLowerCase() === path.resolve(targetDirs.commonDir).toLowerCase();
  } catch {
    return false;
  }
}

function normalizeRelPath(workspaceDir, filePath) {
  if (!filePath) return "";
  if (!workspaceDir) return filePath.replace(/\\/g, "/");
  const abs = path.resolve(workspaceDir, filePath);
  const rel = path.relative(path.resolve(workspaceDir), abs).split(path.sep).join("/");
  return rel && !rel.startsWith("..") ? rel : filePath.replace(/\\/g, "/");
}

function isNonWorkspaceWritePath(filePath, { workspaceDir = "", artifactDir = "" } = {}) {
  if (!filePath) return false;
  const norm = String(filePath).replace(/\\/g, "/");
  if (BRAIN_OR_GENERATED_RE.test(norm)) return true;
  const resolvedFile = workspaceDir ? path.resolve(workspaceDir, filePath) : path.resolve(filePath);
  if (artifactDir) {
    const absArtifact = path.resolve(artifactDir).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const absFile = resolvedFile.replace(/\\/g, "/").toLowerCase();
    if (absFile === absArtifact || absFile.startsWith(`${absArtifact}/`)) return true;
  }
  if (workspaceDir) {
    const rel = path.relative(path.resolve(workspaceDir), resolvedFile);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      if (path.isAbsolute(filePath) && !EXTERNAL_ARTIFACT_PATH_RE.test(norm) && isSameGitCommonRepo(workspaceDir, resolvedFile)) {
        return false;
      }
      return true;
    }
    return EXTERNAL_ARTIFACT_PATH_RE.test(rel.replace(/\\/g, "/"));
  }
  return EXTERNAL_ARTIFACT_PATH_RE.test(norm);
}

function isNonWorkspaceReceipt(receipt) {
  return (
    receipt?.kind === "file_write" &&
    Array.isArray(receipt.paths) &&
    receipt.paths.length > 0 &&
    receipt.paths.every((p) => EXTERNAL_ARTIFACT_PATH_RE.test(String(p ?? "").replace(/\\/g, "/")))
  );
}

const RECORDABLE_RECEIPT_KINDS = new Set([
  "tool-command",
  "tool-write",
  "tool-subagent",
  "tool-workflow",
  "tool-mcp",
]);

function buildReceiptShape(event) {
  if (event.kind === "tool-command") {
    return {
      kind: "command",
      category: classifyCommandCategory(event.command),
      treeDirty: null,
      summary: redactSummary(event.command),
      paths: [],
    };
  }
  if (event.kind === "tool-write") {
    return {
      kind: "file_write",
      category: "other",
      treeDirty: true,
      summary: redactSummary(`${event.tool} ${event.filePath}`),
      paths: event.filePath ? [normalizeRelPath(event.workspaceDir, event.filePath)] : [],
    };
  }
  if (event.kind === "tool-subagent") {
    const roleTag = event.role ? ` (${event.role})` : "";
    return {
      kind: "subagent",
      category: "delegate",
      treeDirty: null,
      summary: redactSummary(`invoke_subagent ${event.subagentType || "subagent"}${roleTag}`),
      paths: [],
    };
  }
  if (event.kind === "tool-workflow") {
    return {
      kind: "workflow",
      category: "delegate",
      treeDirty: null,
      summary: redactSummary(`run_workflow ${event.description || event.scriptPath || "script"}`),
      paths: event.scriptPath ? [normalizeRelPath(event.workspaceDir, event.scriptPath)] : [],
    };
  }
  return {
    kind: "mcp",
    category: "mcp",
    treeDirty: null,
    summary: redactSummary(`${event.serverName || "mcp"}/${event.toolName || event.tool}`),
    paths: [],
  };
}

function matchesAllowedMcpServer(serverName, allowlist) {
  const norm = String(serverName ?? "").trim().toLowerCase();
  if (!norm) return false;
  for (const rawEntry of allowlist ?? []) {
    const entry = String(rawEntry ?? "").trim().toLowerCase();
    if (!entry) continue;
    if (norm === entry) return true;
    if (entry === "astack_trust" && (norm === "astack-trust" || norm === "astack/trust")) {
      return true;
    }
  }
  return false;
}

function isEngineeringMcpServer(serverName, workspaceDir, options = {}) {
  if (Array.isArray(options.engineeringMcpServers)) {
    return matchesAllowedMcpServer(serverName, options.engineeringMcpServers);
  }
  if (matchesAllowedMcpServer(serverName, DEFAULT_ENGINEERING_MCP_SERVERS)) {
    return true;
  }
  if (!workspaceDir) return false;
  const baseRef = resolveBaseRef(workspaceDir);
  if (!baseRef) return false;
  const { policy } = loadRiskPolicy(workspaceDir, { baseRef });
  return matchesAllowedMcpServer(serverName, policy.engineeringMcpServers);
}

/**
 * Appends a single-actor PostToolUse execution receipt to `<trustDir>/receipts.<conversationId>.jsonl`.
 */
export function recordReceipt(event, options = {}) {
  if (!event || !RECORDABLE_RECEIPT_KINDS.has(event.kind)) {
    return null;
  }
  const hasExplicitOverride = Boolean(options.trustDir && options.headSha);
  if (!hasExplicitOverride) {
    const scope = resolveWorkspaceScope(event.workspaceDir, { checkEnrollment: false });
    if (scope.kind === "non_repo") {
      return null;
    }
  }
  if (event.kind === "tool-mcp" && !isEngineeringMcpServer(event.serverName, event.workspaceDir, options)) {
    return null;
  }
  if (event.kind === "tool-write" && isNonWorkspaceWritePath(event.filePath, event)) {
    return null;
  }
  const trustDir = options.trustDir ?? resolveTrustDir(event);
  if (!trustDir) return null;

  const headSha = options.headSha ?? readHeadShaFast(event.workspaceDir);
  const shape = buildReceiptShape(event);
  const entry = {
    schemaVersion: 1,
    ts: options.now ?? new Date().toISOString(),
    conversationId: event.conversationId || "default",
    kind: shape.kind,
    category: shape.category,
    headSha,
    treeDirty: shape.treeDirty,
    ok: !event.error,
    modelName: event.modelName ?? null,
    summary: shape.summary,
    paths: shape.paths,
  };

  fs.mkdirSync(trustDir, { recursive: true });
  const targetFile = path.join(trustDir, `receipts.${entry.conversationId}.jsonl`);
  fs.appendFileSync(targetFile, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/**
 * Appends a verifier verdict receipt into the active trust directory.
 */
export function recordVerifierReceipt({
  trustDir,
  conversationId = "verifier",
  headSha = null,
  verdict,
  findingsPath = null,
  now = new Date().toISOString(),
}) {
  if (!trustDir) return null;
  fs.mkdirSync(trustDir, { recursive: true });
  const entry = {
    schemaVersion: 1,
    ts: now,
    conversationId,
    kind: "verifier",
    category: "verify",
    headSha,
    treeDirty: false,
    ok: verdict === "PASS" || verdict === "PASS_WITH_NOTES",
    summary: `pr-verifier ${verdict}${findingsPath ? ` (${path.basename(findingsPath)})` : ""}`,
    paths: findingsPath ? [findingsPath] : [],
    verdict,
  };
  const targetFile = path.join(trustDir, `receipts.${conversationId}.jsonl`);
  fs.appendFileSync(targetFile, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/**
 * Reads and merges all per-actor receipt logs under `trustDir` sorted chronologically.
 */
export function readMergedReceipts(trustDir) {
  if (!trustDir || !fs.existsSync(trustDir)) return [];
  const entries = [];
  const seen = new Set();
  const files = fs
    .readdirSync(trustDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /^receipts(?:\..+)?\.jsonl$/i.test(d.name))
    .map((d) => d.name)
    .sort();

  for (const name of files) {
    const raw = fs.readFileSync(path.join(trustDir, name), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        const dedupeKey = `${parsed.ts}|${parsed.conversationId}|${parsed.kind}|${parsed.summary}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push(parsed);
      } catch {
        // Ignore truncated partial line from concurrent or crashed writer.
      }
    }
  }

  entries.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));
  return entries;
}

/**
 * Reads `evidence.json` safely, returning `null` if absent or unreadable.
 */
export function readEvidenceSnapshot(trustDir) {
  if (!trustDir) return null;
  const filePath = path.join(trustDir, "evidence.json");
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically persists `evidence.json` via temporary file + rename.
 */
export function writeEvidenceSnapshotAtomic(trustDir, evidence) {
  fs.mkdirSync(trustDir, { recursive: true });
  const target = path.join(trustDir, "evidence.json");
  const tmp = path.join(
    trustDir,
    `evidence.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`,
  );
  fs.writeFileSync(tmp, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return target;
}

const VERIFY_CATEGORIES = new Set(["test", "verify", "lint", "build"]);

/**
 * Evaluates verification freshness against HEAD SHA, patch-id, and write timestamps.
 */
export function computeFreshness({
  receipts = [],
  headSha = null,
  patchId = null,
  priorEvidence = null,
  treeDirty = false,
} = {}) {
  const verifyReceipts = receipts.filter(
    (r) =>
      r.ok &&
      (r.kind === "verifier" || (r.kind === "command" && VERIFY_CATEGORIES.has(r.category))),
  );
  if (verifyReceipts.length === 0) {
    return "missing_receipts";
  }
  const latestVerify = verifyReceipts[verifyReceipts.length - 1];
  const writes = receipts.filter((r) => r.kind === "file_write" && !isNonWorkspaceReceipt(r));
  const latestWrite = writes.length > 0 ? writes[writes.length - 1] : null;

  if (treeDirty || (latestWrite && String(latestWrite.ts) > String(latestVerify.ts))) {
    return "dirty_after_verify";
  }
  if (headSha && latestVerify.headSha === headSha) {
    return "fresh";
  }
  if (
    patchId &&
    priorEvidence?.patchId === patchId &&
    (priorEvidence?.freshness === "fresh" || priorEvidence?.freshness === "fresh_rebase_patch_id")
  ) {
    return "fresh_rebase_patch_id";
  }
  return "stale_sha";
}

/**
 * Computes the remediation round state machine (`open -> fixing -> escalated | verified`).
 */
export function evaluateRoundState({
  reviewRound = 0,
  verdict = null,
  maxReviewRounds = 3,
  fresh = false,
} = {}) {
  if (verdict === "ESCALATE_HUMAN" || (reviewRound >= maxReviewRounds && verdict === "FAIL")) {
    return "escalated";
  }
  if ((verdict === "PASS" || verdict === "PASS_WITH_NOTES") && fresh) {
    return "verified";
  }
  if (verdict === "FAIL") {
    return "fixing";
  }
  return "open";
}

/**
 * Evaluates the `Stop` verification reminder against session receipts, git tree cleanliness, and loop caps.
 */
export function evaluateVerifyReminder(event, options = {}) {
  if (!event || event.kind !== "stop") {
    return { decision: "allow" };
  }
  if (event.continuationActive === true || event.fullyIdle === false) {
    return { decision: "allow" };
  }
  if (event.terminationReason !== "model_stop") {
    return { decision: "allow" };
  }
  if (typeof event.executionNum === "number" && event.executionNum > 2) {
    return { decision: "allow" };
  }
  if (options.requireVerify === false || process.env.ASTACK_REQUIRE_VERIFY === "0") {
    return { decision: "allow" };
  }

  const workspaceDir = event.workspaceDir || "";
  const hasExplicitOverride = options.gitStatus !== undefined || Boolean(options.trustDir && options.headSha);
  if (!hasExplicitOverride) {
    const scope = resolveWorkspaceScope(workspaceDir, { checkEnrollment: false });
    if (scope.kind === "non_repo") {
      return { decision: "allow" };
    }
  }
  let dirtyCode = [];
  if (options.gitStatus !== undefined || (workspaceDir && fs.existsSync(workspaceDir))) {
    let status = options.gitStatus;
    if (status === undefined) {
      try {
        status = execFileSync("git", ["status", "--porcelain"], {
          cwd: workspaceDir,
          encoding: "utf8",
          timeout: 3000,
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        status = "";
      }
    }
    dirtyCode = String(status ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/\.md$/i.test(line));
  }

  const hasExplicitTrust = Boolean(options.trustDir);
  const trustDir = options.trustDir ?? resolveTrustDir(event);
  const evidence = readWithFallback(trustDir, workspaceDir, hasExplicitTrust, readEvidenceSnapshot);
  const receipts = readWithFallback(trustDir, workspaceDir, hasExplicitTrust, readMergedReceipts);
  const headSha = options.headSha ?? (workspaceDir ? readHeadShaFast(workspaceDir) : null);

  const hasCodeWriteReceipts = receipts.some(
    (r) =>
      r.kind === "file_write" &&
      !isNonWorkspaceReceipt(r) &&
      Array.isArray(r.paths) &&
      r.paths.some((p) => !/\.md$/i.test(String(p))),
  );

  if (dirtyCode.length === 0 && !hasCodeWriteReceipts) {
    return { decision: "allow" };
  }

  const freshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
  if (freshness === "fresh" || freshness === "fresh_rebase_patch_id") {
    return { decision: "allow" };
  }

  return {
    decision: "continue",
    reason:
      `AStack verify-reminder (freshness=${freshness}): code changes exist without fresh HEAD verification receipts. Run the relevant test suite or Control Glass check (\`control-ui\` / \`control-cli\`) and \`/deslop\` before stopping (set ASTACK_REQUIRE_VERIFY=0 to suppress).`,
  };
}

function isEscalatedEvidence(evidence, maxRounds = evidence?.maxReviewRounds ?? 3) {
  if (!evidence) return false;
  return (
    evidence.roundState === "escalated" ||
    evidence.verifier?.verdict === "ESCALATE_HUMAN" ||
    ((evidence.reviewRound ?? 0) >= maxRounds && evidence.verifier?.verdict === "FAIL")
  );
}

const PR_INTENT_REGEX =
  /\b(?:open|create|submit|raise|prepare|make|draft|update|refresh|generate)\s+(?:a\s+|an\s+|the\s+|this\s+|my\s+|our\s+)?(?:pr|pull\s+request)\b|\b(?:update|refresh|generate|write|build)\s+(?:the\s+|my\s+)?pr\s+description\b/i;
const PR_QUESTION_ONLY_REGEX =
  /^\s*(?:what\s+is|explain|tell\s+me\s+about|how\s+(?:does|do)\s+(?:a\s+)?pr)\b/i;
const GH_BODY_FLAGS = new Set(["-b", "--body", "-F", "--body-file"]);
const GH_FILL_FLAGS = new Set(["-f", "--fill", "--fill-first", "--fill-verbose"]);
const WRAPPER_VERBS = new Set(["npx", "pnpm", "yarn", "pnpx", "bunx", "uvx", "sudo", "env"]);
const GIT_FLAG_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const GH_FLAG_WITH_ARG = new Set(["-R", "--repo"]);

function discoverVerifyFeaturesDir(workspaceDir) {
  if (!workspaceDir) return null;
  const skillsDir = path.join(workspaceDir, ".agents", "skills");
  if (!fs.existsSync(skillsDir)) return null;
  const dirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("verify-"))
    .map((d) => d.name)
    .sort();
  for (const name of dirs) {
    const featDir = path.join(skillsDir, name, "features");
    if (fs.existsSync(featDir) && fs.statSync(featDir).isDirectory()) {
      return path.posix.join(".agents", "skills", name, "features");
    }
  }
  return null;
}

function readWithFallback(primaryTrustDir, workspaceDir, hasExplicitTrustDir, reader) {
  let result = reader(primaryTrustDir);
  const empty = Array.isArray(result) ? result.length === 0 : !result;
  if (empty && !hasExplicitTrustDir && workspaceDir) {
    const fallbackDir = resolveTrustDir({ workspaceDir, artifactDir: null });
    if (fallbackDir && fallbackDir !== primaryTrustDir) {
      result = reader(fallbackDir);
    }
  }
  return result;
}

function extractCliPrActions(command) {
  const actions = [];
  for (const segment of collectLeafSegments(String(command ?? ""))) {
    const tokens = tokenizeSimpleWords(segment);
    let idx = 0;
    if (tokens[0] === "&") idx++;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
    let verb = "";
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (tok.startsWith("-")) {
        idx++;
        continue;
      }
      const base = path.win32.basename(tok.replace(/\//g, "\\")).toLowerCase().replace(/\.exe$/, "");
      if (WRAPPER_VERBS.has(base)) {
        idx++;
        continue;
      }
      verb = base;
      idx++;
      break;
    }
    if (verb === "git") {
      let skipNext = false;
      for (let i = idx; i < tokens.length; i++) {
        const tok = tokens[i];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (GIT_FLAG_WITH_ARG.has(tok)) {
          skipNext = true;
          continue;
        }
        if (tok.startsWith("-")) continue;
        if (tok.toLowerCase() === "push") {
          actions.push({ kind: "git-push" });
        }
        break;
      }
    } else if (verb === "gh") {
      const positionals = [];
      let skipNext = false;
      for (let i = idx; i < tokens.length; i++) {
        const tok = tokens[i];
        if (skipNext) {
          skipNext = false;
          continue;
        }
        if (GH_FLAG_WITH_ARG.has(tok)) {
          skipNext = true;
          continue;
        }
        if (tok.startsWith("--repo=")) continue;
        if (tok.startsWith("-")) continue;
        positionals.push({ value: tok.toLowerCase(), index: i });
        if (positionals.length >= 2) break;
      }
      if (positionals[0]?.value === "pr") {
        const sub2 = positionals[1]?.value;
        const rest = tokens.slice((positionals[1]?.index ?? idx) + 1);
        if (sub2 === "create" || sub2 === "new") {
          actions.push({ kind: "gh-pr-create", tokens: rest });
        } else if (sub2 === "edit") {
          const touchesBody = rest.some(
            (t) =>
              GH_BODY_FLAGS.has(t) ||
              t.toLowerCase().startsWith("--body=") ||
              t.toLowerCase().startsWith("--body-file="),
          );
          if (touchesBody) {
            actions.push({ kind: "gh-pr-edit-body", tokens: rest });
          }
        }
      }
    }
  }
  return actions;
}

function extractGhBodyText(tokens, workspaceDir) {
  let bodyText = null;
  let bodyFile = null;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const lower = tok.toLowerCase();
    if (GH_FILL_FLAGS.has(tok) || GH_FILL_FLAGS.has(lower)) {
      return {
        error:
          "gh --fill flags bypass the PR statechart and proof contract; run pr-dossier.mjs --format github --out <body-file> and pass --body-file <body-file>",
      };
    }
    if (tok === "-b" || lower === "--body") {
      bodyText = tokens[++i] ?? "";
    } else if (lower.startsWith("--body=")) {
      bodyText = tok.slice("--body=".length);
    } else if (tok === "-F" || lower === "--body-file") {
      bodyFile = tokens[++i] ?? "";
    } else if (lower.startsWith("--body-file=")) {
      bodyFile = tok.slice("--body-file=".length);
    }
  }

  if (bodyFile !== null) {
    if (bodyFile === "-") {
      return {
        error:
          "stdin PR body (-F -) cannot be pre-validated; pass --body-file <path-to-compiled-pr-body.md>",
      };
    }
    const abs = path.isAbsolute(bodyFile)
      ? bodyFile
      : path.resolve(workspaceDir || process.cwd(), bodyFile);
    if (!fs.existsSync(abs)) {
      return { error: `PR body file not found (${bodyFile})` };
    }
    return { bodyText: fs.readFileSync(abs, "utf8") };
  }
  if (bodyText !== null) {
    return { bodyText };
  }
  return { error: "missing --body-file from pr-dossier.mjs --format github" };
}

/**
 * Evaluates a `PreInvocation` payload and injects PR proof instructions when the user asks to open or update a PR.
 */
export function evaluatePrIntent(event, options = {}) {
  if (!event || event.kind !== "pre-invocation") {
    return {};
  }
  const text = String(event.lastUserInput ?? "").trim();
  if (!text || PR_QUESTION_ONLY_REGEX.test(text) || !PR_INTENT_REGEX.test(text)) {
    return {};
  }

  const workspaceDir = event.workspaceDir || "";
  const hasExplicitOverride = Boolean(options.trustDir || options.headSha);
  if (!hasExplicitOverride) {
    const scope = resolveWorkspaceScope(workspaceDir, { checkEnrollment: false });
    if (scope.kind === "non_repo") {
      return {};
    }
  }
  const headSha = options.headSha ?? (workspaceDir ? readHeadShaFast(workspaceDir) : null);
  const trustDir = options.trustDir ?? resolveTrustDir(event);
  const promptHash = crypto
    .createHash("sha256")
    .update(`${headSha ?? "none"}|${text.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);

  if (trustDir) {
    const stateFile = path.join(trustDir, `pr-intent.${event.conversationId || "default"}.json`);
    try {
      if (fs.existsSync(stateFile)) {
        const prev = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (prev?.lastHash === promptHash) {
          return {};
        }
      }
      fs.mkdirSync(trustDir, { recursive: true });
      fs.writeFileSync(
        stateFile,
        `${JSON.stringify({ lastHash: promptHash, ts: new Date().toISOString() })}\n`,
        "utf8",
      );
    } catch {
      // Fail-open if state file cannot be read or written.
    }
  }

  const hasExplicitTrust = Boolean(options.trustDir);
  const evidence = readWithFallback(trustDir, workspaceDir, hasExplicitTrust, readEvidenceSnapshot);
  const receipts = readWithFallback(trustDir, workspaceDir, hasExplicitTrust, readMergedReceipts);
  const freshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });

  const fallbackTrustDir =
    !hasExplicitTrust && event.artifactDir && workspaceDir
      ? resolveTrustDir({ workspaceDir, artifactDir: null })
      : null;
  const hasManifest = Boolean(
    (trustDir && fs.existsSync(path.join(trustDir, "proof-manifest.json"))) ||
      (fallbackTrustDir && fs.existsSync(path.join(fallbackTrustDir, "proof-manifest.json"))),
  );
  const featureDir = discoverVerifyFeaturesDir(workspaceDir);

  const artifactFlag = event.artifactDir ? ` --artifact-dir "${event.artifactDir}"` : "";
  const featureFlag = featureDir ? ` --feature-map "${featureDir}"` : "";
  const manifestStatus = hasManifest
    ? "Detected `proof-manifest.json` in trust directory."
    : "No `proof-manifest.json` detected; compiler will synthesize from Feature Map or HEAD verification receipts.";

  const ephemeralMessage = [
    `AStack PR proof workflow triggered (HEAD \`${(headSha ?? "none").slice(0, 7)}\`, freshness \`${freshness}\`).`,
    manifestStatus,
    `Run \`node skills/review-pr/scripts/pr-dossier.mjs --format github${artifactFlag}${featureFlag} --out <body-file>\` (pass \`--merge-body <body-file>\` to keep human sections) before opening or updating the PR.`,
    "Pass `--body-file <body-file>` to `gh pr create` or pass the compiled Markdown body to `github-mcp-server`, keeping `## Why`, `## What changed`, `## Scope`, and `## Blast Radius` concise per `skills/astack-mode/playbooks/opening-a-pr.md`.",
  ].join("\n");

  return {
    injectSteps: [
      {
        ephemeralMessage,
      },
    ],
  };
}

/**
 * Checks whether a push or PR create/edit command or MCP call has fresh HEAD evidence and satisfies base PR-body policy.
 */
export function evaluateEvidenceGate(event, options = {}) {
  if (!event || (event.kind !== "tool-command" && event.kind !== "tool-mcp")) {
    return { decision: "allow" };
  }

  let actions = [];
  if (event.kind === "tool-command") {
    actions = extractCliPrActions(event.command);
  } else {
    const mcpTool = String(event.toolName ?? "").toLowerCase();
    if (mcpTool === "create_pull_request") {
      actions = [{ kind: "mcp-pr-create", body: event.args?.body }];
    } else if (mcpTool === "update_pull_request" && typeof event.args?.body === "string") {
      actions = [{ kind: "mcp-pr-edit-body", body: event.args.body }];
    }
  }
  if (actions.length === 0) {
    return { decision: "allow" };
  }

  const hasExplicitOverride = Boolean(options.trustDir && options.headSha);
  if (!hasExplicitOverride) {
    const scope = resolveWorkspaceScope(event.workspaceDir, { checkEnrollment: false });
    if (scope.kind === "non_repo") {
      return { decision: "allow" };
    }
  }

  const hasExplicitTrust = Boolean(options.trustDir);
  const trustDir = options.trustDir ?? resolveTrustDir(event);
  const evidence = readWithFallback(trustDir, event.workspaceDir, hasExplicitTrust, readEvidenceSnapshot);
  const receipts = readWithFallback(trustDir, event.workspaceDir, hasExplicitTrust, readMergedReceipts);
  const headSha = options.headSha ?? readHeadShaFast(event.workspaceDir);
  const headless = options.headless ?? false;
  const policy =
    options.policy ??
    loadRiskPolicy(event.workspaceDir, {
      baseRef: options.baseRef ?? resolveBaseRef(event.workspaceDir),
    }).policy;

  const reasons = [];
  const needsFreshness = actions.some(
    (a) => a.kind === "git-push" || a.kind === "gh-pr-create" || a.kind === "mcp-pr-create",
  );

  if (needsFreshness) {
    const receiptFreshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
    let freshness;
    if (evidence && headSha && evidence.headSha === headSha) {
      if (evidence.freshness === "fresh" || evidence.freshness === "fresh_rebase_patch_id") {
        const hasNewerWrite = receipts.some(
          (r) => r.kind === "file_write" && !isNonWorkspaceReceipt(r) && String(r.ts ?? "") > String(evidence.generatedAt ?? ""),
        );
        freshness = hasNewerWrite ? "dirty_after_verify" : evidence.freshness;
      } else if (receiptFreshness === "fresh" || receiptFreshness === "fresh_rebase_patch_id") {
        freshness = receiptFreshness;
      } else {
        freshness = evidence.freshness;
      }
    } else {
      freshness = receiptFreshness;
    }

    const maxRounds = options.maxReviewRounds ?? evidence?.maxReviewRounds ?? 3;
    if (!evidence && freshness === "missing_receipts") {
      reasons.push("no verification receipts or evidence.json found for current branch");
    } else if (freshness !== "fresh" && freshness !== "fresh_rebase_patch_id") {
      reasons.push(`verification freshness is ${freshness}`);
    }
    if (evidence?.assertionDelta?.flagged) {
      reasons.push(`test assertions weakened (${evidence.assertionDelta.weakeningRatio})`);
    }
    if (isEscalatedEvidence(evidence, maxRounds)) {
      reasons.push(
        evidence?.verifier?.verdict === "ESCALATE_HUMAN"
          ? "review remediation escalated for human review"
          : `review remediation hit ${maxRounds}-round escalation cap`,
      );
    }
  }

  const prContract = policy?.prDescriptionContract;
  if (prContract?.enabled === true) {
    for (const act of actions) {
      if (act.kind === "git-push") continue;
      let bodyText = "";
      if (act.kind === "gh-pr-create" || act.kind === "gh-pr-edit-body") {
        const extracted = extractGhBodyText(act.tokens, event.workspaceDir);
        if (extracted.error) {
          reasons.push(extracted.error);
          continue;
        }
        bodyText = extracted.bodyText;
      } else {
        bodyText = String(act.body ?? "");
      }
      const check = validatePrBodyContract(bodyText, prContract);
      if (!check.ok) {
        reasons.push(`PR description contract violation (${check.violations.join("; ")})`);
      }
    }
  }

  if (reasons.length === 0) {
    return { decision: "allow" };
  }

  const detail = reasons.join("; ");
  return {
    decision: headless ? "deny" : "force_ask",
    reason: headless
      ? `AStack evidence-gate: blocked push/PR in headless mode (${detail}).`
      : `AStack evidence-gate: ${detail}. Run verification or pr-dossier.mjs --format github before continuing.`,
  };
}

/**
 * Halts autonomous edit retries after 3 failed review rounds so a human reviews the blocker.
 */
export function evaluateRoundLimit(event, options = {}) {
  if (!event || event.kind === "stop") {
    return { decision: "allow" };
  }
  if (event.kind !== "tool-write") {
    return { decision: "allow" };
  }
  if (!options.trustDir) {
    const scope = resolveWorkspaceScope(event.workspaceDir, { checkEnrollment: false });
    if (scope.kind === "non_repo") {
      return { decision: "allow" };
    }
  }
  const trustDir = options.trustDir ?? resolveTrustDir(event);
  const evidence = readEvidenceSnapshot(trustDir);
  if (!evidence) return { decision: "allow" };

  const maxRounds = options.maxReviewRounds ?? evidence?.maxReviewRounds ?? 3;
  if (!isEscalatedEvidence(evidence, maxRounds)) return { decision: "allow" };

  const headless = options.headless ?? false;
  return {
    decision: headless ? "deny" : "force_ask",
    reason: headless
      ? `AStack round-limiter: blocked edit after ${evidence.reviewRound}/${maxRounds} failed review rounds.`
      : `AStack round-limiter: remediation reached ${evidence.reviewRound}/${maxRounds} failed rounds. Escalate to human review or approve override.`,
  };
}
