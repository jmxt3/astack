import fs from "node:fs";
import path from "node:path";
import { isHeadless, sanitizeConversationId } from "./envelope.mjs";
import {
  detectSessionTestRegression,
  evaluateIntentScope,
  readIntentCard,
} from "./intent.mjs";
import {
  classifyCommandCategory,
  computeFreshness,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  resolveTrustDir,
} from "./ledger.mjs";
import { classifyActionClass, resolveResidual } from "./mitigation.mjs";
import {
  isProtectedTrustStorePath,
  readTrustSettings,
  resolvePluginDataDir,
} from "./outcomes.mjs";
import {
  collectLeafSegments,
  evaluateDecisionTable,
  loadBoundaries,
  loadRiskPolicy,
  resolveEnrolledWorkspaceScope,
  tokenizeSimpleWords,
} from "./policy.mjs";
import { assessChange, classifyFileCategory } from "./risk.mjs";
import { evaluateRepoTrust } from "./trust-level.mjs";

const READ_ONLY_VERBS = new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "ls",
  "dir",
  "get-childitem",
  "gci",
  "rg",
  "ripgrep",
  "grep",
  "select-string",
  "sls",
  "findstr",
  "stat",
  "wc",
]);

const MUTATING_TRUST_CLI_CMDS = new Set([
  "beast",
  "promotion",
  "ceiling",
  "promote",
  "undo",
  "record-outcome",
]);

const SHELL_WRITE_OPERATOR_RE = /(?:>>?|\|\s*tee\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b)/i;
const TRUST_STORE_HINT_RE =
  /(?:plugin-data[\\/]+astack[\\/]+trust|\$\{?PLUGIN_DATA\}?[\\/]+trust|\$env:(?:ASTACK_PLUGIN_DATA|ANTIGRAVITY_PLUGIN_DATA|PLUGIN_DATA)[\\/]+trust)/i;

