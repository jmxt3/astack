import { evaluateIrreversible } from "./policy.mjs";
import {
  HARD_BLOCK_SIGNALS,
  bucketFromScore,
  computeNoisyOrScore,
} from "./risk.mjs";

export const MITIGATION_TABLE = {
  targeted_tests: {
    id: "targeted_tests",
    label: "Targeted tests on HEAD",
    factor: 0.25,
    signals: ["untested_change", "large_diff", "dependency_changed", "new_path"],
  },
  test_coverage: {
    id: "test_coverage",
    label: "Test coverage or passing HEAD test receipt",
    factor: 0.25,
    signals: ["untested_change"],
  },
  blast_radius_proof: {
    id: "blast_radius_proof",
    label: "Caller proof via /blast-radius or verify receipt",
    factor: 0.35,
    signals: ["public_surface_changed"],
  },
  plugin_validate_clean: {
    id: "plugin_validate_clean",
    label: "Plugin validation clean with zero sidecar permissions",
    factor: 1.0,
    signals: ["bundled_sidecar_permissions"],
  },
  ui_control_proof: {
    id: "ui_control_proof",
    label: "Live UI verification proof (proof-manifest or sidecar tests)",
    factor: 0.4,
    signals: ["large_diff", "untested_change"],
  },
  arch_audit_clean: {
    id: "arch_audit_clean",
    label: "Architecture boundary audit clean on HEAD",
    factor: 0.3,
    signals: ["cross_zone_import"],
  },
  human_governance_review: {
    id: "human_governance_review",
    label: "Human review required for governance changes",
    factor: 1.0,
    signals: ["touches_governance"],
  },
  amended_intent: {
    id: "amended_intent",
    label: "Human-approved amended Intent Card covering changed files",
    factor: 1.0,
    signals: ["scope_drift"],
  },
  regression_green: {
    id: "regression_green",
    label: "Regressed test suite back to green on HEAD",
    factor: 1.0,
    signals: ["test_regression"],
  },
  restore_assertions: {
    id: "restore_assertions",
    label: "Restore weakened assertions or human waiver",
    factor: 1.0,
    signals: ["deletes_assertions"],
  },
  verifier_pass: {
    id: "verifier_pass",
    label: "Isolated pr-verifier PASS receipt on HEAD",
    factor: 0.45,
    signals: ["large_diff", "dependency_changed", "new_path", "public_surface_changed"],
  },
  rollback_receipt: {
    id: "rollback_receipt",
    label: "Explicit rollback plan recorded before merge",
    factor: 0.85,
    signals: [],
  },
};

const READ_ONLY_CMD_RE =
  /^\s*(?:git\s+(?:status|diff|log|show|rev-parse|branch\s+(?:-a|-r|--list|--show-current)?$)|rg\b|grep\b|cat\b|head\b|tail\b|ls\b|dir\b|pwd\b|Get-ChildItem\b|Get-Content\b|Select-String\b)/i;
const DEPLOY_CMD_RE =
  /\b(?:kubectl\s+apply|terraform\s+apply|pulumi\s+up|vercel\s+--prod|flyctl?\s+deploy|wrangler\s+deploy|gcloud\s+(?:run|app|functions)\s+deploy|npm\s+publish|gh\s+release\s+create)\b/i;
const EXTERNAL_MSG_CMD_RE =
  /\b(?:gh\s+(?:pr|issue)\s+comment|gh\s+pr\s+review|sendmail\b)\b/i;
const MERGE_CMD_RE = /\b(?:gh\s+pr\s+merge|git\s+merge)\b/i;
const OPEN_PR_CMD_RE = /\bgh\s+pr\s+(?:create|new|edit)\b/i;
const PUSH_CMD_RE = /\bgit\s+(?:-[A-Za-z]\s+\S+\s+)*push\b/i;

/**
 * Classifies a normalized hook event into one of the 9 canonical `ActionClass` levels.
 */
export function classifyActionClass(event) {
  if (!event || typeof event !== "object") return "read";
  if (event.kind === "tool-write") return "local_write";
  if (event.kind === "tool-mcp") {
    const tool = String(event.toolName ?? "").toLowerCase();
    if (tool === "merge_pull_request") return "merge";
    if (tool === "create_pull_request" || tool === "update_pull_request") return "open_pr";
    if (/^(?:create_issue_comment|add_pull_request_review|send_|post_)/.test(tool)) {
      return "external_message";
    }
    if (/^(?:delete_|destroy_|drop_|deploy_)/.test(tool)) {
      return tool.startsWith("deploy_") ? "deploy" : "destructive";
    }
    return "read";
  }
  if (event.kind === "tool-command") {
    const cmd = String(event.command ?? "").trim();
    if (!cmd) return "read";
    if (evaluateIrreversible(cmd, { headless: true }).decision !== "allow") {
      return "destructive";
    }
    if (DEPLOY_CMD_RE.test(cmd)) return "deploy";
    if (EXTERNAL_MSG_CMD_RE.test(cmd)) return "external_message";
    if (MERGE_CMD_RE.test(cmd)) return "merge";
    if (OPEN_PR_CMD_RE.test(cmd)) return "open_pr";
    if (PUSH_CMD_RE.test(cmd)) return "push_branch";
    if (READ_ONLY_CMD_RE.test(cmd)) return "read";
    return "local_exec";
  }
  return "read";
}

