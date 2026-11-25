#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RISK_WEIGHTS,
  HARD_BLOCK_SIGNALS,
  MITIGATION_TABLE,
  bucketFromScore,
  classifyActionClass,
  classifyDominantCategory,
  classifyFileCategory,
  computeFreshness,
  computeNoisyOrScore,
  evaluateRoundState,
  resolveResidual,
} from "../../../../scripts/trust/index.mjs";
import type { RiskResidual, TrustCategory } from "../../../../scripts/trust/index.mjs";

export interface VerificationFinding {
  readonly property: string;
  readonly summary: string;
  readonly counterexample: unknown;
}

export interface RiskMitigationVerificationReport {
  readonly ok: boolean;
  readonly properties: {
    readonly NoisyOrAndDominantCategoryAlgebra: {
      readonly statesChecked: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
    readonly ResidualMitigationNonBypassMatrix: {
      readonly statesChecked: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
    readonly ActionClassNonDowngradeMatrix: {
      readonly statesChecked: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
    readonly FreshnessAndRoundEscalationBFS: {
      readonly visitedStates: number;
      readonly transitions: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
  };
  readonly findings: readonly VerificationFinding[];
}

interface RiskSignalInput {
  readonly id: string;
  readonly severity: number;
  readonly weight: number;
  readonly evidence: string;
}

interface ResidualResolutionResult {
  readonly score: number;
  readonly requiredMitigations: readonly string[];
  readonly satisfied: readonly { readonly id: string; readonly receiptSummary: string }[];
  readonly missingMitigations: readonly string[];
  readonly residual: RiskResidual;
  readonly rollback: { readonly kind: string; readonly plan: string };
}

type FreshnessState =
  | "missing_receipts"
  | "dirty_after_verify"
  | "fresh"
  | "fresh_rebase_patch_id"
  | "stale_sha";

type VerifierVerdict = "PASS" | "PASS_WITH_NOTES" | "FAIL" | "ESCALATE_HUMAN";
type RoundState = "open" | "fixing" | "verified" | "escalated";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const PATCH_ID_1 = "c".repeat(40);
const T0 = "2026-11-24T10:00:00Z";
const T1 = "2026-11-24T10:05:00Z";
const T2 = "2026-11-24T10:10:00Z";

const EVIDENCE_MITIGATION_IDS = new Set([
  "targeted_tests",
  "test_coverage",
  "blast_radius_proof",
  "ui_control_proof",
  "arch_audit_clean",
  "verifier_pass",
  "regression_green",
]);

function verifyNoisyOrAndDominantCategoryAlgebra(): {
  checked: number;
  violations: number;
  firstFinding: VerificationFinding | null;
} {
  let checked = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const recordViolation = (summary: string, counterexample: unknown) => {
    violations++;
    firstFinding ??= {
      property: "NoisyOrAndDominantCategoryAlgebra",
      summary,
      counterexample,
    };
  };

  const emptyScore = computeNoisyOrScore([]);
  checked++;
  if (emptyScore !== 0) {
    recordViolation("computeNoisyOrScore([]) did not return 0", { emptyScore });
  }

  const canonicalSignalIds = [
    "touches_governance",
    "deletes_assertions",
    "untested_change",
    "public_surface_changed",
    "large_diff",
    "new_path",
  ] as const;
  const factors = [1.0, 0.5, 0.25] as const;

  for (let mask = 0; mask < 1 << canonicalSignalIds.length; mask++) {
    const subset = canonicalSignalIds
      .filter((_, idx) => (mask & (1 << idx)) !== 0)
      .map((id) => ({ id, weight: DEFAULT_RISK_WEIGHTS[id] }));

    const baseScore = computeNoisyOrScore(subset);
    checked++;
    if (!Number.isFinite(baseScore) || baseScore < 0 || baseScore > 1) {
      recordViolation("computeNoisyOrScore returned out-of-range score", { subset, baseScore });
    }

    for (const extraId of canonicalSignalIds) {
      if (subset.some((s) => s.id === extraId)) continue;
      const expanded = [...subset, { id: extraId, weight: DEFAULT_RISK_WEIGHTS[extraId] }];
      const expandedScore = computeNoisyOrScore(expanded);
      checked++;
      if (expandedScore < baseScore) {
        recordViolation("Noisy-OR violated monotonicity when adding a signal", {
          subset,
          extraId,
          baseScore,
          expandedScore,
        });
      }
    }

    for (const factor of factors) {
      const mitFactors: Record<string, number> = {};
      for (const s of subset) mitFactors[s.id] = factor;
      const mitigatedScore = computeNoisyOrScore(subset, mitFactors);
      checked++;
      if (!Number.isFinite(mitigatedScore) || mitigatedScore < 0 || mitigatedScore > baseScore) {
        recordViolation("Mitigated noisy-OR score exceeded unmitigated baseScore or left [0,1]", {
          subset,
          factor,
          baseScore,
          mitigatedScore,
        });
      }
    }
  }

  const allSignals = Object.entries(DEFAULT_RISK_WEIGHTS).map(([id, weight]) => ({ id, weight }));
  const allScore = computeNoisyOrScore(allSignals);
  checked++;
  if (!Number.isFinite(allScore) || allScore <= 0 || allScore > 1) {
    recordViolation("Full 12-signal noisy-OR score left (0, 1]", { allScore });
  }

  for (const score of [0, 0.05, 0.2, 0.5, 0.9]) {
    for (const isInherent of [true, false]) {
      checked++;
      const bucket = bucketFromScore(score, { hardBlocked: true, isInherent });
      const expected = isInherent ? "critical" : "blocked";
      if (bucket !== expected) {
        recordViolation("bucketFromScore ignored hardBlocked flag", { score, isInherent, bucket, expected });
      }
    }
  }

  const canonicalPaths: readonly { readonly path: string; readonly expected: TrustCategory }[] = [
    { path: "hooks.json", expected: "governance" },
    { path: "scripts/mcp/tools.mjs", expected: "core" },
    { path: "scripts/cli/statusline.mjs", expected: "tooling" },
    { path: "sidecars/astack_timeline/app.js", expected: "ui" },
    { path: "skills/review-pr/SKILL.md", expected: "skills" },
    { path: "scripts/test/risk.test.mjs", expected: "tests" },
    { path: "README.md", expected: "docs" },
  ];

  for (const item of canonicalPaths) {
    checked++;
    const actual = classifyFileCategory(item.path);
    if (actual !== item.expected) {
      recordViolation("classifyFileCategory drifted from canonical category mapping", { item, actual });
    }
  }

  checked++;
  if (classifyDominantCategory([]) !== "docs") {
    recordViolation("classifyDominantCategory([]) did not return docs", {
      actual: classifyDominantCategory([]),
    });
  }

  const precedence: readonly TrustCategory[] = [
    "governance",
    "core",
    "tooling",
    "ui",
    "skills",
    "tests",
    "docs",
  ];
  for (let mask = 1; mask < 1 << canonicalPaths.length; mask++) {
    const picked = canonicalPaths.filter((_, idx) => (mask & (1 << idx)) !== 0);
    const expected =
      precedence.find((cat) => picked.some((item) => item.expected === cat)) ?? "docs";
    const forward = classifyDominantCategory(picked.map((p) => p.path));
    const reversed = classifyDominantCategory([...picked].reverse().map((p) => p.path));
    checked += 2;
    if (forward !== expected || reversed !== expected) {
      recordViolation("classifyDominantCategory violated category precedence or order-invariance", {
        paths: picked.map((p) => p.path),
        expected,
        forward,
        reversed,
      });
    }
  }

  return { checked, violations, firstFinding };
}

function makeSignal(id: string): RiskSignalInput {
  const weight = Number(DEFAULT_RISK_WEIGHTS[id] ?? 0.2);
  const severity = HARD_BLOCK_SIGNALS.has(id) || id === "deletes_assertions" ? 3 : weight >= 0.2 ? 2 : 1;
  return {
    id,
    severity,
    weight,
    evidence: `formal:${id}`,
  };
}

function verifyResidualMitigationNonBypassMatrix(): {
  checked: number;
  violations: number;
  firstFinding: VerificationFinding | null;
} {
  let checked = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const recordViolation = (summary: string, counterexample: unknown) => {
    violations++;
    firstFinding ??= {
      property: "ResidualMitigationNonBypassMatrix",
      summary,
      counterexample,
    };
  };

  for (const [ruleId, rule] of Object.entries(MITIGATION_TABLE) as Array<
    [string, { readonly factor: number; readonly signals: readonly string[] }]
  >) {
    checked++;
    if (!Number.isFinite(rule.factor) || rule.factor <= 0 || rule.factor > 1) {
      recordViolation("MITIGATION_TABLE rule has invalid factor outside (0, 1]", { ruleId, rule });
    }
    for (const sigId of rule.signals) {
      if (!Object.hasOwn(DEFAULT_RISK_WEIGHTS, sigId)) {
        recordViolation("MITIGATION_TABLE rule references unknown signal", { ruleId, sigId });
      }
    }
  }

  const signalProfiles: readonly (readonly string[])[] = [
    [],
    ...Object.keys(DEFAULT_RISK_WEIGHTS).map((id) => [id]),
    ["touches_governance", "untested_change", "public_surface_changed"],
    ["deletes_assertions", "large_diff"],
  ];
  const categories: readonly TrustCategory[] = ["docs", "ui", "core", "governance"];
  const actions = ["local_write", "open_pr", "merge"] as const;

  const receiptWorlds = [
    {
      name: "empty",
      receipts: [],
      proofManifest: null,
      intent: null,
      rollback: { kind: "revert", plan: "git revert aaaaaaa" },
    },
    {
      name: "all_fresh_full",
      receipts: [
        { kind: "command", category: "test", ok: true, summary: "node --run test", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "verify", ok: true, summary: "blast-radius proof", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "lint", ok: true, summary: "node skills/audit-architecture/scripts/arch-audit.mjs --strict", headSha: HEAD_A, ts: T1 },
        { kind: "verifier", category: "verify", ok: true, verdict: "PASS", summary: "pr-verifier PASS", headSha: HEAD_A, ts: T1 },
      ],
      proofManifest: {
        schemaVersion: 1,
        headSha: HEAD_A,
        checks: [
          {
            id: "ui-1",
            name: "Timeline UI check",
            surface: "ui",
            status: "PASS",
            commandOrAction: "control-ui timeline",
            observed: "PASS",
          },
        ],
      },
      intent: {
        goal: "Formal test",
        affectedGlobs: ["**/*"],
        rollbackPlan: "git revert aaaaaaa",
        approved: true,
      },
      rollback: { kind: "revert", plan: "git revert aaaaaaa" },
    },
    {
      name: "all_failed",
      receipts: [
        { kind: "command", category: "test", ok: false, summary: "node --run test", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "verify", ok: false, summary: "blast-radius proof", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "lint", ok: false, summary: "arch-audit.mjs", headSha: HEAD_A, ts: T1 },
        { kind: "verifier", category: "verify", ok: false, verdict: "FAIL", summary: "pr-verifier FAIL", headSha: HEAD_A, ts: T1 },
      ],
      proofManifest: null,
      intent: null,
      rollback: { kind: "revert", plan: "git revert aaaaaaa" },
    },
    {
      name: "stale_sha",
      receipts: [
        { kind: "command", category: "test", ok: true, summary: "node --run test", headSha: HEAD_B, ts: T1 },
        { kind: "command", category: "verify", ok: true, summary: "blast-radius proof", headSha: HEAD_B, ts: T1 },
        { kind: "command", category: "lint", ok: true, summary: "arch-audit.mjs", headSha: HEAD_B, ts: T1 },
        { kind: "verifier", category: "verify", ok: true, verdict: "PASS", summary: "pr-verifier PASS", headSha: HEAD_B, ts: T1 },
      ],
      proofManifest: {
        schemaVersion: 1,
        headSha: HEAD_B,
        checks: [
          {
            id: "ui-1",
            name: "Timeline UI check",
            surface: "ui",
            status: "PASS",
            commandOrAction: "control-ui timeline",
            observed: "PASS",
          },
        ],
      },
      intent: null,
      rollback: { kind: "revert", plan: "git revert aaaaaaa" },
    },
    {
      name: "dirty_write_after_verify",
      receipts: [
        { kind: "command", category: "test", ok: true, summary: "node --run test", headSha: HEAD_A, ts: T0 },
        { kind: "command", category: "verify", ok: true, summary: "blast-radius proof", headSha: HEAD_A, ts: T0 },
        { kind: "command", category: "lint", ok: true, summary: "arch-audit.mjs", headSha: HEAD_A, ts: T0 },
        { kind: "verifier", category: "verify", ok: true, verdict: "PASS", summary: "pr-verifier PASS", headSha: HEAD_A, ts: T0 },
        { kind: "file_write", ok: true, headSha: HEAD_A, paths: ["src/app.js"], ts: T2 },
      ],
      proofManifest: null,
      intent: null,
      rollback: { kind: "revert", plan: "git revert aaaaaaa" },
    },
    {
      name: "merge_missing_verifier",
      receipts: [
        { kind: "command", category: "test", ok: true, summary: "node --run test", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "verify", ok: true, summary: "blast-radius proof", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "lint", ok: true, summary: "arch-audit.mjs", headSha: HEAD_A, ts: T1 },
      ],
      proofManifest: null,
      intent: {
        goal: "Formal test",
        affectedGlobs: ["**/*"],
        rollbackPlan: "git revert aaaaaaa",
        approved: true,
      },
      rollback: { kind: "revert", plan: "git revert aaaaaaa" },
    },
    {
      name: "merge_missing_rollback",
      receipts: [
        { kind: "command", category: "test", ok: true, summary: "node --run test", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "verify", ok: true, summary: "blast-radius proof", headSha: HEAD_A, ts: T1 },
        { kind: "command", category: "lint", ok: true, summary: "arch-audit.mjs", headSha: HEAD_A, ts: T1 },
        { kind: "verifier", category: "verify", ok: true, verdict: "PASS", summary: "pr-verifier PASS", headSha: HEAD_A, ts: T1 },
      ],
      proofManifest: null,
      intent: null,
      rollback: { kind: "none", plan: "" },
    },
  ] as const;

  const invalidReceiptWorlds = new Set(["all_failed", "stale_sha", "dirty_write_after_verify"]);

  for (const sigIds of signalProfiles) {
    const signals = sigIds.map(makeSignal);
    const inherentScore = computeNoisyOrScore(signals);
    const hasHardSignal = sigIds.some((id) => HARD_BLOCK_SIGNALS.has(id));
    const hasDeletesAssertions = sigIds.includes("deletes_assertions");

    for (const category of categories) {
      for (const action of actions) {
        for (const world of receiptWorlds) {
          checked++;
          const res = resolveResidual(
            {
              action,
              category,
              tier: hasHardSignal ? 3 : 1,
              signals,
              inherentScore,
              score: inherentScore,
              inherent: bucketFromScore(inherentScore, { hardBlocked: hasHardSignal, isInherent: true }),
              residual: bucketFromScore(inherentScore, { hardBlocked: hasHardSignal, isInherent: false }),
              rollback: world.rollback,
              headSha: HEAD_A,
            },
            world.receipts,
            {
              headSha: HEAD_A,
              proofManifest: world.proofManifest,
              intent: world.intent,
            },
          ) as ResidualResolutionResult;

          const satisfiedIds = new Set(res.satisfied.map((s) => s.id));
          const tuple = { sigIds, category, action, world: world.name };

          if (hasHardSignal && res.residual !== "blocked") {
            recordViolation("Hard-block signal was bypassed in resolveResidual", { tuple, res });
          }

          if (hasDeletesAssertions) {
            if (satisfiedIds.has("restore_assertions")) {
              recordViolation("deletes_assertions was auto-satisfied without human waiver", { tuple, res });
            }
            if (res.residual !== "high" && res.residual !== "blocked") {
              recordViolation("deletes_assertions dropped below high/blocked residual", { tuple, res });
            }
          }

          if (
            action === "merge" &&
            (res.missingMitigations.includes("verifier_pass") ||
              res.missingMitigations.includes("rollback_receipt"))
          ) {
            if (res.residual !== "high" && res.residual !== "blocked") {
              recordViolation("Merge without verifier_pass or rollback_receipt was marked low/medium", {
                tuple,
                res,
              });
            }
          }

          if (invalidReceiptWorlds.has(world.name)) {
            const leaked = [...satisfiedIds].filter((id) => EVIDENCE_MITIGATION_IDS.has(id));
            if (leaked.length > 0) {
              recordViolation("Invalid, stale, or dirty-after-verify receipts satisfied evidence mitigations", {
                tuple,
                leaked,
                res,
              });
            }
          }

          if (!Number.isFinite(res.score) || res.score < 0 || res.score > inherentScore || inherentScore > 1) {
            recordViolation("Residual score escaped [0, inherentScore] bounds", {
              tuple,
              inherentScore,
              score: res.score,
            });
          }

          if (category !== "docs" && !res.requiredMitigations.includes("targeted_tests")) {
            recordViolation("Non-docs category omitted targeted_tests requirement", { tuple, res });
          }
          if (category === "ui" && !res.requiredMitigations.includes("ui_control_proof")) {
            recordViolation("UI category omitted ui_control_proof requirement", { tuple, res });
          }
        }
      }
    }
  }

  return { checked, violations, firstFinding };
}

function verifyActionClassNonDowngradeMatrix(): {
  checked: number;
  violations: number;
  firstFinding: VerificationFinding | null;
} {
  let checked = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const recordViolation = (summary: string, counterexample: unknown) => {
    violations++;
    firstFinding ??= {
      property: "ActionClassNonDowngradeMatrix",
      summary,
      counterexample,
    };
  };

  const readCmds = ["git status", "rg foo scripts/", "ls"] as const;
  const privCmds = [
    { cmd: "git push origin feat/x", expected: "push_branch" },
    { cmd: "gh pr create --title t --body b", expected: "open_pr" },
    { cmd: "gh pr merge 1 --squash", expected: "merge" },
    { cmd: "gh pr comment 1 --body hi", expected: "external_message" },
    { cmd: "npm publish", expected: "deploy" },
    { cmd: "git reset --hard HEAD~1", expected: "destructive" },
  ] as const;

  for (const readCmd of readCmds) {
    for (const priv of privCmds) {
      const variants = [
        `${readCmd} && ${priv.cmd}`,
        `${priv.cmd} && ${readCmd}`,
        `${readCmd}; ${priv.cmd}`,
        `env FOO=1 ${priv.cmd}`,
      ];
      for (const command of variants) {
        checked++;
        const actual = classifyActionClass({ kind: "tool-command", command });
        if (actual === "read" || actual === "local_exec" || actual !== priv.expected) {
          recordViolation("Compound or wrapped privileged command downgraded or misclassified", {
            command,
            expected: priv.expected,
            actual,
          });
        }
      }
    }
  }

  const escapedAndFlaggedCmds = [
    { cmd: "git -C repo merge feat", expected: "merge" },
    { cmd: "gh -R org/repo pr merge 1", expected: "merge" },
    { cmd: "g\\it push origin feat", expected: "push_branch" },
    { cmd: "gh p\\r m\\erge 1", expected: "merge" },
  ] as const;
  for (const item of escapedAndFlaggedCmds) {
    checked++;
    const actual = classifyActionClass({ kind: "tool-command", command: item.cmd });
    if (actual !== item.expected) {
      recordViolation("Escaped or flag-prefixed command failed to classify accurately", { item, actual });
    }
  }

  const shellMutations = [
    "git status > out.txt",
    "cat README.md >> a.txt",
    "ls | tee x.txt",
    "git status $(id)",
  ] as const;
  for (const command of shellMutations) {
    checked++;
    const actual = classifyActionClass({ kind: "tool-command", command });
    if (actual === "read") {
      recordViolation("Shell redirection or subshell mutation classified as read", { command, actual });
    }
  }

  const mcpCases = [
    { toolName: "merge_pull_request", expected: "merge" },
    { toolName: "create_pull_request", expected: "open_pr" },
    { toolName: "update_pull_request", expected: "open_pr" },
    { toolName: "push_files", expected: "push_branch" },
    { toolName: "create_or_update_file", expected: "push_branch" },
    { toolName: "create_branch", expected: "push_branch" },
    { toolName: "write_file", expected: "local_write" },
    { toolName: "edit_file", expected: "local_write" },
    { toolName: "create_issue_comment", expected: "external_message" },
    { toolName: "send_email", expected: "external_message" },
    { toolName: "deploy_service", expected: "deploy" },
    { toolName: "delete_file", expected: "destructive" },
    { toolName: "read_file", expected: "read" },
  ] as const;
  for (const item of mcpCases) {
    checked++;
    const actual = classifyActionClass({ kind: "tool-mcp", toolName: item.toolName });
    if (actual !== item.expected) {
      recordViolation("MCP tool classified unexpectedly", { item, actual });
    }
  }

  return { checked, violations, firstFinding };
}

interface FreshnessRoundState {
  readonly hasVerify: boolean;
  readonly verifyMatchesHead: boolean;
  readonly treeDirty: boolean;
  readonly writeAfterVerify: boolean;
  readonly rebaseValid: boolean;
  readonly reviewRound: 0 | 1 | 2 | 3;
  readonly verdict: VerifierVerdict | null;
}

function encodeFreshState(s: FreshnessRoundState): string {
  return [
    s.hasVerify ? 1 : 0,
    s.verifyMatchesHead ? 1 : 0,
    s.treeDirty ? 1 : 0,
    s.writeAfterVerify ? 1 : 0,
    s.rebaseValid ? 1 : 0,
    s.reviewRound,
    s.verdict ?? "null",
  ].join("|");
}

function phaseNodeId(freshness: FreshnessState, roundState: RoundState): string {
  return `p_${freshness}_${roundState}`;
}

function phaseNodeLabel(freshness: FreshnessState, roundState: RoundState): string {
  return `${freshness} / ${roundState}`;
}

function evaluateFreshAndRoundForState(s: FreshnessRoundState): {
  readonly freshness: FreshnessState;
  readonly fresh: boolean;
  readonly roundState: RoundState;
} {
  const receipts: Record<string, unknown>[] = [];
  if (s.hasVerify) {
    receipts.push({
      kind: "command",
      category: "test",
      ok: true,
      summary: "node --run test",
      headSha: s.verifyMatchesHead ? HEAD_A : HEAD_B,
      ts: T1,
    });
  }
  if (s.writeAfterVerify) {
    receipts.push({
      kind: "file_write",
      ok: true,
      paths: ["src/app.js"],
      headSha: HEAD_A,
      ts: T2,
    });
  }

  const freshness = computeFreshness({
    receipts,
    headSha: HEAD_A,
    patchId: s.rebaseValid ? PATCH_ID_1 : null,
    priorEvidence: s.rebaseValid ? { patchId: PATCH_ID_1, freshness: "fresh" } : null,
    treeDirty: s.treeDirty,
  }) as FreshnessState;

  const fresh = freshness === "fresh" || freshness === "fresh_rebase_patch_id";
  const roundState = evaluateRoundState({
    reviewRound: s.reviewRound,
    verdict: s.verdict,
    maxReviewRounds: 3,
    fresh,
  }) as RoundState;

  return { freshness, fresh, roundState };
}

function verifyFreshnessAndRoundEscalationBfs(): {
  visitedStates: number;
  transitions: number;
  violations: number;
  firstFinding: VerificationFinding | null;
  mermaid: string;
} {
  const initial: FreshnessRoundState = {
    hasVerify: false,
    verifyMatchesHead: false,
    treeDirty: false,
    writeAfterVerify: false,
    rebaseValid: false,
    reviewRound: 0,
    verdict: null,
  };

  const visited = new Set<string>([encodeFreshState(initial)]);
  const queue: Array<{ readonly state: FreshnessRoundState; readonly trace: readonly string[] }> = [
    { state: initial, trace: ["init"] },
  ];
  let transitions = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const nodeLabels = new Map<string, string>();
  const edges = new Set<string>();
  const verifiedNodes = new Set<string>();
  const escalatedNodes = new Set<string>();
  const brokenNodes = new Set<string>();

  const recordEval = (
    s: FreshnessRoundState,
    trace: readonly string[],
  ): { readonly id: string; readonly freshness: FreshnessState; readonly roundState: RoundState } => {
    const evalRes = evaluateFreshAndRoundForState(s);
    const id = phaseNodeId(evalRes.freshness, evalRes.roundState);
    nodeLabels.set(id, phaseNodeLabel(evalRes.freshness, evalRes.roundState));
    if (evalRes.roundState === "verified") verifiedNodes.add(id);
    if (evalRes.roundState === "escalated") escalatedNodes.add(id);

    const recordViolation = (summary: string) => {
      violations++;
      brokenNodes.add(id);
      firstFinding ??= {
        property: "FreshnessAndRoundEscalationBFS",
        summary,
        counterexample: {
          stepCount: trace.length - 1,
          trace,
          state: s,
          evaluated: evalRes,
        },
      };
    };

    if (!s.hasVerify && evalRes.freshness !== "missing_receipts") {
      recordViolation("Missing verification receipts did not resolve to missing_receipts");
    }
    if (s.hasVerify && (s.treeDirty || s.writeAfterVerify) && evalRes.freshness !== "dirty_after_verify") {
      recordViolation("Dirty tree or post-verify file_write did not resolve to dirty_after_verify");
    }
    if (
      s.hasVerify &&
      !s.treeDirty &&
      !s.writeAfterVerify &&
      !s.verifyMatchesHead &&
      !s.rebaseValid &&
      evalRes.freshness !== "stale_sha"
    ) {
      recordViolation("Stale SHA without matching rebase patch-id did not resolve to stale_sha");
    }
    if (
      evalRes.fresh &&
      (!s.hasVerify || s.treeDirty || s.writeAfterVerify || (!s.verifyMatchesHead && !s.rebaseValid))
    ) {
      recordViolation("State marked fresh without clean HEAD or valid patch-id rebase");
    }
    const expectedVerified = evalRes.fresh && (s.verdict === "PASS" || s.verdict === "PASS_WITH_NOTES");
    if ((evalRes.roundState === "verified") !== expectedVerified) {
      recordViolation("roundState === verified did not match fresh && passing verdict");
    }
    if ((s.verdict === "ESCALATE_HUMAN" || (s.reviewRound >= 3 && s.verdict === "FAIL")) && evalRes.roundState !== "escalated") {
      recordViolation("ESCALATE_HUMAN or 3-round FAIL failed to enter escalated state");
    }

    return { id, freshness: evalRes.freshness, roundState: evalRes.roundState };
  };

  const initEval = recordEval(initial, ["init"]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const s = current.state;
    const fromId = phaseNodeId(
      evaluateFreshAndRoundForState(s).freshness,
      evaluateFreshAndRoundForState(s).roundState,
    );

    const nextMoves: Array<{ readonly label: string; readonly next: FreshnessRoundState }> = [
      {
        label: "file_write",
        next: {
          ...s,
          treeDirty: true,
          writeAfterVerify: s.hasVerify ? true : s.writeAfterVerify,
          rebaseValid: false,
        },
      },
      {
        label: "git_commit",
        next: {
          ...s,
          treeDirty: false,
          verifyMatchesHead: false,
          rebaseValid: false,
        },
      },
      {
        label: "verify_pass",
        next: {
          ...s,
          hasVerify: true,
          verifyMatchesHead: true,
          treeDirty: false,
          writeAfterVerify: false,
          rebaseValid: false,
        },
      },
    ];

    if (s.hasVerify && !s.treeDirty && !s.writeAfterVerify) {
      nextMoves.push({
        label: "rebase_same_patch_id",
        next: {
          ...s,
          verifyMatchesHead: false,
          rebaseValid: true,
        },
      });
    }

    if (s.reviewRound < 3 && s.verdict !== "ESCALATE_HUMAN") {
      nextMoves.push({
        label: "verifier_pass",
        next: {
          ...s,
          verdict: "PASS",
        },
      });
      nextMoves.push({
        label: "verifier_pass_with_notes",
        next: {
          ...s,
          verdict: "PASS_WITH_NOTES",
        },
      });
      nextMoves.push({
        label: "verifier_fail",
        next: {
          ...s,
          reviewRound: (s.reviewRound + 1) as 1 | 2 | 3,
          verdict: "FAIL",
        },
      });
      nextMoves.push({
        label: "verifier_escalate",
        next: {
          ...s,
          verdict: "ESCALATE_HUMAN",
        },
      });
    }

    for (const move of nextMoves) {
      transitions++;
      const nextTrace = [...current.trace, move.label];
      const evalNext = recordEval(move.next, nextTrace);
      if (fromId !== evalNext.id) {
        edges.add(`  ${fromId} --> ${evalNext.id}: ${move.label}`);
      }
      const key = encodeFreshState(move.next);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: move.next, trace: nextTrace });
      }
    }
  }

  const lines = [
    "%% provenance: formal-ts",
    "stateDiagram-v2",
    "  classDef pass fill:#e6f6ec,stroke:#1a7f37,color:#116329",
    "  classDef fail fill:#ffecee,stroke:#cf222e,color:#82071e",
    "  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834",
    `  [*] --> ${initEval.id}`,
  ];
  for (const [id, label] of [...nodeLabels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${id}: ${label}`);
  }
  for (const edge of [...edges].sort()) {
    lines.push(edge);
  }
  for (const id of [...verifiedNodes].sort()) {
    if (!brokenNodes.has(id)) lines.push(`  class ${id} pass`);
  }
  for (const id of [...escalatedNodes].sort()) {
    if (!brokenNodes.has(id)) lines.push(`  class ${id} fail`);
  }
  for (const id of [...brokenNodes].sort()) {
    lines.push(`  class ${id} breaks`);
  }

  return {
    visitedStates: visited.size,
    transitions,
    violations,
    firstFinding,
    mermaid: `${lines.join("\n")}\n`,
  };
}

/**
 * Runs all four zero-Java formal checks against scripts/trust/index.mjs and returns the verification report plus Mermaid chart.
 */
export function runRiskMitigationVerification(): RiskMitigationVerificationReport & { readonly mermaid: string } {
  const r1 = verifyNoisyOrAndDominantCategoryAlgebra();
  const r2 = verifyResidualMitigationNonBypassMatrix();
  const r3 = verifyActionClassNonDowngradeMatrix();
  const r4 = verifyFreshnessAndRoundEscalationBfs();

  const findings = [
    r1.firstFinding,
    r2.firstFinding,
    r3.firstFinding,
    r4.firstFinding,
  ].filter((f): f is VerificationFinding => f !== null);

  return {
    ok: findings.length === 0,
    properties: {
      NoisyOrAndDominantCategoryAlgebra: {
        statesChecked: r1.checked,
        violations: r1.violations,
        status: r1.firstFinding ? "fail" : "pass",
      },
      ResidualMitigationNonBypassMatrix: {
        statesChecked: r2.checked,
        violations: r2.violations,
        status: r2.firstFinding ? "fail" : "pass",
      },
      ActionClassNonDowngradeMatrix: {
        statesChecked: r3.checked,
        violations: r3.violations,
        status: r3.firstFinding ? "fail" : "pass",
      },
      FreshnessAndRoundEscalationBFS: {
        visitedStates: r4.visitedStates,
        transitions: r4.transitions,
        violations: r4.violations,
        status: r4.firstFinding ? "fail" : "pass",
      },
    },
    findings,
    mermaid: r4.mermaid,
  };
}

const USAGE = `Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning .agents/skills/verify-risk-mitigation-formal/scripts/verify-risk.ts [options]

Options:
  --emit-mermaid <path>  Write explored stateDiagram-v2 chart for PR descriptions
  --json                 Emit machine-readable JSON verification report (default)
  -h, --help             Show this help text and exit 0`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "emit-mermaid": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const report = runRiskMitigationVerification();
  if (values["emit-mermaid"]) {
    const outFile = path.resolve(process.cwd(), values["emit-mermaid"]);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, report.mermaid, "utf8");
  }
  const { mermaid: _chart, ...jsonReport } = report;
  process.stdout.write(`${JSON.stringify(jsonReport, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}
