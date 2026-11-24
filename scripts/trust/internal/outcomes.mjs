import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEnrolledWorkspaceScope } from "./policy.mjs";
import { TRUST_CATEGORIES } from "./risk.mjs";

export const OUTCOME_SCORES = {
  clean: 1,
  plan_accepted: 1,
  approved_with_edits: 0.5,
  plan_revised: 0.5,
  follow_up_fix: 0.5,
  human_override: 0,
  reverted: 0,
  trunk_broken: 0,
};

export const MERGE_OUTCOMES = new Set([
  "clean",
  "approved_with_edits",
  "follow_up_fix",
  "reverted",
  "trunk_broken",
]);

export const GENESIS_HASH = "0".repeat(64);
const VALID_CATEGORIES = new Set(TRUST_CATEGORIES);
const HEX40_RE = /^[0-9a-f]{40}$/i;
const SAFE_REPO_ID_RE = /^[0-9a-f]{8,64}$/i;

export const DEFAULT_TRUST_SETTINGS = {
  schemaVersion: 1,
  updatedAt: null,
  beastOn: false,
  promotionMode: "manual",
  ceilings: {
    docs: 2,
    tests: 2,
    ui: 2,
    skills: 2,
    tooling: 2,
    core: 2,
    governance: 2,
  },
  confirmedLevels: {
    docs: 0,
    tests: 0,
    ui: 0,
    skills: 0,
    tooling: 0,
    core: 0,
    governance: 0,
  },
  lastAutoPromo: null,
  categoryPolicyHashes: {},
  categoryPolicyResets: {},
};

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSyncMs(ms) {
  Atomics.wait(SLEEP_BUFFER, 0, 0, Math.max(1, ms));
}

function splitUncollapsedSegments(subPath) {
  return String(subPath ?? "")
    .split(/[\\/]+/)
    .filter((seg) => seg.length > 0 && seg !== ".");
}

function stripWinLongPathPrefix(targetPath) {
  return /^\\\\\?\\[A-Za-z]:[\\/]/.test(targetPath) ? targetPath.slice(4) : targetPath;
}

/**
 * Walks path segments left-to-right, dereferencing symlinks before folding `..`
 * so `lnk/../target` resolves `lnk` first rather than colliding lexically.
 */
export function resolveRealPathBestEffort(rawPath, maxHopsOrOptions = 40) {
  const maxHops =
    typeof maxHopsOrOptions === "number"
      ? maxHopsOrOptions
      : (maxHopsOrOptions?.maxHops ?? 40);
  const baseDirRaw = stripWinLongPathPrefix(
    typeof maxHopsOrOptions === "object" && maxHopsOrOptions?.baseDir
      ? String(maxHopsOrOptions.baseDir)
      : process.cwd(),
  );
  const realFn = fs.realpathSync.native ?? fs.realpathSync;
  const input = stripWinLongPathPrefix(String(rawPath ?? ""));

  const parsedInput = path.parse(input);
  let prefix;
  let queue;

  if (parsedInput.root) {
    prefix = path.resolve(parsedInput.root);
    queue = splitUncollapsedSegments(input.slice(parsedInput.root.length));
  } else {
    const parsedBase = path.parse(baseDirRaw);
    prefix = parsedBase.root ? path.resolve(parsedBase.root) : path.resolve(process.cwd());
    queue = [
      ...(parsedBase.root ? splitUncollapsedSegments(baseDirRaw.slice(parsedBase.root.length)) : splitUncollapsedSegments(baseDirRaw)),
      ...splitUncollapsedSegments(input),
    ];
  }

  let hops = 0;
  let idx = 0;

  while (idx < queue.length) {
    const seg = queue[idx];
    idx += 1;

    if (seg === "..") {
      const parent = path.dirname(prefix);
      prefix = parent;
      continue;
    }

    const candidate = path.join(prefix, seg);
    let lst = null;
    try {
      lst = fs.lstatSync(candidate);
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
        prefix = candidate;
        continue;
      }
      return idx < queue.length ? path.join(candidate, ...queue.slice(idx)) : candidate;
    }

    if (lst.isSymbolicLink()) {
      hops += 1;
      if (hops > maxHops) {
        return idx < queue.length ? path.join(candidate, ...queue.slice(idx)) : candidate;
      }
      try {
        const rawTarget = stripWinLongPathPrefix(fs.readlinkSync(candidate));
        const parsedTarget = path.parse(rawTarget);
        const remaining = queue.slice(idx);
        if (parsedTarget.root) {
          prefix = path.resolve(parsedTarget.root);
          queue = [...splitUncollapsedSegments(rawTarget.slice(parsedTarget.root.length)), ...remaining];
        } else {
          // Relative symlink target resolves against real parent directory (`prefix`).
          queue = [...splitUncollapsedSegments(rawTarget), ...remaining];
        }
        idx = 0;
        continue;
      } catch {
        prefix = candidate;
        continue;
      }
    }

    try {
      prefix = realFn(candidate);
    } catch {
      prefix = candidate;
    }
  }

  return prefix;
}