function receiptMatchesHead(receipt, headSha, priorEvidence) {
  if (!receipt?.ok) return false;
  if (!headSha) return true;
  if (receipt.headSha === headSha) return true;
  if (
    priorEvidence?.freshness === "fresh_rebase_patch_id" &&
    priorEvidence?.headSha &&
    receipt.headSha === priorEvidence.headSha
  ) {
    return true;
  }
  return false;
}

function hasNewerCodeWrite(receipts, receiptTs) {
  if (!receiptTs) return false;
  return receipts.some(
    (r) => r?.kind === "file_write" && String(r.ts ?? "") > String(receiptTs),
  );
}

function findFreshReceipt(receipts, headSha, priorEvidence, predicate) {
  for (let i = receipts.length - 1; i >= 0; i--) {
    const r = receipts[i];
    if (!receiptMatchesHead(r, headSha, priorEvidence)) continue;
    if (!predicate(r)) continue;
    if (hasNewerCodeWrite(receipts, r.ts)) continue;
    return r;
  }
  return null;
}

function checkMitigationSatisfied(id, { assessment, receipts, headSha, priorEvidence, proofManifest, intent }) {
  if (id === "human_governance_review" || id === "restore_assertions") {
    return null;
  }
  if (id === "plugin_validate_clean") {
    return null;
  }
  if (id === "amended_intent") {
    if (intent?.approved === true && !assessment.signals.some((s) => s.id === "scope_drift")) {
      return { id, receiptSummary: `Approved Intent Card (${intent.goal?.slice(0, 48) ?? "ok"})`, headSha };
    }
    return null;
  }
  if (id === "regression_green") {
    if (!assessment.signals.some((s) => s.id === "test_regression")) {
      const r = findFreshReceipt(receipts, headSha, priorEvidence, (x) => x.kind === "command" && x.category === "test");
      if (r) return { id, receiptSummary: r.summary, headSha: r.headSha ?? headSha };
    }
    return null;
  }
  if (id === "targeted_tests" || id === "test_coverage") {
    const r = findFreshReceipt(
      receipts,
      headSha,
      priorEvidence,
      (x) => x.kind === "command" && (x.category === "test" || x.category === "verify"),
    );
    return r ? { id, receiptSummary: r.summary, headSha: r.headSha ?? headSha } : null;
  }
  if (id === "blast_radius_proof") {
    const r = findFreshReceipt(
      receipts,
      headSha,
      priorEvidence,
      (x) => x.kind === "verifier" || (x.kind === "command" && x.category === "verify"),
    );
    if (r) return { id, receiptSummary: r.summary, headSha: r.headSha ?? headSha };
    if (proofManifest && (!headSha || !proofManifest.headSha || proofManifest.headSha === headSha)) {
      const pass = (proofManifest.checks ?? []).find((c) => c.status === "PASS");
      if (pass) return { id, receiptSummary: `proof-manifest: ${pass.name}`, headSha: proofManifest.headSha ?? headSha };
    }
    return null;
  }
  if (id === "ui_control_proof") {
    if (proofManifest && (!headSha || !proofManifest.headSha || proofManifest.headSha === headSha)) {
      const uiPass = (proofManifest.checks ?? []).find(
        (c) => c.status === "PASS" && (c.surface === "ui" || /ui|timeline/i.test(`${c.name} ${c.commandOrAction}`)),
      );
      if (uiPass) return { id, receiptSummary: `control-ui PASS (${uiPass.name})`, headSha: proofManifest.headSha ?? headSha };
    }
    const r = findFreshReceipt(
      receipts,
      headSha,
      priorEvidence,
      (x) =>
        x.kind === "command" &&
        (x.category === "verify" || x.category === "test") &&
        /control-ui|test:sidecar|timeline\.test|server\.test/i.test(String(x.summary ?? "")),
    );
    return r ? { id, receiptSummary: r.summary, headSha: r.headSha ?? headSha } : null;
  }
  if (id === "arch_audit_clean") {
    const r = findFreshReceipt(
      receipts,
      headSha,
      priorEvidence,
      (x) => x.kind === "command" && x.category === "lint" && /arch-audit|validate-astack/i.test(String(x.summary ?? "")),
    );
    return r ? { id, receiptSummary: r.summary, headSha: r.headSha ?? headSha } : null;
  }
  if (id === "verifier_pass") {
    const r = findFreshReceipt(
      receipts,
      headSha,
      priorEvidence,
      (x) => x.kind === "verifier" && (x.verdict === "PASS" || x.verdict === "PASS_WITH_NOTES"),
    );
    if (r) return { id, receiptSummary: r.summary, headSha: r.headSha ?? headSha };
    if (
      priorEvidence?.verifier &&
      !priorEvidence.verifier.stale &&
      (priorEvidence.verifier.verdict === "PASS" || priorEvidence.verifier.verdict === "PASS_WITH_NOTES") &&
      (priorEvidence.verifier.importantCount ?? 0) === 0 &&
      (priorEvidence.verifier.reviewViolationCount ?? 0) === 0 &&
      (!headSha || priorEvidence.verifier.headSha === headSha)
    ) {
      return { id, receiptSummary: `pr-verifier ${priorEvidence.verifier.verdict}`, headSha: priorEvidence.verifier.headSha ?? headSha };
    }
    return null;
  }
  if (id === "rollback_receipt") {
    const plan = String(intent?.rollbackPlan ?? assessment?.rollback?.plan ?? "").trim();
    const kind = assessment?.rollback?.kind ?? "none";
    const hasExplicitRollback =
      Boolean(intent?.rollbackPlan && String(intent.rollbackPlan).trim()) ||
      (kind !== "none" && Boolean(plan) && !/^manual rollback required/i.test(plan));
    if (hasExplicitRollback) {
      return { id, receiptSummary: plan, headSha };
    }
    return null;
  }
  return null;
}

