import crypto from "node:crypto";
import {
  MERGE_OUTCOMES,
  appendOutcome,
  computeBrierScore,
  readOutcomeLedger,
  readTrustSettings,
  writeTrustSettingsAtomic,
} from "./outcomes.mjs";
import { DEFAULT_RISK_POLICY } from "./policy.mjs";
import { TRUST_CATEGORIES } from "./risk.mjs";

export const TRUST_EMA_ALPHA = 0.1;
export const IDLE_DECAY_DAYS = 30;
export const IDLE_DECAY_RATE = 0.9;
export const CATEGORY_RESET_MAX_SCORE = 0.4;
export const REVERT_COOLDOWN_DAYS = 14;

export const LEVEL_THRESHOLDS = {
  1: { minOutcomes: 5, minScore: 0.4, demoteBelow: 0.3 },
  2: { minOutcomes: 10, minScore: 0.65, demoteBelow: 0.55, zeroRevertsDays: 14 },
  3: { minMerges: 20, minScore: 0.85, demoteBelow: 0.75, maxBrier: 0.12 },
};

const CATEGORY_LABELS = {
  docs: "Docs & Guides",
  tests: "Unit & Integration Tests",
  ui: "UI & Timeline Sidecar",
  skills: "Skills & Playbooks",
  tooling: "CLI & Eval Scripts",
  core: "Trust Core & MCP",
  governance: "Policy, Hooks & REVIEW.md",
};

/**
 * Computes a deterministic hash of a category's policy definition (globs + base ceiling) to detect category redefinition.
 */