function normalizePosixLower(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function getLeadingVerb(tokens) {
  let idx = 0;
  if (tokens[0] === "&") idx++;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  while (idx < tokens.length && tokens[idx].startsWith("-")) idx++;
  if (idx >= tokens.length) return "";
  return path.win32.basename(tokens[idx].replace(/\//g, "\\")).toLowerCase().replace(/\.exe$/, "");
}

/**
 * Returns true when a shell command attempts to modify `${PLUGIN_DATA}/trust/**` or run mutating `scripts/trust/cli.mjs` commands.
 */
export function isProtectedTrustShellCommand(command, options = {}) {
  const raw = String(command ?? "").trim();
  if (!raw) return false;

  const resolvedTrustRoot = normalizePosixLower(
    path.resolve(path.join(resolvePluginDataDir(options), "trust")),
  );

  for (const segment of collectLeafSegments(raw)) {
    const tokens = tokenizeSimpleWords(segment);
    if (tokens.length === 0) continue;

    for (let i = 0; i < tokens.length; i++) {
      const cleanTok = normalizePosixLower(tokens[i]);
      if (cleanTok.endsWith("scripts/trust/cli.mjs") || cleanTok.endsWith("/trust/cli.mjs") || cleanTok === "trust/cli.mjs") {
        for (let j = i + 1; j < tokens.length; j++) {
          const arg = tokens[j].toLowerCase();
          if (arg.startsWith("-")) continue;
          if (MUTATING_TRUST_CLI_CMDS.has(arg)) {
            return true;
          }
          break;
        }
      }
    }

    const normSeg = normalizePosixLower(segment);
    const touchesResolvedDir = Boolean(resolvedTrustRoot && normSeg.includes(resolvedTrustRoot));
    const touchesHint = TRUST_STORE_HINT_RE.test(segment);
    const touchesTokenPath = tokens.some(
      (tok) =>
        (tok.includes("/") || tok.includes("\\")) &&
        isProtectedTrustStorePath(tok, { dataDir: options.dataDir }),
    );

    if (touchesResolvedDir || touchesHint || touchesTokenPath) {
      const verb = getLeadingVerb(tokens);
      const pureRead = READ_ONLY_VERBS.has(verb) && !SHELL_WRITE_OPERATOR_RE.test(segment);
      if (!pureRead) {
        return true;
      }
    }
  }

  return false;
}

function buildPendingWriteAssessment({ event, scope, policy, receipts, evidence, intent, headSha }) {
  const relPath = path
    .relative(path.resolve(scope.repoRoot), path.resolve(scope.repoRoot, event.filePath))
    .split(path.sep)
    .join("/");
  const cleanRel = relPath.startsWith("..") ? event.filePath.replace(/\\/g, "/") : relPath;
  const chunkLines = (Array.isArray(event.chunks) ? event.chunks : []).join("\n").split(/\r?\n/);
  const addedDiff = chunkLines.map((line) => `+${line}`).join("\n");
  const diffText = `diff --git a/${cleanRel} b/${cleanRel}\n--- a/${cleanRel}\n+++ b/${cleanRel}\n@@ -1,0 +1,${chunkLines.length} @@\n${addedDiff}\n`;
  const numstat = `${chunkLines.length}\t0\t${cleanRel}\n`;
  const boundaries = loadBoundaries(scope.repoRoot).boundaries;
  const raw = assessChange({
    diffText,
    numstat,
    statusText: ` M ${cleanRel}\n`,
    policy,
    receipts,
    boundaries,
    intent,
    action: "local_write",
    headSha,
  });
  return resolveResidual(raw, receipts, {
    headSha,
    priorEvidence: evidence,
    intent,
  });
}

function buildActionAssessment({ event, action, scope, policy, receipts, evidence, intent, headSha }) {
  if (event.kind === "tool-write" && event.filePath) {
    return buildPendingWriteAssessment({ event, scope, policy, receipts, evidence, intent, headSha });
  }
  if (evidence?.riskAssessment) {
    const base = structuredClone(evidence.riskAssessment);
    const reg = detectSessionTestRegression(receipts);
    if (reg.regressed && !base.signals.some((s) => s.id === "test_regression")) {
      base.signals.push({
        id: "test_regression",
        severity: 3,
        evidence: `regressed test(s): ${reg.commands.slice(0, 2).join(", ")}`,
      });
      base.residual = "blocked";
    }
    return base;
  }
  const reg = detectSessionTestRegression(receipts);
  const category = intent?.category ?? "core";
  const signals = [];
  if (reg.regressed) {
    signals.push({
      id: "test_regression",
      severity: 3,
      evidence: `regressed test(s): ${reg.commands.slice(0, 2).join(", ")}`,
    });
  }
  const hasTestReceipt = receipts.some(
    (r) => r?.ok && r.kind === "command" && (r.category === "test" || r.category === "verify"),
  );
  const score = reg.regressed ? 0.85 : hasTestReceipt ? 0.05 : 0.1;
  return {
    action,
    category,
    tier: reg.regressed ? 3 : 1,
    signals,
    score,
    inherent: reg.regressed ? "critical" : "low",
    requiredMitigations: reg.regressed ? ["regression_green"] : [],
    satisfied: [],
    residual: reg.regressed ? "blocked" : "low",
    rollback: { kind: "checkout", plan: intent?.rollbackPlan || "git checkout -- ." },
    predictedAt: new Date().toISOString(),
    headSha: headSha ?? null,
  };
}

/**
 * Evaluates `PreToolUse` autonomy decisions strictly on enrolled repos while denying agent mutations to `${PLUGIN_DATA}/trust/**`.
 */
export function evaluateTrustGate(event, options = {}) {
  if (!event || (event.kind !== "tool-write" && event.kind !== "tool-command" && event.kind !== "tool-mcp")) {
    return { decision: "allow" };
  }

  if (
    event.kind === "tool-write" &&
    isProtectedTrustStorePath(event.filePath, { dataDir: options.dataDir })
  ) {
    return {
      decision: "deny",
      reason: "AStack trust-gate: agent writes to protected trust ledger or human settings are forbidden.",
    };
  }
  if (
    event.kind === "tool-command" &&
    isProtectedTrustShellCommand(event.command, { dataDir: options.dataDir })
  ) {
    return {
      decision: "deny",
      reason: "AStack trust-gate: shell commands modifying protected trust ledger or human settings are forbidden.",
    };
  }

  try {
    const scope =
      options.scope ?? resolveEnrolledWorkspaceScope(event.workspaceDir, { baseRef: options.baseRef });
    if (!scope || scope.kind !== "enrolled_repo" || !scope.repoId) {
      return { decision: "allow" };
    }

    const action = options.action ?? classifyActionClass(event);
    if (action === "read") {
      return { decision: "allow" };
    }

    const policyLoaded = options.policy
      ? { policy: options.policy, error: null }
      : loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
    if (policyLoaded.error) {
      return { decision: "allow" };
    }
    const policy = policyLoaded.policy;

    const settingsRes = readTrustSettings(scope.repoId, { dataDir: options.dataDir });
    if (settingsRes.parseError) {
      return { decision: "allow" };
    }

    const trust =
      options.trust ??
      evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir: options.dataDir,
        nowMs: options.nowMs,
      });
    if (!trust || trust.frozen || !trust.chainValid) {
      return { decision: "allow" };
    }

    const trustDir = options.trustDir ?? resolveTrustDir(event);
    const evidence = options.evidence !== undefined ? options.evidence : readEvidenceSnapshot(trustDir);
    const receipts = options.receipts !== undefined ? options.receipts : readMergedReceipts(trustDir);
    const headSha = options.headSha ?? readHeadShaFast(scope.repoRoot);
    const intent =
      options.intent !== undefined
        ? options.intent
        : readIntentCard(trustDir, event.conversationId || "default");
    const headless = options.headless ?? isHeadless();

    const assessment =
      options.assessment ??
      buildActionAssessment({ event, action, scope, policy, receipts, evidence, intent, headSha });

    if (
      action === "local_exec" &&
      ["test", "verify", "lint"].includes(classifyCommandCategory(event.command))
    ) {
      const nonRegBlockers = (assessment.signals ?? []).filter(
        (s) => s.id !== "test_regression" && s.severity === 3,
      );
      if (assessment.residual === "blocked" && nonRegBlockers.length === 0) {
        return { decision: "allow" };
      }
    }

    const category = assessment.category ?? "core";
    const catState = trust.categories?.[category] ?? { level: 0, score: 0 };

    if (
      action === "local_write" &&
      trust.beastOn &&
      !intent &&
      (catState.level <= 1 || assessment.residual !== "low")
    ) {
      const askDecision = headless ? "deny" : "force_ask";
      const verb = headless ? "Blocked" : "Paused";
      return {
        decision: askDecision,
        reason: `${verb}. Local write needs an Intent Card (declare_intent) before editing ${category} at L${catState.level} (T ${catState.score.toFixed(2)}). Residual ${assessment.residual} (R ${Number(assessment.score ?? 0).toFixed(2)}).`,
      };
    }

    const result = evaluateDecisionTable({
      action,
      residual: assessment.residual,
      trustLevel: catState.level,
      category,
      trustScore: catState.score,
      riskScore: assessment.score,
      signals: assessment.signals,
      beastOn: trust.beastOn,
      policy,
      headless,
      isOwnRevert: Boolean(options.isOwnRevert),
    });

    if (result.decision === "deny" && result.reason) {
      const sigIds = new Set((assessment.signals ?? []).map((s) => s.id));
      if (sigIds.has("scope_drift") || sigIds.has("test_regression")) {
        return {
          decision: "deny",
          reason: `${result.reason} Escalate with the 2+ failed hypotheses tried or amend the Intent Card.`,
        };
      }
    }

    return result.reason ? { decision: result.decision, reason: result.reason } : { decision: result.decision };
  } catch {
    return { decision: "allow" };
  }
}

function handoffStatePath(trustDir, conversationId = "default") {
  return path.join(trustDir, `handoff.${sanitizeConversationId(conversationId)}.json`);
}

function readHandoffState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { transitions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.transitions
      ? parsed
      : { transitions: {} };
  } catch {
    return { transitions: {} };
  }
}

