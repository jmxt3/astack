#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  computeFreshness,
  evaluateRepoTrust,
  loadRiskPolicy,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  resolveBaseRef,
  resolveTrustDir,
  resolveTrustStoreDir,
  resolveWorkspaceScope,
} from "../trust/index.mjs";

const USAGE = `Usage: node scripts/cli/statusline.mjs [options]

Reads Antigravity CLI statusLine JSON from stdin and prints a single ANSI pipeline status line.

Options:
  -h, --help   Show this help text and exit 0`;

const ANSI_COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

function resolveArtifactDirFromTranscript(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return null;
  const resolved = path.resolve(transcriptPath.trim());
  const marker = `${path.sep}.system_generated${path.sep}`;
  const idx = resolved.indexOf(marker);
  if (idx !== -1) {
    return resolved.slice(0, idx);
  }
  return null;
}

/**
 * Computes fast zero-spawn AStack pipeline & trust state from an Antigravity CLI stdin payload.
 */
export function readCliPipelineState(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload) ? rawPayload : {};
  const workspaceDir =
    typeof payload?.workspace?.project_dir === "string" && payload.workspace.project_dir.trim()
      ? payload.workspace.project_dir.trim()
      : typeof payload.cwd === "string" && payload.cwd.trim()
        ? payload.cwd.trim()
        : process.cwd();
  const artifactDir = resolveArtifactDirFromTranscript(payload.transcript_path);
  const repoName = path.basename(path.resolve(workspaceDir)) || "workspace";

  const headSha = readHeadShaFast(workspaceDir);
  const trustDirs = [
    artifactDir ? resolveTrustDir({ workspaceDir, artifactDir }) : null,
    resolveTrustDir({ workspaceDir }),
  ].filter(Boolean);

  let evidence = null;
  let receipts = [];
  for (const td of trustDirs) {
    if (!evidence) evidence = readEvidenceSnapshot(td);
    const merged = readMergedReceipts(td);
    if (merged.length > 0 && receipts.length === 0) receipts = merged;
  }

  const freshness = headSha
    ? computeFreshness({ receipts, headSha, priorEvidence: evidence })
    : receipts.length > 0
      ? computeFreshness({ receipts, headSha: null, priorEvidence: evidence })
      : "no_git";

  const hasPlan = Boolean(artifactDir && fs.existsSync(path.join(artifactDir, "implementation_plan.md")));
  const hasWalkthrough = Boolean(artifactDir && fs.existsSync(path.join(artifactDir, "walkthrough.md")));
  const hasWrites = receipts.some((r) => r.kind === "file_write");
  const isFresh = freshness === "fresh" || freshness === "fresh_rebase_patch_id";
  const isStale = freshness === "dirty_after_verify" || freshness === "stale_sha";
  const verifierVerdict = evidence?.verifier?.verdict ?? null;

  const planSym = hasWalkthrough || hasWrites || verifierVerdict ? "✓" : hasPlan ? "●" : "·";
  const buildSym = isFresh ? "✓" : isStale ? "!" : hasWrites || payload.agent_state === "running" ? "●" : "·";
  const reviewSym =
    verifierVerdict === "PASS" || verifierVerdict === "PASS_WITH_NOTES"
      ? "✓"
      : verifierVerdict === "FAIL" || verifierVerdict === "ESCALATE_HUMAN"
        ? "!"
        : evidence
          ? "●"
          : "·";
  const shipSym = "·";

  const activeStage =
    reviewSym === "●" || reviewSym === "!"
      ? "Review"
      : reviewSym === "✓"
        ? "Ship"
        : buildSym !== "·"
          ? "Build"
          : planSym === "●"
            ? "Plan"
            : "Ready";

  const tier = typeof evidence?.riskTier === "number" ? evidence.riskTier : null;
  let enrolledScope = null;
  let enrolledPolicy = null;
  if (headSha) {
    const fastScope = resolveWorkspaceScope(workspaceDir, { checkEnrollment: false });
    const storeDir = fastScope.repoId ? resolveTrustStoreDir(fastScope.repoId) : null;
    if (
      fastScope.kind !== "non_repo" &&
      fastScope.repoRoot &&
      (fs.existsSync(path.join(fastScope.repoRoot, ".agents", "risk-policy.json")) ||
        Boolean(storeDir && fs.existsSync(storeDir)))
    ) {
      const baseRef = resolveBaseRef(fastScope.repoRoot);
      if (baseRef) {
        const loaded = loadRiskPolicy(fastScope.repoRoot, { baseRef });
        if (loaded.present && !loaded.error && fastScope.repoId) {
          enrolledScope = { ...fastScope, kind: "enrolled_repo", baseRef };
          enrolledPolicy = loaded.policy;
        }
      }
    }
  }

  const normHead = typeof headSha === "string" && headSha.trim() ? headSha.trim().toLowerCase() : null;
  const topEvHead =
    typeof evidence?.headSha === "string" && evidence.headSha.trim()
      ? evidence.headSha.trim().toLowerCase()
      : null;
  const innerEvHead =
    typeof evidence?.riskAssessment?.headSha === "string" && evidence.riskAssessment.headSha.trim()
      ? evidence.riskAssessment.headSha.trim().toLowerCase()
      : null;
  const evidenceMatchesHead =
    Boolean(evidence?.riskAssessment) &&
    Boolean(normHead) &&
    Boolean(topEvHead || innerEvHead) &&
    (!topEvHead || topEvHead === normHead) &&
    (!innerEvHead || innerEvHead === normHead);
  const riskAssessment = enrolledScope && evidenceMatchesHead ? evidence.riskAssessment : null;
  const riskScore =
    typeof riskAssessment?.score === "number" &&
    Number.isFinite(riskAssessment.score) &&
    riskAssessment.score >= 0 &&
    riskAssessment.score <= 1
      ? riskAssessment.score
      : null;
  let activeCategory =
    typeof riskAssessment?.category === "string" && riskAssessment.category.trim()
      ? riskAssessment.category.trim()
      : null;
  let trustLevel = null;
  let beastOn = false;
  if (enrolledScope) {
    const repoTrust = evaluateRepoTrust({ repoId: enrolledScope.repoId, policy: enrolledPolicy });
    beastOn = repoTrust.beastOn;
    if (!activeCategory || !Object.hasOwn(repoTrust.categories, activeCategory)) {
      const best = [...repoTrust.categoryList].sort(
        (a, b) => b.level - a.level || b.totalOutcomes - a.totalOutcomes,
      )[0];
      activeCategory = best?.totalOutcomes > 0 ? best.id : "core";
    }
    const cat = repoTrust.categories[activeCategory] ?? null;
    if (cat) {
      trustLevel = cat.level;
    }
  }
  const ctxPct =
    typeof payload?.context_window?.used_percentage === "number"
      ? Math.round(payload.context_window.used_percentage)
      : null;
  const width =
    typeof payload.terminal_width === "number" && payload.terminal_width > 0
      ? payload.terminal_width
      : process.stdout.columns || 100;

  return {
    repoName,
    headSha,
    freshness,
    activeStage,
    tier,
    riskScore,
    activeCategory,
    trustLevel,
    beastOn,
    ctxPct,
    width,
    stages: { plan: planSym, build: buildSym, review: reviewSym, ship: shipSym },
  };
}