export function computeCategoryPolicyHash(category, policy = DEFAULT_RISK_POLICY) {
  const autonomy = policy?.autonomy ?? DEFAULT_RISK_POLICY.autonomy ?? {};
  const defaultCap = DEFAULT_RISK_POLICY.autonomy?.ceilings?.[category] ?? (category === "governance" ? 2 : 3);
  const rawCap = autonomy.ceilings?.[category];
  const ceiling =
    typeof rawCap === "number" && Number.isFinite(rawCap)
      ? Math.max(1, Math.min(category === "governance" ? 2 : 3, Math.floor(rawCap)))
      : defaultCap;
  const payload = {
    category,
    ceiling,
    tiers: policy?.tiers ?? DEFAULT_RISK_POLICY.tiers,
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

/**
 * Resolves effective promotion mode and per-category ceilings, applying stricter-wins base-branch policy rules.
 */
export function resolveEffectiveAutonomy(policy = DEFAULT_RISK_POLICY, settings = null) {
  const baseAutonomy = policy?.autonomy ?? {};
  const localSettings = settings ?? {};
  const basePromotion =
    baseAutonomy.promotion === "manual" || baseAutonomy.promotion === "auto"
      ? baseAutonomy.promotion
      : null;
  const localPromotion = localSettings.promotionMode === "auto" ? "auto" : "manual";
  const promotionMode =
    basePromotion === "manual" ? "manual" : localPromotion;
  const promotionLockedByPolicy = basePromotion === "manual";

  const ceilings = {};
  const maxCeilings = {};
  for (const cat of TRUST_CATEGORIES) {
    const hardMax = cat === "governance" ? 2 : 3;
    const rawBaseCap = baseAutonomy.ceilings?.[cat];
    const baseCap =
      typeof rawBaseCap === "number" && Number.isFinite(rawBaseCap)
        ? Math.max(1, Math.min(hardMax, Math.floor(rawBaseCap)))
        : hardMax;
    const rawLocalCap = localSettings.ceilings?.[cat];
    const defaultCap =
      typeof baseAutonomy.defaultCeiling === "number"
        ? Math.max(1, Math.min(baseCap, Math.floor(baseAutonomy.defaultCeiling)))
        : Math.min(2, baseCap);
    const localCap =
      typeof rawLocalCap === "number" && Number.isFinite(rawLocalCap)
        ? Math.max(1, Math.min(hardMax, Math.floor(rawLocalCap)))
        : defaultCap;
    maxCeilings[cat] = baseCap;
    ceilings[cat] = Math.min(baseCap, localCap);
  }

  return {
    promotionMode,
    promotionLockedByPolicy,
    ceilings,
    maxCeilings,
    maxBrierScore:
      typeof baseAutonomy.maxBrierScore === "number" && Number.isFinite(baseAutonomy.maxBrierScore)
        ? baseAutonomy.maxBrierScore
        : 0.12,
    auditSampleRate:
      typeof baseAutonomy.auditSampleRate === "number" && baseAutonomy.auditSampleRate >= 1
        ? Math.floor(baseAutonomy.auditSampleRate)
        : 5,
  };
}

function applyIdleDecay(score, elapsedMs) {
  if (elapsedMs <= 0 || score <= 0) return score;
  const days = elapsedMs / (86400 * 1000);
  const periods = Math.floor(days / IDLE_DECAY_DAYS);
  if (periods <= 0) return score;
  return score * IDLE_DECAY_RATE ** periods;
}

/**
 * Evaluates a single category's EMA score, Brier calibration, promotion eligibility, and current level from ledger outcomes.
 */
export function evaluateCategoryState({
  category,
  entries = [],
  ceiling = 2,
  maxCeiling = 3,
  promotionMode = "manual",
  confirmedLevel = 0,
  maxBrierScore = 0.12,
  policyReset = false,
  chainValid = true,
  nowMs = Date.now(),
} = {}) {
  const isGov = category === "governance";
  const effectiveMax = isGov ? 2 : Math.max(1, Math.min(3, maxCeiling));
  const effectiveCeiling = Math.max(1, Math.min(effectiveMax, ceiling));

  const catEntries = entries
    .filter((e) => e.category === category)
    .sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));

  let score = 0;
  let earnedLevel = 0;
  let clean = 0;
  let edited = 0;
  let reverted = 0;
  let merges = 0;
  let lastTsMs = null;
  let missedAudit = false;
  let lastBadTsMs = null;
  const revertCooldownMs = REVERT_COOLDOWN_DAYS * 86400 * 1000;

  for (let i = 0; i < catEntries.length; i++) {
    const e = catEntries[i];
    const tsMs = Date.parse(String(e.ts ?? "")) || nowMs;
    if (lastTsMs !== null && tsMs > lastTsMs) {
      score = applyIdleDecay(score, tsMs - lastTsMs);
    }
    lastTsMs = tsMs;

    const y = Number(e.y ?? 0);
    if (y >= 0.5) {
      score = score + TRUST_EMA_ALPHA * (y - score);
      if (y === 1) clean += 1;
      else edited += 1;
    } else {
      score = score / 2;
      reverted += 1;
      lastBadTsMs = tsMs;
      earnedLevel = Math.max(0, Math.min(earnedLevel, effectiveCeiling) - 1);
    }
    if (MERGE_OUTCOMES.has(e.outcome)) {
      merges += 1;
    }
    if (e.sampledAudit === true && e.auditCompleted === false) {
      missedAudit = true;
      if (earnedLevel >= 3) earnedLevel = 2;
    }

    const totalSoFar = clean + edited + reverted;
    const brierSoFar = computeBrierScore(catEntries.slice(0, i + 1), 20);
    const hasRecentRevert = lastBadTsMs !== null && tsMs - lastBadTsMs < revertCooldownMs;

    if (earnedLevel === 3 && (score < LEVEL_THRESHOLDS[3].demoteBelow || missedAudit)) {
      earnedLevel = 2;
    }
    if (earnedLevel === 2 && score < LEVEL_THRESHOLDS[2].demoteBelow) {
      earnedLevel = 1;
    }
    if (earnedLevel === 1 && score < LEVEL_THRESHOLDS[1].demoteBelow) {
      earnedLevel = 0;
    }

    if (y >= 0.5) {
      if (earnedLevel === 0 && totalSoFar >= LEVEL_THRESHOLDS[1].minOutcomes && score >= LEVEL_THRESHOLDS[1].minScore) {
        earnedLevel = 1;
      } else if (
        earnedLevel === 1 &&
        totalSoFar >= LEVEL_THRESHOLDS[2].minOutcomes &&
        !hasRecentRevert &&
        score >= LEVEL_THRESHOLDS[2].minScore
      ) {
        earnedLevel = 2;
      } else if (
        earnedLevel === 2 &&
        !isGov &&
        merges >= LEVEL_THRESHOLDS[3].minMerges &&
        !hasRecentRevert &&
        !missedAudit &&
        score >= LEVEL_THRESHOLDS[3].minScore &&
        brierSoFar <= maxBrierScore
      ) {
        earnedLevel = 3;
      }
    }
  }

  let idleDays = 0;
  if (lastTsMs !== null && nowMs > lastTsMs) {
    idleDays = Math.floor((nowMs - lastTsMs) / (86400 * 1000));
    score = applyIdleDecay(score, nowMs - lastTsMs);
  }

  if (policyReset) {
    score = Math.min(score, CATEGORY_RESET_MAX_SCORE);
    earnedLevel = Math.min(earnedLevel, 1);
  }

  if (earnedLevel === 3 && (score < LEVEL_THRESHOLDS[3].demoteBelow || missedAudit)) {
    earnedLevel = 2;
  }
  if (earnedLevel === 2 && score < LEVEL_THRESHOLDS[2].demoteBelow) {
    earnedLevel = 1;
  }
  if (earnedLevel === 1 && score < LEVEL_THRESHOLDS[1].demoteBelow) {
    earnedLevel = 0;
  }

  const roundedScore = Number(Math.max(0, Math.min(1, score)).toFixed(4));
  const brier = computeBrierScore(catEntries, 20);
  const cappedEarned = Math.min(earnedLevel, effectiveCeiling);
  const boundedConfirmed = Math.max(0, Math.min(cappedEarned, Number(confirmedLevel) || 0));

  let activeLevel = 0;
  let eligibleNextLevel = null;

  if (!chainValid) {
    activeLevel = 0;
    eligibleNextLevel = null;
  } else if (promotionMode === "auto" && !isGov) {
    activeLevel = cappedEarned;
    eligibleNextLevel = null;
  } else {
    activeLevel = boundedConfirmed;
    if (cappedEarned > activeLevel) {
      eligibleNextLevel = activeLevel + 1;
    }
  }

  return {
    id: category,
    label: CATEGORY_LABELS[category] ?? category,
    level: activeLevel,
    earnedLevel: cappedEarned,
    ceiling: effectiveCeiling,
    maxCeiling: effectiveMax,
    score: roundedScore,
    brier,
    clean,
    edited,
    reverted,
    merges,
    totalOutcomes: clean + edited + reverted,
    idleDays,
    missedAudit,
    policyReset,
    promoReady: eligibleNextLevel !== null && eligibleNextLevel <= effectiveCeiling,
    eligibleNextLevel,
    frozen: !chainValid,
  };
}