function writeHandoffStateAtomic(filePath, state) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function collectReceiptPaths(receipts = []) {
  const paths = new Set();
  for (const r of receipts) {
    if (r?.kind === "file_write" && Array.isArray(r.paths)) {
      for (const p of r.paths) {
        if (typeof p === "string" && p.trim()) paths.add(p.replace(/\\/g, "/"));
      }
    }
  }
  return [...paths];
}

function hasFreshVerifierPass({ receipts, evidence, headSha }) {
  const hasReceipt = receipts.some(
    (r) =>
      r?.kind === "verifier" &&
      r.ok &&
      (r.verdict === "PASS" || r.verdict === "PASS_WITH_NOTES") &&
      (!headSha || !r.headSha || r.headSha === headSha),
  );
  const verifier = evidence?.verifier ?? null;
  const hasEvidence = Boolean(
    verifier &&
      !verifier.stale &&
      (verifier.verdict === "PASS" || verifier.verdict === "PASS_WITH_NOTES") &&
      (verifier.importantCount ?? 0) === 0 &&
      (verifier.reviewViolationCount ?? 0) === 0 &&
      (!headSha || verifier.headSha === headSha),
  );
  return hasReceipt || hasEvidence;
}

function hasMergeCompleted(receipts = []) {
  return receipts.some(
    (r) =>
      r?.ok &&
      ((r.kind === "mcp" && /merge_pull_request/i.test(String(r.toolName ?? ""))) ||
        (r.kind === "command" && /\bgh\s+pr\s+merge\b/i.test(String(r.summary ?? "")))),
  );
}

