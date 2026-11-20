import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  PIPELINE_STAGES,
  TOOL_MATCHERS,
  classifyCommandCategory,
  computeAssertionDelta,
  computeFreshness,
  evaluateBoundaryViolation,
  evaluateEvidenceGate,
  evaluateRoundLimit,
  evaluateRoundState,
  evaluateVerifyReminder,
  extractImportSpecifiers,
  formatPipelineRail,
  parseHookPayload,
  parseHookStdin,
  readHeadShaFast,
  readMergedReceipts,
  recordReceipt,
  recordVerifierReceipt,
  runArchitectureAudit,
  writeEvidenceSnapshotAtomic,
} from "../trust/index.mjs";

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-trust-core-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.js"), "export const v = 1;\n", "utf8");
  execFileSync("git", ["add", "app.js"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("parseHookPayload normalizes App/IDE write tools and Antigravity Stop payloads", () => {
  const writeTo = parseHookPayload({
    conversationId: "conv/1",
    workspacePaths: ["/repo/app"],
    artifactDirectoryPath: "/artifacts/1",
    toolCall: {
      name: "write_to_file",
      args: { TargetFile: ".env", CodeContent: "SECRET=1\n" },
    },
  });
  assert.equal(writeTo.kind, "tool-write");
  assert.equal(writeTo.filePath, ".env");
  assert.deepEqual(writeTo.chunks, ["SECRET=1\n"]);
  assert.equal(writeTo.workspaceDir, "/repo/app");
  assert.equal(writeTo.artifactDir, "/artifacts/1");
  assert.equal(writeTo.conversationId, "conv_1");

  const multiReplace = parseHookPayload({
    toolCall: {
      name: "multi_replace_file_content",
      args: {
        TargetFile: "src/a.js",
        ReplacementChunks: [
          { ReplacementContent: "const a = 1;" },
          { ReplacementContent: "const b = 'ghp_" + "A".repeat(30) + "';" },
        ],
      },
    },
  });
  assert.equal(multiReplace.kind, "tool-write");
  assert.equal(multiReplace.chunks.length, 2);

  const stopEv = parseHookPayload({
    terminationReason: "model_stop",
    fullyIdle: true,
    continuationActive: false,
    workspacePaths: ["/repo/app"],
  });
  assert.equal(stopEv.kind, "stop");
  assert.equal(stopEv.terminationReason, "model_stop");
  assert.equal(stopEv.fullyIdle, true);
  assert.equal(stopEv.workspaceDir, "/repo/app");

  const { event: badEvent } = parseHookStdin("{broken-json");
  assert.equal(badEvent, null);
  assert.match(TOOL_MATCHERS.fileWrite, /multi_replace_file_content/);
});

test("readHeadShaFast, recordReceipt, and readMergedReceipts operate across concurrent actors", () => {
  const repo = makeTempGitRepo();
  const trustDir = path.join(repo, ".tmp", "trust");
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(readHeadShaFast(repo), head);

    const start = performance.now();
    const r1 = recordReceipt(
      {
        kind: "tool-write",
        conversationId: "actor-a",
        tool: "replace_file_content",
        filePath: path.join(repo, "app.js"),
        workspaceDir: repo,
      },
      { trustDir, now: "2026-11-20T10:00:00Z" },
    );
    const elapsedMs = performance.now() - start;
    assert.ok(elapsedMs < 50, `Expected <50ms in-process receipt append, got ${elapsedMs}ms`);
    assert.equal(r1.headSha, head);

    recordReceipt(
      {
        kind: "tool-command",
        conversationId: "actor-b",
        command: "node --test scripts/test/trust-core.test.mjs",
        error: "",
        workspaceDir: repo,
      },
      { trustDir, now: "2026-11-20T10:01:00Z" },
    );
    recordVerifierReceipt({
      trustDir,
      conversationId: "pr-verifier",
      headSha: head,
      verdict: "PASS",
      now: "2026-11-20T10:02:00Z",
    });

    const merged = readMergedReceipts(trustDir);
    assert.equal(merged.length, 3);
    assert.equal(merged[0].conversationId, "actor-a");
    assert.equal(merged[1].category, "test");
    assert.equal(merged[2].kind, "verifier");

    assert.equal(computeFreshness({ receipts: merged, headSha: head }), "fresh");
    assert.equal(computeFreshness({ receipts: merged, headSha: "0".repeat(40) }), "stale_sha");
    assert.equal(computeFreshness({ receipts: merged, headSha: head, treeDirty: true }), "dirty_after_verify");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("evaluateRoundState, evaluateEvidenceGate, evaluateRoundLimit, and formatPipelineRail enforce contracts", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-gate-test-"));
  try {
    assert.equal(evaluateRoundState({ reviewRound: 1, verdict: "FAIL", fresh: false }), "fixing");
    assert.equal(evaluateRoundState({ reviewRound: 3, verdict: "FAIL", fresh: false }), "escalated");
    assert.equal(evaluateRoundState({ reviewRound: 2, verdict: "PASS", fresh: true }), "verified");

    const pushEv = parseHookPayload({
      toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/x" } },
      workspacePaths: [tmp],
    });
    const blockedMissing = evaluateEvidenceGate(pushEv, { trustDir: tmp, headSha: "a".repeat(40), headless: true });
    assert.equal(blockedMissing.decision, "deny");

    writeEvidenceSnapshotAtomic(tmp, {
      schemaVersion: 1,
      headSha: "a".repeat(40),
      freshness: "fresh",
      roundState: "verified",
      reviewRound: 1,
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });
    const allowedPush = evaluateEvidenceGate(pushEv, { trustDir: tmp, headSha: "a".repeat(40), headless: true });
    assert.equal(allowedPush.decision, "allow");

    writeEvidenceSnapshotAtomic(tmp, {
      schemaVersion: 1,
      headSha: "a".repeat(40),
      freshness: "fresh",
      roundState: "escalated",
      reviewRound: 3,
      verifier: { verdict: "FAIL" },
    });
    const editEv = parseHookPayload({
      toolCall: { name: "replace_file_content", args: { TargetFile: "app.js", ReplacementContent: "x" } },
    });
    const roundBlocked = evaluateRoundLimit(editEv, { trustDir: tmp, headless: false });
    assert.equal(roundBlocked.decision, "force_ask");

    const stopEv = parseHookPayload({
      terminationReason: "model_stop",
      fullyIdle: true,
      workspacePaths: [tmp],
    });
    const remind = evaluateVerifyReminder(stopEv, { requireVerify: true, gitStatus: " M src/app.js\n" });
    assert.equal(remind.decision, "continue");

    const rail = formatPipelineRail({ playbook: "feature" });
    assert.equal(PIPELINE_STAGES.length, 6);
    assert.match(rail, /2\. \[HUMAN GATE\] Implementation Plan/);
    assert.match(rail, /6\. \[HUMAN GATE\] Visual PR Review & Merge/);
    assert.equal(classifyCommandCategory("npm run test:trust"), "test");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseHookPayload classifies read_file as tool-other and readMergedReceipts includes dotted conversationIds", () => {
  const readEv = parseHookPayload({
    toolCall: { name: "read_file", args: { Path: "README.md" } },
  });
  assert.equal(readEv.kind, "tool-other");
  assert.equal(readEv.tool, "read_file");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dotted-id-"));
  try {
    const rec = recordReceipt(
      {
        kind: "tool-command",
        conversationId: "worker.1",
        command: "node --test",
        error: "",
        workspaceDir: tmp,
      },
      { trustDir: tmp, headSha: "b".repeat(40), now: "2026-11-20T12:00:00Z" },
    );
    assert.equal(rec.conversationId, "worker.1");
    const merged = readMergedReceipts(tmp);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].conversationId, "worker.1");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("evaluateEvidenceGate reacts to newer writes and passing test receipts on the same HEAD", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-gate-live-"));
  const head = "c".repeat(40);
  try {
    const pushEv = parseHookPayload({
      toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/y" } },
      workspacePaths: [tmp],
    });

    writeEvidenceSnapshotAtomic(tmp, {
      schemaVersion: 1,
      generatedAt: "2026-11-20T10:00:00.000Z",
      headSha: head,
      freshness: "fresh",
      roundState: "verified",
      reviewRound: 1,
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });
    recordReceipt(
      {
        kind: "tool-write",
        conversationId: "worker-1",
        tool: "edit_file",
        filePath: "src/app.js",
        workspaceDir: tmp,
      },
      { trustDir: tmp, headSha: head, now: "2026-11-20T10:05:00.000Z" },
    );
    const dirtyPush = evaluateEvidenceGate(pushEv, { trustDir: tmp, headSha: head, headless: true });
    assert.equal(dirtyPush.decision, "deny");
    assert.match(dirtyPush.reason, /dirty_after_verify/);

    writeEvidenceSnapshotAtomic(tmp, {
      schemaVersion: 1,
      generatedAt: "2026-11-20T10:06:00.000Z",
      headSha: head,
      freshness: "missing_receipts",
      roundState: "open",
      reviewRound: 0,
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });
    recordReceipt(
      {
        kind: "tool-command",
        conversationId: "worker-1",
        command: "node --test",
        error: "",
        workspaceDir: tmp,
      },
      { trustDir: tmp, headSha: head, now: "2026-11-20T10:07:00.000Z" },
    );
    const refreshedPush = evaluateEvidenceGate(pushEv, { trustDir: tmp, headSha: head, headless: true });
    assert.equal(refreshedPush.decision, "allow");

    writeEvidenceSnapshotAtomic(tmp, {
      schemaVersion: 1,
      generatedAt: "2026-11-20T10:08:00.000Z",
      headSha: head,
      freshness: "fresh",
      roundState: "open",
      reviewRound: 3,
      maxReviewRounds: 3,
      verifier: { verdict: "FAIL", headSha: "d".repeat(40), stale: true },
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });
    const escalatedPush = evaluateEvidenceGate(pushEv, { trustDir: tmp, headSha: head, headless: true });
    assert.equal(escalatedPush.decision, "deny");
    assert.match(escalatedPush.reason, /escalation cap/);

    assert.equal(evaluateRoundState({ reviewRound: 1, verdict: "ESCALATE_HUMAN", fresh: false }), "escalated");
    writeEvidenceSnapshotAtomic(tmp, {
      schemaVersion: 1,
      generatedAt: "2026-11-20T10:09:00.000Z",
      headSha: head,
      freshness: "fresh",
      roundState: "open",
      reviewRound: 1,
      maxReviewRounds: 3,
      verifier: { verdict: "ESCALATE_HUMAN", headSha: head, stale: false },
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });
    const earlyEscalatePush = evaluateEvidenceGate(pushEv, { trustDir: tmp, headSha: head, headless: true });
    assert.equal(earlyEscalatePush.decision, "deny");
    const earlyEscalateEdit = evaluateRoundLimit(
      parseHookPayload({ toolCall: { name: "edit_file", args: { Path: "app.js", Replacement: "y" } } }),
      { trustDir: tmp, headless: true },
    );
    assert.equal(earlyEscalateEdit.decision, "deny");

    writeEvidenceSnapshotAtomic(tmp, {
      schemaVersion: 1,
      generatedAt: "2026-11-20T10:10:00.000Z",
      headSha: head,
      freshness: "fresh",
      roundState: "open",
      reviewRound: 5,
      maxReviewRounds: 5,
      verifier: { verdict: "FAIL", headSha: head, stale: false },
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });
    const customCapPush = evaluateEvidenceGate(pushEv, { trustDir: tmp, headSha: head, headless: true });
    assert.equal(customCapPush.decision, "deny");
    assert.match(customCapPush.reason, /5-round escalation cap/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("boundary parser handles multiline imports, extensionless publicEntry, gi banned flags, and per-file assertion weakening", () => {
  const source = [
    "// import { nope } from '../core/internal/commented.js';",
    "/* import { block } from '../core/internal/block.js'; */",
    "const s = '// not a comment';",
    "import {",
    "  secret,",
    "} from '../core/internal/secret.js';",
  ].join("\n");
  const specs = extractImportSpecifiers(source);
  assert.deepEqual(specs, [{ specifier: "../core/internal/secret.js", line: 4 }]);

  const boundaries = {
    schemaVersion: 1,
    zones: {
      core: { include: ["src/core/**"], publicEntry: ["src/core/index.ts"] },
      app: { include: ["src/app/**"] },
    },
    importRules: [{ id: "no-core-internal", from: "app", forbidImportFrom: ["core"] }],
    bannedPatterns: [{ id: "no-timer", regex: "setTimeout\\(", flags: "gi", fileGlobs: ["src/app/**"] }],
  };

  assert.equal(
    evaluateBoundaryViolation({
      relPath: "src/app/main.ts",
      content: 'import { api } from "../core/index";\nimport { root } from "../core";\n',
      boundaries,
    }),
    null,
  );
  assert.match(
    evaluateBoundaryViolation({
      relPath: "src/app/main.ts",
      content: source,
      boundaries,
    }) ?? "",
    /no-core-internal/,
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-gi-flag-"));
  try {
    fs.mkdirSync(path.join(tmp, ".agents"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "src", "app"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".agents", "boundaries.json"), JSON.stringify(boundaries), "utf8");
    fs.writeFileSync(
      path.join(tmp, "src", "app", "timers.ts"),
      "setTimeout(() => 1, 10);\nsetTimeout(() => 2, 10);\n",
      "utf8",
    );
    const audit = runArchitectureAudit({ cwd: tmp });
    assert.equal(audit.bannedHits.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const perFileDiff = [
    "diff --git a/tests/a.test.js b/tests/a.test.js",
    "--- a/tests/a.test.js",
    "+++ b/tests/a.test.js",
    "@@ -1,3 +1,1 @@",
    "-assert.equal(1, 1);",
    "-assert.equal(2, 2);",
    "-assert.equal(3, 3);",
    "diff --git a/tests/b.test.js b/tests/b.test.js",
    "--- a/tests/b.test.js",
    "+++ b/tests/b.test.js",
    "@@ -1,1 +1,6 @@",
    "+assert.ok(true);",
    "+assert.ok(true);",
    "+assert.ok(true);",
    "+assert.ok(true);",
    "+assert.ok(true);",
  ].join("\n");
  const delta = computeAssertionDelta(perFileDiff, 0.25);
  assert.deepEqual(delta.flaggedFiles, ["tests/a.test.js"]);
  assert.equal(delta.flagged, true);
});