/**
 * Evaluates all 7 categories and repository trust status from the local ledger and human settings.
 */
export function evaluateRepoTrust({
  repoId,
  policy = DEFAULT_RISK_POLICY,
  dataDir = null,
  nowMs = Date.now(),
} = {}) {
  const ledger = repoId
    ? readOutcomeLedger(repoId, { dataDir })
    : { ok: true, chainValid: true, brokenAtLine: null, reason: null, entries: [], ledgerPath: null };
  const settingsRes = repoId
    ? readTrustSettings(repoId, { dataDir })
    : { present: false, settingsPath: null, settings: null };
  const settings = settingsRes.settings;
  const effective = resolveEffectiveAutonomy(policy, settings);

  const categories = {};
  const categoryList = [];
  for (const cat of TRUST_CATEGORIES) {
    const curHash = computeCategoryPolicyHash(cat, policy);
    const savedHash = settings?.categoryPolicyHashes?.[cat] ?? null;
    const policyReset = Boolean(savedHash && savedHash !== curHash);
    const catState = evaluateCategoryState({
      category: cat,
      entries: ledger.entries,
      ceiling: effective.ceilings[cat],
      maxCeiling: effective.maxCeilings[cat],
      promotionMode: effective.promotionMode,
      confirmedLevel: settings?.confirmedLevels?.[cat] ?? 0,
      maxBrierScore: effective.maxBrierScore,
      policyReset,
      chainValid: ledger.chainValid,
      nowMs,
    });
    categories[cat] = catState;
    categoryList.push(catState);
  }

  return {
    repoId: repoId ?? null,
    chainValid: ledger.chainValid,
    brokenAtLine: ledger.brokenAtLine,
    chainError: ledger.reason,
    frozen: !ledger.chainValid,
    ledgerPath: ledger.ledgerPath,
    settingsPath: settingsRes.settingsPath,
    beastOn: Boolean(settings?.beastOn) && ledger.chainValid,
    promotionMode: effective.promotionMode,
    promotionLockedByPolicy: effective.promotionLockedByPolicy,
    auditSampleRate: effective.auditSampleRate,
    maxBrierScore: effective.maxBrierScore,
    lastAutoPromo: settings?.lastAutoPromo ?? null,
    totalOutcomes: ledger.entries.length,
    categories,
    categoryList,
  };
}

