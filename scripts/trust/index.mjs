import {
  FILE_WRITE_TOOL_MATCHER,
  FILE_WRITE_TOOLS,
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
  evaluateRoundLimit,
  evaluateRoundState,
  evaluateVerifyReminder,
  formatPipelineRail,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  recordReceipt,
  recordVerifierReceipt,
  resolveTrustDir,
  writeEvidenceSnapshotAtomic,
} from "./internal/ledger.mjs";
import {
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
  resolveRelativeImportPath,
} from "./internal/policy.mjs";
import {
  classifyRiskTier,
  clusterChangedFiles,
  compilePrDossier,
  renderDossierMarkdown,
  validateFindingsDocument,
} from "./internal/dossier.mjs";
import { runArchitectureAudit } from "./internal/audit.mjs";

export const TOOL_MATCHERS = {
  fileWriteTools: FILE_WRITE_TOOLS,
  fileWrite: FILE_WRITE_TOOL_MATCHER,
  secretGuard: SECRET_GUARD_MATCHER,
  command: "run_command",
};

export {
  DEFAULT_RISK_POLICY,
  PIPELINE_STAGES,
  classifyCommandCategory,
  classifyRiskTier,
  clusterChangedFiles,
  compilePrDossier,
  computeAssertionDelta,
  computeFreshness,
  evaluateBoundaryViolation,
  evaluateBoundaryWrite,
  evaluateEvidenceGate,
  evaluateIrreversible,
  evaluateRoundLimit,
  evaluateRoundState,
  evaluateSecrets,
  evaluateSessionContext,
  evaluateVerifyReminder,
  extractImportSpecifiers,
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
  readMergedReceipts,
  recordReceipt,
  recordVerifierReceipt,
  renderDossierMarkdown,
  resolveBaseRef,
  resolveRelativeImportPath,
  resolveTrustDir,
  runArchitectureAudit,
  runHookShell,
  validateFindingsDocument,
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
