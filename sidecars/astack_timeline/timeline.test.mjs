import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { COMMAND_DOCS, evaluateTimelineSnapshot, resolveSafeArtifactUri, TIMELINE_STEPS } from "./timeline-engine.mjs";

function makeFixture(prefix = "astack-tl-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const brainDir = path.join(root, "brain");
  const workspaceDir = path.join(root, "repo");
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  return { root, brainDir, workspaceDir };
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeTranscript(brainDir, convId, steps) {
  const filePath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
  writeText(filePath, `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`);
}

function writeReceipt(brainDir, convId, receipts) {
  const filePath = path.join(brainDir, convId, "astack-trust", `receipts.${convId}.jsonl`);
  writeText(filePath, `${receipts.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

test("TIMELINE_STEPS defines 5 concise developer stages without internal tool clutter", () => {
  assert.equal(TIMELINE_STEPS.length, 5);
  assert.deepEqual(
    TIMELINE_STEPS.map((s) => s.primaryCommand),
    ["/setup-astack", "/plan", "/astack-mode", "/review-pr", "/astack-mode open the pr"],
  );
  for (const step of TIMELINE_STEPS) {
    assert.ok(typeof step.summary === "string" && step.summary.trim().length > 0, `Missing summary for ${step.id}`);
  }
});

test("every stage command exposes description and GitHub docsUrl across snapshots", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  try {
    const snap = evaluateTimelineSnapshot({ conversationId: "conv-docs", brainDir, workspaceDir });
    assert.equal(snap.stages.length, 5);
    for (const stage of snap.stages) {
      assert.ok(typeof stage.summary === "string" && stage.summary.trim().length > 0);
      for (const cmd of stage.commands) {
        assert.ok(COMMAND_DOCS[cmd.command], `Missing COMMAND_DOCS entry for ${cmd.command}`);
        assert.ok(typeof cmd.description === "string" && cmd.description.trim().length > 0);
        assert.match(cmd.docsUrl ?? "", /^https:\/\/github\.com\/jmxt3\/astack\/blob\/main\//);
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh unconfigured repo highlights Setup as next step", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  try {
    const snap = evaluateTimelineSnapshot({ conversationId: "conv-fresh", brainDir, workspaceDir });
    assert.equal(snap.stages[0].status, "next");
    assert.equal(snap.stages[1].status, "pending");
    assert.equal(snap.nextAction.command, "/setup-astack");
    assert.equal(snap.doneCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configured repo marks Setup done and Plan next", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    const snap = evaluateTimelineSnapshot({ conversationId: "conv-ready", brainDir, workspaceDir });
    assert.equal(snap.stages[0].status, "done");
    assert.equal(snap.stages[1].status, "next");
    assert.equal(snap.nextAction.command, "/plan");
    assert.equal(snap.doneCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tracks /plan + /grill-me waiting gate and exposes safe implementation_plan.md URI", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-plan-gate";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/plan /grill-me add login rate limiting</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:05Z",
        tool_calls: [{ name: "ask_question", args: { questions: [] } }],
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:01:00Z",
        tool_calls: [
          {
            name: "write_file",
            args: { Path: path.join(brainDir, convId, "implementation_plan.md") },
          },
        ],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.stages[0].status, "done");
    assert.equal(snap.stages[1].status, "waiting_gate");
    assert.equal(snap.stages[1].commands[0].state, "done");
    assert.equal(snap.stages[1].commands[1].command, "/grill-me");
    assert.equal(snap.stages[1].commands[1].state, "done");
    assert.equal(snap.stages[1].artifact?.name, "implementation_plan.md");
    assert.match(snap.stages[1].artifact?.uri ?? "", /^file:\/\//);
    assert.equal(snap.nextAction.command, "Proceed");
    assert.equal(snap.liveState, "warn");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores casual prose mentions of slash commands inside user questions", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-prose";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>Should we run /review-pr or /interrogate before /deslop?</USER_REQUEST>",
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.stages[1].status, "next");
    assert.equal(snap.stages[2].status, "pending");
    assert.equal(snap.stages[2].commands[1].state, "pending");
    assert.equal(snap.stages[3].status, "pending");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tracks /interrogate, marks Build & Prove done on fresh verify, and flips stale after newer edits", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-build-stale";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
    const headSha = "0123456789abcdef0123456789abcdef01234567";

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/astack-mode add feature flag</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:01:00Z",
        tool_calls: [
          { name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } },
          { name: "read_file", args: { Path: "/plugin/skills/interrogate/SKILL.md" } },
        ],
      },
    ]);

    const baseReceipts = [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:30Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/app.js",
        paths: ["src/app.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:01:30Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ];
    writeReceipt(brainDir, convId, baseReceipts);

    const cleanSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(cleanSnap.stages[1].status, "skipped");
    assert.equal(cleanSnap.stages[2].status, "done");
    assert.equal(cleanSnap.stages[2].commands[1].command, "/interrogate");
    assert.equal(cleanSnap.stages[2].commands[1].state, "done");
    assert.equal(cleanSnap.stages[3].status, "next");
    assert.equal(cleanSnap.nextAction.command, "/review-pr");

    writeReceipt(brainDir, convId, [
      ...baseReceipts,
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:02:30Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/app.js",
        paths: ["src/app.js"],
      },
    ]);

    const staleSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(staleSnap.stages[2].status, "stale");
    assert.equal(staleSnap.freshness, "dirty_after_verify");
    assert.equal(staleSnap.liveState, "warn");
    assert.equal(staleSnap.nextAction.command, "/astack-mode");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("surfaces PR Review waiting gate, Risk Tier, and escalated error state from evidence.json", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-review";
  try {
    const headSha = "abcdef0123456789abcdef0123456789abcdef01";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);
    writeText(path.join(brainDir, convId, "pr-review.md"), "# PR Review\n");
    writeText(
      path.join(brainDir, convId, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        freshness: "fresh",
        riskTier: 2,
        riskLabel: "high",
        reviewRound: 1,
        maxReviewRounds: 3,
        roundState: "verified",
        autoMergeEligible: false,
        verifier: { verdict: "PASS" },
      }),
    );

    const passSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(passSnap.riskTier, 2);
    assert.equal(passSnap.riskLabel, "high");
    assert.equal(passSnap.stages[3].status, "waiting_gate");
    assert.equal(passSnap.stages[3].artifact?.name, "pr-review.md");
    assert.equal(passSnap.stages[4].status, "next");
    assert.equal(passSnap.nextAction.command, "/astack-mode open the pr");

    writeText(
      path.join(brainDir, convId, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        freshness: "fresh",
        riskTier: 2,
        riskLabel: "high",
        reviewRound: 3,
        maxReviewRounds: 3,
        roundState: "escalated",
        verifier: { verdict: "FAIL" },
      }),
    );

    const escSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(escSnap.stages[3].status, "error");
    assert.equal(escSnap.liveState, "error");
    assert.equal(escSnap.liveLabel, "Escalated");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveSafeArtifactUri blocks traversal and paths outside brainConvDir", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-safe";
  try {
    const convDir = path.join(brainDir, convId);
    fs.mkdirSync(convDir, { recursive: true });
    writeText(path.join(workspaceDir, "secret.txt"), "nope");
    writeText(path.join(convDir, "implementation_plan.md"), "# Ok\n");

    assert.equal(resolveSafeArtifactUri(convDir, "../repo/secret.txt"), null);
    assert.equal(resolveSafeArtifactUri(convDir, "sub/file.md"), null);
    assert.equal(resolveSafeArtifactUri(convDir, "missing.md"), null);
    assert.match(resolveSafeArtifactUri(convDir, "implementation_plan.md") ?? "", /^file:\/\//);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