function normalizePathForCompare(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Serializes cross-process read-modify-write access inside `${PLUGIN_DATA}/trust/<repoId>` via an exclusive lockfile.
 */
export function withTrustStoreLock(storeDir, lockName, fn, { timeoutMs = 4000, staleMs = 15000 } = {}) {
  fs.mkdirSync(storeDir, { recursive: true });
  const lockPath = path.join(storeDir, lockName);
  const deadline = Date.now() + timeoutMs;
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, `${process.pid}:${Date.now()}\n`);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring trust store lock ${lockName}`);
      }
      sleepSyncMs(12 + Math.floor(Math.random() * 16));
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      void 0;
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      void 0;
    }
  }
}

function renameWithRetrySync(tmpPath, targetPath) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      if (err?.code !== "EPERM" && err?.code !== "EBUSY" && err?.code !== "EACCES") {
        break;
      }
      sleepSyncMs(12 * attempt);
    }
  }
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    void 0;
  }
  throw lastErr;
}

/**
 * Resolves the local `${PLUGIN_DATA}` root directory without network dependencies.
 */
export function resolvePluginDataDir(options = {}) {
  const raw =
    options.dataDir ||
    process.env.ASTACK_PLUGIN_DATA ||
    process.env.ANTIGRAVITY_PLUGIN_DATA ||
    process.env.PLUGIN_DATA ||
    "";
  if (typeof raw === "string" && raw.trim() && !raw.includes("${")) {
    return path.resolve(raw.trim());
  }
  return path.join(os.homedir(), ".gemini", "antigravity", "plugin-data", "astack");
}

/**
 * Resolves `${PLUGIN_DATA}/trust/<repoId>` safely after validating `repoId`.
 */
export function resolveTrustStoreDir(repoId, options = {}) {
  if (typeof repoId !== "string" || !SAFE_REPO_ID_RE.test(repoId.trim())) {
    return null;
  }
  const base = resolvePluginDataDir(options);
  return path.join(base, "trust", repoId.trim().toLowerCase());
}

/**
 * Returns true if `targetPath` points inside `${PLUGIN_DATA}/trust` (ledger or human settings store), resolving symlinks and relative workspace paths.
 */
export function isProtectedTrustStorePath(targetPath, options = {}) {
  if (typeof targetPath !== "string" || !targetPath.trim()) return false;
  const raw = stripWinLongPathPrefix(targetPath.trim());
  const resolvedBase = path.join(resolvePluginDataDir(options), "trust");
  const baseCandidates = new Set([
    normalizePathForCompare(path.resolve(resolvedBase)),
    normalizePathForCompare(resolveRealPathBestEffort(resolvedBase)),
  ]);

  const hasWorkspaceDir = typeof options.workspaceDir === "string" && options.workspaceDir.trim().length > 0;
  const rawResolved =
    !path.isAbsolute(raw) && hasWorkspaceDir
      ? path.resolve(options.workspaceDir, raw)
      : path.resolve(raw);
  const targetCandidates = [
    normalizePathForCompare(rawResolved),
    normalizePathForCompare(
      resolveRealPathBestEffort(raw, hasWorkspaceDir ? { baseDir: options.workspaceDir } : undefined),
    ),
  ];
  if (!path.isAbsolute(raw) && hasWorkspaceDir) {
    targetCandidates.push(normalizePathForCompare(path.resolve(raw)));
    targetCandidates.push(normalizePathForCompare(resolveRealPathBestEffort(raw)));
  }

  for (const target of targetCandidates) {
    for (const base of baseCandidates) {
      if (target === base || target.startsWith(`${base}/`)) {
        return true;
      }
    }
    if (/(?:^|\/)plugin-data\/astack\/trust(?:\/|$)/.test(target)) {
      return true;
    }
  }
  const rawPosix = raw.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)plugin-data\/astack\/trust(?:\/|$)/.test(rawPosix);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Verifies the SHA-256 hash chain across raw JSONL ledger lines.
 */
export function verifyLedgerChain(rawText) {
  const entries = [];
  let expectedPrev = GENESIS_HASH;
  let lineNum = 0;

  for (const rawLine of String(rawText ?? "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    lineNum += 1;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        ok: false,
        chainValid: false,
        brokenAtLine: lineNum,
        reason: `Malformed JSON at ledger line ${lineNum}`,
        entries,
        lastHash: expectedPrev,
      };
    }
    if (!parsed || typeof parsed !== "object" || parsed.prevHash !== expectedPrev) {
      return {
        ok: false,
        chainValid: false,
        brokenAtLine: lineNum,
        reason: `Hash chain mismatch at ledger line ${lineNum}`,
        entries,
        lastHash: expectedPrev,
      };
    }
    if (!VALID_CATEGORIES.has(parsed.category) || !Object.hasOwn(OUTCOME_SCORES, parsed.outcome)) {
      return {
        ok: false,
        chainValid: false,
        brokenAtLine: lineNum,
        reason: `Invalid category or outcome at ledger line ${lineNum}`,
        entries,
        lastHash: expectedPrev,
      };
    }
    if (!HEX40_RE.test(String(parsed.headSha ?? ""))) {
      return {
        ok: false,
        chainValid: false,
        brokenAtLine: lineNum,
        reason: `Invalid commit headSha at ledger line ${lineNum}`,
        entries,
        lastHash: expectedPrev,
      };
    }
    entries.push(parsed);
    expectedPrev = sha256Hex(trimmed);
  }

  return {
    ok: true,
    chainValid: true,
    brokenAtLine: null,
    reason: null,
    entries,
    lastHash: expectedPrev,
  };
}

/**
 * Reads and verifies `${PLUGIN_DATA}/trust/<repoId>/ledger.jsonl`.
 */
export function readOutcomeLedger(repoId, options = {}) {
  const storeDir = resolveTrustStoreDir(repoId, options);
  if (!storeDir) {
    return {
      ok: false,
      chainValid: false,
      brokenAtLine: null,
      reason: "Invalid repoId",
      entries: [],
      lastHash: GENESIS_HASH,
      ledgerPath: null,
    };
  }
  const ledgerPath = path.join(storeDir, "ledger.jsonl");
  if (!fs.existsSync(ledgerPath)) {
    return {
      ok: true,
      chainValid: true,
      brokenAtLine: null,
      reason: null,
      entries: [],
      lastHash: GENESIS_HASH,
      ledgerPath,
    };
  }
  const raw = fs.readFileSync(ledgerPath, "utf8");
  const verified = verifyLedgerChain(raw);
  return { ...verified, ledgerPath };
}

/**
 * Appends one git-anchored outcome line to `${PLUGIN_DATA}/trust/<repoId>/ledger.jsonl`, strictly gated on `enrolled_repo`.
 */
export function appendOutcome({
  workspaceDir,
  scope = null,
  category,
  outcome,
  headSha,
  predictedR = 0,
  prNumber = null,
  source = "manual",
  note = "",
  sampledAudit = false,
  auditCompleted = null,
  dedupeOutcomes = null,
  now = new Date().toISOString(),
  dataDir = null,
  baseRef = undefined,
} = {}) {
  const resolvedScope =
    scope ?? resolveEnrolledWorkspaceScope(workspaceDir, { baseRef });
  if (!resolvedScope || resolvedScope.kind !== "enrolled_repo" || !resolvedScope.repoId) {
    throw new Error("Outcomes can only be recorded for enrolled git repositories");
  }
  if (!HEX40_RE.test(String(headSha ?? ""))) {
    throw new Error("Outcome requires a valid 40-hex commit or merge headSha");
  }
  if (!VALID_CATEGORIES.has(category)) {
    throw new Error(`Invalid trust category: ${category}`);
  }
  if (!Object.hasOwn(OUTCOME_SCORES, outcome)) {
    throw new Error(`Invalid outcome: ${outcome}`);
  }
  const rVal = Number(predictedR);
  if (!Number.isFinite(rVal) || rVal < 0 || rVal > 1) {
    throw new Error(`predictedR must be a finite number in [0, 1], got ${predictedR}`);
  }

  const normalizedHeadSha = String(headSha).toLowerCase();
  const validPrNumber = Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
  const dedupeSet =
    Array.isArray(dedupeOutcomes) && dedupeOutcomes.length > 0 ? new Set(dedupeOutcomes) : null;

  const storeDir = resolveTrustStoreDir(resolvedScope.repoId, { dataDir });
  return withTrustStoreLock(storeDir, "ledger.lock", () => {
    const existing = readOutcomeLedger(resolvedScope.repoId, { dataDir });
    if (!existing.chainValid) {
      throw new Error(`Cannot append outcome: ${existing.reason}`);
    }

    if (dedupeSet && validPrNumber !== null) {
      const prior = existing.entries.find(
        (e) =>
          e.prNumber === validPrNumber &&
          String(e.headSha ?? "").toLowerCase() === normalizedHeadSha &&
          dedupeSet.has(e.outcome),
      );
      if (prior) {
        return {
          duplicate: true,
          entry: prior,
          ledgerPath: existing.ledgerPath,
          entryHash: null,
        };
      }
    }

    const entry = {
      schemaVersion: 1,
      ts: now,
      repoId: resolvedScope.repoId,
      category,
      headSha: normalizedHeadSha,
      prNumber: validPrNumber,
      outcome,
      y: OUTCOME_SCORES[outcome],
      predictedR: Number(rVal.toFixed(4)),
      source: String(source || "manual").slice(0, 40),
      note: String(note ?? "").slice(0, 200),
      sampledAudit: Boolean(sampledAudit),
      auditCompleted: auditCompleted === null ? null : Boolean(auditCompleted),
      prevHash: existing.lastHash,
    };

    const serialized = JSON.stringify(entry);
    fs.appendFileSync(existing.ledgerPath, `${serialized}\n`, "utf8");
    return {
      duplicate: false,
      entry,
      ledgerPath: existing.ledgerPath,
      entryHash: sha256Hex(serialized),
    };
  });
}

/**
 * Computes Brier calibration error over the most recent `windowSize` outcomes (`bad = 1 - y`).
 */
export function computeBrierScore(entries = [], windowSize = 20) {
  const slice = entries.slice(-Math.max(1, windowSize));
  if (slice.length === 0) return 0;
  let sum = 0;
  for (const e of slice) {
    const r = Math.max(0, Math.min(1, Number(e.predictedR ?? 0)));
    const y = Math.max(0, Math.min(1, Number(e.y ?? 1)));
    const bad = 1 - y;
    sum += (r - bad) ** 2;
  }
  return Number((sum / slice.length).toFixed(4));
}

function clampCeiling(cat, value) {
  const n = Number.parseInt(String(value ?? 2), 10);
  const bounded = Number.isFinite(n) ? Math.max(1, Math.min(3, n)) : 2;
  return cat === "governance" ? Math.min(2, bounded) : bounded;
}

function normalizeSettings(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const ceilings = {};
  const confirmedLevels = {};
  for (const cat of TRUST_CATEGORIES) {
    ceilings[cat] = clampCeiling(cat, src.ceilings?.[cat] ?? 2);
    const rawLvl = Number.parseInt(String(src.confirmedLevels?.[cat] ?? 0), 10);
    const maxLvl = cat === "governance" ? 2 : ceilings[cat];
    confirmedLevels[cat] = Number.isFinite(rawLvl) ? Math.max(0, Math.min(maxLvl, rawLvl)) : 0;
  }
  const promotionMode = src.promotionMode === "auto" ? "auto" : "manual";
  return {
    schemaVersion: 1,
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : null,
    beastOn: Boolean(src.beastOn),
    promotionMode,
    ceilings,
    confirmedLevels,
    lastAutoPromo:
      src.lastAutoPromo &&
      typeof src.lastAutoPromo === "object" &&
      VALID_CATEGORIES.has(src.lastAutoPromo.catId)
        ? {
            catId: src.lastAutoPromo.catId,
            fromLvl: Number(src.lastAutoPromo.fromLvl) || 0,
            toLvl: Number(src.lastAutoPromo.toLvl) || 0,
            score: Number(src.lastAutoPromo.score) || 0,
            ceiling: clampCeiling(src.lastAutoPromo.catId, src.lastAutoPromo.ceiling),
            ts: typeof src.lastAutoPromo.ts === "string" ? src.lastAutoPromo.ts : null,
          }
        : null,
    categoryPolicyHashes:
      src.categoryPolicyHashes && typeof src.categoryPolicyHashes === "object"
        ? { ...src.categoryPolicyHashes }
        : {},
    categoryPolicyResets:
      src.categoryPolicyResets && typeof src.categoryPolicyResets === "object"
        ? { ...src.categoryPolicyResets }
        : {},
  };
}

/**
 * Reads human-managed trust settings from `${PLUGIN_DATA}/trust/<repoId>/settings.json`.
 */
export function readTrustSettings(repoId, options = {}) {
  const storeDir = resolveTrustStoreDir(repoId, options);
  if (!storeDir) {
    return { present: false, parseError: null, settingsPath: null, settings: structuredClone(DEFAULT_TRUST_SETTINGS) };
  }
  const settingsPath = path.join(storeDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    return { present: false, parseError: null, settingsPath, settings: structuredClone(DEFAULT_TRUST_SETTINGS) };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return { present: true, parseError: null, settingsPath, settings: normalizeSettings(parsed) };
  } catch (err) {
    return {
      present: false,
      parseError: err?.message ?? "Invalid settings JSON",
      settingsPath,
      settings: structuredClone(DEFAULT_TRUST_SETTINGS),
    };
  }
}

/**
 * Atomically persists validated human settings to `${PLUGIN_DATA}/trust/<repoId>/settings.json`.
 */
export function writeTrustSettingsAtomic(repoId, patchOrSettings, options = {}) {
  const storeDir = resolveTrustStoreDir(repoId, options);
  if (!storeDir) {
    throw new Error("Invalid repoId for trust settings write");
  }
  const doWrite = () => {
    const current = readTrustSettings(repoId, options).settings;
    const patch = patchOrSettings && typeof patchOrSettings === "object" ? patchOrSettings : {};
    const merged = normalizeSettings({
      ...current,
      ...patch,
      ceilings: {
        ...current.ceilings,
        ...(patch.ceilings && typeof patch.ceilings === "object" ? patch.ceilings : {}),
      },
      confirmedLevels: {
        ...current.confirmedLevels,
        ...(patch.confirmedLevels && typeof patch.confirmedLevels === "object"
          ? patch.confirmedLevels
          : {}),
      },
      categoryPolicyHashes: {
        ...current.categoryPolicyHashes,
        ...(patch.categoryPolicyHashes && typeof patch.categoryPolicyHashes === "object"
          ? patch.categoryPolicyHashes
          : {}),
      },
      categoryPolicyResets: {
        ...current.categoryPolicyResets,
        ...(patch.categoryPolicyResets && typeof patch.categoryPolicyResets === "object"
          ? patch.categoryPolicyResets
          : {}),
      },
      updatedAt: options.now ?? new Date().toISOString(),
    });

    fs.mkdirSync(storeDir, { recursive: true });
    const target = path.join(storeDir, "settings.json");
    const tmp = path.join(
      storeDir,
      `settings.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`,
    );
    fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    renameWithRetrySync(tmp, target);
    return { settings: merged, settingsPath: target };
  };

  if (options.alreadyLocked === true) {
    return doWrite();
  }
  return withTrustStoreLock(storeDir, "settings.lock", doWrite);
}

/**
 * Classifies a PR's post-merge or review outcome from branch commits, reviews, revert signals, and CI checks.
 */
export function classifyObservedOutcome({
  reverted = false,
  trunkBroken = false,
  rejected = false,
  followUpFix = false,
  changesRequested = false,
  branchCommitShas = [],
  agentReceiptShas = [],
} = {}) {
  if (reverted) return { outcome: "reverted", y: 0, reason: "Merge commit was reverted" };
  if (trunkBroken) return { outcome: "trunk_broken", y: 0, reason: "Trunk CI failed after merge" };
  if (rejected) return { outcome: "human_override", y: 0, reason: "PR or plan rejected by human" };
  if (followUpFix) return { outcome: "follow_up_fix", y: 0.5, reason: "Follow-up fix touched same files in watch window" };
  if (changesRequested) {
    return { outcome: "approved_with_edits", y: 0.5, reason: "Human requested changes before merge" };
  }
  const agentSet = new Set(agentReceiptShas.map((s) => String(s).toLowerCase()));
  const humanCommits = branchCommitShas.filter((s) => s && !agentSet.has(String(s).toLowerCase()));
  if (agentSet.size > 0 && humanCommits.length > 0) {
    return {
      outcome: "approved_with_edits",
      y: 0.5,
      reason: `${humanCommits.length} human commit(s) pushed on agent branch before merge`,
    };
  }
  return { outcome: "clean", y: 1, reason: "Merged cleanly with no edits, reverts, or regressions" };
}
