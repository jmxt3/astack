import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DELEGATE_GUIDE_DATA, GITHUB_DOCS_BASE } from "./command-catalog.mjs";
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
      if (cmd.invocable !== false) {
        assert.equal(cmd.copyText, cmd.command.trim(), `copyText must not add trailing space for ${cmd.command}`);
        assert.equal(cmd.copyText.endsWith(" "), false);
        assert.equal(cmd.command.startsWith("/"), true, `Invocable timeline command must start with /: ${cmd.command}`);
      } else {
        assert.equal(cmd.copyText, null, `Non-invocable internal step must have copyText === null: ${cmd.command}`);
        assert.ok(cmd.invokedBy && COMMAND_DOCS[cmd.invokedBy], `Internal step ${cmd.command} must reference valid invokedBy`);
        assert.ok(
          cmd.backingPath && fs.existsSync(path.join(REPO_ROOT, ...cmd.backingPath.split("/"))),
          `Missing backingPath for ${cmd.command}: ${cmd.backingPath}`,
        );
      }
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
    for (const sub of cleanSnap.stages[1].subChecks) {
      assert.equal(sub.status, "done");
      assert.ok(typeof sub.detail === "string" && sub.detail.length > 0);
    }
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
    assert.match(staleSnap.stages[1].subChecks[1].detail, /Re-run \/deslop or \/no-comments/);
    assert.match(staleSnap.stages[1].subChecks[2].detail, /Re-run tests or validation/);
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
          { name: "read_file", args: { Path: "/plugin/skills/maintain-verification-skill/SKILL.md" } },
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

    assert.equal(snap.setup.commands.find((c) => c.command === "/maintain-verification-skill")?.state, "done");

    assert.equal(build.autoSubCommands.find((c) => c.command === "/deslop")?.ran, true);
    assert.equal(build.moreCommands.find((c) => c.command === "/tdd")?.state, "pending");
    assert.equal(review.autoSubCommands.find((c) => c.command === "pr-verifier")?.ran, true);
    assert.equal(review.autoSubCommands.find((c) => c.command === "pr-verifier")?.invocable, false);
    assert.equal(review.moreCommands.find((c) => c.command === "/security-audit")?.state, "done");
    assert.equal(review.moreCommands.find((c) => c.command === "/blast-radius")?.state, "pending");
    const watchPrItem = ship.autoSubCommands.find((c) => c.command === "watch-pr.mjs");
    assert.equal(watchPrItem?.ran, true);
    assert.equal(watchPrItem?.invocable, false);
    assert.equal(watchPrItem?.copyText, null);
    assert.equal(watchPrItem?.invokedBy, "/astack-mode babysit");
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
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:25Z",
        tool_calls: [{ name: "read_file", args: { Path: path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md") } }],
      },
    ]);

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
    assert.equal(unverified.stages[1].status, "active", "Walkthrough without fresh verification must not mark Build & Prove done");

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
    assert.equal(verified.stages[1].status, "done", "Fresh test receipt plus walkthrough must clear earlier verify-skill reads");
    assert.equal(verified.freshness, "fresh");
    assert.equal(verified.stages[2].status, "next");

    const worktreeWs = path.join(root, ".gemini", "antigravity", "worktrees", "conv-wt", "subagent-branch");
    writeText(path.join(worktreeWs, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, "conv-wt", [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/astack-mode update widget</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:10Z",
        tool_calls: [{ name: "edit_file", args: { Path: path.join(worktreeWs, "src", "widget.js") } }],
      },
    ]);
    const wtSnap = evaluateTimelineSnapshot({ conversationId: "conv-wt", brainDir, workspaceDir: worktreeWs });
    assert.equal(wtSnap.stages[1].status, "active", "Edits inside ~/.gemini/antigravity/worktrees/... must mark Build & Prove active");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("COMMAND_DOCS and DELEGATE_GUIDE_DATA cover all native delegate commands with valid repo docs links", () => {
  const expectedKeys = [
    "/swarm",
    "/run-workflow",
    "/schedule",
    "/automation",
    "/browser",
    "/boost",
    "/goal",
    "/teamwork",
    "/btw",
    "/learn",
    "/compact",
    "subagents",
    "research",
  ];
  for (const key of expectedKeys) {
    const doc = COMMAND_DOCS[key];
    assert.ok(doc, `Missing COMMAND_DOCS entry for ${key}`);
    assert.ok(typeof doc.description === "string" && doc.description.trim().length > 0, `Missing description for ${key}`);
    assert.ok(doc.docsUrl?.startsWith(`${GITHUB_DOCS_BASE}/`), `Expected repo docsUrl for ${key}: ${doc.docsUrl}`);
    const relPath = doc.docsUrl.slice(`${GITHUB_DOCS_BASE}/`.length).split("#")[0];
    assert.ok(fs.existsSync(path.join(REPO_ROOT, ...relPath.split("/"))), `Missing docs target ${relPath} for ${key}`);
  }

  const nativeJson = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "skills", "astack-mode", "references", "native-commands.json"), "utf8"),
  );
  for (const nativeCmd of nativeJson.commands) {
    assert.ok(COMMAND_DOCS[nativeCmd.command], `COMMAND_DOCS missing native command ${nativeCmd.command}`);
  }
  const skillDirs = fs
    .readdirSync(path.join(REPO_ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("principle-"))
    .map((d) => `/${d.name}`);
  for (const sCmd of skillDirs) {
    assert.ok(COMMAND_DOCS[sCmd], `COMMAND_DOCS missing skill ${sCmd}`);
  }
  const alongsideSec = DELEGATE_GUIDE_DATA.sections.find((s) => s.id === "alongside");
  const compactItem = alongsideSec?.items.find((i) => i.command === "/compact");
  assert.ok(compactItem);
  assert.notEqual(compactItem.ownership, "Not wired yet");
  assert.notEqual(compactItem.statusPill, "not wired");

  assert.equal(DELEGATE_GUIDE_DATA.picks.length, 10);
  assert.equal(DELEGATE_GUIDE_DATA.sections.length, 5);
  assert.equal(DELEGATE_GUIDE_DATA.delegateMenu.length, 6);
  const pickIds = new Set(DELEGATE_GUIDE_DATA.picks.map((p) => p.id));
  for (const p of DELEGATE_GUIDE_DATA.picks) {
    assert.ok(p.chipLabel && p.kicker && p.prompt && p.how);
  }
  for (const section of DELEGATE_GUIDE_DATA.sections) {
    assert.ok(section.id && section.title && section.subtitle && Array.isArray(section.items) && section.items.length > 0);
    for (const item of section.items) {
      if (item.pickId) assert.ok(pickIds.has(item.pickId), `Unknown pickId ${item.pickId}`);
    }
  }
});