/**
 * Applies a validated human settings mutation (Beast toggle, Promotion mode, Ceiling, Manual Promote, or Auto Undo).
 */
export function applyTrustSettingsAction({
  repoId,
  policy = DEFAULT_RISK_POLICY,
  action,
  dataDir = null,
  now = new Date().toISOString(),
} = {}) {
  if (!repoId) throw new Error("repoId is required");
  if (!action || typeof action !== "object") throw new Error("action object is required");

  const nowMs = Date.parse(now) || Date.now();
  const before = evaluateRepoTrust({ repoId, policy, dataDir, nowMs });
  const current = readTrustSettings(repoId, { dataDir }).settings;

  const next = {
    ...current,
    ceilings: { ...current.ceilings },
    confirmedLevels: { ...current.confirmedLevels },
    categoryPolicyHashes: { ...current.categoryPolicyHashes },
  };
  for (const cat of TRUST_CATEGORIES) {
    if (!next.categoryPolicyHashes[cat]) {
      next.categoryPolicyHashes[cat] = computeCategoryPolicyHash(cat, policy);
    }
  }

  if (typeof action.beastOn === "boolean") {
    next.beastOn = action.beastOn;
  }

  if (action.promotionMode === "manual" || action.promotionMode === "auto") {
    if (action.promotionMode === "auto" && before.promotionLockedByPolicy) {
      throw new Error("Base-branch policy locks promotion mode to manual");
    }
    next.promotionMode = action.promotionMode;
    if (action.promotionMode === "auto") {
      for (const cat of before.categoryList) {
        if (cat.id === "governance") continue;
        if (cat.earnedLevel > cat.level && cat.earnedLevel <= cat.ceiling) {
          next.confirmedLevels[cat.id] = cat.earnedLevel;
          next.lastAutoPromo = {
            catId: cat.id,
            fromLvl: cat.level,
            toLvl: cat.earnedLevel,
            score: cat.score,
            ceiling: cat.ceiling,
            ts: now,
          };
        }
      }
    }
  }

  if (action.setCeiling && typeof action.setCeiling === "object") {
    const { category, ceiling } = action.setCeiling;
    if (!TRUST_CATEGORIES.includes(category)) {
      throw new Error(`Unknown category: ${category}`);
    }
    const maxCap = before.categories[category].maxCeiling;
    const requested = Number.parseInt(String(ceiling), 10);
    if (!Number.isFinite(requested) || requested < 1 || requested > 3) {
      throw new Error("ceiling must be 1, 2, or 3");
    }
    if (requested > maxCap) {
      throw new Error(`${category} ceiling cannot exceed policy limit L${maxCap}`);
    }
    next.ceilings[category] = requested;
    if (next.confirmedLevels[category] > requested) {
      next.confirmedLevels[category] = requested;
    }
  }

  if (typeof action.promoteCategory === "string" && action.promoteCategory) {
    const catId = action.promoteCategory;
    if (!TRUST_CATEGORIES.includes(catId)) {
      throw new Error(`Unknown category: ${catId}`);
    }
    const catState = before.categories[catId];
    if (before.frozen) {
      throw new Error("Cannot promote while ledger hash chain is broken");
    }
    if (!catState.promoReady || catState.eligibleNextLevel === null) {
      throw new Error(`${catId} is not currently eligible for promotion`);
    }
    next.confirmedLevels[catId] = Math.min(catState.ceiling, catState.eligibleNextLevel);
    if (next.lastAutoPromo?.catId === catId) {
      next.lastAutoPromo = null;
    }
  }

  if (action.undoAutoPromo === true) {
    const banner = current.lastAutoPromo;
    next.promotionMode = "manual";
    if (banner && TRUST_CATEGORIES.includes(banner.catId)) {
      next.confirmedLevels[banner.catId] = Math.max(0, Number(banner.fromLvl) || 0);
    }
    next.lastAutoPromo = null;
  }

  const saved = writeTrustSettingsAtomic(repoId, next, { dataDir, now });
  const trust = evaluateRepoTrust({ repoId, policy, dataDir, nowMs });
  return { ...saved, trust };
}

