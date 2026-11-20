import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COMMAND_DOCS, evaluateTimelineSnapshot, resolveSafeArtifactUri, TIMELINE_STEPS } from "./timeline-engine.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

test("TIMELINE_STEPS defines 4 concise per-conversation stages without internal tool clutter", () => {
  assert.equal(TIMELINE_STEPS.length, 4);
  assert.deepEqual(
    TIMELINE_STEPS.map((s) => s.primaryCommand),
    ["/plan", "/astack-mode", "/review-pr", "/astack-mode open the pr"],
  );
  for (const step of TIMELINE_STEPS) {
    assert.ok(typeof step.summary === "string" && step.summary.trim().length > 0, `Missing summary for ${step.id}`);
  }
});

test("every stage and setup command exposes description, trimmed copyText, and existing repo docsUrl", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    const snap = evaluateTimelineSnapshot({ conversationId: "conv-docs", brainDir, workspaceDir });
    assert.equal(snap.stages.length, 4);
    const containers = [snap.setup, ...snap.stages];
    const allCommands = containers.flatMap((c) => [
      ...(c?.commands ?? []),
      ...(c?.autoSubCommands ?? []),
      ...(c?.moreCommands ?? []),
    ]);
    for (const stage of snap.stages) {
      assert.ok(typeof stage.summary === "string" && stage.summary.trim().length > 0);
      assert.ok(Array.isArray(stage.autoSubCommands) && stage.autoSubCommands.length > 0);
      assert.ok(Array.isArray(stage.moreCommands) && stage.moreCommands.length > 0);
    }
    for (const cmd of allCommands) {
      assert.ok(COMMAND_DOCS[cmd.command], `Missing COMMAND_DOCS entry for ${cmd.command}`);
      assert.ok(typeof cmd.description === "string" && cmd.description.trim().length > 0);
      assert.equal(cmd.copyText, cmd.command.trim(), `copyText must not add trailing space for ${cmd.command}`);
      assert.equal(cmd.copyText.endsWith(" "), false);
      assert.match(cmd.docsUrl ?? "", /^https:\/\/github\.com\/jmxt3\/astack\/blob\/main\//);
      const rel = cmd.docsUrl.replace("https://github.com/jmxt3/astack/blob/main/", "").split("#")[0];
      assert.equal(fs.existsSync(path.join(REPO_ROOT, ...rel.split("/"))), true, `Missing docs target: ${rel}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("blank idle state recommends /plan instead of falling through to Ship", () => {
  const snap = evaluateTimelineSnapshot({ conversationId: "", brainDir: "", workspaceDir: "" });
  assert.equal(snap.hasConversation, false);
  assert.equal(snap.setup.status, "unknown");
  assert.equal(snap.doneCount, 0);
  assert.equal(snap.totalCount, 4);
  assert.equal(snap.stages.every((s) => s.status === "pending"), true);
  assert.equal(snap.nextAction.stageId, "plan");
  assert.equal(snap.nextAction.command, "/plan");
});

test("idle state with configured workspace highlights Plan as next and marks setup ready", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    const snap = evaluateTimelineSnapshot({ conversationId: "", brainDir, workspaceDir });
    assert.equal(snap.hasConversation, false);
    assert.equal(snap.setup.status, "ready");
    assert.equal(snap.stages[0].status, "next");
    assert.equal(snap.doneCount, 0);
    assert.equal(snap.totalCount, 4);
    assert.equal(snap.nextAction.stageId, "plan");
    assert.equal(snap.nextAction.command, "/plan");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh unconfigured repo flags setup readiness and keeps 4-stage count at 0 / 4", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  try {
    const snap = evaluateTimelineSnapshot({ conversationId: "conv-fresh", brainDir, workspaceDir });
    assert.equal(snap.setup.status, "needs_setup");
    assert.equal(snap.stages[0].status, "pending");
    assert.equal(snap.nextAction.stageId, "setup");
    assert.equal(snap.nextAction.command, "/setup-astack");
    assert.equal(snap.doneCount, 0);
    assert.equal(snap.totalCount, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("configured repo marks setup ready and Plan next with 0 / 4 conversation progress", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    const snap = evaluateTimelineSnapshot({ conversationId: "conv-ready", brainDir, workspaceDir });
    assert.equal(snap.setup.status, "ready");
    assert.equal(snap.stages[0].status, "next");
    assert.equal(snap.nextAction.command, "/plan");
    assert.equal(snap.doneCount, 0);
    assert.equal(snap.totalCount, 4);
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
    assert.equal(snap.setup.status, "ready");
    assert.equal(snap.stages[0].status, "waiting_gate");
    assert.equal(snap.stages[0].commands[0].state, "done");
    assert.equal(snap.stages[0].commands[1].command, "/grill-me");
    assert.equal(snap.stages[0].commands[1].state, "done");
    assert.equal(snap.stages[0].artifact?.name, "implementation_plan.md");
    assert.match(snap.stages[0].artifact?.uri ?? "", /^file:\/\//);
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
    assert.equal(snap.stages[0].status, "next");
    assert.equal(snap.stages[1].status, "pending");
    assert.equal(snap.stages[1].commands[1].state, "pending");
    assert.equal(snap.stages[2].status, "pending");
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
    assert.equal(cleanSnap.stages[0].status, "skipped");
    assert.equal(cleanSnap.stages[1].status, "done");
    assert.equal(cleanSnap.stages[1].commands[1].command, "/interrogate");
    assert.equal(cleanSnap.stages[1].commands[1].state, "done");
    assert.equal(cleanSnap.stages[2].status, "next");
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
    assert.equal(staleSnap.stages[1].status, "stale");
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
    assert.equal(passSnap.stages[2].status, "waiting_gate");
    assert.equal(passSnap.stages[2].artifact?.name, "pr-review.md");
    assert.equal(passSnap.stages[3].status, "next");
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
    assert.equal(escSnap.stages[2].status, "error");
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

test("detects autoSubCommands and opt-in moreCommands from transcript while ignoring casual prose", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-subcmds";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>Should we run /blast-radius or /tdd later?</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:01:00Z",
        content: "<USER_REQUEST>/security-audit check auth boundary</USER_REQUEST>",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:02:00Z",
        tool_calls: [
          { name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } },
          { name: "invoke_subagent", args: { TypeName: "pr-verifier" } },
          { name: "run_command", args: { CommandLine: "node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --pr 1" } },
        ],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    const build = snap.stages[1];
    const review = snap.stages[2];
    const ship = snap.stages[3];

    assert.equal(build.autoSubCommands.find((c) => c.command === "/deslop")?.ran, true);
    assert.equal(build.moreCommands.find((c) => c.command === "/tdd")?.state, "pending");
    assert.equal(review.autoSubCommands.find((c) => c.command === "pr-verifier")?.ran, true);
    assert.equal(review.moreCommands.find((c) => c.command === "/security-audit")?.state, "done");
    assert.equal(review.moreCommands.find((c) => c.command === "/blast-radius")?.state, "pending");
    assert.equal(ship.autoSubCommands.find((c) => c.command === "watch-pr")?.ran, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("marks Build & Prove done on Proceed + fresh verify + walkthrough without /astack-mode, but requires fresh verify", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-proceed-walkthrough";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
    writeText(path.join(brainDir, convId, "walkthrough.md"), "# Walkthrough\n");

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/plan add status badge</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:10Z",
        tool_calls: [{ name: "write_file", args: { Path: path.join(brainDir, convId, "implementation_plan.md") } }],
      },
      {
        step_index: 2,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:20Z",
        content: "<USER_REQUEST>Proceeded with implementation_plan.md</USER_REQUEST>",
      },
    ]);

    // Walkthrough without passing verification must NOT mark Build & Prove done.
    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:30Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/badge.js",
        paths: ["src/badge.js"],
      },
    ]);
    const unverified = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(unverified.stages[0].status, "done");
    assert.equal(unverified.stages[1].status, "active");

    // Once tests pass on HEAD — even if a legacy brain-artifact write receipt landed afterward — Build & Prove is done.
    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:30Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/badge.js",
        paths: ["src/badge.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:01:00Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:01:30Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "write_file walkthrough.md",
        paths: ["C:/Users/dev/.gemini/antigravity/brain/conv-proceed-walkthrough/walkthrough.md"],
      },
    ]);
    const verified = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(verified.stages[1].status, "done");
    assert.equal(verified.freshness, "fresh");
    assert.equal(verified.stages[2].status, "next");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
