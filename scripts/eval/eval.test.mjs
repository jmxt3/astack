import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractReplayUsage, extractStructuredReplayPayload, gradeReplayOutput, runIncidentReplay } from "./incident-replay.mjs";
import { runEvalSuite } from "./run-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const evalCli = path.join(here, "run-eval.mjs");

test("runEvalSuite passes all routing fixture lint and structural contract cases", () => {
  const report = runEvalSuite();
  assert.equal(report.ok, true, JSON.stringify(report.results.filter((r) => !r.pass), null, 2));
  assert.equal(report.suiteKind, "routing-fixture-and-contract-lint");
  assert.equal(report.failed, 0);
  assert.ok(report.total >= 19);
});

test("runIncidentReplay passes offline seed incidents and gradeReplayOutput catches missed bugs and false positives", () => {
  const replay = runIncidentReplay({ live: false });
  assert.equal(replay.ok, true, JSON.stringify(replay.results, null, 2));
  assert.equal(replay.bugRecall, 1);
  assert.equal(replay.falsePositives, 0);

  const missedBug = gradeReplayOutput(
    {
      id: "bug-1",
      expectedVerdict: ["FAIL"],
      expectImportantMin: 1,
      expectImportantMax: 3,
      expectedCategories: ["correctness"],
    },
    {
      schemaVersion: 1,
      verdict: "PASS",
      summary: "Missed it",
      findings: [],
      dropped: [],
      reviewMdCompliance: { checked: true, violations: [] },
    },
  );
  assert.equal(missedBug.pass, false);
  assert.ok(missedBug.reasons.length >= 2);

  const falsePos = gradeReplayOutput(
    {
      id: "clean-1",
      expectedVerdict: ["PASS"],
      expectImportantMin: 0,
      expectImportantMax: 0,
      expectedCategories: [],
    },
    {
      schemaVersion: 1,
      verdict: "FAIL",
      summary: "False alarm",
      findings: [
        {
          id: "FP-1",
          severity: "important",
          category: "correctness",
          file: "README.md",
          line: 1,
          claim: "Bogus",
          evidence: "None",
          suggestedFix: "None",
        },
      ],
      dropped: [],
      reviewMdCompliance: { checked: true, violations: [] },
    },
  );
  assert.equal(falsePos.pass, false);
  assert.match(falsePos.reasons.join(";"), /False positive/);
});

test("run-eval CLI supports --help, -h, --json, and --replay --json", () => {
  for (const flag of ["--help", "-h"]) {
    const res = spawnSync(process.execPath, [evalCli, flag], { encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage: node scripts\/eval\/run-eval\.mjs/);
  }
  const jsonRun = spawnSync(process.execPath, [evalCli, "--json"], { encoding: "utf8" });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  assert.equal(JSON.parse(jsonRun.stdout).ok, true);

  const replayRun = spawnSync(process.execPath, [evalCli, "--replay", "--json"], { encoding: "utf8" });
  assert.equal(replayRun.status, 0, replayRun.stderr);
  const parsedReplay = JSON.parse(replayRun.stdout);
  assert.equal(parsedReplay.ok, true);
  assert.equal(parsedReplay.suiteKind, "offline-incident-replay-contract");
});

test("extractStructuredReplayPayload handles snake_case structured_output, stream-json events, and usage", () => {
  const sample = { schemaVersion: 1, verdict: "PASS", findings: [] };
  assert.deepEqual(
    extractStructuredReplayPayload({ structured_output: sample, usage: { input_tokens: 10, total_tokens: 15 } }),
    sample,
  );
  assert.deepEqual(extractStructuredReplayPayload({ structuredOutput: sample }), sample);
  assert.deepEqual(
    extractStructuredReplayPayload({ event: "result", result: { structured_output: JSON.stringify(sample) } }),
    sample,
  );
  assert.deepEqual(extractStructuredReplayPayload({ result: JSON.stringify(sample) }), sample);
  assert.deepEqual(extractStructuredReplayPayload(sample), sample);

  const usage = extractReplayUsage({
    event: "result",
    result: { usage: { input_tokens: 120, output_tokens: 30, thinking_tokens: 45, total_tokens: 195 } },
  });
  assert.deepEqual(usage, { input_tokens: 120, output_tokens: 30, thinking_tokens: 45, total_tokens: 195 });
  assert.equal(extractReplayUsage({}), null);
});
