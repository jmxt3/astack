import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendLogRow, cleanCell } from "./log.mjs";

test("cleanCell flattens control whitespace and neutralizes formula injection", () => {
  assert.equal(cleanCell("hello\tworld\r\nok"), "hello world  ok");
  assert.equal(cleanCell("=cmd|'/C calc'!A0"), "'=cmd|'/C calc'!A0");
  assert.equal(cleanCell("+1+1"), "'+1+1");
  assert.equal(cleanCell("-danger"), "'-danger");
  assert.equal(cleanCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(cleanCell("safe cell"), "safe cell");
});

test("appendLogRow writes TSV header once and appends timestamped sanitized rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-log-test-"));
  try {
    const logfile = path.join(dir, "nested", "decision.tsv");
    const ts1 = new Date("2026-11-14T00:00:00.000Z");
    const ts2 = new Date("2026-11-14T00:05:00.000Z");

    appendLogRow({
      logfile,
      phase: "build",
      decision: "keep\tsimple",
      why: "laziness-protocol",
      evidence: "=HYPERLINK()",
      result: "pass",
      now: ts1,
    });
    appendLogRow({
      logfile,
      phase: "verify",
      decision: "ship",
      why: "tests green",
      evidence: "4/4 pass",
      result: "ok",
      now: ts2,
    });

    const lines = fs.readFileSync(logfile, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(lines[0], "ts\tphase\tdecision\twhy\tevidence\tresult");
    assert.equal(lines[1], "2026-11-14T00:00:00Z\tbuild\tkeep simple\tlaziness-protocol\t'=HYPERLINK()\tpass");
    assert.equal(lines[2], "2026-11-14T00:05:00Z\tverify\tship\ttests green\t4/4 pass\tok");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
