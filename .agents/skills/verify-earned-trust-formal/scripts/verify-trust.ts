#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RISK_POLICY,
  TRUST_CATEGORIES,
  evaluateCategoryState,
  evaluateDecisionTable,
  resolveEffectiveAutonomy,
} from "../../../../scripts/trust/index.mjs";
import type {
  AutonomyActionClass,
  CategoryTrustState,
  LedgerEntry,
  PromotionMode,
  RiskResidual,
  TrustCategory,
} from "../../../../scripts/trust/index.mjs";

export interface VerificationFinding {
  readonly property: string;
  readonly summary: string;
  readonly counterexample: unknown;
}

export interface TrustVerificationReport {
  readonly ok: boolean;
  readonly properties: {
    readonly EffectiveAutonomyPolicyPrecedence: {
      readonly statesChecked: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
    readonly DecisionTableSafetyMatrix: {
      readonly statesChecked: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
    readonly CategoryStateAndDemotionInvariants: {
      readonly statesChecked: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
    readonly EarnedTrustLifecycleBFS: {
      readonly visitedStates: number;
      readonly transitions: number;
      readonly violations: number;
      readonly status: "pass" | "fail";
    };
  };
  readonly findings: readonly VerificationFinding[];
}

const BASE_MS = Date.parse("2026-11-01T00:00:00Z");
const SHA_ZERO = "0".repeat(40);
const MAX_STAGE_HOPS = 3;

function buildCleanEntries(cat: TrustCategory, count: number): readonly LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      ts: new Date(BASE_MS + i * 3600_000).toISOString(),
      repoId: "formal00",
      category: cat,
      headSha: SHA_ZERO,
      prNumber: i + 1,
      outcome: "clean",
      y: 1,
      predictedR: 0.05,
      source: "formal",
      note: "",
      prevHash: SHA_ZERO,
    });
  }
  return entries;
}

const TIER_COUNTS = [0, 5, 10, 20] as const;

const ENTRIES_FOR_TIER: Readonly<Record<"ui" | "governance", readonly (readonly LedgerEntry[])[]>> = {
  ui: TIER_COUNTS.map((n) => buildCleanEntries("ui", n)),
  governance: TIER_COUNTS.map((n) => buildCleanEntries("governance", n)),
};

function makeRevertedEntry(cat: TrustCategory, tier: number): LedgerEntry {
  const offset = TIER_COUNTS[tier] ?? 0;
  return {
    ts: new Date(BASE_MS + offset * 3600_000).toISOString(),
    repoId: "formal00",
    category: cat,
    headSha: SHA_ZERO,
    prNumber: offset + 1,
    outcome: "reverted",
    y: 0,
    predictedR: 0.05,
    source: "formal",
    note: "",
    prevHash: SHA_ZERO,
  };
}

/**
 * Exhaustively verifies base-policy precedence and governance hard caps in resolveEffectiveAutonomy.
 */
function verifyEffectiveAutonomyPolicyPrecedence(): {
  checked: number;
  violations: number;
  firstFinding: VerificationFinding | null;
} {
  let checked = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const basePromotions: readonly (PromotionMode | null)[] = [null, "manual", "auto"];
  const localPromotions: readonly PromotionMode[] = ["manual", "auto"];
  const ceilings = [1, 2, 3] as const;

  const recordViolation = (summary: string, counterexample: unknown) => {
    violations++;
    firstFinding ??= {
      property: "EffectiveAutonomyPolicyPrecedence",
      summary,
      counterexample,
    };
  };

  for (const basePromo of basePromotions) {
    for (const localPromo of localPromotions) {
      for (const baseCap of ceilings) {
        for (const localCap of ceilings) {
          const policyCeilings: Record<string, number> = {};
          const localCeilings: Record<string, number> = {};
          for (const cat of TRUST_CATEGORIES) {
            policyCeilings[cat] = baseCap;
            localCeilings[cat] = localCap;
          }
          const policy = {
            ...DEFAULT_RISK_POLICY,
            autonomy: {
              ...(DEFAULT_RISK_POLICY.autonomy as Record<string, unknown>),
              promotion: basePromo,
              ceilings: policyCeilings,
            },
          };
          const settings = {
            promotionMode: localPromo,
            ceilings: localCeilings,
          };
          const res = resolveEffectiveAutonomy(policy, settings);

          for (const cat of TRUST_CATEGORIES) {
            checked++;
            const hardMax = cat === "governance" ? 2 : 3;
            const effCap = res.ceilings[cat];
            const maxCap = res.maxCeilings[cat];

            if (basePromo === "manual" && (res.promotionMode !== "manual" || !res.promotionLockedByPolicy)) {
              recordViolation("Base manual lock overridden by local promotion setting", {
                basePromo,
                localPromo,
                actual: res,
              });
            }
            if (cat === "governance" && (effCap > 2 || maxCap > 2)) {
              recordViolation("Governance ceiling exceeded hard cap L2", {
                baseCap,
                localCap,
                effCap,
                maxCap,
              });
            }
            if (
              effCap < 1 ||
              effCap > maxCap ||
              maxCap > hardMax ||
              effCap > Math.min(baseCap, localCap, hardMax)
            ) {
              recordViolation("Effective ceiling violated stricter-wins policy bound", {
                cat,
                baseCap,
                localCap,
                effCap,
                maxCap,
              });
            }
          }
        }
      }
    }
  }

  return { checked, violations, firstFinding };
}