function hasRollbackReady({ receipts, evidence, intent, headSha }) {
  if (receipts.some((r) => r?.kind === "rollback" && r.ok && (!headSha || !r.headSha || r.headSha === headSha))) {
    return true;
  }
  const rb = evidence?.riskAssessment?.rollback;
  if (rb && rb.kind && rb.kind !== "none" && typeof rb.plan === "string" && rb.plan.trim() && !/^manual rollback/i.test(rb.plan)) {
    return true;
  }
  return Boolean(intent?.rollbackPlan && String(intent.rollbackPlan).trim());
}

/**
 * Evaluates Beast Mode stage-to-stage `Stop` continuation with strict idle, receipt, breaker, human-gate, and transition-cap guards.
 */
export function evaluateStageHandoff(event, options = {}) {
  if (!event || event.kind !== "stop") return { decision: "allow" };
  if (event.fullyIdle !== true || event.terminationReason !== "model_stop") {
    return { decision: "allow" };
  }
  if (event.continuationActive === true) return { decision: "allow" };
  if (typeof event.executionNum === "number" && event.executionNum > 2) {
    return { decision: "allow" };
  }

  try {
    const scope =
      options.scope ?? resolveEnrolledWorkspaceScope(event.workspaceDir, { baseRef: options.baseRef });
    if (!scope || scope.kind !== "enrolled_repo" || !scope.repoId) {
      return { decision: "allow" };
    }

    const policyLoaded = options.policy
      ? { policy: options.policy, error: null }
      : loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
    if (policyLoaded.error) return { decision: "allow" };
    const policy = policyLoaded.policy;

    const settingsRes = readTrustSettings(scope.repoId, { dataDir: options.dataDir });
    if (settingsRes.parseError) return { decision: "allow" };

    const trust =
      options.trust ??
      evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir: options.dataDir,
        nowMs: options.nowMs,
      });
    if (!trust || !trust.beastOn || trust.frozen || !trust.chainValid) {
      return { decision: "allow" };
    }

    const trustDir = options.trustDir ?? resolveTrustDir(event);
    const evidence = options.evidence !== undefined ? options.evidence : readEvidenceSnapshot(trustDir);
    const receipts = options.receipts !== undefined ? options.receipts : readMergedReceipts(trustDir);
    const headSha = options.headSha ?? readHeadShaFast(scope.repoRoot);
    const intent =
      options.intent !== undefined
        ? options.intent
        : readIntentCard(trustDir, event.conversationId || "default");

    if (hasMergeCompleted(receipts)) {
      return { decision: "allow" };
    }

    const maxRounds = evidence?.maxReviewRounds ?? policy.maxReviewRounds ?? 3;
    const escalated =
      evidence?.roundState === "escalated" ||
      evidence?.verifier?.verdict === "ESCALATE_HUMAN" ||
      ((evidence?.reviewRound ?? 0) >= maxRounds && evidence?.verifier?.verdict === "FAIL");
    if (escalated) return { decision: "allow" };
    if (evidence?.assertionDelta?.flagged) return { decision: "allow" };
    if (detectSessionTestRegression(receipts).regressed) return { decision: "allow" };

    const changedFiles = collectReceiptPaths(receipts);
    if (intent && changedFiles.length > 0 && !evaluateIntentScope(intent, changedFiles).inScope) {
      return { decision: "allow" };
    }

    const riskAssessment = evidence?.riskAssessment ?? null;
    if (riskAssessment?.residual === "blocked") {
      return { decision: "allow" };
    }

    const category =
      riskAssessment?.category ??
      intent?.category ??
      (changedFiles.length > 0 ? classifyFileCategory(changedFiles[0]) : "core");
    const catState = trust.categories?.[category] ?? { level: 0, score: 0 };
    const residual = riskAssessment?.residual ?? "low";
    const riskScore = riskAssessment?.score ?? 0;
    const signals = riskAssessment?.signals ?? [];

    const freshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
    const fresh = freshness === "fresh" || freshness === "fresh_rebase_patch_id";
    const verifiedPass = hasFreshVerifierPass({ receipts, evidence, headSha });

    let transitionId = null;
    let prompt = null;

    if (fresh && verifiedPass) {
      const mergeRes = evaluateDecisionTable({
        action: "merge",
        residual,
        trustLevel: catState.level,
        category,
        trustScore: catState.score,
        riskScore,
        signals,
        beastOn: trust.beastOn,
        policy,
        headless: false,
      });
      if (mergeRes.decision === "auto_approve" && hasRollbackReady({ receipts, evidence, intent, headSha })) {
        transitionId = "stage3_to_stage4";
        prompt = `Beast Mode Stage 3 -> Stage 4 (Ship): HEAD ${(headSha ?? "").slice(0, 7)} passed isolated pr-verifier with ${residual} residual risk (${category} L${catState.level}). Merge the verified PR, record the rollback receipt, and schedule post-merge watch.`;
      } else {
        return { decision: "allow" };
      }
    } else if (fresh && changedFiles.length > 0) {
      const prRes = evaluateDecisionTable({
        action: "open_pr",
        residual,
        trustLevel: catState.level,
        category,
        trustScore: catState.score,
        riskScore,
        signals,
        beastOn: trust.beastOn,
        policy,
        headless: false,
      });
      if (prRes.decision === "auto_approve") {
        transitionId = "stage2_to_stage3";
        prompt = `Beast Mode Stage 2 -> Stage 3 (PR Review): HEAD ${(headSha ?? "").slice(0, 7)} verification receipts are fresh (${category} L${catState.level}, residual ${residual}). Run isolated pr-verifier and compile the PR dossier (pr-dossier.mjs --format github) before opening or updating the PR.`;
      } else {
        return { decision: "allow" };
      }
    } else if (intent && intent.approved === true && changedFiles.length === 0) {
      const writeRes = evaluateDecisionTable({
        action: "local_write",
        residual,
        trustLevel: catState.level,
        category,
        trustScore: catState.score,
        riskScore,
        signals,
        beastOn: trust.beastOn,
        policy,
        headless: false,
      });
      if (writeRes.decision === "auto_approve") {
        transitionId = "stage1_to_stage2";
        prompt = `Beast Mode Stage 1 -> Stage 2 (Build & Verify): Intent Card is approved for ${category} (L${catState.level}). Implement the declared scope, run targeted tests on HEAD, and collect fresh verification receipts.`;
      } else {
        return { decision: "allow" };
      }
    }

    if (!transitionId || !prompt) {
      return { decision: "allow" };
    }

    const maxPerStage = options.maxTransitionsPerStage ?? 2;
    const stateFile = trustDir ? handoffStatePath(trustDir, event.conversationId) : null;
    const state = readHandoffState(stateFile);
    const stageKey = `${headSha ?? "none"}:${transitionId}`;
    const priorCount = Number(state.transitions?.[stageKey] ?? 0);
    if (priorCount >= maxPerStage) {
      return { decision: "allow" };
    }

    state.transitions[stageKey] = priorCount + 1;
    state.lastTransition = {
      transitionId,
      headSha: headSha ?? null,
      ts: new Date().toISOString(),
    };
    writeHandoffStateAtomic(stateFile, state);

    return {
      decision: "continue",
      reason: prompt,
    };
  } catch {
    return { decision: "allow" };
  }
}

