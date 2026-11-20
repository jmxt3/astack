import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

function findGitEntry(startDir) {
  if (!startDir) return null;
  let current = path.resolve(startDir);
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
  const stat = fs.statSync(found.dotGitPath);
  if (stat.isDirectory()) {
    return {
      repoRoot: found.repoRoot,
      gitDir: found.dotGitPath,
      commonDir: found.dotGitPath,
    };
  }
  if (!stat.isFile()) return null;
  const raw = fs.readFileSync(found.dotGitPath, "utf8");
  const match = raw.match(/^gitdir:\s*(.+)$/im);
  if (!match) return null;
  const gitDir = path.resolve(found.repoRoot, match[1].trim());
  const commonFile = path.join(gitDir, "commondir");
  let commonDir = gitDir;
  if (fs.existsSync(commonFile)) {
    const relCommon = fs.readFileSync(commonFile, "utf8").trim();
    if (relCommon) commonDir = path.resolve(gitDir, relCommon);
  }
  return { repoRoot: found.repoRoot, gitDir, commonDir };
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
    return path.join(path.resolve(workspaceDir), ".tmp", "astack-trust");
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

function normalizeRelPath(workspaceDir, filePath) {
  if (!filePath) return "";
  if (!workspaceDir) return filePath.replace(/\\/g, "/");
  const abs = path.resolve(workspaceDir, filePath);
  const rel = path.relative(path.resolve(workspaceDir), abs).split(path.sep).join("/");
  return rel && !rel.startsWith("..") ? rel : filePath.replace(/\\/g, "/");
}

/**
 * Appends a single-actor PostToolUse execution receipt to `<trustDir>/receipts.<conversationId>.jsonl`.
 */
export function recordReceipt(event, options = {}) {
  if (!event || (event.kind !== "tool-command" && event.kind !== "tool-write")) {
    return null;
  }
  const trustDir = options.trustDir ?? resolveTrustDir(event);
  if (!trustDir) return null;

  const headSha = options.headSha ?? readHeadShaFast(event.workspaceDir);
  const isCommand = event.kind === "tool-command";
  const category = isCommand ? classifyCommandCategory(event.command) : "other";
  const entry = {
    schemaVersion: 1,
    ts: options.now ?? new Date().toISOString(),
    conversationId: event.conversationId || "default",
    kind: isCommand ? "command" : "file_write",
    category,
    headSha,
    treeDirty: isCommand ? null : true,
    ok: !event.error,
    summary: redactSummary(isCommand ? event.command : `${event.tool} ${event.filePath}`),
    paths: isCommand || !event.filePath ? [] : [normalizeRelPath(event.workspaceDir, event.filePath)],
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
  const writes = receipts.filter((r) => r.kind === "file_write");
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
 * Evaluates the `Stop` verification reminder across Antigravity and legacy payloads.
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

  const requireVerify = options.requireVerify ?? process.env.ASTACK_REQUIRE_VERIFY === "1";
  if (!requireVerify) {
    return { decision: "allow" };
  }

  const workspaceDir = event.workspaceDir;
  if (!workspaceDir || !fs.existsSync(workspaceDir)) {
    return { decision: "allow" };
  }

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
      return { decision: "allow" };
    }
  }

  const dirtyCode = String(status)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/\.md$/i.test(line));

  if (dirtyCode.length === 0) {
    return { decision: "allow" };
  }

  return {
    decision: "continue",
    reason:
      "AStack verify-reminder (ASTACK_REQUIRE_VERIFY=1): uncommitted code changes detected. Confirm empirical verification ran against the real target (`control-ui`, `control-cli`, test suite) and run `/deslop` if finished.",
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

/**
 * Checks whether a push or PR creation command has fresh verification evidence on HEAD.
 */
export function evaluateEvidenceGate(event, options = {}) {
  if (!event || event.kind !== "tool-command") {
    return { decision: "allow" };
  }
  const cmd = String(event.command ?? "");
  if (!/\bgit\s+push\b|\bgh\s+pr\s+create\b/i.test(cmd)) {
    return { decision: "allow" };
  }

  const trustDir = options.trustDir ?? resolveTrustDir(event);
  const evidence = readEvidenceSnapshot(trustDir);
  const receipts = readMergedReceipts(trustDir);
  const headSha = options.headSha ?? readHeadShaFast(event.workspaceDir);
  const headless = options.headless ?? false;

  const receiptFreshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
  let freshness;
  if (evidence && headSha && evidence.headSha === headSha) {
    if (evidence.freshness === "fresh" || evidence.freshness === "fresh_rebase_patch_id") {
      const hasNewerWrite = receipts.some(
        (r) => r.kind === "file_write" && String(r.ts ?? "") > String(evidence.generatedAt ?? ""),
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
  const reasons = [];
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

  if (reasons.length === 0) {
    return { decision: "allow" };
  }

  const detail = reasons.join("; ");
  return {
    decision: headless ? "deny" : "force_ask",
    reason: headless
      ? `AStack evidence-gate: blocked push/PR in headless mode (${detail}).`
      : `AStack evidence-gate: ${detail}. Run verification or pr-dossier.mjs before continuing.`,
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
