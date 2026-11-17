import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
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

test("run-eval CLI supports --help, -h, and --json", () => {
  for (const flag of ["--help", "-h"]) {
    const res = spawnSync(process.execPath, [evalCli, flag], { encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /Usage: node scripts\/eval\/run-eval\.mjs/);
  }
  const jsonRun = spawnSync(process.execPath, [evalCli, "--json"], { encoding: "utf8" });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.ok, true);
});