function colorizeSymbol(sym) {
  if (sym === "✓") return `${ANSI_COLORS.green}${sym}${ANSI_COLORS.reset}`;
  if (sym === "!") return `${ANSI_COLORS.red}${sym}${ANSI_COLORS.reset}`;
  if (sym === "●") return `${ANSI_COLORS.cyan}${sym}${ANSI_COLORS.reset}`;
  return `${ANSI_COLORS.dim}${sym}${ANSI_COLORS.reset}`;
}

function colorizeFreshness(freshness) {
  if (freshness === "fresh" || freshness === "fresh_rebase_patch_id") {
    return `${ANSI_COLORS.green}${freshness}${ANSI_COLORS.reset}`;
  }
  if (freshness === "dirty_after_verify" || freshness === "stale_sha") {
    return `${ANSI_COLORS.yellow}${freshness}${ANSI_COLORS.reset}`;
  }
  return `${ANSI_COLORS.dim}${freshness}${ANSI_COLORS.reset}`;
}

/**
 * Renders an ANSI width-adaptive status line compatible with CLI `stack_with_default: true`.
 */
export function renderStatusLine(rawPayload, { ansi = true } = {}) {
  const s = readCliPipelineState(rawPayload);
  const tierPart = s.tier !== null ? `Tier ${s.tier}` : null;
  const riskPart = s.riskScore !== null ? `R ${s.riskScore.toFixed(2)}` : null;
  const trustPart =
    s.trustLevel !== null
      ? `${s.beastOn ? "Beast " : ""}${s.activeCategory ? `${s.activeCategory} ` : ""}L${s.trustLevel}`
      : null;
  const ctxPart = s.ctxPct !== null ? `${s.ctxPct}% ctx` : null;

  if (s.width < 70) {
    const p = ansi ? colorizeSymbol(s.stages.plan) : s.stages.plan;
    const b = ansi ? colorizeSymbol(s.stages.build) : s.stages.build;
    const r = ansi ? colorizeSymbol(s.stages.review) : s.stages.review;
    const sh = ansi ? colorizeSymbol(s.stages.ship) : s.stages.ship;
    const shortFresh = s.freshness === "missing_receipts" ? "unverified" : s.freshness;
    const parts = [
      `AStack [P${p} B${b} R${r} S${sh}]`,
      tierPart ? `T${s.tier}` : null,
      s.trustLevel !== null ? `${s.beastOn ? "Beast " : ""}L${s.trustLevel}` : null,
      riskPart,
      ansi ? colorizeFreshness(shortFresh) : shortFresh,
      s.ctxPct !== null ? `${s.ctxPct}%` : null,
    ].filter(Boolean);
    return parts.join(" · ");
  }

  const segs = [
    `Plan ${ansi ? colorizeSymbol(s.stages.plan) : s.stages.plan}`,
    `Build ${ansi ? colorizeSymbol(s.stages.build) : s.stages.build}`,
    `Review ${ansi ? colorizeSymbol(s.stages.review) : s.stages.review}`,
    `Ship ${ansi ? colorizeSymbol(s.stages.ship) : s.stages.ship}`,
  ].join(" | ");
  const header = ansi ? `${ANSI_COLORS.bold}AStack${ANSI_COLORS.reset}` : "AStack";
  const parts = [
    `${header} [${segs}]`,
    tierPart,
    riskPart,
    trustPart,
    ansi ? colorizeFreshness(s.freshness) : s.freshness,
    ctxPart,
  ].filter(Boolean);
  return parts.join(" · ");
}

/**
 * Safely parses CLI JSON from stdin, returning `{}` on empty or invalid input.
 */
export function parseCliStdin(rawText) {
  if (typeof rawText !== "string" || !rawText.trim()) return {};
  try {
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function main() {
  const { values } = parseArgs({
    options: { help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  const line = renderStatusLine(parseCliStdin(raw));
  process.stdout.write(`${line}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stdout.write("AStack [Ready]\n");
  }
}
