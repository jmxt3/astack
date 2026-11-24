#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_RISK_WEIGHTS, assessChange, loadRiskPolicy } from "../trust/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..");

const USAGE = `Usage: node scripts/eval/risk-backtest.mjs [options]

Replays recent PR commits on a git base ref, scores each change with assessChange(),
derives historical outcomes (clean, follow_up_fix, reverted), and prints Brier calibration.

Options:
  --base <ref>     Git ref to replay (defaults to origin/main, falling back to HEAD)
  --cwd <dir>      Git repository directory (defaults to repository root)
  --limit <n>      Maximum PR commits to replay (default: 15)
  --window <days>  Follow-up fix watch window in days (default: 7)
  --json           Emit machine-readable JSON output
  -h, --help       Show this help text and exit 0`;

function tryGit(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function parsePrNumber(subject) {
  const m = String(subject ?? "").match(/\(#(\d+)\)|Merge pull request #(\d+)\b/i);
  if (!m) return null;
  return Number.parseInt(m[1] ?? m[2], 10);
}

function outcomeScore(outcome) {
  if (outcome === "clean") return 1;
  if (outcome === "follow_up_fix" || outcome === "approved_with_edits") return 0.5;
  return 0;
}

function parseNumstatFiles(numstatText) {
  const files = new Set();
  for (const line of String(numstatText ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    files.add(parts.slice(2).join("\t").replace(/\\/g, "/"));
  }
  return files;
}

function isFixSubject(subject) {
  return /^(?:fix|revert)\b|hotfix|regression|broken/i.test(String(subject ?? "").trim());
}

function isRevertOf(laterSubject, earlier) {
  const lower = String(laterSubject ?? "").toLowerCase();
  if (!lower.startsWith('revert "')) return false;
  const cleanEarlier = String(earlier.subject ?? "").toLowerCase().slice(0, 32);
  return (cleanEarlier && lower.includes(cleanEarlier)) || (earlier.prNumber && lower.includes(`#${earlier.prNumber}`));
}

/**
 * Replays git history on `baseRef` and computes Brier calibration plus suggested signal weights.
 */
export function runRiskBacktest({
  cwd = DEFAULT_ROOT,
  baseRef = "origin/main",
  limit = 15,
  windowDays = 7,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const effectiveRef =
    tryGit(resolvedCwd, ["rev-parse", "--verify", baseRef]) !== null ? baseRef : "HEAD";
  const { policy } = loadRiskPolicy(resolvedCwd, { baseRef: effectiveRef });

  const logRaw =
    tryGit(resolvedCwd, [
      "log",
      "--first-parent",
      `-${Math.max(1, limit * 3)}`,
      "--format=%H%x1f%ct%x1f%s",
      effectiveRef,
    ]) ?? "";

  const allCommits = [];
  for (const line of logRaw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [sha, tsRaw, subject] = line.split("\x1f");
    if (!sha || !subject) continue;
    const prNumber = parsePrNumber(subject);
    if (prNumber === null) continue;
    allCommits.push({
      sha: sha.trim(),
      tsSec: Number.parseInt(tsRaw, 10) || 0,
      subject: subject.trim(),
      prNumber,
    });
    if (allCommits.length >= limit) break;
  }

  allCommits.reverse();

  const enriched = allCommits.map((c) => {
    const numstat = tryGit(resolvedCwd, ["show", "--format=", "--no-renames", "--numstat", "-m", "--first-parent", c.sha]) ?? "";
    const diffText = tryGit(resolvedCwd, ["show", "--format=", "--no-renames", "-m", "--first-parent", c.sha]) ?? "";
    const assessment = assessChange({
      diffText,
      numstat,
      policy,
      headSha: c.sha,
      now: new Date(c.tsSec * 1000).toISOString(),
    });
    return {
      ...c,
      files: parseNumstatFiles(numstat),
      assessment,
    };
  });

  const windowSec = Math.max(1, windowDays) * 86400;
  const rows = [];
  const signalStats = new Map();

  for (let i = 0; i < enriched.length; i++) {
    const cur = enriched[i];
    let outcome = "clean";
    const followUpMatches = [];
    const followUpPrs = [];

    for (let j = i + 1; j < enriched.length; j++) {
      const later = enriched[j];
      const dt = later.tsSec - cur.tsSec;
      if (dt < 0 || dt > windowSec * 2) continue;
      if (isRevertOf(later.subject, cur)) {
        outcome = "reverted";
        followUpMatches.length = 0;
        followUpPrs.length = 0;
        followUpMatches.push(`PR #${later.prNumber} (${later.sha.slice(0, 7)})`);
        followUpPrs.push(later.prNumber);
        break;
      }
      if (dt <= windowSec && isFixSubject(later.subject)) {
        const shared = [...cur.files].filter(
          (f) => later.files.has(f) && !/^README\.md$|^package-lock\.json$/i.test(f),
        );
        if (shared.length > 0) {
          outcome = "follow_up_fix";
          followUpMatches.push(`PR #${later.prNumber} (${shared.slice(0, 2).join(", ")})`);
          followUpPrs.push(later.prNumber);
        }
      }
    }
    const matchedBy = followUpMatches.length > 0 ? followUpMatches.join("; ") : null;

    const y = outcomeScore(outcome);
    const bad = 1 - y;
    const sqErr = Number(((cur.assessment.score - bad) ** 2).toFixed(4));
    for (const sig of cur.assessment.signals) {
      const st = signalStats.get(sig.id) ?? { fired: 0, badSum: 0 };
      st.fired += 1;
      st.badSum += bad;
      signalStats.set(sig.id, st);
    }

    rows.push({
      prNumber: cur.prNumber,
      sha: cur.sha.slice(0, 7),
      subject: cur.subject,
      category: cur.assessment.category,
      tier: cur.assessment.tier,
      score: cur.assessment.score,
      inherent: cur.assessment.inherent,
      residual: cur.assessment.residual,
      signals: cur.assessment.signals.map((s) => s.id),
      outcome,
      y,
      matchedBy,
      followUpPrs,
      brierTerm: sqErr,
    });
  }

  const brierScore =
    rows.length > 0
      ? Number((rows.reduce((sum, r) => sum + r.brierTerm, 0) / rows.length).toFixed(4))
      : 0;

  const suggestedWeights = {};
  for (const [id, st] of signalStats.entries()) {
    const empirical = st.badSum / Math.max(1, st.fired);
    const prior = DEFAULT_RISK_WEIGHTS[id] ?? 0.2;
    suggestedWeights[id] = Number(((prior + empirical) / 2).toFixed(3));
  }

  return {
    baseRef: effectiveRef,
    count: rows.length,
    brierScore,
    suggestedWeights,
    rows,
  };
}

/**
 * Evaluates labeled fixture regression cases from `scripts/eval/fixtures/risk-cases.json`.
 */
export function runRiskFixtureCases(
  fixturesPath = path.join(__dirname, "fixtures", "risk-cases.json"),
) {
  const raw = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  const results = [];
  for (const tc of raw.cases ?? []) {
    const assessment = assessChange({ diffText: tc.diff });
    const sigIds = new Set(assessment.signals.map((s) => s.id));
    const reasons = [];
    if (tc.expectedCategory && assessment.category !== tc.expectedCategory) {
      reasons.push(`expected category ${tc.expectedCategory}, got ${assessment.category}`);
    }
    if (tc.expectedResidual && assessment.residual !== tc.expectedResidual) {
      reasons.push(`expected residual ${tc.expectedResidual}, got ${assessment.residual}`);
    }
    for (const req of tc.expectedSignals ?? []) {
      if (!sigIds.has(req)) reasons.push(`missing expected signal ${req}`);
    }
    for (const forbid of tc.forbiddenSignals ?? []) {
      if (sigIds.has(forbid)) reasons.push(`unexpected forbidden signal ${forbid}`);
    }
    results.push({
      id: tc.id,
      pass: reasons.length === 0,
      category: assessment.category,
      residual: assessment.residual,
      score: assessment.score,
      signals: [...sigIds],
      reasons,
    });
  }
  return {
    ok: results.every((r) => r.pass),
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    results,
  };
}

function formatTable(report) {
  const lines = [
    `Risk Backtest (${report.baseRef}) | commits=${report.count} | Brier=${report.brierScore}`,
    "",
    "| PR | Category | R | Residual | Outcome | Signals |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of report.rows) {
    lines.push(
      `| #${r.prNumber} | ${r.category} | ${r.score.toFixed(2)} | ${r.residual} | ${r.outcome}${r.matchedBy ? ` (${r.matchedBy})` : ""} | ${r.signals.join(", ") || "none"} |`,
    );
  }
  return lines.join("\n");
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string", default: "origin/main" },
      cwd: { type: "string" },
      limit: { type: "string", default: "15" },
      window: { type: "string", default: "7" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const report = runRiskBacktest({
    cwd: values.cwd ?? DEFAULT_ROOT,
    baseRef: values.base,
    limit: Number.parseInt(values.limit, 10) || 15,
    windowDays: Number.parseInt(values.window, 10) || 7,
  });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatTable(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