/**
 * Appends a graded outcome to the repo ledger and updates Auto-promotion Undo state if a level changed.
 */
export function recordOutcomeWithTrustSync({
  workspaceDir,
  scope,
  policy = DEFAULT_RISK_POLICY,
  category,
  outcome,
  headSha,
  predictedR = 0,
  prNumber = null,
  source = "manual",
  note = "",
  sampledAudit = false,
  auditCompleted = null,
  now = new Date().toISOString(),
  dataDir = null,
  baseRef = undefined,
} = {}) {
  const nowMs = Date.parse(now) || Date.now();
  const repoId = scope?.repoId ?? null;
  const before = repoId ? evaluateRepoTrust({ repoId, policy, dataDir, nowMs }) : null;
  const appended = appendOutcome({
    workspaceDir,
    scope,
    category,
    outcome,
    headSha,
    predictedR,
    prNumber,
    source,
    note,
    sampledAudit,
    auditCompleted,
    now,
    dataDir,
    baseRef,
  });
  const effectiveRepoId = appended.entry.repoId;
  const after = evaluateRepoTrust({ repoId: effectiveRepoId, policy, dataDir, nowMs });
  const prevCat = before?.categories?.[category];
  const nextCat = after.categories[category];
  if (prevCat && nextCat) {
    if (nextCat.level > prevCat.level && after.promotionMode === "auto" && category !== "governance") {
      writeTrustSettingsAtomic(
        effectiveRepoId,
        {
          confirmedLevels: { [category]: nextCat.level },
          lastAutoPromo: {
            catId: category,
            fromLvl: prevCat.level,
            toLvl: nextCat.level,
            score: nextCat.score,
            ceiling: nextCat.ceiling,
            ts: now,
          },
        },
        { dataDir, now },
      );
    } else if (appended.entry.y === 0 && prevCat.level > 0) {
      const demotedLevel = Math.min(nextCat.earnedLevel, Math.max(0, prevCat.level - 1));
      writeTrustSettingsAtomic(
        effectiveRepoId,
        {
          confirmedLevels: { [category]: demotedLevel },
          lastAutoPromo: null,
        },
        { dataDir, now },
      );
    } else if (nextCat.level < prevCat.level) {
      writeTrustSettingsAtomic(
        effectiveRepoId,
        {
          confirmedLevels: { [category]: nextCat.level },
          lastAutoPromo: null,
        },
        { dataDir, now },
      );
    }
  }
  const finalTrust = evaluateRepoTrust({ repoId: effectiveRepoId, policy, dataDir, nowMs });
  return { ...appended, trust: finalTrust };
}
