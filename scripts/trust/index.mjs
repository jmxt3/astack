import {
  EVIDENCE_GATE_MATCHER,
  FILE_WRITE_TOOL_MATCHER,
  FILE_WRITE_TOOLS,
  RECEIPT_LEDGER_MATCHER,
  SECRET_GUARD_MATCHER,
  isHeadless,
  parseHookPayload,
  parseHookStdin,
  runHookShell,
} from "./internal/envelope.mjs";
import {
  PIPELINE_STAGES,
  classifyCommandCategory,
  computeFreshness,
  evaluateEvidenceGate,
  evaluatePrIntent,
  evaluateRoundLimit,
  evaluateRoundState,
  evaluateVerifyReminder,
  formatPipelineRail,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  recordReceipt,
  recordRollbackReceipt,
  recordVerifierReceipt,
  resolveTrustDir,
  writeEvidenceSnapshotAtomic,
} from "./internal/ledger.mjs";
import {
  DEFAULT_ENGINEERING_MCP_SERVERS,
  DEFAULT_RISK_POLICY,
  computeAssertionDelta,
  evaluateBoundaryViolation,
  evaluateBoundaryWrite,
  evaluateIrreversible,
  evaluateSecrets,
  evaluateSessionContext,
  extractImportSpecifiers,
  globToRegex,
  loadBoundaries,
  loadRiskPolicy,
  matchesAnyGlob,
  readBaseReviewContext,
  resolveBaseRef,
  resolveEnrolledWorkspaceScope as resolveWorkspaceScope,
  resolveRelativeImportPath,
} from "./internal/policy.mjs";
import {
  deriveRepoId,
  findGitEntry,
  resolveGitDirs,
} from "./internal/workspace-scope.mjs";
import {
  classifyRiskTier,
  clusterChangedFiles,
  compilePrDossier,
  renderDossierMarkdown,
  validateFindingsDocument,
} from "./internal/dossier.mjs";
import {
  renderGitHubPrProof,
  resolvePrStatechart,
  validatePrBodyContract,
  validateProofManifest,
} from "./internal/pr-proof.mjs";
import { runArchitectureAudit } from "./internal/audit.mjs";
import {
  DEFAULT_RISK_WEIGHTS,
  HARD_BLOCK_SIGNALS,
  TRUST_CATEGORIES,
  assessChange,
  bucketFromScore,
  classifyDominantCategory,
  classifyFileCategory,
  computeNoisyOrScore,
} from "./internal/risk.mjs";
import {
  MITIGATION_TABLE,
  classifyActionClass,
  resolveResidual,
} from "./internal/mitigation.mjs";
import {
  detectSessionTestRegression,
  evaluateIntentScope,
  readIntentCard,
  recordIntentCard,
  validateIntentCard,
} from "./internal/intent.mjs";

export const TOOL_MATCHERS = {
  fileWriteTools: FILE_WRITE_TOOLS,
  fileWrite: FILE_WRITE_TOOL_MATCHER,
  secretGuard: SECRET_GUARD_MATCHER,
  evidenceGate: EVIDENCE_GATE_MATCHER,
  receiptLedger: RECEIPT_LEDGER_MATCHER,
  command: "run_command",
};

export {
  DEFAULT_ENGINEERING_MCP_SERVERS,
  DEFAULT_RISK_POLICY,
  DEFAULT_RISK_WEIGHTS,
  HARD_BLOCK_SIGNALS,
  MITIGATION_TABLE,
  PIPELINE_STAGES,
  TRUST_CATEGORIES,
  assessChange,
  bucketFromScore,
  classifyActionClass,
  classifyCommandCategory,
  classifyDominantCategory,
  classifyFileCategory,
  classifyRiskTier,
  clusterChangedFiles,
  compilePrDossier,
  computeAssertionDelta,
  computeFreshness,
  computeNoisyOrScore,
  deriveRepoId,
  detectSessionTestRegression,
  evaluateBoundaryViolation,
  evaluateBoundaryWrite,
  evaluateEvidenceGate,
  evaluateIntentScope,
  evaluateIrreversible,
  evaluatePrIntent,
  evaluateRoundLimit,
  evaluateRoundState,
  evaluateSecrets,
  evaluateSessionContext,
  evaluateVerifyReminder,
  extractImportSpecifiers,
  findGitEntry,
  formatPipelineRail,
  globToRegex,
  isHeadless,
  loadBoundaries,
  loadRiskPolicy,
  matchesAnyGlob,
  parseHookPayload,
  parseHookStdin,
  readBaseReviewContext,
  readEvidenceSnapshot,
  readHeadShaFast,
  readIntentCard,
  readMergedReceipts,
  recordIntentCard,
  recordReceipt,
  recordRollbackReceipt,
  recordVerifierReceipt,
  renderDossierMarkdown,
  renderGitHubPrProof,
  resolveBaseRef,
  resolveGitDirs,
  resolvePrStatechart,
  resolveRelativeImportPath,
  resolveResidual,
  resolveTrustDir,
  resolveWorkspaceScope,
  runArchitectureAudit,
  runHookShell,
  validateFindingsDocument,
  validateIntentCard,
  validatePrBodyContract,
  validateProofManifest,
  writeEvidenceSnapshotAtomic,
};

/**
 * Dispatches any named Antigravity lifecycle hook over stdin/stdout fail-open.
 */
export function runHook(hookId) {
  const headless = isHeadless();
  switch (hookId) {
    case "receipt-ledger":
      runHookShell(
        (event) => {
          recordReceipt(event);
          return {};
        },
        { hint: "post", fallback: {} },
      );
      return;
    case "session-context":
      runHookShell(
        (event) => evaluateSessionContext(event),
        { hint: "session-start", fallback: {} },
      );
      return;
    case "pr-intent":
      runHookShell(
        (event) => evaluatePrIntent(event),
        { hint: "pre-invocation", fallback: {} },
      );
      return;
    case "irreversible-guard":
      runHookShell((event) => evaluateIrreversible(event, { headless }), { hint: "pre" });
      return;
    case "secret-guard":
      runHookShell((event) => evaluateSecrets(event, { headless }), { hint: "pre" });
      return;
    case "verify-reminder":
      runHookShell((event) => evaluateVerifyReminder(event), { hint: "stop" });
      return;
    case "evidence-gate":
      runHookShell((event) => evaluateEvidenceGate(event, { headless }), { hint: "pre" });
      return;
    case "boundary-guard":
      runHookShell((event) => evaluateBoundaryWrite(event, { headless }), { hint: "pre" });
      return;
    case "round-limiter":
      runHookShell((event) => evaluateRoundLimit(event, { headless }), { hint: "pre" });
      return;
    default:
      runHookShell(() => ({ decision: "allow" }));
  }
}
