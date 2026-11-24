import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessChange,
  classifyDominantCategory,
  classifyFileCategory,
  computeNoisyOrScore,
} from "../trust/index.mjs";
import { runRiskBacktest, runRiskFixtureCases } from "../eval/risk-backtest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../..");
const backtestCli = path.join(rootDir, "scripts", "eval", "risk-backtest.mjs");

test("assessChange computes noisy-OR score, category precedence, and all change signals deterministically", () => {
  assert.equal(computeNoisyOrScore([]), 0);
  const s1 = computeNoisyOrScore([{ id: "a", weight: 0.3 }]);
  const s2 = computeNoisyOrScore([
    { id: "a", weight: 0.3 },
    { id: "b", weight: 0.2 },
  ]);
  assert.equal(s1, 0.3);
  assert.equal(s2, 0.44);
  assert.ok(s2 > s1 && s2 <= 1);
  assert.equal(computeNoisyOrScore([{ id: "a", weight: 0.5 }], { a: 0.2 }), 0.1);

  assert.equal(classifyFileCategory("README.md"), "docs");
  assert.equal(classifyFileCategory("scripts/test/risk.test.mjs"), "tests");
  assert.equal(classifyFileCategory("sidecars/astack_timeline/app.js"), "ui");
  assert.equal(classifyFileCategory("sidecars/astack_timeline/sidecar.json"), "governance");
  assert.equal(classifyFileCategory("skills/review-pr/SKILL.md"), "skills");
  assert.equal(classifyFileCategory("scripts/cli/statusline.mjs"), "tooling");
  assert.equal(classifyFileCategory("scripts/trust/index.mjs"), "governance");
  assert.equal(classifyFileCategory("scripts/mcp/tools.mjs"), "core");
  assert.equal(classifyFileCategory(".agents/risk-policy.json"), "governance");
  assert.equal(classifyDominantCategory(["README.md", "scripts/test/a.test.mjs", "sidecars/astack_timeline/app.js"]), "ui");
  assert.equal(classifyDominantCategory(["README.md", "hooks.json"]), "governance");

  const complexDiff = [
    "diff --git a/package.json b/package.json",
    "--- a/package.json",
    "+++ b/package.json",
    "@@ -1,2 +1,3 @@",
    "+  \"dep\": \"1.0.0\"",
    "diff --git a/scripts/consumer.mjs b/scripts/consumer.mjs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/scripts/consumer.mjs",
    "@@ -0,0 +1,2 @@",
    "+import { x } from './trust/internal/ledger.mjs';",
    "+export const y = x;",
  ].join("\n");

  const assessed = assessChange({
    diffText: complexDiff,
    numstat: "500\t20\tscripts/consumer.mjs\n1\t0\tpackage.json\n",
    receipts: [
      { kind: "command", category: "test", ok: true, summary: "node --test", headSha: "a".repeat(40) },
      { kind: "command", category: "test", ok: false, summary: "node --test", headSha: "a".repeat(40) },
    ],
    intent: {
      affectedGlobs: ["docs/**"],
    },
    headSha: "a".repeat(40),
  });

  const ids = new Set(assessed.signals.map((s) => s.id));
  assert.ok(ids.has("dependency_changed"));
  assert.ok(ids.has("cross_zone_import"));
  assert.ok(ids.has("large_diff"));
  assert.ok(ids.has("new_path"));
  assert.ok(ids.has("scope_drift"));
  assert.ok(ids.has("test_regression"));
  assert.equal(assessed.residual, "blocked");
  assert.equal(assessed.inherent, "critical");
  assert.equal(assessed.tier, 3);
  assert.ok(assessed.score > 0.7 && assessed.score <= 1);
  assert.match(assessed.rollback.plan, /git revert aaaaaaa/);

  const wideIntent = assessChange({
    diffText: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
    intent: { affectedGlobs: ["**/*"] },
  });
  assert.ok(wideIntent.signals.some((s) => s.id === "wide_declared_scope"));
  assert.equal(wideIntent.signals.some((s) => s.id === "scope_drift"), false);
});

test("risk-cases.json regression fixtures pass including PR #13 sidecar permissions and PR #15 cleanup", () => {
  const report = runRiskFixtureCases();
  assert.equal(report.ok, true, JSON.stringify(report.results.filter((r) => !r.pass), null, 2));
  assert.ok(report.total >= 5);
});

test("risk-backtest.mjs replays origin/main history and flags PR #13 with follow_up_fix from PR #15", () => {
  for (const flag of ["--help", "-h"]) {
    const h = spawnSync(process.execPath, [backtestCli, flag], { encoding: "utf8" });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /Usage: node scripts\/eval\/risk-backtest\.mjs/);
  }

  const run = spawnSync(process.execPath, [backtestCli, "--base", "origin/main", "--json"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.ok(parsed.count >= 5, `Expected historical PR commits, got ${parsed.count}`);
  assert.equal(typeof parsed.brierScore, "number");
  assert.ok(parsed.brierScore >= 0 && parsed.brierScore <= 1);

  const pr13 = parsed.rows.find((r) => r.prNumber === 13);
  assert.ok(pr13, "Expected PR #13 in origin/main backtest");
  assert.ok(pr13.signals.includes("bundled_sidecar_permissions"), `PR #13 signals: ${pr13.signals}`);
  assert.ok(pr13.signals.includes("touches_governance"), `PR #13 signals: ${pr13.signals}`);
  assert.equal(pr13.residual, "blocked");
  assert.equal(pr13.outcome, "follow_up_fix");
  assert.match(pr13.matchedBy ?? "", /#15/);

  const pr15 = parsed.rows.find((r) => r.prNumber === 15);
  assert.ok(pr15, "Expected PR #15 in origin/main backtest");
  assert.equal(pr15.signals.includes("bundled_sidecar_permissions"), false);

  const direct = runRiskBacktest({ cwd: rootDir, baseRef: "origin/main", limit: 15 });
  assert.equal(direct.count, parsed.count);
});

test("assessChange still fires untested_change when a newer file_write invalidates an earlier passing test receipt", () => {
  const headSha = "1111111111111111111111111111111111111111";
  const diffText = [
    "diff --git a/scripts/app.mjs b/scripts/app.mjs",
    "--- a/scripts/app.mjs",
    "+++ b/scripts/app.mjs",
    "@@ -1 +1,2 @@",
    " export const a = 1;",
    "+export const b = 2;",
    "",
  ].join("\n");
  const stale = assessChange({
    diffText,
    headSha,
    receipts: [
      { kind: "command", category: "test", ok: true, headSha, ts: "2026-11-24T10:00:00Z", summary: "node --test" },
      { kind: "file_write", ok: true, headSha, ts: "2026-11-24T10:05:00Z", paths: ["scripts/app.mjs"] },
    ],
  });
  assert.ok(stale.signals.some((s) => s.id === "untested_change"));

  const fresh = assessChange({
    diffText,
    headSha,
    receipts: [
      { kind: "file_write", ok: true, headSha, ts: "2026-11-24T10:00:00Z", paths: ["scripts/app.mjs"] },
      { kind: "command", category: "test", ok: true, headSha, ts: "2026-11-24T10:05:00Z", summary: "node --test" },
    ],
  });
  assert.equal(fresh.signals.some((s) => s.id === "untested_change"), false);
});