/**
 * Injects one compact `PreInvocation` `ephemeralMessage` naming active stage, category level, residual risk, and missing receipts when Beast Mode is On.
 */
export function evaluateStageContext(event, options = {}) {
  if (!event || event.kind !== "pre-invocation") return {};

  try {
    const scope =
      options.scope ?? resolveEnrolledWorkspaceScope(event.workspaceDir, { baseRef: options.baseRef });
    if (!scope || scope.kind !== "enrolled_repo" || !scope.repoId) {
      return {};
    }

    const policyLoaded = options.policy
      ? { policy: options.policy, error: null }
      : loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
    if (policyLoaded.error) return {};
    const policy = policyLoaded.policy;

    const settingsRes = readTrustSettings(scope.repoId, { dataDir: options.dataDir });
    if (settingsRes.parseError) return {};

    const trust =
      options.trust ??
      evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir: options.dataDir,
        nowMs: options.nowMs,
      });
    if (!trust || !trust.beastOn || trust.frozen || !trust.chainValid) {
      return {};
    }

    const trustDir = options.trustDir ?? resolveTrustDir(event);
    const evidence = options.evidence !== undefined ? options.evidence : readEvidenceSnapshot(trustDir);
    const receipts = options.receipts !== undefined ? options.receipts : readMergedReceipts(trustDir);
    const headSha = options.headSha ?? readHeadShaFast(scope.repoRoot);
    const intent =
      options.intent !== undefined
        ? options.intent
        : readIntentCard(trustDir, event.conversationId || "default");

    const changedFiles = collectReceiptPaths(receipts);
    const freshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
    const fresh = freshness === "fresh" || freshness === "fresh_rebase_patch_id";
    const verifiedPass = hasFreshVerifierPass({ receipts, evidence, headSha });
    const merged = hasMergeCompleted(receipts);

    const stage = merged
      ? "4. Ship"
      : verifiedPass && fresh
        ? "3. PR Review (ready)"
        : changedFiles.length > 0
          ? "2. Build & Verify"
          : "1. Plan & Intent";

    const riskAssessment = evidence?.riskAssessment ?? null;
    const category =
      riskAssessment?.category ??
      intent?.category ??
      (changedFiles.length > 0 ? classifyFileCategory(changedFiles[0]) : "core");
    const catState = trust.categories?.[category] ?? { level: 0, score: 0, ceiling: 2 };
    const residual = riskAssessment?.residual ?? "low";
    const riskScore = Number(riskAssessment?.score ?? 0).toFixed(2);
    const satisfiedIds = new Set((riskAssessment?.satisfied ?? []).map((s) => s.id));
    const missing = (riskAssessment?.requiredMitigations ?? []).filter((id) => !satisfiedIds.has(id));

    const hintParts = [];
    if (!intent && (catState.level <= 1 || residual !== "low")) {
      hintParts.push("declare Intent Card via declare_intent before writes");
    }
    if (missing.length > 0) {
      hintParts.push(`missing mitigations: ${missing.join(", ")}`);
    } else if (!fresh && changedFiles.length > 0) {
      hintParts.push(`HEAD freshness=${freshness}`);
    } else {
      hintParts.push(`ceiling L${catState.ceiling}, promotion=${trust.promotionMode}`);
    }

    const ephemeralMessage = `AStack Beast Mode active (stage=${stage}, category=${category}, L${catState.level} T=${catState.score.toFixed(2)}, residual=${residual} R=${riskScore}; ${hintParts.join("; ")}).`;
    return {
      injectSteps: [{ ephemeralMessage }],
    };
  } catch {
    return {};
  }
}