test("timeline-engine detects subagent lifecycles, swarm workers, goal, boost, teamwork, workflow, schedules, btw, and artifacts", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-act-");
  try {
    const convId = "conv-live";
    const childPlanId = "11111111-1111-4111-8111-111111111111";
    const childBuildId = "22222222-2222-4222-8222-222222222222";
    const childReviewId = "33333333-3333-4333-8333-333333333333";

    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\nApproved\n");
    writeText(path.join(brainDir, convId, "walkthrough.md"), "# Walkthrough\n");
    writeText(path.join(brainDir, convId, "architecture-diagram.svg"), "<svg></svg>\n");

    writeTranscript(brainDir, childPlanId, [
      { step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-20T10:01:30Z", content: "Research summary complete." },
    ]);

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/goal /boost /teamwork /astack-mode Implement timeline. Done when all checks pass.</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:01:00Z",
        tool_calls: [
          { name: "invoke_subagent", args: { TypeName: "research", Role: "Caller Mapper", Prompt: "Map callers" } },
          { name: "write_to_file", args: { TargetFile: path.join(brainDir, convId, "implementation_plan.md") } },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        created_at: "2026-11-20T10:01:05Z",
        content: JSON.stringify({ conversationId: childPlanId }),
      },
      {
        step_index: 3,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:02:00Z",
        content: "Proceeded with plan.",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:03:00Z",
        tool_calls: [
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "a.mjs") } },
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "b.mjs") } },
          { name: "swarm", args: { action: "title", title: "Timeline implementation" } },
          { name: "swarm", args: { action: "add", name: "worker", tasks: ["src/a.mjs", "src/b.mjs"], brief: "Implement module" } },
          { name: "swarm", args: { action: "add", name: "verifier", brief: "Verify tests on HEAD" } },
          { name: "swarm", args: { action: "add", name: "old-helper", brief: "Temp helper" } },
          { name: "swarm", args: { action: "kill", name: "old-helper" } },
          { name: "post_message", args: { from: "worker-1", to: "verifier", body: "Ready for check" } },
          { name: "invoke_subagent", args: { TypeName: "browser", Role: "UI Verifier", Prompt: "Check live view" } },
          { name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "PR Verifier", Prompt: "Audit diff" } },
          { name: "schedule", args: { DurationSeconds: 120, Prompt: "Run node node_modules/watch-pr.mjs --pr 11" } },
          { name: "run_workflow", args: { Script: "parallel()" } },
        ],
      },
      {
        step_index: 5,
        type: "GENERIC",
        created_at: "2026-11-20T10:03:05Z",
        content: `Created subagents {"conversationId":"${childBuildId}"} and {"conversationId":"${childReviewId}"}\ntask id: ${convId}/task-1`,
      },
      {
        step_index: 6,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-20T10:04:00Z",
        content: `[SYSTEM sender=${childReviewId}] Verification finished.`,
      },
      {
        step_index: 7,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:04:30Z",
        content: "<USER_REQUEST>/btw why is worker-2 touching b.mjs?</USER_REQUEST>",
      },
      {
        step_index: 8,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:05:00Z",
        content: "<USER_REQUEST>/automation Run nightly regression suite</USER_REQUEST>",
      },
    ]);

    const first = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    const second = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(first.etag, second.etag, "Snapshot ETag must be deterministic across identical reads");

    assert.equal(first.activity.goal.active, true);
    assert.equal(first.activity.goal.completed, false);
    assert.match(first.activity.goal.predicate, /all checks pass/i);
    assert.equal(first.activity.goal.checksTotal, 3);
    assert.equal(first.activity.boost.active, true);
    assert.equal(first.activity.teamwork.active, true);
    assert.equal(first.activity.sideQuestions.count, 1);
    assert.equal(first.activity.workflow.runsCount, 1);
    assert.equal(first.activity.workflow.active, true);
    assert.equal(first.activity.changedFilesCount, 2);
    assert.equal(first.activity.workflow.suggestedReview?.command, "/run-workflow");

    assert.equal(first.activity.swarm.active, true);
    assert.equal(first.activity.swarm.title, "Timeline implementation");
    assert.equal(first.activity.swarm.posts, 1);
    assert.equal(first.activity.swarm.totalCount, 3, "Killed swarm worker must be excluded from active totalCount");
    assert.equal(first.activity.swarm.workingCount, 3);

    const byType = new Map(first.activity.subagents.map((s) => [s.type, s]));
    assert.equal(byType.get("research")?.stageId, "plan");
    assert.equal(byType.get("research")?.status, "done", "Child transcript PLANNER_RESPONSE finishes research subagent");
    assert.equal(byType.get("browser")?.stageId, "build");
    assert.equal(byType.get("browser")?.status, "running");
    assert.equal(byType.get("pr-verifier")?.stageId, "review");
    assert.equal(byType.get("pr-verifier")?.status, "done", "SYSTEM_MESSAGE sender finishes pr-verifier subagent");
    assert.equal(first.activity.runningSubagentsCount, 1);

    assert.equal(first.activity.schedules.length, 1);
    assert.equal(first.activity.schedules[0].taskId, `${convId}/task-1`);
    assert.equal(first.activity.schedules[0].label, "watch-pr.mjs --pr 11");
    assert.equal(first.activity.schedules[0].stageId, "ship");
    assert.equal(first.activity.schedules[0].active, true);
    assert.equal(first.activity.automations.length, 1);
    assert.equal(first.activity.scheduledCount, 2);
    assert.equal(first.activity.pr?.number, 11);

    assert.ok(first.stages[0].artifacts.some((a) => a.name === "implementation_plan.md"));
    assert.ok(first.stages[1].artifacts.some((a) => a.name === "walkthrough.md"));
    assert.ok(first.stages[1].artifacts.some((a) => a.name === "architecture-diagram.svg"));
    assert.ok(first.stages[3].artifacts.some((a) => a.name === "PR #11"));
    assert.equal(first.activity.artifactCount, 3, "File artifactCount must exclude PR entries");
    assert.equal(first.activity.prs.totalCount, 1);
    assert.equal(first.activity.prs.items[0].number, 11);
    assert.equal(first.activity.agentsTotalCount, 6);

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/goal Done when clean</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:02:00Z",
        content: "All checks green.\n<!-- GOAL_COMPLETE -->",
      },
    ]);
    const doneGoalSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(doneGoalSnap.activity.goal.detected, true);
    assert.equal(doneGoalSnap.activity.goal.active, false);
    assert.equal(doneGoalSnap.activity.goal.completed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("timeline-engine ignores slash command questions in plain prose", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-prose-");
  try {
    const convId = "conv-prose";
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>Should we try /goal or /swarm or /boost?</USER_REQUEST>",
      },
    ]);
    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.activity.goal.detected, false);
    assert.equal(snap.activity.goal.active, false);
    assert.equal(snap.activity.swarm.active, false);
    assert.equal(snap.activity.boost.detected, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateTimelineSnapshot hides nextAction once all workflow stages are accomplished", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-all-done";
  try {
    const headSha = "abcdef0123456789abcdef0123456789abcdef01";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
    writeText(path.join(brainDir, convId, "walkthrough.md"), "# Walkthrough\n");
    writeText(path.join(brainDir, convId, "pr-review.md"), "# PR Review\n");
    writeText(
      path.join(brainDir, convId, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        freshness: "fresh",
        riskTier: 0,
        riskLabel: "low",
        reviewRound: 1,
        maxReviewRounds: 3,
        roundState: "verified",
        autoMergeEligible: true,
        verifier: { verdict: "PASS" },
      }),
    );
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/plan build widget</USER_REQUEST>",
      },
      {
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:05Z",
        content: "Proceed",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:10Z",
        tool_calls: [
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "widget.js") } },
          { name: "run_command", args: { CommandLine: "npm test" } },
          { name: "run_command", args: { CommandLine: "gh pr create --fill" } },
        ],
      },
    ]);
    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:08Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/widget.js",
        paths: ["src/widget.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:15Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "npm test",
        paths: [],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.deepEqual(
      snap.stages.map((s) => s.status),
      ["done", "done", "done", "done"],
    );
    assert.equal(snap.nextAction, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps Build & Prove pending during /plan with baseline lint checks and avoids false stale on first edit", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-plan-baseline";
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);

    const step0 = {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: "2026-11-20T10:00:00Z",
      content: "<USER_REQUEST>/plan /astack-mode design native improvements</USER_REQUEST>",
    };
    const step1 = {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-20T10:00:10Z",
      tool_calls: [{ name: "read_file", args: { Path: "/plugin/skills/astack-mode/SKILL.md" } }],
    };
    writeTranscript(brainDir, convId, [step0, step1]);
    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:20Z",
        conversationId: convId,
        kind: "command",
        category: "lint",
        headSha,
        ok: true,
        summary: "node scripts/validate-astack.mjs --json",
        paths: [],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:25Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --run test:sidecar",
        paths: [],
      },
    ]);

    const planningSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(planningSnap.doneCount, 0);
    assert.equal(planningSnap.stages[0].status, "active");
    assert.equal(planningSnap.stages[0].commands[0].state, "active");
    assert.equal(planningSnap.nextAction.stageId, "plan");
    assert.equal(planningSnap.nextAction.inProgress, true);
    assert.equal(planningSnap.stages[1].status, "pending");
    assert.equal(planningSnap.stages[1].commands[0].state, "pending");
    assert.deepEqual(
      planningSnap.stages[1].subChecks.map((c) => c.status),
      ["pending", "pending", "pending"],
    );

    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
    const step2 = {
      step_index: 2,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-20T10:01:00Z",
      tool_calls: [{ name: "write_file", args: { Path: path.join(brainDir, convId, "implementation_plan.md") } }],
    };
    writeTranscript(brainDir, convId, [step0, step1, step2]);

    const gateSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(gateSnap.doneCount, 0);
    assert.equal(gateSnap.stages[0].status, "waiting_gate");
    assert.equal(gateSnap.stages[0].commands[0].state, "done");
    assert.equal(gateSnap.stages[1].status, "pending");

    const step3 = {
      step_index: 3,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: "2026-11-20T10:02:00Z",
      content: "<USER_REQUEST>Proceeded with implementation_plan.md</USER_REQUEST>",
    };
    writeTranscript(brainDir, convId, [step0, step1, step2, step3]);

    const approvedSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(approvedSnap.stages[0].status, "done");
    assert.equal(approvedSnap.stages[1].status, "active");

    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:20Z",
        conversationId: convId,
        kind: "command",
        category: "lint",
        headSha,
        ok: true,
        summary: "node scripts/validate-astack.mjs --json",
        paths: [],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:03:00Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/index.js",
        paths: ["src/index.js"],
      },
    ]);

    const firstEditSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(firstEditSnap.stages[1].status, "active", "Pre-plan lint receipt must not make first edit stale");
    assert.equal(firstEditSnap.stages[1].subChecks[0].status, "done");
    assert.equal(firstEditSnap.stages[1].subChecks[2].status, "pending");

    const step4 = {
      step_index: 4,
      type: "PLANNER_RESPONSE",
      created_at: "2026-11-20T10:04:00Z",
      tool_calls: [{ name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } }],
    };
    writeTranscript(brainDir, convId, [step0, step1, step2, step3, step4]);
    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:20Z",
        conversationId: convId,
        kind: "command",
        category: "lint",
        headSha,
        ok: true,
        summary: "node scripts/validate-astack.mjs --json",
        paths: [],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:03:00Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/index.js",
        paths: ["src/index.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:05:00Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);

    const doneSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(doneSnap.stages[1].status, "done");
    assert.equal(doneSnap.doneCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detects Antigravity metadata Slash Command chips even after text while ignoring casual prose", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-meta-cmd";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: [
          "<USER_REQUEST>@README.md please use /plan and do not run /review-pr yet</USER_REQUEST>",
          "<ADDITIONAL_METADATA>",
          "/plan is a [Slash Command]:",
          "<PLAN>Plan instructions</PLAN>",
          "</ADDITIONAL_METADATA>",
        ].join("\n"),
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.stages[0].status, "active");
    assert.equal(snap.stages[0].commands[0].state, "active");
    assert.equal(snap.stages[2].status, "pending");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps Build & Prove pending on read-only test/lint run without edits, and completes on doc-only edits + verify", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-readonly-vs-docs";
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>Check test status</USER_REQUEST>",
      },
    ]);
    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:10Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);

    const readOnlySnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(readOnlySnap.stages[1].status, "pending");
    assert.equal(readOnlySnap.doneCount, 0);

    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:10Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file README.md",
        paths: ["README.md"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-20T10:00:20Z",
        conversationId: convId,
        kind: "command",
        category: "lint",
        headSha,
        ok: true,
        summary: "node scripts/validate-astack.mjs",
        paths: [],
      },
    ]);

    const docSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(docSnap.stages[1].status, "done");
    assert.equal(docSnap.stages[1].detail, "Documentation edits verified on HEAD.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores workspace repository skill/playbook source reads in parent and child transcripts while honoring installed plugin skills", () => {
  const { root, brainDir, workspaceDir } = makeFixture();
  const convId = "conv-workspace-skills";
  const childId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T10:00:00Z",
        content: "<USER_REQUEST>/plan audit our skills directory</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:10Z",
        tool_calls: [
          { name: "read_file", args: { Path: path.join(workspaceDir, "skills", "review-pr", "SKILL.md") } },
          { name: "read_file", args: { Path: path.join(workspaceDir, "skills", "setup-astack", "SKILL.md") } },
          { name: "read_file", args: { Path: path.join(workspaceDir, "skills", "astack-mode", "playbooks", "babysit.md") } },
          { name: "read_file", args: { Path: path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md") } },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        created_at: "2026-11-20T10:00:20Z",
        content: `Started subagent {"conversationId": "${childId}"}`,
      },
    ]);
    writeTranscript(brainDir, childId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T10:00:25Z",
        tool_calls: [
          { name: "read_file", args: { Path: path.join(workspaceDir, "skills", "control-ui", "SKILL.md") } },
          { name: "read_file", args: { Path: path.join(workspaceDir, "skills", "arena", "SKILL.md") } },
          { name: "read_file", args: { Path: "/external-plugin/skills/how/SKILL.md" } },
        ],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.setup.ranInSession, false);
    assert.equal(snap.stages[0].status, "active");
    assert.equal(snap.stages[0].autoSubCommands.find((c) => c.command === "/how")?.ran, true);
    assert.equal(snap.stages[1].status, "pending");
    assert.equal(snap.stages[1].autoSubCommands.find((c) => c.command === "/control-ui")?.ran, false);
    assert.equal(snap.stages[1].moreCommands.find((c) => c.command === "/arena")?.state, "pending");
    assert.equal(snap.stages[2].status, "pending");
    assert.equal(snap.stages[3].status, "pending");
    assert.equal(snap.stages[3].commands.find((c) => c.command === "/astack-mode babysit")?.state, "pending");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not mark clean stale when transcript whole-second cleanup matches same-second millisecond edit receipt", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-ms-");
  const convId = "conv-same-sec";
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-21T18:30:00Z",
        content: "<USER_REQUEST>/astack-mode update ui</USER_REQUEST>",
      },
      {
        step_index: 709,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T18:30:38Z",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "node skills/audit-architecture/scripts/arch-audit.mjs --cwd . --strict" } },
        ],
      },
    ]);

    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-21T18:30:38.199Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file scripts/mcp/src/tla-viewer.js",
        paths: ["scripts/mcp/src/tla-viewer.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-21T18:31:00.500Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --run test",
        paths: [],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.stages[1].status, "done");
    assert.equal(snap.stages[1].subChecks.find((c) => c.id === "clean")?.status, "done");
    assert.equal(snap.stages[1].subChecks.find((c) => c.id === "verify")?.status, "done");
    assert.equal(snap.liveLabel, "Live");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports Re-clean wording without blaming verification when only cleanup is stale before PR review", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-reclean-");
  const convId = "conv-reclean";
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-21T18:30:00Z",
        content: "<USER_REQUEST>/astack-mode update ui</USER_REQUEST>",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T18:30:10Z",
        tool_calls: [{ name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } }],
      },
    ]);

    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-21T18:30:40.100Z",
        conversationId: convId,
        kind: "file_write",
        category: "other",
        headSha,
        ok: true,
        summary: "edit_file src/ui.js",
        paths: ["src/ui.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-21T18:30:42.000Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.stages[1].status, "stale");
    assert.equal(snap.stages[1].subChecks.find((c) => c.id === "clean")?.status, "stale");
    assert.equal(snap.stages[1].subChecks.find((c) => c.id === "verify")?.status, "done");
    assert.equal(snap.liveLabel, "Re-clean");
    assert.equal(snap.stages[1].collapsedSummary, "Code edited after cleanup.");
    assert.match(snap.stages[1].detail, /Re-run \/deslop or \/no-comments/);
    assert.doesNotMatch(snap.stages[1].detail, /after verification/i);
    assert.match(snap.nextAction.hint, /Code edited after cleanup/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolves parent repo name for linked git worktrees and surfaces risk tier description and globs", () => {
  const { root, brainDir } = makeFixture("astack-tl-wt-");
  const mainRepo = path.join(root, "astack-main");
  const worktreeDir = path.join(root, "worktrees", "astack-main", "feature-branch");
  const convId = "conv-worktree";
  try {
    const headSha = "abcdef0123456789abcdef0123456789abcdef01";
    const wtGitDir = path.join(mainRepo, ".git", "worktrees", "feature-branch");
    writeText(path.join(wtGitDir, "HEAD"), "ref: refs/heads/feature-branch\n");
    writeText(path.join(wtGitDir, "commondir"), "../..\n");
    writeText(path.join(worktreeDir, ".git"), `gitdir: ${wtGitDir}\n`);
    writeText(path.join(worktreeDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(
      path.join(brainDir, convId, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        freshness: "fresh",
        riskTier: 3,
        riskLabel: "critical",
        matchedRiskRules: [
          { tier: 3, glob: "hooks.json", files: ["hooks.json"] },
          { tier: 3, glob: "scripts/trust/**", files: ["scripts/trust/index.mjs"] },
          { tier: 1, glob: "skills/**", files: ["skills/foo/SKILL.md"] },
        ],
        reviewRound: 1,
        maxReviewRounds: 3,
        roundState: "verified",
        verifier: { verdict: "PASS" },
      }),
    );

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir: worktreeDir });
    assert.equal(snap.workspaceName, "astack-main");
    assert.equal(snap.branch, "feature-branch");
    assert.equal(snap.riskTier, 3);
    assert.match(snap.riskDescription, /hooks/i);
    assert.deepEqual(snap.riskMatchedGlobs, ["hooks.json", "scripts/trust/**"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tracks multi-PR states separately from file artifacts, exposes total agents executed, and ignores PR mentions in read_file outputs", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-kpi-");
  const convId = "conv-kpi";
  try {
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
    writeText(path.join(brainDir, convId, "walkthrough.md"), "# Walkthrough\n");
    writeText(path.join(brainDir, convId, "pr-review.md"), "# PR Review\n");

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-21T10:00:00Z",
        content: "<USER_REQUEST>/astack-mode open PRs</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T10:01:00Z",
        tool_calls: [
          { name: "invoke_subagent", args: { TypeName: "research", Role: "Researcher", Prompt: "Inspect repo" } },
          { name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "Verifier", Prompt: "Verify PR" } },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        created_at: "2026-11-21T10:01:05Z",
        content: '{"conversationId":"11111111-1111-1111-1111-111111111111"}\n{"conversationId":"22222222-2222-2222-2222-222222222222"}',
      },
      {
        step_index: 3,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-21T10:03:00Z",
        content: "[Notice] All your subagents and background tasks have been stopped due to server restart.",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T10:04:00Z",
        tool_calls: [{ name: "read_file", args: { Path: "sidecars/astack_timeline/timeline.test.mjs" } }],
      },
      {
        step_index: 5,
        type: "GENERIC",
        created_at: "2026-11-21T10:04:01Z",
        content: "watch-pr.mjs --pr 99\nhttps://github.com/acme/demo/pull/99\n",
      },
      {
        step_index: 6,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T10:05:00Z",
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: 'gh pr create --title "feat: first change" --body "ok"' },
          },
        ],
      },
      {
        step_index: 7,
        type: "GENERIC",
        created_at: "2026-11-21T10:05:05Z",
        content: "https://github.com/acme/demo/pull/13\n",
      },
      {
        step_index: 8,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T10:06:00Z",
        tool_calls: [
          {
            name: "run_command",
            args: { CommandLine: 'gh pr create --title "fix: second change" --body "ok"' },
          },
        ],
      },
      {
        step_index: 9,
        type: "GENERIC",
        created_at: "2026-11-21T10:06:05Z",
        content: "https://github.com/acme/demo/pull/14\n",
      },
    ]);

    const prMetaByNumber = new Map([
      [13, { number: 13, title: "feat: first change", state: "merged", url: "https://github.com/acme/demo/pull/13" }],
      [14, { number: 14, title: "fix: second change", state: "open", url: "https://github.com/acme/demo/pull/14" }],
    ]);
    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir, prMetaByNumber });

    assert.equal(snap.activity.agentsWorkingCount, 0);
    assert.equal(snap.activity.agentsTotalCount, 2);
    assert.equal(snap.activity.doneSubagentsCount, 2);
    assert.equal(snap.activity.artifactCount, 3);
    assert.equal(snap.activity.prs.totalCount, 2, "read_file fixture PR #99 must not leak into prs");
    assert.equal(snap.activity.prs.openCount, 1);
    assert.equal(snap.activity.prs.mergedCount, 1);
    assert.deepEqual(
      snap.activity.prs.items.map((p) => `${p.number}:${p.state}`),
      ["14:open", "13:merged"],
    );
    assert.equal(snap.stages[3].collapsedSummary, "2 PRs (1 open, 1 merged).");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("counts only genuine Antigravity background tasks with toolSummary titles and ignores synchronous commands", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-bgtasks-");
  const convId = "conv-bgtasks";
  try {
    writeText(path.join(brainDir, convId, ".system_generated", "tasks", "task-2.log"), "suite output\n");
    writeText(path.join(brainDir, convId, ".system_generated", "tasks", "task-4.log"), "server started\n");

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T12:00:00Z",
        tool_calls: [
          { name: "write_file", args: { Path: "src/index.mjs" } },
          { name: "run_command", args: { CommandLine: "node --run test", toolSummary: "Run full Node test suite" } },
          { name: "run_command", args: { CommandLine: "node --check src/index.mjs", toolSummary: "Syntax check" } },
        ],
      },
      {
        step_index: 1,
        type: "GENERIC",
        created_at: "2026-11-21T12:00:01Z",
        content: "Created file.",
      },
      {
        step_index: 2,
        type: "GENERIC",
        created_at: "2026-11-21T12:00:02Z",
        content: `Created At: 2026-11-21T12:00:02Z\nTool is running as a background task with task id: ${convId}/task-2\nTask Description: node --run test`,
      },
      {
        step_index: 3,
        type: "GENERIC",
        created_at: "2026-11-21T12:00:03Z",
        content: `Created At: 2026-11-21T12:00:03Z\nCompleted At: 2026-11-21T12:00:03Z\nCommand output:\nTool is running as a background task with task id: ${convId}/task-999`,
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T12:00:10Z",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "node server.mjs", IsDaemon: true, toolSummary: "Start preview server" } },
        ],
      },
      {
        step_index: 5,
        type: "GENERIC",
        created_at: "2026-11-21T12:00:11Z",
        content: `Tool is running as a background task with task id: ${convId}/task-4\n`,
      },
      {
        step_index: 6,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-21T12:00:25Z",
        content: `[Message] sender=${convId}/task-2 content=Task id "${convId}/task-2" finished with result:\nCommand exited with code 0.`,
      },
      {
        step_index: 7,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T12:00:30Z",
        tool_calls: [{ name: "manage_task", args: { Action: "kill", TaskId: `${convId}/task-4` } }],
      },
      {
        step_index: 8,
        type: "GENERIC",
        created_at: "2026-11-21T12:00:31Z",
        content: `Task "${convId}/task-4" cancelled.`,
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.activity.backgroundJobs.count, 2, "Only real background tasks count; sync commands and stdout echoes excluded");
    assert.equal(snap.activity.tasksTotalCount, 2);
    assert.equal(snap.activity.runningTasksCount, 0);
    assert.deepEqual(
      snap.activity.backgroundJobs.items.map((j) => ({ slug: j.taskSlug, title: j.title, status: j.status, log: j.logFile })),
      [
        { slug: "task-2", title: "Run full Node test suite", status: "done", log: "task-2.log" },
        { slug: "task-4", title: "Start preview server", status: "stopped", log: "task-4.log" },
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clears Plan gate and unmutes Build & Prove when downstream walkthrough, PR review, or shipping already occurred", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-downstream-");
  const convId = "conv-downstream-pr-iter";
  const verifierChildId = "55555555-5555-4555-8555-555555555555";
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
    writeText(path.join(brainDir, convId, "walkthrough.md"), "# Walkthrough\n");
    writeTranscript(brainDir, verifierChildId, [
      { step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T10:03:00Z", content: "Looks good." },
    ]);
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-22T10:00:00Z",
        content: "<USER_REQUEST>/plan /grill-me build auth contract</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T10:01:00Z",
        tool_calls: [
          { name: "read_file", args: { Path: "/plugin/skills/how/SKILL.md" } },
          { name: "read_file", args: { Path: "/plugin/skills/why/SKILL.md" } },
          { name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "Verifier", Prompt: "Check PR" } },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        created_at: "2026-11-22T10:01:05Z",
        content: JSON.stringify({ conversationId: verifierChildId }),
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T10:04:00Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "git push origin feat/auth" } }],
      },
      {
        step_index: 4,
        type: "GENERIC",
        created_at: "2026-11-22T10:04:05Z",
        content: "https://github.com/acme/demo/pull/237\n",
      },
    ]);
    writeReceipt(brainDir, convId, [
      {
        schemaVersion: 1,
        ts: "2026-11-22T10:03:30Z",
        conversationId: convId,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.deepEqual(
      snap.stages.map((s) => s.status),
      ["done", "done", "done", "done"],
      "Downstream walkthrough + verify + push must clear stale Plan gate, complete Build & Prove, and stop PR Review from spinning",
    );
    assert.equal(snap.workflowMode, "pr_iteration");
    assert.equal(snap.workflowLabel, "PR iteration");
    assert.equal(snap.liveLabel, "Live");
    assert.equal(snap.activity.activeStageId, "ship");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("marks Plan and Build as Earlier in standalone PR review sessions and keeps post-ship re-review active", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-pr-only-");
  const convId = "conv-pr-review-only";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-22T11:00:00Z",
        content: "<USER_REQUEST>/review-pr check https://github.com/acme/demo/pull/237</USER_REQUEST>",
      },
    ]);

    const reviewOnly = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(reviewOnly.stages[0].status, "skipped");
    assert.equal(reviewOnly.stages[0].skippedReason, "earlier");
    assert.equal(reviewOnly.stages[1].status, "skipped");
    assert.equal(reviewOnly.stages[1].skippedReason, "earlier");
    assert.equal(reviewOnly.stages[2].status, "active");
    assert.equal(reviewOnly.workflowMode, "pr_review");
    assert.equal(reviewOnly.workflowLabel, "PR review");

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T11:00:00Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "git push origin feat/pr-237" } }],
      },
      {
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-22T11:05:00Z",
        content: "<USER_REQUEST>/review-pr re-verify after latest fix</USER_REQUEST>",
      },
    ]);
    const postShipReview = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(postShipReview.stages[2].status, "active", "Re-running /review-pr after push must remain active");
    assert.equal(postShipReview.workflowMode, "pr_iteration");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detects edits in sibling git repos, linked worktrees, and cross-machine repo paths while ignoring brain and temp writes", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-multi-repo-");
  const siblingRepo = path.join(root, "player-support-gaia");
  const convId = "conv-multi-repo";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(siblingRepo, ".git", "HEAD"), "ref: refs/heads/feat/pr-237\n");
    writeText(path.join(siblingRepo, "apps", "server", "src", "chat", "setup.ts"), "export const ok = true;\n");
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T12:00:00Z",
        tool_calls: [{ name: "write_to_file", args: { TargetFile: path.join(brainDir, convId, "implementation_plan.md") } }],
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T12:01:00Z",
        tool_calls: [
          { name: "write_to_file", args: { TargetFile: "/Users/dev/.gemini/jetski/brain/conv-x/notes.md" } },
          { name: "write_to_file", args: { TargetFile: "/tmp/scratch-note.txt" } },
          { name: "write_to_file", args: { TargetFile: "../outside.js" } },
        ],
      },
    ]);
    const ignoredOnly = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(ignoredOnly.stages[0].status, "waiting_gate", "Brain/tmp/traversal writes must not clear Plan gate");
    assert.equal(ignoredOnly.stages[1].status, "pending");

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T12:00:00Z",
        tool_calls: [{ name: "write_to_file", args: { TargetFile: path.join(brainDir, convId, "implementation_plan.md") } }],
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T12:02:00Z",
        tool_calls: [
          { name: "replace_file_content", args: { TargetFile: path.join(siblingRepo, "apps", "server", "src", "chat", "setup.ts") } },
          { name: "edit_file", args: { Path: "/Users/other-machine/dev/repo/src/client.ts" } },
        ],
      },
    ]);
    const crossRepoSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(crossRepoSnap.stages[0].status, "done", "Sibling repo or cross-machine edits after plan must mark Plan done");
    assert.equal(crossRepoSnap.stages[1].status, "active", "Sibling repo or cross-machine edits must activate Build & Prove");
    assert.equal(crossRepoSnap.activity.changedFilesCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a brand-new /plan written after earlier shipped work in waiting_gate", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-replan-");
  const convId = "conv-replan";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan 2\n");
    writeText(path.join(brainDir, convId, "walkthrough.md"), "# Walkthrough 1\n");

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T10:00:00Z",
        tool_calls: [
          { name: "write_to_file", args: { TargetFile: path.join(brainDir, convId, "walkthrough.md") } },
          { name: "run_command", args: { CommandLine: "git push origin feat/task-1" } },
        ],
      },
      {
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-22T10:10:00Z",
        content: "<USER_REQUEST>/plan design task 2</USER_REQUEST>",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-22T10:11:00Z",
        tool_calls: [{ name: "write_to_file", args: { TargetFile: path.join(brainDir, convId, "implementation_plan.md") } }],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.stages[0].status, "waiting_gate", "New plan written after prior shipping must pause at review checkpoint");
    assert.equal(snap.liveLabel, "Review");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detects /astack-mode babysit, /astack-mode release-and-postmortem, and compile_pr_dossier MCP tool", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-shipcmds-");
  const convId = "conv-ship-cmds";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T10:00:00Z",
        content: "<USER_REQUEST>/astack-mode babysit pr 24 to green</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T10:00:10Z",
        tool_calls: [
          { name: "call_mcp_tool", args: { ServerName: "astack_trust", ToolName: "compile_pr_dossier" } },
          { name: "read_file", args: { Path: "/external-plugin/skills/astack-mode/playbooks/release-and-postmortem.md" } },
          { name: "run_command", args: { CommandLine: "node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --pr 24 --status-only" } },
        ],
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    const review = snap.stages[2];
    const ship = snap.stages[3];
    assert.equal(review.autoSubCommands.find((c) => c.command === "pr-dossier.mjs")?.ran, true);
    assert.equal(ship.commands.find((c) => c.command === "/astack-mode babysit")?.state, "done");
    assert.equal(ship.autoSubCommands.find((c) => c.command === "watch-pr.mjs")?.ran, true);
    assert.equal(ship.moreCommands.find((c) => c.command === "/astack-mode release-and-postmortem")?.state, "done");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
