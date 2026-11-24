import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_RISK_POLICY,
  PIPELINE_STAGES,
  TOOL_MATCHERS,
  classifyCommandCategory,
  computeAssertionDelta,
  computeFreshness,
  deriveRepoId,
  evaluateBoundaryViolation,
  evaluateEvidenceGate,
  evaluatePrIntent,
  evaluateRoundLimit,
  evaluateRoundState,
  evaluateSessionContext,
  evaluateVerifyReminder,
  extractImportSpecifiers,
  formatPipelineRail,
  parseHookPayload,
  parseHookStdin,
  readHeadShaFast,
  readMergedReceipts,
  recordReceipt,
  recordRollbackReceipt,
  recordVerifierReceipt,
  resolveBaseRef,
  resolveGitDirs,
  resolveTrustDir,
  resolveWorkspaceScope,
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
    assert.equal(classifyCommandCategory("node --run test:trust"), "test");
    assert.equal(classifyCommandCategory("node --test scripts/test/risk.test.mjs"), "test");
    assert.equal(
      classifyCommandCategory(
        "node --experimental-strip-types .agents/skills/verify-earned-trust-formal/scripts/verify-trust.ts --json",
      ),
      "verify",
    );
    assert.equal(classifyCommandCategory("node skills/review-pr/scripts/pr-dossier.mjs --json"), "verify");
    assert.equal(classifyCommandCategory("node skills/audit-architecture/scripts/arch-audit.mjs --cwd . --strict"), "lint");
    assert.equal(classifyCommandCategory("agy plugin validate --strict --json ."), "lint");
    assert.equal(classifyCommandCategory("Get-ChildItem .agents/skills/verify-astack/features | Select-Object Name"), "other");
    assert.equal(classifyCommandCategory("Select-String -Path x.log -Pattern validate-astack"), "other");
    assert.equal(classifyCommandCategory("git grep arch-audit"), "other");
    assert.equal(classifyCommandCategory("git show origin/main:REVIEW.md"), "other");
    assert.equal(classifyCommandCategory('echo "node --test"'), "other");
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

    const trustSubDir = path.join(tmp, "sub", "astack-trust");
    fs.mkdirSync(trustSubDir, { recursive: true });
    for (const evilId of ["/../../escaped", "..\\..\\escaped", "../.."]) {
      recordReceipt({ kind: "tool-command", conversationId: evilId, command: "node --test", error: "", workspaceDir: tmp }, { trustDir: trustSubDir, headSha: "b".repeat(40) });
      recordVerifierReceipt({ trustDir: trustSubDir, conversationId: evilId, headSha: "b".repeat(40), verdict: "PASS" });
      recordRollbackReceipt({ trustDir: trustSubDir, conversationId: evilId, headSha: "b".repeat(40), plan: "git revert HEAD" });
    }
    assert.equal(fs.existsSync(path.join(tmp, "escaped.jsonl")), false);
    assert.equal(fs.existsSync(path.join(tmp, "sub", "escaped.jsonl")), false);
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

