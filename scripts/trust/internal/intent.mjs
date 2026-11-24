import fs from "node:fs";
import path from "node:path";
import { sanitizeConversationId } from "./envelope.mjs";
import { matchesAnyGlob } from "./policy.mjs";
import { TRUST_CATEGORIES, classifyDominantCategory, classifyFileCategory } from "./risk.mjs";

const VALID_CATEGORIES = new Set(TRUST_CATEGORIES);
const VALID_RISK_LABELS = new Set(["low", "medium", "high", "critical"]);

function normalizeGlob(g) {
  return String(g ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Validates an Intent Card payload before persistence.
 */
export function validateIntentCard(card) {
  const errors = [];
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return ["Intent Card must be a JSON object"];
  }
  if (typeof card.goal !== "string" || !card.goal.trim()) {
    errors.push("goal must be a non-empty string");
  }
  if (!Array.isArray(card.affectedGlobs) || card.affectedGlobs.length === 0) {
    errors.push("affectedGlobs must be a non-empty array of glob strings");
  } else {
    for (const g of card.affectedGlobs) {
      if (typeof g !== "string" || !g.trim()) {
        errors.push("each affectedGlobs entry must be a non-empty string");
        break;
      }
    }
  }
  if (typeof card.rollbackPlan !== "string" || !card.rollbackPlan.trim()) {
    errors.push("rollbackPlan must be a non-empty string");
  }
  if (card.assumptions !== undefined && (!Array.isArray(card.assumptions) || card.assumptions.some((a) => typeof a !== "string"))) {
    errors.push("assumptions must be an array of strings");
  }
  if (card.edgeCases !== undefined && (!Array.isArray(card.edgeCases) || card.edgeCases.some((e) => typeof e !== "string"))) {
    errors.push("edgeCases must be an array of strings");
  }
  if (card.category !== undefined && !VALID_CATEGORIES.has(card.category)) {
    errors.push(`category must be one of ${TRUST_CATEGORIES.join(", ")}`);
  }
  if (card.predictedRisk !== undefined && card.predictedRisk !== null) {
    if (typeof card.predictedRisk === "number") {
      if (!Number.isFinite(card.predictedRisk) || card.predictedRisk < 0 || card.predictedRisk > 1) {
        errors.push("predictedRisk number must be in [0, 1]");
      }
    } else if (typeof card.predictedRisk === "string") {
      if (!VALID_RISK_LABELS.has(card.predictedRisk.toLowerCase())) {
        errors.push("predictedRisk string must be low, medium, high, or critical");
      }
    } else {
      errors.push("predictedRisk must be a number in [0, 1] or a risk label");
    }
  }
  return errors;
}

/**
 * Evaluates modified paths against an Intent Card's declared scope globs.
 */
export function evaluateIntentScope(intent, changedFiles = []) {
  const globs = Array.isArray(intent?.affectedGlobs)
    ? intent.affectedGlobs.map(normalizeGlob).filter(Boolean)
    : [];
  const hasWildcardAll = globs.some((g) => g === "**" || g === "**/*" || g === "*");
  const coveredCategories = [...new Set(globs.map((g) => classifyFileCategory(g.replace(/\*+/g, "file"))))];
  const wideScope = hasWildcardAll || globs.length > 10 || coveredCategories.length >= 3;
  const wideScopeReason = hasWildcardAll
    ? "declared scope uses catch-all wildcard"
    : globs.length > 10
      ? `declared scope lists ${globs.length} globs (>10)`
      : coveredCategories.length >= 3
        ? `declared scope spans ${coveredCategories.length} categories (${coveredCategories.join(", ")})`
        : null;

  const driftedFiles = [];
  if (globs.length > 0) {
    for (const file of changedFiles) {
      const clean = normalizeGlob(file);
      if (!clean) continue;
      if (!matchesAnyGlob(clean, globs)) {
        driftedFiles.push(clean);
      }
    }
  }

  return {
    inScope: driftedFiles.length === 0,
    driftedFiles,
    wideScope,
    wideScopeReason,
    coveredCategories,
  };
}

/**
 * Detects any test command in session receipts that passed earlier and later failed.
 */
export function detectSessionTestRegression(receipts = []) {
  const everPassed = new Set();
  const latestOk = new Map();
  for (const r of receipts) {
    if (r?.kind !== "command" || r.category !== "test") continue;
    const key = String(r.summary ?? "").trim();
    if (!key) continue;
    if (r.ok) everPassed.add(key);
    latestOk.set(key, Boolean(r.ok));
  }
  const commands = [];
  for (const cmd of everPassed) {
    if (latestOk.get(cmd) === false) commands.push(cmd);
  }
  return {
    regressed: commands.length > 0,
    commands,
  };
}

function intentFilePath(trustDir, conversationId = "default") {
  const safeId = sanitizeConversationId(conversationId || "default");
  return path.join(trustDir, `intent.${safeId}.json`);
}

/**
 * Atomically writes an Intent Card to `<trustDir>/intent.<conversationId>.json`.
 */
export function recordIntentCard({
  trustDir,
  conversationId = "default",
  card,
  headSha = null,
  now = new Date().toISOString(),
}) {
  if (!trustDir) throw new Error("trustDir is required to store an Intent Card");
  const errors = validateIntentCard(card);
  if (errors.length > 0) {
    throw new Error(`Invalid Intent Card: ${errors.join("; ")}`);
  }
  const normalized = {
    schemaVersion: 1,
    conversationId: sanitizeConversationId(conversationId),
    recordedAt: now,
    headSha: headSha ?? card.headSha ?? null,
    goal: card.goal.trim(),
    affectedGlobs: card.affectedGlobs.map(normalizeGlob).filter(Boolean),
    assumptions: Array.isArray(card.assumptions) ? card.assumptions.map((s) => s.trim()).filter(Boolean) : [],
    edgeCases: Array.isArray(card.edgeCases) ? card.edgeCases.map((s) => s.trim()).filter(Boolean) : [],
    rollbackPlan: card.rollbackPlan.trim(),
    predictedRisk: card.predictedRisk ?? null,
    category:
      card.category ??
      classifyDominantCategory(card.affectedGlobs.map((g) => g.replace(/\*+/g, "file"))),
    approved: card.approved === true,
    approvedAt: card.approved === true ? (card.approvedAt ?? now) : null,
  };

  fs.mkdirSync(trustDir, { recursive: true });
  const target = intentFilePath(trustDir, conversationId);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
  return { intent: normalized, targetPath: target };
}

/**
 * Safely reads `<trustDir>/intent.<conversationId>.json`, returning `null` if absent or malformed.
 */
export function readIntentCard(trustDir, conversationId = "default") {
  if (!trustDir) return null;
  const target = intentFilePath(trustDir, conversationId);
  if (!fs.existsSync(target)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return validateIntentCard(parsed).length === 0 ? parsed : null;
  } catch {
    return null;
  }
}