/**
 * Applies fresh HEAD receipts to a `RiskAssessment`, returning required/satisfied mitigations and residual risk.
 */
export function resolveResidual(assessment, receipts = [], options = {}) {
  if (!assessment || typeof assessment !== "object") {
    throw new Error("resolveResidual requires a RiskAssessment object");
  }
  const headSha = options.headSha ?? assessment.headSha ?? null;
  const priorEvidence = options.priorEvidence ?? null;
  const proofManifest = options.proofManifest ?? null;
  const intent = options.intent ?? null;

  const requiredSet = new Set();
  if (assessment.category !== "docs") {
    requiredSet.add("targeted_tests");
  }
  if (assessment.category === "ui") {
    requiredSet.add("ui_control_proof");
  }
  for (const sig of assessment.signals ?? []) {
    if (sig.id === "untested_change") requiredSet.add("test_coverage");
    else if (sig.id === "public_surface_changed") requiredSet.add("blast_radius_proof");
    else if (sig.id === "bundled_sidecar_permissions") requiredSet.add("plugin_validate_clean");
    else if (sig.id === "touches_governance") requiredSet.add("human_governance_review");
    else if (sig.id === "scope_drift") requiredSet.add("amended_intent");
    else if (sig.id === "test_regression") requiredSet.add("regression_green");
    else if (sig.id === "deletes_assertions") requiredSet.add("restore_assertions");
    else if (sig.id === "cross_zone_import") requiredSet.add("arch_audit_clean");
  }
  if (assessment.action === "merge") {
    requiredSet.add("verifier_pass");
    requiredSet.add("rollback_receipt");
  }

  const requiredMitigations = [...requiredSet];
  const satisfied = [];
  const missingMitigations = [];
  const mitigationFactors = {};

  for (const id of requiredMitigations) {
    const match = checkMitigationSatisfied(id, {
      assessment,
      receipts,
      headSha,
      priorEvidence,
      proofManifest,
      intent,
    });
    if (match) {
      satisfied.push(match);
      const rule = MITIGATION_TABLE[id];
      for (const sigId of rule?.signals ?? []) {
        const cur = mitigationFactors[sigId] ?? 1;
        mitigationFactors[sigId] = Math.min(cur, rule.factor);
      }
    } else {
      missingMitigations.push(id);
    }
  }

  const hardBlocked = (assessment.signals ?? []).some((s) => HARD_BLOCK_SIGNALS.has(s.id));
  const score = computeNoisyOrScore(assessment.signals ?? [], mitigationFactors);
  let residual = bucketFromScore(score, { hardBlocked, isInherent: false });
  if (
    assessment.action === "merge" &&
    !hardBlocked &&
    (missingMitigations.includes("verifier_pass") || missingMitigations.includes("rollback_receipt"))
  ) {
    if (residual === "low" || residual === "medium") residual = "high";
  }

  const rollbackPlan =
    (intent?.rollbackPlan && String(intent.rollbackPlan).trim()) ||
    assessment.rollback?.plan ||
    `git revert ${(headSha ?? "HEAD").slice(0, 7)}`;
  const rollback = {
    kind: assessment.rollback?.kind ?? "revert",
    plan: rollbackPlan,
  };

  const label = residual === "blocked" ? "Blocked risk" : `${residual.charAt(0).toUpperCase()}${residual.slice(1)} risk`;
  const satisfiedNote =
    satisfied.length > 0
      ? ` Mitigated by ${satisfied.map((s) => s.id).join(", ")}.`
      : "";
  const signalText =
    (assessment.signals ?? []).length > 0
      ? ` because of ${(assessment.signals ?? []).slice(0, 3).map((s) => s.id).join(", ")}`
      : ` across ${assessment.category} only`;
  const summary = `${label} (R ${score.toFixed(2)})${signalText}.${satisfiedNote} Undo: ${rollback.plan}.`;

  return {
    ...assessment,
    score,
    requiredMitigations,
    satisfied,
    missingMitigations,
    residual,
    rollback,
    summary,
  };
}