test("evaluateSessionContext emits once-per-session AStack Timeline pill instruction only inside git repos when enabled in Antigravity App", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-session-pill-"));
  const repo = makeTempGitRepo();
  const cfgPath = path.join(tmp, "config.json");
  const appArtifactDir = path.join(tmp, ".gemini", "antigravity", "brain", "conv-1");
  const cliArtifactDir = path.join(tmp, ".gemini", "antigravity-cli", "brain", "conv-1");
  try {
    assert.deepEqual(
      evaluateSessionContext({ workspaceDir: repo, artifactDir: appArtifactDir }, { configPath: cfgPath }),
      {},
    );

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ sidecars: { "astack/astack_timeline": { enabled: false } } }),
      "utf8",
    );
    assert.deepEqual(
      evaluateSessionContext({ workspaceDir: repo, artifactDir: appArtifactDir }, { configPath: cfgPath }),
      {},
    );

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ sidecars: { "astack/astack_timeline": { resolvedPermissions: null } } }),
      "utf8",
    );
    assert.deepEqual(
      evaluateSessionContext({ workspaceDir: repo, artifactDir: appArtifactDir }, { configPath: cfgPath }),
      {},
    );

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ sidecars: { "astack/astack_timeline": { resolvedPermissions: {} } } }),
      "utf8",
    );
    assert.deepEqual(
      evaluateSessionContext({ workspaceDir: "", artifactDir: appArtifactDir }, { configPath: cfgPath }),
      {},
      "Empty workspace must stay silent even when Timeline is enabled",
    );
    assert.deepEqual(
      evaluateSessionContext({ workspaceDir: tmp, artifactDir: appArtifactDir }, { configPath: cfgPath }),
      {},
      "Non-git workspace must stay silent even when Timeline is enabled",
    );

    const appRes = evaluateSessionContext(
      { workspaceDir: repo, artifactDir: appArtifactDir },
      { configPath: cfgPath },
    );
    assert.ok(Array.isArray(appRes.injectSteps));
    assert.match(
      appRes.injectSteps[0].systemMessage.systemMessage,
      /\[AStack Timeline\]\(sidecar:\/\/astack\/astack_timeline\/\)/,
    );

    assert.deepEqual(
      evaluateSessionContext({ workspaceDir: repo, artifactDir: cliArtifactDir }, { configPath: cfgPath }),
      {},
    );

    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ sidecars: { "astack/astack_timeline": { enabled: true } } }),
      "utf8",
    );
    const enabledRes = evaluateSessionContext(
      { workspaceDir: repo, artifactDir: appArtifactDir },
      { configPath: cfgPath },
    );
    assert.match(
      enabledRes.injectSteps[0].systemMessage.systemMessage,
      /\[AStack Timeline\]\(sidecar:\/\/astack\/astack_timeline\/\)/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("recordReceipt and computeFreshness ignore brain artifact and out-of-workspace writes", () => {
  const repo = makeTempGitRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-brain-"));
  const trustDir = path.join(artifactDir, "astack-trust");
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    assert.equal(
      recordReceipt(
        {
          kind: "tool-write",
          conversationId: "conv-1",
          tool: "write_file",
          filePath: path.join(artifactDir, "walkthrough.md"),
          workspaceDir: repo,
          artifactDir,
        },
        { trustDir, now: "2026-11-20T10:02:00Z" },
      ),
      null,
    );

    assert.equal(
      recordReceipt(
        {
          kind: "tool-write",
          conversationId: "conv-1",
          tool: "write_file",
          filePath: path.join(os.homedir(), ".gemini", "antigravity", "brain", "conv-1", "walkthrough.md"),
          workspaceDir: repo,
        },
        { trustDir, now: "2026-11-20T10:02:01Z" },
      ),
      null,
    );

    const legacyReceipts = [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:00Z",
        conversationId: "conv-1",
        kind: "file_write",
        category: "other",
        headSha: head,
        ok: true,
        summary: "edit_file app.js",
        paths: ["app.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:01:00Z",
        conversationId: "conv-1",
        kind: "command",
        category: "test",
        headSha: head,
        ok: true,
        summary: "node --test",
        paths: [],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:02:00Z",
        conversationId: "conv-1",
        kind: "file_write",
        category: "other",
        headSha: head,
        ok: true,
        summary: "write_file walkthrough.md",
        paths: ["C:/Users/dev/.gemini/antigravity/brain/conv-1/walkthrough.md"],
      },
    ];

    assert.equal(
      recordReceipt(
        {
          kind: "tool-write",
          conversationId: "conv-1",
          tool: "write_file",
          filePath: "../outside.js",
          workspaceDir: repo,
        },
        { trustDir, now: "2026-11-20T10:02:02Z" },
      ),
      null,
    );

    assert.equal(computeFreshness({ receipts: legacyReceipts, headSha: head }), "fresh");

    const pushEv = parseHookPayload({
      toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/demo" } },
      workspaceDir: repo,
    });
    const legacyReceiptsFile = path.join(trustDir, "receipts.conv-1.jsonl");
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(legacyReceiptsFile, `${legacyReceipts.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    writeEvidenceSnapshotAtomic(trustDir, {
      schemaVersion: 1,
      generatedAt: "2026-11-20T10:01:30Z",
      headSha: head,
      freshness: "fresh",
      roundState: "open",
      reviewRound: 0,
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });
    assert.equal(
      evaluateEvidenceGate(pushEv, { trustDir, headSha: head, headless: true }).decision,
      "allow",
    );

    const worktreeRoot = path.join(artifactDir, ".gemini", "antigravity", "worktrees", "conv-1", "subagent-ws");
    fs.mkdirSync(path.join(worktreeRoot, "src"), { recursive: true });
    const worktreeReceipt = recordReceipt(
      {
        kind: "tool-write",
        conversationId: "conv-wt",
        tool: "edit_file",
        filePath: path.join(worktreeRoot, "src", "app.js"),
        workspaceDir: worktreeRoot,
      },
      { trustDir, headSha: head, now: "2026-11-20T10:02:03Z" },
    );
    assert.ok(worktreeReceipt, "Legitimate writes inside ~/.gemini/antigravity/worktrees/... must still record receipts");
    assert.deepEqual(worktreeReceipt.paths, ["src/app.js"]);

    const linkedWtDir = path.join(artifactDir, "linked-wt");
    const wtGitMeta = path.join(repo, ".git", "worktrees", "linked-wt");
    fs.mkdirSync(wtGitMeta, { recursive: true });
    fs.writeFileSync(path.join(wtGitMeta, "HEAD"), `${head}\n`, "utf8");
    fs.writeFileSync(path.join(wtGitMeta, "commondir"), "../..\n", "utf8");
    fs.mkdirSync(path.join(linkedWtDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(linkedWtDir, ".git"), `gitdir: ${wtGitMeta}\n`, "utf8");
    const linkedWtReceipt = recordReceipt(
      {
        kind: "tool-write",
        conversationId: "conv-linked-wt",
        tool: "edit_file",
        filePath: path.join(linkedWtDir, "src", "fix.js"),
        workspaceDir: repo,
      },
      { trustDir, headSha: head, now: "2026-11-20T10:02:04Z" },
    );
    assert.ok(linkedWtReceipt, "Writes inside a linked git worktree sharing commonDir with workspaceDir must record receipts");

    assert.equal(
      recordReceipt(
        {
          kind: "tool-write",
          conversationId: "conv-1",
          tool: "write_file",
          filePath: path.join(os.homedir(), ".gemini", "jetski", "brain", "conv-1", "walkthrough.md"),
          workspaceDir: repo,
        },
        { trustDir, now: "2026-11-20T10:02:05Z" },
      ),
      null,
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("resolveWorkspaceScope isolates non-git workspaces, derives worktree-stable repoIds, and requires base-branch enrollment", () => {
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "astack-non-git-"));
  const repoA = makeTempGitRepo();
  const repoB = makeTempGitRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-scope-art-"));
  try {
    const t0 = performance.now();
    const nonGitScope = resolveWorkspaceScope(nonGit);
    const elapsedMs = performance.now() - t0;
    assert.equal(nonGitScope.kind, "non_repo");
    assert.equal(nonGitScope.repoRoot, null);
    assert.equal(nonGitScope.repoId, null);
    assert.ok(elapsedMs < 25, `Expected fast non_repo check, got ${elapsedMs}ms`);

    assert.equal(resolveWorkspaceScope("").kind, "non_repo");
    assert.equal(resolveTrustDir({ workspaceDir: nonGit }), null);
    assert.equal(
      resolveTrustDir({ workspaceDir: nonGit, artifactDir }),
      path.join(path.resolve(artifactDir), "astack-trust"),
    );

    assert.equal(
      recordReceipt({
        kind: "tool-command",
        conversationId: "non-git-conv",
        command: "node --test",
        error: "",
        workspaceDir: nonGit,
        artifactDir,
      }),
      null,
    );
    assert.equal(fs.existsSync(path.join(nonGit, ".tmp", "astack-trust")), false);
    assert.equal(fs.existsSync(path.join(artifactDir, "astack-trust")), false);

    execFileSync("git", ["remote", "add", "origin", "git@github.com:Acme/Demo-Repo.git"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "https://user@GITHUB.COM/acme/demo-repo/"], { cwd: repoB, stdio: "ignore" });
    const idA = deriveRepoId(resolveGitDirs(repoA).commonDir);
    const idB = deriveRepoId(resolveGitDirs(repoB).commonDir);
    assert.equal(idA, idB, "SSH and HTTPS origin URLs must normalize to identical repoId");

    const wtDir = path.join(artifactDir, "wt-a");
    execFileSync("git", ["worktree", "add", "-b", "feat/wt-scope", wtDir], { cwd: repoA, stdio: "ignore" });
    const mainScope = resolveWorkspaceScope(repoA);
    const wtScope = resolveWorkspaceScope(wtDir);
    assert.equal(mainScope.kind, "git_unregistered");
    assert.equal(wtScope.kind, "git_unregistered");
    assert.equal(wtScope.repoId, mainScope.repoId, "Worktree must share repoId with main checkout");

    fs.mkdirSync(path.join(wtDir, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(wtDir, ".agents", "risk-policy.json"), '{"schemaVersion":1}\n', "utf8");
    execFileSync("git", ["add", ".agents/risk-policy.json"], { cwd: wtDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "branch-only self enroll attempt"], { cwd: wtDir, stdio: "ignore" });
    const baseBranchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoA, encoding: "utf8" }).trim();
    assert.equal(
      resolveWorkspaceScope(wtDir, { baseRef: baseBranchName }).kind,
      "git_unregistered",
      "Feature-branch-only .agents/risk-policy.json must not enroll the repository",
    );

    fs.mkdirSync(path.join(repoA, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repoA, ".agents", "risk-policy.json"), '{"schemaVersion":1}\n', "utf8");
    execFileSync("git", ["add", ".agents/risk-policy.json"], { cwd: repoA, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "enroll base"], { cwd: repoA, stdio: "ignore" });
    const enrolled = resolveWorkspaceScope(repoA, { baseRef: baseBranchName });
    assert.equal(enrolled.kind, "enrolled_repo");
    assert.equal(enrolled.baseRef, baseBranchName);

    const tellaRec = recordReceipt({
      kind: "tool-mcp",
      conversationId: "mcp-filter",
      serverName: "tella",
      toolName: "export_video",
      workspaceDir: repoA,
      artifactDir,
    });
    assert.equal(tellaRec, null, "Non-SWE MCP servers inside a git repo must write zero receipts");

    const ghRec = recordReceipt({
      kind: "tool-mcp",
      conversationId: "mcp-filter",
      serverName: "github-mcp-server",
      toolName: "get_pull_request",
      workspaceDir: repoA,
      artifactDir,
    });
    assert.ok(ghRec, "Allowlisted engineering MCP server must record receipts");
    assert.equal(ghRec.kind, "mcp");

    assert.equal(resolveBaseRef(repoA, "nonexistent-ref"), null);
    const branchOnly = fs.mkdtempSync(path.join(os.tmpdir(), "astack-branch-only-"));
    try {
      execFileSync("git", ["init", "-b", "feat/only"], { cwd: branchOnly, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: branchOnly, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "t"], { cwd: branchOnly, stdio: "ignore" });
      fs.mkdirSync(path.join(branchOnly, ".agents"), { recursive: true });
      fs.writeFileSync(path.join(branchOnly, ".agents", "risk-policy.json"), '{"schemaVersion":1}\n', "utf8");
      execFileSync("git", ["add", ".agents/risk-policy.json"], { cwd: branchOnly, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "feat only"], { cwd: branchOnly, stdio: "ignore" });
      assert.equal(resolveBaseRef(branchOnly), null);
      assert.equal(resolveWorkspaceScope(branchOnly).kind, "git_unregistered");
    } finally {
      fs.rmSync(branchOnly, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("evaluatePrIntent sanitizes conversationId and confines pr-intent state files to trustDir", () => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-pr-intent-"));
  const trustDir = path.join(parentDir, "nested", "astack-trust");
  fs.mkdirSync(trustDir, { recursive: true });
  try {
    const res = evaluatePrIntent(
      {
        kind: "pre-invocation",
        conversationId: "../../escape",
        lastUserInput: "Please open a PR for this branch.",
        workspaceDir: parentDir,
      },
      { trustDir, headSha: "d".repeat(40) },
    );
    assert.ok(Array.isArray(res.injectSteps) && res.injectSteps.length === 1);
    assert.match(res.injectSteps[0].ephemeralMessage, /AStack PR proof workflow triggered/);
    assert.equal(fs.existsSync(path.join(parentDir, "escape.json")), false);
    assert.equal(fs.existsSync(path.join(parentDir, "pr-intent...json")), false);
    assert.equal(fs.existsSync(path.join(parentDir, "nested", "escape.json")), false);
    const written = fs.readdirSync(trustDir).filter((name) => name.startsWith("pr-intent."));
    assert.equal(written.length, 1);
    assert.equal(written[0], "pr-intent.escape.json");
    assert.equal(DEFAULT_RISK_POLICY.tiers["1"].globs.includes("sidecars/**"), true);
    assert.equal(DEFAULT_RISK_POLICY.tiers["2"].globs.includes("mcp_config.json"), true);
    assert.equal(DEFAULT_RISK_POLICY.tiers["3"].globs.includes("sidecars/*/sidecar.json"), true);
    assert.equal(classifyCommandCategory('echo "\u201c; node --test ; \u201d"'), "other");
  } finally {
    fs.rmSync(parentDir, { recursive: true, force: true });
  }
});