/**
 * Exhaustively checks every (action, residual, trustLevel, category, beastOn, headless, isOwnRevert) tuple.
 */
function verifyDecisionTableSafetyMatrix(): {
  checked: number;
  violations: number;
  firstFinding: VerificationFinding | null;
} {
  let checked = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const actions: readonly AutonomyActionClass[] = [
    "local_write",
    "local_exec",
    "push_branch",
    "open_pr",
    "merge",
    "deploy",
    "external_message",
    "destructive",
  ];
  const residuals: readonly RiskResidual[] = ["low", "medium", "high", "blocked"];
  const levels = [0, 1, 2, 3] as const;
  const categories: readonly TrustCategory[] = ["ui", "governance", "docs"];
  const bools = [false, true] as const;

  const irreversible = new Set<AutonomyActionClass>(["deploy", "external_message", "destructive"]);

  const fail = (summary: string, input: unknown, decision: string) => {
    violations++;
    firstFinding ??= {
      property: "DecisionTableSafetyMatrix",
      summary,
      counterexample: { input, decision },
    };
  };

  for (const action of actions) {
    for (const residual of residuals) {
      for (const trustLevel of levels) {
        for (const category of categories) {
          for (const beastOn of bools) {
            for (const headless of bools) {
              for (const isOwnRevert of bools) {
                checked++;
                const res = evaluateDecisionTable({
                  action,
                  residual,
                  trustLevel,
                  category,
                  trustScore: trustLevel * 0.25,
                  riskScore: residual === "low" ? 0.05 : residual === "medium" ? 0.25 : 0.75,
                  beastOn,
                  policy: DEFAULT_RISK_POLICY,
                  headless,
                  isOwnRevert,
                });
                const d = res.decision;

                if (residual === "blocked" && d !== "deny") {
                  fail("Blocked residual failed to deny", { action, residual, trustLevel, category, beastOn, headless }, d);
                }
                if (irreversible.has(action)) {
                  if (d === "auto_approve" || d === "allow") {
                    fail("Irreversible action permitted without gate", { action, residual, trustLevel, category, beastOn, headless }, d);
                  }
                  const mustDeny = residual === "high" || residual === "blocked" || headless;
                  if (mustDeny && d !== "deny") {
                    fail("High-risk or headless irreversible action was not denied", { action, residual, trustLevel, category, beastOn, headless }, d);
                  }
                  if (!mustDeny && d !== "ask" && d !== "force_ask") {
                    fail("Low/medium interactive irreversible action did not prompt human", { action, residual, trustLevel, category, beastOn, headless }, d);
                  }
                }
                if (!beastOn && d === "auto_approve") {
                  fail("Auto-approve returned while Beast Mode was Off", { action, residual, trustLevel, category, beastOn, headless }, d);
                }
                if (residual === "high" && d === "auto_approve") {
                  fail("High residual risk auto-approved", { action, residual, trustLevel, category, beastOn, headless }, d);
                }
                if (headless && (d === "ask" || d === "force_ask")) {
                  fail("Headless evaluation returned interactive prompt instead of failing closed", { action, residual, trustLevel, category, beastOn, headless }, d);
                }
                if (action === "merge" && !isOwnRevert && d === "auto_approve") {
                  if (category === "governance") {
                    fail("Governance merge auto-approved", { action, residual, trustLevel, category, beastOn, headless }, d);
                  }
                  if (residual !== "low") {
                    fail("Non-low residual merge auto-approved", { action, residual, trustLevel, category, beastOn, headless }, d);
                  }
                  if (trustLevel < 3) {
                    fail("Merge auto-approved below L3", { action, residual, trustLevel, category, beastOn, headless }, d);
                  }
                }
                if ((action === "local_write" || action === "local_exec") && d === "auto_approve") {
                  if (!beastOn || trustLevel < 1 || (residual !== "low" && residual !== "medium")) {
                    fail("Local mutation auto-approved outside L1+ low/medium guard", { action, residual, trustLevel, category, beastOn }, d);
                  }
                }
                if ((action === "push_branch" || action === "open_pr") && d === "auto_approve") {
                  if (!beastOn || trustLevel < 2 || (residual !== "low" && residual !== "medium")) {
                    fail("Remote branch/PR action auto-approved outside L2+ low/medium guard", { action, residual, trustLevel, category, beastOn }, d);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return { checked, violations, firstFinding };
}

/**
 * Verifies evaluateCategoryState invariants over synthetic ledger histories, plus bad-outcome and audit demotions.
 */
function verifyCategoryStateAndDemotionInvariants(): {
  checked: number;
  violations: number;
  firstFinding: VerificationFinding | null;
} {
  let checked = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const categories = ["ui", "governance"] as const;
  const tiers = [0, 1, 2, 3] as const;
  const modes: readonly PromotionMode[] = ["manual", "auto"];
  const ceilings = [1, 2, 3] as const;
  const confirmedLevels = [0, 1, 2, 3] as const;
  const bools = [false, true] as const;
  const nowMs = BASE_MS + 25 * 3600_000;

  const fail = (summary: string, counterexample: unknown) => {
    violations++;
    firstFinding ??= {
      property: "CategoryStateAndDemotionInvariants",
      summary,
      counterexample,
    };
  };

  for (const category of categories) {
    for (const tier of tiers) {
      const entries = ENTRIES_FOR_TIER[category][tier];
      for (const promotionMode of modes) {
        for (const ceiling of ceilings) {
          for (const maxCeiling of ceilings) {
            for (const confirmedLevel of confirmedLevels) {
              for (const chainValid of bools) {
                for (const policyReset of bools) {
                  checked++;
                  const st = evaluateCategoryState({
                    category,
                    entries,
                    ceiling,
                    maxCeiling,
                    promotionMode,
                    confirmedLevel,
                    chainValid,
                    policyReset,
                    nowMs,
                  });

                  if (
                    st.level < 0 ||
                    st.level > 3 ||
                    st.earnedLevel < 0 ||
                    st.earnedLevel > 3 ||
                    st.ceiling < 1 ||
                    st.ceiling > 3 ||
                    st.score < 0 ||
                    st.score > 1
                  ) {
                    fail("TypeOK violated on CategoryTrustState", { input: { category, tier, promotionMode, ceiling, maxCeiling, confirmedLevel, chainValid, policyReset }, st });
                  }
                  if (st.level > st.ceiling || st.earnedLevel > st.ceiling) {
                    fail("LevelRespectsCeiling violated", { input: { category, tier, ceiling, maxCeiling }, st });
                  }
                  if (category === "governance") {
                    if (st.level > 2 || st.earnedLevel > 2 || st.ceiling > 2 || st.maxCeiling > 2) {
                      fail("GovernanceNeverExceedsL2 violated", { input: { tier, promotionMode, ceiling, maxCeiling, confirmedLevel }, st });
                    }
                    if (st.level > confirmedLevel) {
                      fail("GovernanceNeverAutoPromotes violated", { input: { tier, promotionMode, ceiling, confirmedLevel }, st });
                    }
                  }
                  if (chainValid && (promotionMode === "manual" || category === "governance") && st.level > confirmedLevel) {
                    fail("ManualNeverExceedsConfirmed violated", { input: { category, tier, promotionMode, confirmedLevel }, st });
                  }
                  if (!chainValid && (st.level !== 0 || !st.frozen || st.promoReady || st.eligibleNextLevel !== null)) {
                    fail("FrozenForcesL0 violated", { input: { category, tier, promotionMode, confirmedLevel }, st });
                  }
                  if (policyReset && (st.earnedLevel > 1 || st.score > 0.4)) {
                    fail("PolicyResetCapsAtL1 violated", { input: { category, tier }, st });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  for (const category of categories) {
    for (const tier of [1, 2, 3] as const) {
      for (const ceiling of ceilings) {
        checked++;
        const entries = ENTRIES_FOR_TIER[category][tier];
        const before = evaluateCategoryState({
          category,
          entries,
          ceiling,
          maxCeiling: ceiling,
          promotionMode: "auto",
          confirmedLevel: 3,
          chainValid: true,
          nowMs,
        });
        const afterEntries = [...entries, makeRevertedEntry(category, tier)];
        const after = evaluateCategoryState({
          category,
          entries: afterEntries,
          ceiling,
          maxCeiling: ceiling,
          promotionMode: "auto",
          confirmedLevel: Math.max(0, before.level - 1),
          chainValid: true,
          nowMs: nowMs + 3600_000,
        });
        if (!(after.earnedLevel < before.earnedLevel && after.score < before.score)) {
          fail("Reverted outcome did not strictly demote category", { category, tier, ceiling, before, after });
        }
      }
    }
  }

  checked++;
  const uiTier3 = ENTRIES_FOR_TIER.ui[3];
  const missedAuditEntries: readonly (LedgerEntry & { sampledAudit?: boolean; auditCompleted?: boolean | null })[] = [
    ...uiTier3,
    {
      ...buildCleanEntries("ui", 1)[0],
      ts: new Date(BASE_MS + 21 * 3600_000).toISOString(),
      prNumber: 21,
      sampledAudit: true,
      auditCompleted: false,
    },
  ];
  const auditDemoted = evaluateCategoryState({
    category: "ui",
    entries: missedAuditEntries,
    ceiling: 3,
    maxCeiling: 3,
    promotionMode: "auto",
    confirmedLevel: 3,
    chainValid: true,
    nowMs,
  });
  if (auditDemoted.earnedLevel > 2 || auditDemoted.level > 2 || !auditDemoted.missedAudit) {
    fail("Missed sampled audit failed to demote ui from L3 to <= L2", { auditDemoted });
  }

  return { checked, violations, firstFinding };
}

interface BfsState {
  readonly cat: "ui" | "governance";
  readonly mode: PromotionMode;
  readonly ceiling: 1 | 2 | 3;
  readonly tier: number;
  readonly confirmed: number;
  readonly autoPromoted: boolean;
  readonly hasUndo: boolean;
  readonly undoFrom: number;
  readonly chainValid: boolean;
  readonly demotionOk: boolean;
  readonly stage: 1 | 2 | 3 | 4;
  readonly stageHops: number;
}

function evalLifecycleNode(
  s: BfsState,
  nowMs: number,
  extraEntry?: LedgerEntry,
): CategoryTrustState {
  const effective = resolveEffectiveAutonomy(DEFAULT_RISK_POLICY, {
    promotionMode: s.mode,
    ceilings: { [s.cat]: s.ceiling },
  });
  const baseEntries = ENTRIES_FOR_TIER[s.cat][s.tier];
  const entries = extraEntry ? [...baseEntries, extraEntry] : baseEntries;
  return evaluateCategoryState({
    category: s.cat,
    entries,
    ceiling: effective.ceilings[s.cat],
    maxCeiling: effective.maxCeilings[s.cat],
    promotionMode: effective.promotionMode,
    confirmedLevel: s.confirmed,
    chainValid: s.chainValid,
    nowMs,
  });
}

function chartNodeId(cat: "ui" | "governance", level: number, frozen: boolean, stage: number): string {
  return `${cat}_L${level}_${frozen ? "frozen" : `s${stage}`}`;
}

function chartNodeLabel(cat: "ui" | "governance", level: number, frozen: boolean, stage: number): string {
  return frozen ? `${cat} L0 FROZEN s${stage}` : `${cat} L${level} stage ${stage}`;
}

function bfsStateKey(s: BfsState): string {
  return [
    s.cat,
    s.mode,
    s.ceiling,
    s.tier,
    s.confirmed,
    s.autoPromoted ? 1 : 0,
    s.hasUndo ? 1 : 0,
    s.undoFrom,
    s.chainValid ? 1 : 0,
    s.demotionOk ? 1 : 0,
    s.stage,
    s.stageHops,
  ].join("|");
}

/**
 * Bounded BFS explorer backed directly by resolveEffectiveAutonomy, evaluateCategoryState, and evaluateDecisionTable.
 */
function verifyEarnedTrustLifecycleBfs(): {
  visitedStates: number;
  transitions: number;
  violations: number;
  firstFinding: VerificationFinding | null;
  mermaid: string;
} {
  const nowMs = BASE_MS + 25 * 3600_000;
  const stageAction = (stage: 1 | 2 | 3): AutonomyActionClass =>
    stage === 1 ? "local_write" : stage === 2 ? "open_pr" : "merge";

  const initials: readonly BfsState[] = (["ui", "governance"] as const).map((cat) => ({
    cat,
    mode: "manual",
    ceiling: 2,
    tier: 0,
    confirmed: 0,
    autoPromoted: false,
    hasUndo: false,
    undoFrom: 0,
    chainValid: true,
    demotionOk: true,
    stage: 1,
    stageHops: 0,
  }));

  const visited = new Set<string>();
  const queue: Array<{ state: BfsState; trace: readonly string[] }> = [];
  const nodeLabels = new Map<string, string>();
  const edges = new Set<string>();
  const shipNodes = new Set<string>();
  const frozenNodes = new Set<string>();
  const brokenNodes = new Set<string>();

  for (const init of initials) {
    visited.add(bfsStateKey(init));
    queue.push({ state: init, trace: [`init(${init.cat})`] });
    const id = chartNodeId(init.cat, 0, false, init.stage);
    nodeLabels.set(id, chartNodeLabel(init.cat, 0, false, init.stage));
  }

  let transitions = 0;
  let violations = 0;
  let firstFinding: VerificationFinding | null = null;

  const checkInvariants = (s: BfsState, catState: CategoryTrustState, trace: readonly string[]) => {
    const id = chartNodeId(s.cat, catState.level, catState.frozen, s.stage);
    nodeLabels.set(id, chartNodeLabel(s.cat, catState.level, catState.frozen, s.stage));
    if (s.stage === 4 && catState.level === 3 && !catState.frozen) shipNodes.add(id);
    if (catState.frozen) frozenNodes.add(id);

    const recordBreak = (inv: string, summary: string) => {
      violations++;
      brokenNodes.add(id);
      firstFinding ??= {
        property: `EarnedTrustLifecycleBFS.${inv}`,
        summary,
        counterexample: { stepCount: trace.length - 1, trace, state: s, evaluated: catState },
      };
    };

    if (catState.level < 0 || catState.level > 3 || s.stage < 1 || s.stage > 4) {
      recordBreak("TypeOK", `Invalid trust level ${catState.level} or stage ${s.stage}`);
    }
    if (catState.level > catState.ceiling) {
      recordBreak("LevelRespectsCeiling", `Level ${catState.level} exceeded ceiling ${catState.ceiling}`);
    }
    if (s.cat === "governance") {
      if (catState.level > 2 || catState.ceiling > 2 || catState.earnedLevel > 2) {
        recordBreak("GovernanceNeverExceedsL2", `Governance reached L${catState.level} / earned L${catState.earnedLevel}`);
      }
      if (s.autoPromoted) {
        recordBreak("GovernanceNeverAutoPromotes", "Governance triggered auto-promotion");
      }
      if (s.stage >= 4) {
        recordBreak("GovernanceNeverAutoMerges", "Governance reached automated merge stage 4");
      }
    }
    if (s.chainValid && (s.mode === "manual" || s.cat === "governance") && catState.level > s.confirmed) {
      recordBreak("ManualNeverExceedsConfirmed", `Level ${catState.level} exceeded confirmed ${s.confirmed}`);
    }
    if (!s.chainValid && (catState.level !== 0 || !catState.frozen)) {
      recordBreak("FrozenForcesL0", `Broken ledger chain left level at ${catState.level}`);
    }
    if (!s.demotionOk) {
      recordBreak("BadOutcomeDemotes", "Bad outcome failed to demote level");
    }
    if (s.stageHops > MAX_STAGE_HOPS || s.stage < 1 || s.stage > 4) {
      recordBreak("StageHandoffsBounded", `Stage handoffs out of bounds: stage=${s.stage}, hops=${s.stageHops}`);
    }
  };

  while (queue.length > 0) {
    const item = queue.shift()!;
    const cur = item.state;
    const curCat = evalLifecycleNode(cur, nowMs);
    checkInvariants(cur, curCat, item.trace);

    if (!cur.chainValid) continue;

    const fromChartId = chartNodeId(cur.cat, curCat.level, curCat.frozen, cur.stage);
    const nextSteps: Array<{ label: string; next: BfsState }> = [];

    const maxTier = cur.cat === "governance" ? 2 : 3;
    const nextTier = Math.min(maxTier, cur.tier + 1);
    const cleanTarget: BfsState = { ...cur, tier: nextTier };
    const cleanEval = evalLifecycleNode(cleanTarget, nowMs);
    const didAutoClean = cur.mode === "auto" && cur.cat !== "governance" && cleanEval.level > curCat.level;
    nextSteps.push({
      label: "CleanOutcome",
      next: {
        ...cleanTarget,
        confirmed: didAutoClean ? cleanEval.level : cur.confirmed,
        autoPromoted: cur.autoPromoted || didAutoClean,
        hasUndo: didAutoClean ? true : cur.hasUndo,
        undoFrom: didAutoClean ? curCat.level : cur.undoFrom,
      },
    });

    const badEvalWithSameConf = evalLifecycleNode(cur, nowMs + 3600_000, makeRevertedEntry(cur.cat, cur.tier));
    const demotedConf = curCat.level > 0 ? Math.min(badEvalWithSameConf.earnedLevel, curCat.level - 1) : 0;
    const badTarget: BfsState = {
      ...cur,
      tier: Math.min(cur.tier, badEvalWithSameConf.earnedLevel),
      confirmed: demotedConf,
      hasUndo: false,
      undoFrom: 0,
    };
    const badFinalEval = evalLifecycleNode(badTarget, nowMs);
    nextSteps.push({
      label: "BadOutcome",
      next: {
        ...badTarget,
        demotionOk: cur.demotionOk && (curCat.level === 0 || badFinalEval.level < curCat.level),
      },
    });

    if (curCat.promoReady && curCat.eligibleNextLevel !== null) {
      nextSteps.push({
        label: "ManualPromote",
        next: {
          ...cur,
          confirmed: Math.min(curCat.ceiling, curCat.eligibleNextLevel),
          hasUndo: false,
          undoFrom: 0,
        },
      });
    }

    const nextMode: PromotionMode = cur.mode === "manual" ? "auto" : "manual";
    const toggleTarget: BfsState = { ...cur, mode: nextMode };
    const toggleEval = evalLifecycleNode(toggleTarget, nowMs);
    const didAutoToggle = nextMode === "auto" && cur.cat !== "governance" && toggleEval.level > curCat.level;
    nextSteps.push({
      label: `ToggleMode(${nextMode})`,
      next: {
        ...toggleTarget,
        confirmed: didAutoToggle ? toggleEval.level : cur.confirmed,
        autoPromoted: cur.autoPromoted || didAutoToggle,
        hasUndo: didAutoToggle ? true : cur.hasUndo,
        undoFrom: didAutoToggle ? curCat.level : cur.undoFrom,
      },
    });

    if (cur.hasUndo) {
      nextSteps.push({
        label: "UndoAutoPromo",
        next: {
          ...cur,
          mode: "manual",
          confirmed: Math.min(cur.undoFrom, curCat.ceiling),
          hasUndo: false,
          undoFrom: 0,
        },
      });
    }

    for (const c of [1, 2, 3] as const) {
      const eff = resolveEffectiveAutonomy(DEFAULT_RISK_POLICY, {
        promotionMode: cur.mode,
        ceilings: { [cur.cat]: c },
      });
      const clampedC = eff.ceilings[cur.cat] as 1 | 2 | 3;
      const baseConf = Math.min(cur.confirmed, clampedC);
      const ceilTarget: BfsState = { ...cur, ceiling: clampedC, confirmed: baseConf };
      const ceilEval = evalLifecycleNode(ceilTarget, nowMs);
      const didAutoCeil = cur.mode === "auto" && cur.cat !== "governance" && ceilEval.level > curCat.level;
      const clampedDown = clampedC < curCat.level;
      nextSteps.push({
        label: `SetCeiling(L${c})`,
        next: {
          ...ceilTarget,
          confirmed: didAutoCeil ? ceilEval.level : baseConf,
          autoPromoted: cur.autoPromoted || didAutoCeil,
          hasUndo: didAutoCeil ? true : clampedDown ? false : cur.hasUndo,
          undoFrom: didAutoCeil ? curCat.level : clampedDown ? 0 : cur.undoFrom,
        },
      });
    }

    nextSteps.push({
      label: "CorruptLedger",
      next: {
        ...cur,
        chainValid: false,
        hasUndo: false,
        undoFrom: 0,
      },
    });

    if (cur.stage < 4 && cur.stageHops < MAX_STAGE_HOPS) {
      const action = stageAction(cur.stage);
      const decision = evaluateDecisionTable({
        action,
        residual: "low",
        trustLevel: curCat.level,
        category: cur.cat,
        trustScore: curCat.score,
        riskScore: 0.05,
        beastOn: true,
        policy: DEFAULT_RISK_POLICY,
        headless: false,
      });
      if (decision.decision === "auto_approve") {
        nextSteps.push({
          label: `AdvanceStage(${action})`,
          next: {
            ...cur,
            stage: (cur.stage + 1) as 2 | 3 | 4,
            stageHops: cur.stageHops + 1,
          },
        });
      }
    }

    for (const step of nextSteps) {
      transitions++;
      const nextEval = evalLifecycleNode(step.next, nowMs);
      const toChartId = chartNodeId(step.next.cat, nextEval.level, nextEval.frozen, step.next.stage);
      nodeLabels.set(toChartId, chartNodeLabel(step.next.cat, nextEval.level, nextEval.frozen, step.next.stage));
      if (fromChartId !== toChartId) {
        edges.add(`  ${fromChartId} --> ${toChartId}: ${step.label}`);
      }
      const k = bfsStateKey(step.next);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push({ state: step.next, trace: [...item.trace, step.label] });
      }
    }
  }

  const lines = [
    "%% provenance: formal-ts",
    "stateDiagram-v2",
    "  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834",
    "  classDef pass fill:#e6f6ec,stroke:#1a7f37,color:#116329",
    "  classDef skip fill:#fff8c5,stroke:#9a6700,color:#4d2d00",
    `  [*] --> ${chartNodeId("ui", 0, false, 1)}`,
    `  [*] --> ${chartNodeId("governance", 0, false, 1)}`,
  ];
  for (const [id, label] of [...nodeLabels.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${id}: ${label}`);
  }
  for (const edge of [...edges].sort()) {
    lines.push(edge);
  }
  for (const id of [...shipNodes].sort()) lines.push(`  class ${id} pass`);
  for (const id of [...frozenNodes].sort()) lines.push(`  class ${id} skip`);
  for (const id of [...brokenNodes].sort()) lines.push(`  class ${id} breaks`);

  return {
    visitedStates: visited.size,
    transitions,
    violations,
    firstFinding,
    mermaid: `${lines.join("\n")}\n`,
  };
}

/**
 * Runs all four zero-Java formal checks against scripts/trust/index.mjs and returns the full verification report plus Mermaid chart.
 */
export function runEarnedTrustVerification(): TrustVerificationReport & { readonly mermaid: string } {
  const r1 = verifyEffectiveAutonomyPolicyPrecedence();
  const r2 = verifyDecisionTableSafetyMatrix();
  const r3 = verifyCategoryStateAndDemotionInvariants();
  const r4 = verifyEarnedTrustLifecycleBfs();

  const findings = [
    r1.firstFinding,
    r2.firstFinding,
    r3.firstFinding,
    r4.firstFinding,
  ].filter((f): f is VerificationFinding => f !== null);

  return {
    ok: findings.length === 0,
    properties: {
      EffectiveAutonomyPolicyPrecedence: {
        statesChecked: r1.checked,
        violations: r1.violations,
        status: r1.firstFinding ? "fail" : "pass",
      },
      DecisionTableSafetyMatrix: {
        statesChecked: r2.checked,
        violations: r2.violations,
        status: r2.firstFinding ? "fail" : "pass",
      },
      CategoryStateAndDemotionInvariants: {
        statesChecked: r3.checked,
        violations: r3.violations,
        status: r3.firstFinding ? "fail" : "pass",
      },
      EarnedTrustLifecycleBFS: {
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

const USAGE = `Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning .agents/skills/verify-earned-trust-formal/scripts/verify-trust.ts [options]

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

  const report = runEarnedTrustVerification();
  if (values["emit-mermaid"]) {
    const outFile = path.resolve(process.cwd(), values["emit-mermaid"]);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, report.mermaid, "utf8");
  }
  const { mermaid: _chart, ...jsonReport } = report;
  process.stdout.write(`${JSON.stringify(jsonReport, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}
