import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { COLLEAGUE_REVIEW_GUIDE, DELEGATE_GUIDE_DATA, GITHUB_DOCS_BASE } from "./command-catalog.mjs";
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
    ["/plan", "/astack-mode", "/pre-pr", "/astack-mode open the pr"],
  );
  assert.equal(TIMELINE_STEPS[2].label, "Pre-PR Check");
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
        content: "<USER_REQUEST>Should we run /pre-pr or /interrogate before /deslop?</USER_REQUEST>",
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
    assert.equal(cleanSnap.nextAction.command, "/pre-pr");

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

test("surfaces Pre-PR Check waiting gate, Risk Tier, and escalated error state from evidence.json", () => {
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

  assert.deepEqual(
    DELEGATE_GUIDE_DATA.stages.map((s) => s.id),
    ["setup", "plan", "build", "review", "colleague-pr", "ship", "anytime"],
  );
  assert.deepEqual(
    COLLEAGUE_REVIEW_GUIDE.intents.map((i) => i.id),
    ["single", "queue", "stack"],
  );
  const anytimeStage = DELEGATE_GUIDE_DATA.stages.find((s) => s.id === "anytime");
  const compactExample = anytimeStage?.examples.find((ex) => ex.id === "compact");
  assert.ok(compactExample);
  assert.notEqual(compactExample.ownership, "Not wired yet");
  assert.equal(DELEGATE_GUIDE_DATA.delegateMenu.length, 6);
  assert.doesNotMatch(JSON.stringify(DELEGATE_GUIDE_DATA), /[\u2013\u2014]/);

  const exampleIds = new Set();
  for (const stage of DELEGATE_GUIDE_DATA.stages) {
    assert.ok(stage.id && stage.title && stage.subtitle && stage.icon, `Missing stage metadata for ${stage?.id}`);
    assert.ok(Array.isArray(stage.examples) && stage.examples.length > 0, `Missing examples for stage ${stage.id}`);
    assert.ok(Array.isArray(stage.commands) && stage.commands.length > 0, `Missing commands for stage ${stage.id}`);

    for (const ex of stage.examples) {
      assert.ok(ex.id && ex.label && ex.kicker && ex.prompt && ex.how && ex.ownership, `Incomplete example ${ex?.id}`);
      assert.ok(Array.isArray(ex.commands) && ex.commands.length > 0, `Missing commands for example ${ex.id}`);
      exampleIds.add(ex.id);
      for (const cmd of ex.commands) {
        const doc = COMMAND_DOCS[cmd];
        assert.ok(doc, `Missing COMMAND_DOCS entry for example command ${cmd} (${ex.id})`);
        assert.ok(doc.docsUrl?.startsWith(`${GITHUB_DOCS_BASE}/`), `Expected repo docsUrl for ${cmd}: ${doc.docsUrl}`);
        const relPath = doc.docsUrl.slice(`${GITHUB_DOCS_BASE}/`.length).split("#")[0];
        assert.ok(fs.existsSync(path.join(REPO_ROOT, ...relPath.split("/"))), `Missing docs target ${relPath} for ${cmd}`);
      }
    }

    for (const cmd of stage.commands) {
      const doc = COMMAND_DOCS[cmd];
      assert.ok(doc, `Missing COMMAND_DOCS entry for stage command ${cmd} (${stage.id})`);
      assert.ok(doc.docsUrl?.startsWith(`${GITHUB_DOCS_BASE}/`), `Expected repo docsUrl for ${cmd}: ${doc.docsUrl}`);
      const relPath = doc.docsUrl.slice(`${GITHUB_DOCS_BASE}/`.length).split("#")[0];
      assert.ok(fs.existsSync(path.join(REPO_ROOT, ...relPath.split("/"))), `Missing docs target ${relPath} for ${cmd}`);
    }
  }

  for (const expectedPickId of [
    "subagents",
    "browser",
    "swarm",
    "rw",
    "boost",
    "goal",
    "teamwork",
    "schedule",
    "automation",
    "btw",
  ]) {
    assert.ok(exampleIds.has(expectedPickId), `Missing expected delegation pick ID ${expectedPickId} in stages examples`);
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
          "<USER_REQUEST>@README.md please use /plan and do not run /pre-pr yet</USER_REQUEST>",
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
          { name: "read_file", args: { Path: path.join(workspaceDir, "skills", "pre-pr", "SKILL.md") } },
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
      "Downstream walkthrough + verify + push must clear stale Plan gate, complete Build & Prove, and stop Pre-PR Check from spinning",
    );
    assert.equal(snap.workflowMode, "pr_iteration");
    assert.equal(snap.workflowLabel, "PR iteration");
    assert.equal(snap.liveLabel, "Live");
    assert.deepEqual(snap.activity.liveStageIds, []);
    assert.equal(snap.activity.suggestedStageId, null);
    assert.deepEqual(
      snap.stages.map((s) => s.railState),
      ["done", "done", "done", "done"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("marks Plan and Build as Earlier in standalone Pre-PR Check sessions and keeps post-ship re-check active", () => {
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
        content: "<USER_REQUEST>/pre-pr check https://github.com/acme/demo/pull/237</USER_REQUEST>",
      },
    ]);

    const reviewOnly = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(reviewOnly.stages[0].status, "skipped");
    assert.equal(reviewOnly.stages[0].skippedReason, "earlier");
    assert.equal(reviewOnly.stages[1].status, "skipped");
    assert.equal(reviewOnly.stages[1].skippedReason, "earlier");
    assert.equal(reviewOnly.stages[2].status, "active");
    assert.equal(reviewOnly.workflowMode, "pr_review");
    assert.equal(reviewOnly.workflowLabel, "Pre-PR check");
    assert.equal(reviewOnly.panelDefaultMode, "build");

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
        content: "<USER_REQUEST>/pre-pr re-verify after latest fix</USER_REQUEST>",
      },
    ]);
    const postShipReview = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(postShipReview.stages[2].status, "active", "Re-running /pre-pr after push must remain active");
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

test("living rail models parallel work, skipped ahead, waiting on you, and all-done rest with running background tasks", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-rail-");
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);

    const convParallel = "conv-rail-parallel";
    writeText(path.join(brainDir, convParallel, "implementation_plan.md"), "# Plan\n");
    writeText(path.join(brainDir, convParallel, "walkthrough.md"), "# Walkthrough\n");
    writeText(path.join(brainDir, convParallel, "pr-review.md"), "# PR Review\n");
    writeTranscript(brainDir, convParallel, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T10:00:00Z",
        content: "<USER_REQUEST>/plan build parallel rail</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T10:00:10Z",
        tool_calls: [{ name: "write_file", args: { Path: path.join(brainDir, convParallel, "implementation_plan.md") } }],
      },
      {
        step_index: 2,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T10:01:00Z",
        content: "Proceed",
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T10:02:00Z",
        tool_calls: [
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "rail.js") } },
          { name: "invoke_subagent", args: { TypeName: "astack-agent", Role: "Builder", Prompt: "Build UI" } },
          { name: "invoke_subagent", args: { TypeName: "browser", Role: "Verifier", Prompt: "Verify UI" } },
          { name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "Reviewer", Prompt: "Review diff" } },
        ],
      },
    ]);
    const parallelSnap = evaluateTimelineSnapshot({ conversationId: convParallel, brainDir, workspaceDir });
    assert.deepEqual(
      parallelSnap.stages.map((s) => s.railState),
      ["done", "running", "running", "suggested"],
    );
    assert.deepEqual(parallelSnap.activity.liveStageIds, ["build", "review"]);
    assert.equal(parallelSnap.activity.liveAgentsByStage.build, 2);
    assert.equal(parallelSnap.activity.liveAgentsByStage.review, 1);
    assert.equal(parallelSnap.activity.suggestedStageId, "ship");

    const convSkipped = "conv-rail-skipped";
    writeTranscript(brainDir, convSkipped, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T11:00:00Z",
        content: "<USER_REQUEST>/astack-mode ship directly</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T11:00:10Z",
        tool_calls: [
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "ship.js") } },
          { name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } },
          { name: "invoke_subagent", args: { TypeName: "astack-agent", Role: "Shipper", Prompt: "Open the PR on GitHub" } },
        ],
      },
    ]);
    writeReceipt(brainDir, convSkipped, [
      {
        schemaVersion: 1,
        ts: "2026-11-24T11:00:05Z",
        conversationId: convSkipped,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit_file src/ship.js",
        paths: ["src/ship.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-24T11:00:20Z",
        conversationId: convSkipped,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);
    const skippedSnap = evaluateTimelineSnapshot({ conversationId: convSkipped, brainDir, workspaceDir });
    assert.deepEqual(
      skippedSnap.stages.map((s) => s.railState),
      ["skipped", "done", "skipped", "running"],
    );
    assert.deepEqual(skippedSnap.activity.liveStageIds, ["ship"]);
    assert.equal(skippedSnap.activity.liveAgentsByStage.ship, 1);
    assert.equal(skippedSnap.activity.suggestedStageId, null);

    const convWaiting = "conv-rail-waiting";
    writeText(path.join(brainDir, convWaiting, "implementation_plan.md"), "# Plan\n");
    writeTranscript(brainDir, convWaiting, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T12:00:00Z",
        content: "<USER_REQUEST>/plan /astack-mode design queued build</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T12:00:10Z",
        tool_calls: [{ name: "write_file", args: { Path: path.join(brainDir, convWaiting, "implementation_plan.md") } }],
      },
    ]);
    const waitingSnap = evaluateTimelineSnapshot({ conversationId: convWaiting, brainDir, workspaceDir });
    assert.deepEqual(
      waitingSnap.stages.map((s) => s.railState),
      ["yourturn", "queued", "pending", "pending"],
    );
    assert.deepEqual(waitingSnap.activity.liveStageIds, []);
    assert.equal(waitingSnap.activity.suggestedStageId, "plan");

    const convDoneJob = "conv-rail-done-job";
    writeText(path.join(brainDir, convDoneJob, "walkthrough.md"), "# Walkthrough\n");
    writeText(path.join(brainDir, convDoneJob, "pr-review.md"), "# PR Review\n");
    writeText(
      path.join(brainDir, convDoneJob, "astack-trust", "evidence.json"),
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
    writeTranscript(brainDir, convDoneJob, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T13:00:00Z",
        content: "<USER_REQUEST>/astack-mode build and watch PR</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T13:01:00Z",
        tool_calls: [
          { name: "invoke_subagent", args: { TypeName: "research", Role: "Planner", Prompt: "Scan repo" } },
          { name: "invoke_subagent", args: { TypeName: "astack-agent", Role: "Builder", Prompt: "Implement" } },
          { name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "Reviewer", Prompt: "Verify" } },
          { name: "run_command", args: { CommandLine: "gh pr create --fill" } },
          { name: "run_command", args: { CommandLine: "node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --pr 42", toolSummary: "Watch PR #42" } },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        created_at: "2026-11-24T13:01:05Z",
        content: `Tool is running as a background task with task id: ${convDoneJob}/task-7\nhttps://github.com/acme/demo/pull/42`,
      },
      {
        step_index: 3,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-24T13:02:00Z",
        content: "All your subagents and background tasks have been stopped due to user check.",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T13:03:00Z",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --pr 42", toolSummary: "Watch PR #42 live" } },
        ],
      },
      {
        step_index: 5,
        type: "GENERIC",
        created_at: "2026-11-24T13:03:02Z",
        content: `Tool is running as a background task with task id: ${convDoneJob}/task-8`,
      },
    ]);
    writeReceipt(brainDir, convDoneJob, [
      {
        schemaVersion: 1,
        ts: "2026-11-24T13:01:10Z",
        conversationId: convDoneJob,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit_file src/ui.js",
        paths: ["src/ui.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-24T13:01:20Z",
        conversationId: convDoneJob,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);
    const doneJobSnap = evaluateTimelineSnapshot({ conversationId: convDoneJob, brainDir, workspaceDir });
    assert.deepEqual(
      doneJobSnap.stages.map((s) => s.railState),
      ["skipped", "done", "done", "done"],
    );
    assert.deepEqual(doneJobSnap.activity.liveStageIds, []);
    assert.equal(doneJobSnap.activity.suggestedStageId, null);
    assert.equal(doneJobSnap.stages[3].stats.tasks.running, 1);

    const sum = (fn) => doneJobSnap.stages.reduce((acc, s) => acc + fn(s.stats), 0);
    assert.equal(sum((st) => st.agents.total), doneJobSnap.activity.agentsTotalCount);
    assert.equal(sum((st) => st.agents.running), doneJobSnap.activity.agentsWorkingCount);
    assert.equal(sum((st) => st.prs.open), doneJobSnap.activity.prs.openCount);
    assert.equal(sum((st) => st.prs.merged), doneJobSnap.activity.prs.mergedCount);
    assert.equal(sum((st) => st.prs.closed), doneJobSnap.activity.prs.closedCount);
    assert.equal(sum((st) => st.artifacts.total), doneJobSnap.activity.artifactCount);
    assert.equal(sum((st) => st.tasks.total), doneJobSnap.activity.tasksTotalCount);
    assert.equal(sum((st) => st.tasks.running), doneJobSnap.activity.runningTasksCount);

    assert.match(parallelSnap.stages[1].collapsedSummary, /2 subagents$/);
    assert.match(parallelSnap.stages[2].collapsedSummary, /1 subagent$/);

    const convErrStale = "conv-rail-err-stale";
    writeText(path.join(brainDir, convErrStale, "pr-review.md"), "# PR Review\n");
    writeText(
      path.join(brainDir, convErrStale, "astack-trust", "evidence.json"),
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
    writeTranscript(brainDir, convErrStale, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T14:00:00Z",
        content: "<USER_REQUEST>/astack-mode fix widget</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-24T14:00:10Z",
        tool_calls: [
          { name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } },
          { name: "swarm", args: { action: "add", name: "worker", brief: "Edit widget" } },
          { name: "invoke_subagent", args: { TypeName: "astack-agent", Role: "Tester", Prompt: "Check before we ship" } },
          { name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "Verifier", Prompt: "Audit PR" } },
          { name: "run_workflow", args: { Description: "Review changed files" } },
        ],
      },
    ]);
    writeReceipt(brainDir, convErrStale, [
      {
        schemaVersion: 1,
        ts: "2026-11-24T14:00:20Z",
        conversationId: convErrStale,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-24T14:00:30Z",
        conversationId: convErrStale,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit_file src/widget.js",
        paths: ["src/widget.js"],
      },
    ]);
    const errStaleSnap = evaluateTimelineSnapshot({ conversationId: convErrStale, brainDir, workspaceDir });
    assert.equal(errStaleSnap.stages[1].railState, "running");
    assert.equal(errStaleSnap.stages[2].railState, "error", "Escalated error must not be masked by active review subagent/workflow");
    assert.ok(errStaleSnap.activity.liveStageIds.includes("build"));
    assert.ok(errStaleSnap.activity.liveStageIds.includes("review"));
    assert.equal(errStaleSnap.activity.liveAgentsByStage.build, 2, "Swarm worker + build subagent mentioning 'ship' must stay on build");
    assert.equal(errStaleSnap.activity.liveAgentsByStage.ship, 0);

    const convStaleOnly = "conv-rail-stale-only";
    writeTranscript(brainDir, convStaleOnly, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-24T15:00:00Z",
        content: "<USER_REQUEST>/astack-mode update</USER_REQUEST>",
      },
    ]);
    writeReceipt(brainDir, convStaleOnly, [
      {
        schemaVersion: 1,
        ts: "2026-11-24T15:00:05Z",
        conversationId: convStaleOnly,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit_file src/a.js",
        paths: ["src/a.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-24T15:00:10Z",
        conversationId: convStaleOnly,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-24T15:00:20Z",
        conversationId: convStaleOnly,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit_file src/a.js",
        paths: ["src/a.js"],
      },
    ]);
    const staleOnlySnap = evaluateTimelineSnapshot({ conversationId: convStaleOnly, brainDir, workspaceDir });
    assert.equal(staleOnlySnap.stages[1].railState, "stale");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clears failed subagent retries, TimerCondition schedules, manage_task(list), merged watch-pr timers, and stale /run-workflow suggestion", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-ghosts-");
  const convId = "conv-ghosts";
  const retryChildId = "99999999-8888-4777-8666-555555555555";
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);
    writeText(path.join(brainDir, convId, "pr-review.md"), "# PR Review\n");
    writeText(
      path.join(brainDir, convId, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        freshness: "fresh",
        riskTier: 3,
        riskLabel: "critical",
        reviewRound: 2,
        maxReviewRounds: 3,
        roundState: "verified",
        verifier: { verdict: "PASS" },
      }),
    );
    writeTranscript(brainDir, retryChildId, [
      { step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T02:52:24Z", content: "PASS" },
    ]);
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-25T02:40:00Z",
        content: "<USER_REQUEST>/astack-mode ship feature</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:41:00Z",
        tool_calls: [
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "a.ts") } },
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "b.ts") } },
          { name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } },
        ],
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:41:03Z",
        tool_calls: [
          { name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "Verifier Round 2", Prompt: "Verify" } },
        ],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-25T02:41:05Z",
        content: "Encountered error in step execution: failed to resolve workspace URIs for subagent",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:41:10Z",
        tool_calls: [{ name: "invoke_subagent", args: { TypeName: "pr-verifier", Role: "Verifier", Prompt: "Verify" } }],
      },
      {
        step_index: 5,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T02:41:12Z",
        content: `Created the following subagent:\n{"conversationId":"${retryChildId}"}`,
      },
      {
        step_index: 6,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-25T02:42:00Z",
        content: `[Message] sender=${retryChildId} content=PASS`,
      },
      {
        step_index: 7,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:43:00Z",
        tool_calls: [
          { name: "run_command", args: { CommandLine: "gh pr create --title \"feat: demo\" --body \"ok\"" } },
          { name: "run_command", args: { CommandLine: "node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --pr 61", toolSummary: "Watch PR #61" } },
        ],
      },
      {
        step_index: 8,
        type: "GENERIC",
        created_at: "2026-11-25T02:43:01Z",
        content: "https://github.com/acme/demo/pull/61\n",
      },
      {
        step_index: 9,
        type: "GENERIC",
        created_at: "2026-11-25T02:43:02Z",
        content: `Tool is running as a background task with task id: ${convId}/task-10`,
      },
      {
        step_index: 10,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:44:00Z",
        tool_calls: [
          {
            name: "schedule",
            args: {
              DurationSeconds: 300,
              Prompt: "Check watch-pr.mjs status on PR #61 if still running.",
              TimerCondition: `${convId}/task-10`,
            },
          },
        ],
      },
      {
        step_index: 11,
        type: "GENERIC",
        created_at: "2026-11-25T02:44:01Z",
        content: `Tool is running as a background task with task id: ${convId}/task-11`,
      },
      {
        step_index: 12,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-25T02:45:00Z",
        content: `[Message] sender=${convId}/task-10 content=Task id "${convId}/task-10" finished with result:\nCommand exited with code 0.`,
      },
      {
        step_index: 13,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:45:05Z",
        tool_calls: [{ name: "manage_task", args: { Action: "list" } }],
      },
      {
        step_index: 14,
        type: "GENERIC",
        created_at: "2026-11-25T02:45:06Z",
        content: "No background tasks are currently running.",
      },
      {
        step_index: 15,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:46:00Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "gh pr merge 61 --squash" } }],
      },
    ]);
    writeReceipt(brainDir, convId, [
      { schemaVersion: 1, ts: "2026-11-25T02:41:01Z", conversationId: convId, kind: "file_write", category: "ui", headSha, ok: true, summary: "edit", paths: ["src/a.ts", "src/b.ts"] },
      { schemaVersion: 1, ts: "2026-11-25T02:41:30Z", conversationId: convId, kind: "command", category: "test", headSha, ok: true, summary: "node --test", paths: [] },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.deepEqual(snap.stages.map((s) => s.railState), ["skipped", "done", "done", "done"]);
    assert.deepEqual(snap.activity.liveStageIds, []);
    assert.equal(snap.activity.runningSubagentsCount, 0);
    assert.equal(snap.activity.runningTasksCount, 0);
    assert.equal(snap.activity.scheduledCount, 0);
    assert.equal(snap.activity.subagents[0].status, "failed");
    assert.equal(snap.activity.subagents[1].status, "done");
    assert.equal(snap.activity.workflow.suggestedReview, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildRiskPresentation separates human governance gates, defect blocks, low risk, and merged PR resolution", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-riskpres-");
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);

    const makeCase = (convId, { riskAssessment, merged = false }) => {
      writeText(path.join(brainDir, convId, "pr-review.md"), "# PR Review\n");
      writeText(
        path.join(brainDir, convId, "astack-trust", "evidence.json"),
        JSON.stringify({
          schemaVersion: 1,
          headSha,
          freshness: "fresh",
          riskTier: riskAssessment.tier,
          riskLabel: riskAssessment.tier === 3 ? "critical" : "low",
          reviewRound: 1,
          maxReviewRounds: 3,
          roundState: "verified",
          verifier: { verdict: "PASS" },
          riskAssessment,
        }),
      );
      if (merged) {
        writeTranscript(brainDir, convId, [
          {
            step_index: 0,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-25T02:50:00Z",
            tool_calls: [{ name: "run_command", args: { CommandLine: "gh pr create --title \"x\" --body \"y\"" } }],
          },
          {
            step_index: 1,
            type: "GENERIC",
            created_at: "2026-11-25T02:50:02Z",
            content: "https://github.com/acme/demo/pull/61\n",
          },
          {
            step_index: 2,
            type: "PLANNER_RESPONSE",
            created_at: "2026-11-25T02:51:00Z",
            tool_calls: [{ name: "run_command", args: { CommandLine: "gh pr merge 61 --squash" } }],
          },
        ]);
      }
      return evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    };

    const govGate = makeCase("conv-gov-gate", {
      riskAssessment: {
        tier: 3,
        score: 0.5748,
        residual: "blocked",
        signals: [{ id: "touches_governance", weight: 0.55, evidence: ".agents/skills/verify-app/features/auth.md" }],
        satisfied: [{ id: "targeted_tests" }],
        rollback: { kind: "revert", plan: "git revert 0123456" },
      },
    });
    assert.equal(govGate.trust.riskPresentation?.mode, "human_gate");
    assert.equal(govGate.trust.riskPresentation?.tone, "warn");
    assert.equal(govGate.trust.riskPresentation?.scorePct, 57);
    assert.equal(govGate.trust.riskPresentation?.headerBadge, "Review gate · Risk 57%");
    assert.match(govGate.trust.riskPresentation?.headline ?? "", /Human review required · Risk 57%/);
    assert.match(govGate.trust.riskPresentation?.nextHint ?? "", /PR dossier is ready/i);
    assert.equal(govGate.trust.riskPresentation?.whyItems[0]?.evidence, ".agents/skills/verify-app/features/auth.md");
    assert.equal(govGate.trust.riskPresentation?.rollbackCommand, "git revert 0123456");

    const defectGate = makeCase("conv-defect", {
      riskAssessment: {
        tier: 3,
        score: 0.65,
        residual: "blocked",
        signals: [{ id: "test_regression", weight: 0.65, evidence: "node --test failed" }],
        satisfied: [],
        rollback: { kind: "revert", plan: "git revert 0123456" },
      },
    });
    assert.equal(defectGate.trust.riskPresentation?.mode, "defect_blocked");
    assert.equal(defectGate.trust.riskPresentation?.tone, "err");
    assert.match(defectGate.trust.riskPresentation?.headline ?? "", /Action needed · Risk 65%/);

    const mergedGate = makeCase("conv-merged", {
      merged: true,
      riskAssessment: {
        tier: 3,
        score: 0.5748,
        residual: "blocked",
        signals: [{ id: "touches_governance", weight: 0.55, evidence: ".agents/skills/verify-app/features/auth.md" }],
        satisfied: [{ id: "targeted_tests" }],
        rollback: { kind: "revert", plan: "git revert 0123456" },
      },
    });
    assert.equal(mergedGate.trust.riskPresentation?.mode, "resolved_merged");
    assert.equal(mergedGate.trust.riskPresentation?.tone, "done");
    assert.equal(mergedGate.trust.riskPresentation?.headerBadge, "Merged · Risk 57%");
    assert.equal(mergedGate.trust.riskPresentation?.headline, "Reviewed & merged (PR #61)");

    const lowGate = makeCase("conv-low", {
      riskAssessment: {
        tier: 0,
        score: 0.05,
        residual: "low",
        signals: [],
        satisfied: [],
        rollback: { kind: "revert", plan: "git revert 0123456" },
      },
    });
    assert.equal(lowGate.trust.riskPresentation?.mode, "low_ok");
    assert.equal(lowGate.trust.riskPresentation?.tone, "neutral");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores manage_subagents(list) echoes, catches non-'subagent' spawn errors, and suppresses stage markers for unretried failed spawns", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-sa-edges-");
  const convId = "conv-sa-edges";
  const retryChildId = "44444444-4444-4444-8444-444444444444";
  const secondChildId = "55555555-5555-4555-8555-555555555555";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(brainDir, convId, "pr-review.md"), "# PR Review\nPASS\n");
    writeText(
      path.join(brainDir, convId, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        freshness: "fresh",
        riskTier: 1,
        riskLabel: "medium",
        reviewRound: 1,
        maxReviewRounds: 3,
        roundState: "verified",
        verifier: { verdict: "PASS" },
      }),
    );
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-25T02:49:00Z",
        content: "<USER_REQUEST>/pre-pr</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:50:31Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              TypeName: "pr-verifier",
              Role: "Independent PR Verifier (Round 2)",
              Prompt: "Verify branch diff",
            },
          },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-25T02:50:40Z",
        content: "Encountered error in step execution: failed to create git worktree: Filename too long",
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:50:43Z",
        tool_calls: [
          {
            name: "invoke_subagent",
            args: {
              TypeName: "pr-verifier",
              Role: "Verifier",
              Prompt: "Verify branch diff",
            },
          },
        ],
      },
      {
        step_index: 4,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T02:50:54Z",
        content: JSON.stringify({ conversationId: retryChildId }),
      },
      {
        step_index: 5,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:51:00Z",
        tool_calls: [
          { name: "manage_subagents", args: { Action: "list" } },
          {
            name: "invoke_subagent",
            args: {
              TypeName: "self",
              Role: "Follow-up Helper",
              Prompt: "Check docs",
            },
          },
        ],
      },
      {
        step_index: 6,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T02:51:01Z",
        content: `You have 1 active subagent(s):\n${JSON.stringify([{ conversationId: retryChildId, role: "Verifier", type: "pr-verifier" }])}`,
      },
      {
        step_index: 7,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T02:51:02Z",
        content: JSON.stringify({ conversationId: secondChildId }),
      },
      {
        step_index: 8,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-25T02:52:25Z",
        content: `[Message] sender=${retryChildId} content=PASS`,
      },
      {
        step_index: 9,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-25T02:52:26Z",
        content: `[Message] sender=${secondChildId} content=DONE`,
      },
      {
        step_index: 10,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:53:00Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "gh pr create --title \"fix: callback\" --body \"ok\"" } }],
      },
      {
        step_index: 11,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T02:53:05Z",
        content: "https://github.com/org/repo/pull/62",
      },
    ]);

    const snap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(snap.activity.totalSubagentsCount, 3);
    assert.equal(snap.activity.doneSubagentsCount, 2);
    assert.equal(snap.activity.runningSubagentsCount, 0);
    assert.equal(snap.activity.subagents[0].status, "failed");
    assert.equal(snap.activity.subagents[1].status, "done");
    assert.equal(snap.activity.subagents[1].childConvId, retryChildId);
    assert.equal(snap.activity.subagents[2].status, "done");
    assert.equal(snap.activity.subagents[2].childConvId, secondChildId);
    assert.deepEqual(snap.activity.liveStageIds, []);
    const reviewStage = snap.stages.find((s) => s.id === "review");
    assert.equal(reviewStage?.status, "done");
    assert.equal(reviewStage?.railState, "done");

    const convUnretried = "conv-failed-browser";
    writeTranscript(brainDir, convUnretried, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T03:00:00Z",
        tool_calls: [{ name: "write_file", args: { Path: path.join(workspaceDir, "src", "app.js") } }],
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T03:00:05Z",
        tool_calls: [{ name: "invoke_subagent", args: { TypeName: "browser", Role: "UI Verifier", Prompt: "Verify UI" } }],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-25T03:00:06Z",
        content: "Encountered error in step execution: failed to start browser",
      },
    ]);
    const unretriedSnap = evaluateTimelineSnapshot({ conversationId: convUnretried, brainDir, workspaceDir });
    const buildStage = unretriedSnap.stages.find((s) => s.id === "build");
    const verifyCheck = buildStage?.subChecks?.find((c) => c.id === "verify");
    assert.equal(unretriedSnap.activity.subagents.length, 1);
    assert.equal(unretriedSnap.activity.subagents[0].status, "failed");
    assert.equal(unretriedSnap.activity.runningSubagentsCount, 0);
    assert.equal(unretriedSnap.activity.doneSubagentsCount, 0);
    assert.notEqual(verifyCheck?.status, "done");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deactivates failed schedule calls, ignores TimerCondition 'never', and ignores error outputs on manage_task(list)", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-sch-edges-");
  const convId = "conv-sch-edges";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:53:00Z",
        tool_calls: [
          {
            name: "schedule",
            args: {
              DurationSeconds: 60,
              Prompt: "First schedule that fails",
            },
          },
        ],
      },
      {
        step_index: 1,
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-25T02:53:01Z",
        content: "Encountered error in step execution: invalid schedule parameter",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:54:00Z",
        tool_calls: [
          {
            name: "schedule",
            args: {
              DurationSeconds: 300,
              TimerCondition: "never",
              Prompt: "Check CI status",
            },
          },
        ],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-25T02:54:01Z",
        content: `Tool is running as a background task with task id: ${convId}/task-2`,
      },
      {
        step_index: 4,
        type: "SYSTEM_MESSAGE",
        created_at: "2026-11-25T02:55:00Z",
        content: `[Message] sender=${convId}/task-other content=Task id "${convId}/task-other" finished with result:\nCommand exited with code 0.`,
      },
      {
        step_index: 5,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:55:10Z",
        tool_calls: [{ name: "manage_task", args: { Action: "list" } }],
      },
      {
        step_index: 6,
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-25T02:55:11Z",
        content: "Encountered error in step execution: No background tasks are currently running.",
      },
    ]);

    const midSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(midSnap.activity.schedules[0]?.active, false);
    assert.equal(midSnap.activity.schedules[1]?.taskId, `${convId}/task-2`);
    assert.equal(midSnap.activity.schedules[1]?.active, true);
    assert.equal(midSnap.activity.runningTasksCount, 1);

    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:53:00Z",
        tool_calls: [{ name: "schedule", args: { DurationSeconds: 60, Prompt: "First schedule that fails" } }],
      },
      {
        step_index: 1,
        type: "GENERIC",
        status: "ERROR",
        created_at: "2026-11-25T02:53:01Z",
        content: "Encountered error in step execution: invalid schedule parameter",
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:54:00Z",
        tool_calls: [{ name: "schedule", args: { DurationSeconds: 300, TimerCondition: "never", Prompt: "Check CI status" } }],
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-25T02:54:01Z",
        content: `Tool is running as a background task with task id: ${convId}/task-2`,
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-25T02:56:00Z",
        tool_calls: [{ name: "manage_task", args: { Action: "list" } }],
      },
      {
        step_index: 5,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-25T02:56:01Z",
        content: "No background tasks are currently running.",
      },
    ]);

    const afterListSnap = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(afterListSnap.activity.schedules[1]?.active, false);
    assert.equal(afterListSnap.activity.runningTasksCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateTimelineSnapshot invalidates cached workspace scope and policy on immediate risk-policy or main commit mutations", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-policy-cache-");
  const convId = "conv-policy-cache";
  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: workspaceDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: workspaceDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: workspaceDir, stdio: "ignore" });
    writeText(path.join(workspaceDir, "README.md"), "# Init\n");
    execFileSync("git", ["add", "."], { cwd: workspaceDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: workspaceDir, stdio: "ignore" });

    const beforeEnroll = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(beforeEnroll.trust.scopeKind, "git_unregistered");
    assert.equal(beforeEnroll.trust.enrolled, false);

    writeText(
      path.join(workspaceDir, ".agents", "risk-policy.json"),
      JSON.stringify({ schemaVersion: 1, autonomy: { defaultCeiling: 2, ceilings: { ui: 1 } } }, null, 2),
    );
    execFileSync("git", ["add", "."], { cwd: workspaceDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "enroll"], { cwd: workspaceDir, stdio: "ignore" });

    const afterEnroll = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(afterEnroll.trust.scopeKind, "enrolled_repo");
    assert.equal(afterEnroll.trust.enrolled, true);
    assert.equal(afterEnroll.trust.activeCatState?.ceiling, 1);

    writeText(
      path.join(workspaceDir, ".agents", "risk-policy.json"),
      JSON.stringify({ schemaVersion: 1, autonomy: { defaultCeiling: 2, ceilings: { ui: 2 } } }, null, 2),
    );
    execFileSync("git", ["add", "."], { cwd: workspaceDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "raise ceiling"], { cwd: workspaceDir, stdio: "ignore" });

    const afterPolicyBump = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(afterPolicyBump.trust.activeCatState?.ceiling, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main-agent active turns light up running blue flame across stages and hold compound open-PR prompts queued until Build & Review finish", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-main-turn-");
  try {
    const headSha = "0123456789abcdef0123456789abcdef01234567";
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);

    const convPlan = "conv-main-plan";
    writeTranscript(brainDir, convPlan, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:00:00Z",
        content: "<USER_REQUEST>/plan design running rail</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:00:02Z",
        tool_calls: [{ name: "read_file", args: { Path: path.join(workspaceDir, "README.md") } }],
      },
    ]);
    const planNow = Date.parse("2026-11-26T03:00:05Z");
    const planSnap = evaluateTimelineSnapshot({ conversationId: convPlan, brainDir, workspaceDir, nowMs: planNow });
    assert.equal(planSnap.stages[0].railState, "running");
    assert.deepEqual(planSnap.activity.liveStageIds, ["plan"]);

    const convCompound = "conv-main-compound";
    writeTranscript(brainDir, convCompound, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:03:40Z",
        content: "<USER_REQUEST>/astack-mode Okay, proceeds. Open a PR.</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:03:45Z",
        tool_calls: [{ name: "edit_file", args: { Path: path.join(workspaceDir, "src", "app.js") } }],
      },
    ]);
    const compoundNow = Date.parse("2026-11-26T03:03:50Z");
    const compoundSnap = evaluateTimelineSnapshot({ conversationId: convCompound, brainDir, workspaceDir, nowMs: compoundNow });
    assert.equal(compoundSnap.stages[1].railState, "running");
    assert.equal(compoundSnap.stages[2].status, "pending", "Compound open-PR prompt must not prematurely skip Pre-PR Check while Build is active");
    assert.equal(compoundSnap.stages[3].railState, "queued", "Ship should be queued behind Build & Review");
    assert.equal(compoundSnap.nextAction?.stageId, "build");
    assert.deepEqual(compoundSnap.activity.liveStageIds, ["build"]);
    assert.equal(compoundSnap.activity.liveAgentsByStage.build, 0, "Main-agent turn must not add fake subagent count");

    const convReview = "conv-main-review";
    writeTranscript(brainDir, convReview, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:04:00Z",
        content: "<USER_REQUEST>/pre-pr check branch</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:04:05Z",
        tool_calls: [{ name: "edit_file", args: { Path: path.join(workspaceDir, "src", "app.js") } }],
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:04:10Z",
        tool_calls: [{ name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } }],
      },
      {
        step_index: 3,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:04:20Z",
        content: "<USER_REQUEST>/astack-mode Open a PR after review</USER_REQUEST>",
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:04:22Z",
        tool_calls: [{ name: "call_mcp_tool", args: { ServerName: "astack_trust", ToolName: "compile_pr_dossier" } }],
      },
    ]);
    writeReceipt(brainDir, convReview, [
      { schemaVersion: 1, ts: "2026-11-26T03:04:06Z", conversationId: convReview, kind: "file_write", category: "ui", headSha, ok: true, summary: "edit", paths: ["src/app.js"] },
      { schemaVersion: 1, ts: "2026-11-26T03:04:12Z", conversationId: convReview, kind: "command", category: "test", headSha, ok: true, summary: "node --test", paths: [] },
    ]);
    const reviewNow = Date.parse("2026-11-26T03:04:25Z");
    const reviewSnap = evaluateTimelineSnapshot({ conversationId: convReview, brainDir, workspaceDir, nowMs: reviewNow });
    assert.equal(reviewSnap.stages[1].status, "done");
    assert.equal(reviewSnap.stages[2].railState, "running");
    assert.equal(reviewSnap.stages[2].collapsedSummary, "Compiling PR dossier and verifying HEAD.");
    assert.equal(reviewSnap.stages[3].railState, "queued");
    assert.deepEqual(reviewSnap.activity.liveStageIds, ["review"]);

    const convShip = "conv-main-ship";
    writeText(path.join(brainDir, convShip, "pr-review.md"), "# PR Review\n");
    writeText(
      path.join(brainDir, convShip, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        freshness: "fresh",
        riskTier: 1,
        riskLabel: "low",
        reviewRound: 1,
        maxReviewRounds: 3,
        roundState: "verified",
        autoMergeEligible: true,
        verifier: { verdict: "PASS" },
      }),
    );
    writeTranscript(brainDir, convShip, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:05:00Z",
        content: "<USER_REQUEST>/astack-mode open the pr</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:05:05Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "git status -sb" } }],
      },
    ]);
    const shipNow = Date.parse("2026-11-26T03:05:10Z");
    const shipSnap = evaluateTimelineSnapshot({ conversationId: convShip, brainDir, workspaceDir, nowMs: shipNow });
    assert.equal(shipSnap.stages[2].status, "done");
    assert.equal(shipSnap.stages[3].railState, "running");
    assert.deepEqual(shipSnap.activity.liveStageIds, ["ship"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main-turn running indicator clears immediately on completion, ask_question, errors, stops, and stale transcripts", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-main-clear-");
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");

    const convDone = "conv-clear-done";
    writeTranscript(brainDir, convDone, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:10:00Z",
        content: "<USER_REQUEST>/astack-mode update widget</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:10:05Z",
        tool_calls: [{ name: "edit_file", args: { Path: path.join(workspaceDir, "src", "widget.js") } }],
      },
      {
        step_index: 2,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:10:10Z",
        content: "Updated src/widget.js.",
      },
    ]);
    const doneSnap = evaluateTimelineSnapshot({
      conversationId: convDone,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-26T03:10:11Z"),
    });
    assert.notEqual(doneSnap.stages[1].railState, "running");
    assert.equal(doneSnap.stages[1].railState, "queued");
    assert.deepEqual(doneSnap.activity.liveStageIds, []);

    const convAsk = "conv-clear-ask";
    writeTranscript(brainDir, convAsk, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:11:00Z",
        content: "<USER_REQUEST>/plan clarify options</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:11:05Z",
        tool_calls: [{ name: "ask_question", args: { questions: [] } }],
      },
    ]);
    const askSnap = evaluateTimelineSnapshot({
      conversationId: convAsk,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-26T03:11:06Z"),
    });
    assert.notEqual(askSnap.stages[0].railState, "running");
    assert.deepEqual(askSnap.activity.liveStageIds, []);

    const convErr = "conv-clear-err";
    writeTranscript(brainDir, convErr, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:12:00Z",
        content: "<USER_REQUEST>/astack-mode fix bug</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "ERROR_MESSAGE",
        status: "DONE",
        created_at: "2026-11-26T03:12:03Z",
        content: "Error: The stream was interrupted.",
      },
    ]);
    const errSnap = evaluateTimelineSnapshot({
      conversationId: convErr,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-26T03:12:04Z"),
    });
    assert.notEqual(errSnap.stages[1].railState, "running");
    assert.deepEqual(errSnap.activity.liveStageIds, []);

    const convStopped = "conv-clear-stopped";
    writeTranscript(brainDir, convStopped, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:13:00Z",
        content: "<USER_REQUEST>/astack-mode fix bug</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-26T03:13:03Z",
        content: "All your subagents and background tasks have been stopped.",
      },
    ]);
    const stoppedSnap = evaluateTimelineSnapshot({
      conversationId: convStopped,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-26T03:13:04Z"),
    });
    assert.notEqual(stoppedSnap.stages[1].railState, "running");
    assert.deepEqual(stoppedSnap.activity.liveStageIds, []);

    const convStale = "conv-clear-stale";
    writeTranscript(brainDir, convStale, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:00:00Z",
        content: "<USER_REQUEST>/astack-mode abandoned turn</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:00:05Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test" } }],
      },
    ]);
    const staleSnap = evaluateTimelineSnapshot({
      conversationId: convStale,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-26T03:06:06Z"),
    });
    assert.notEqual(staleSnap.stages[1].railState, "running");
    assert.deepEqual(staleSnap.activity.liveStageIds, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("running background command keeps an active build stage running while waiting for wakeup", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-bg-cmd-");
  const convId = "conv-bg-cmd-running";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T03:20:00Z",
        content: "<USER_REQUEST>/astack-mode run test suite</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:20:02Z",
        tool_calls: [
          { name: "edit_file", args: { Path: path.join(workspaceDir, "src", "main.js") } },
          { name: "run_command", args: { CommandLine: "node --run test", toolSummary: "Run test suite" } },
        ],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T03:20:03Z",
        content: "Edited src/main.js",
      },
      {
        step_index: 3,
        type: "GENERIC",
        status: "RUNNING",
        created_at: "2026-11-26T03:20:04Z",
        content: `Tool is running as a background task with task id: ${convId}/task-1\nTask Description: node --run test`,
      },
      {
        step_index: 4,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T03:20:05Z",
        content: "Waiting for background test run to finish.",
      },
    ]);

    const snap = evaluateTimelineSnapshot({
      conversationId: convId,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-26T03:20:30Z"),
    });
    assert.equal(snap.stages[1].status, "active");
    assert.equal(snap.stages[1].railState, "running");
    assert.deepEqual(snap.activity.liveStageIds, ["build"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detects colleague PR review intents (single, queue, stack) and keeps Build mode when workspace edits or /pre-pr exist", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-colleague-");
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");

    const convSingle = "conv-colleague-single";
    writeTranscript(brainDir, convSingle, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T04:00:00Z",
        content: "<USER_REQUEST>/interrogate https://github.com/acme/demo/pull/301 skeptically</USER_REQUEST>",
      },
    ]);
    const singleSnap = evaluateTimelineSnapshot({ conversationId: convSingle, brainDir, workspaceDir });
    assert.equal(singleSnap.panelDefaultMode, "review_pr");
    assert.equal(singleSnap.colleagueReview.detected, true);
    assert.equal(singleSnap.colleagueReview.activeIntent, "single");
    assert.deepEqual(singleSnap.colleagueReview.detectedCommands, ["/interrogate"]);
    assert.equal(singleSnap.colleagueReview.targetPrs[0]?.number, 301);
    assert.equal(singleSnap.colleagueReview.targetPrs[0]?.url, "https://github.com/acme/demo/pull/301");

    const convQueue = "conv-colleague-queue";
    writeTranscript(brainDir, convQueue, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T04:05:00Z",
        content: "<USER_REQUEST>/fanout Review PR #231, #232, and #235 in isolated branch workspaces</USER_REQUEST>",
      },
    ]);
    const queueSnap = evaluateTimelineSnapshot({ conversationId: convQueue, brainDir, workspaceDir });
    assert.equal(queueSnap.panelDefaultMode, "review_pr");
    assert.equal(queueSnap.colleagueReview.activeIntent, "queue");
    assert.ok(queueSnap.colleagueReview.detectedCommands.includes("/fanout"));
    assert.deepEqual(
      queueSnap.colleagueReview.targetPrs.map((p) => p.number),
      [235, 232, 231],
    );

    const convStack = "conv-colleague-stack";
    writeTranscript(brainDir, convStack, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T04:10:00Z",
        content: "<USER_REQUEST>/swarm Review stacked PRs #240, #241, and #242 with @verifier</USER_REQUEST>",
      },
    ]);
    const stackSnap = evaluateTimelineSnapshot({ conversationId: convStack, brainDir, workspaceDir });
    assert.equal(stackSnap.panelDefaultMode, "review_pr");
    assert.equal(stackSnap.colleagueReview.activeIntent, "stack");
    assert.ok(stackSnap.colleagueReview.detectedCommands.includes("/swarm"));

    const convEdited = "conv-colleague-edited";
    writeTranscript(brainDir, convEdited, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T04:15:00Z",
        content: "<USER_REQUEST>/interrogate check branch</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T04:15:10Z",
        tool_calls: [{ name: "edit_file", args: { Path: path.join(workspaceDir, "src", "app.js") } }],
      },
    ]);
    const editedSnap = evaluateTimelineSnapshot({ conversationId: convEdited, brainDir, workspaceDir });
    assert.equal(editedSnap.panelDefaultMode, "build");
    assert.equal(editedSnap.colleagueReview.detected, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateTimelineSnapshot caches transcript parsing without cross-call mutation leaks and refreshes on transcript, task log, or child transcript updates", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-trcache-");
  const convId = "conv-trcache";
  const childConvId = "12121212-3434-4567-8901-232323232323";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeTranscript(brainDir, childConvId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "RUNNING",
        created_at: "2026-11-26T05:00:02Z",
        content: "",
      },
    ]);
    writeTranscript(brainDir, convId, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-26T05:00:00Z",
        content: "<USER_REQUEST>/astack-mode run check</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T05:00:01Z",
        tool_calls: [{ name: "invoke_subagent", args: { TypeName: "research", Role: "Scanner", Prompt: "Scan repo" } }],
      },
      {
        step_index: 2,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T05:00:01Z",
        content: `{"conversationId":"${childConvId}"}`,
      },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T05:00:02Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: "node --test", toolSummary: "Run tests" } }],
      },
      {
        step_index: 4,
        type: "GENERIC",
        status: "DONE",
        created_at: "2026-11-26T05:00:02Z",
        content: `Tool is running as a background task with task id: ${convId}/task-88`,
      },
    ]);

    const first = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(first.activity.runningSubagentsCount, 1);
    assert.equal(first.activity.backgroundJobs.count, 1);
    assert.equal(first.activity.backgroundJobs.items[0].logFile, null);

    first.activity.subagents[0].status = "mutated";
    const second = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(second.activity.subagents[0].status, "running", "Cached transcript clones must isolate caller mutations");
    assert.equal(second.etag, first.etag);

    writeText(path.join(brainDir, convId, ".system_generated", "tasks", "task-88.log"), "ok\n");
    writeText(path.join(brainDir, convId, ".system_generated", "tasks", "task-99.log"), "done\n");
    const withTaskLog = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(withTaskLog.activity.backgroundJobs.count, 2, "Existing task-88 must attach logFile without duplicating");
    assert.equal(withTaskLog.activity.backgroundJobs.items.find((j) => j.taskSlug === "task-88")?.logFile, "task-88.log");

    writeTranscript(brainDir, childConvId, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-26T05:00:10Z",
        content: "Finished scan",
      },
    ]);
    const afterChildDone = evaluateTimelineSnapshot({ conversationId: convId, brainDir, workspaceDir });
    assert.equal(afterChildDone.activity.runningSubagentsCount, 0, "Child transcript completion must update parent snapshot");
    assert.equal(afterChildDone.activity.subagents[0].status, "done");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provides deterministic next-step instructions, dynamic command prompts, and stage-aware Risk % for partial Build & Prove", () => {
  const { root, brainDir, workspaceDir } = makeFixture("astack-tl-guided-");
  const headSha = "084812aad9700881367458a5eccb2072a50b3686";
  try {
    writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
    writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);

    const convPartial = "conv-partial-build";
    const files = [
      "apps/desktop/scripts/release.js",
      "apps/desktop/scripts/windows-build-guard.ps1",
      ".github/workflows/release.yml",
      "apps/desktop/scripts/release-guard.test.js",
      "apps/desktop/src-tauri/Cargo.toml",
    ];
    writeTranscript(brainDir, convPartial, [
      {
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-27T16:00:00Z",
        content: "<USER_REQUEST>Fix GitHub Actions release build</USER_REQUEST>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-27T16:10:00Z",
        content: "Fixed and verified.",
      },
    ]);
    writeReceipt(brainDir, convPartial, [
      {
        schemaVersion: 1,
        ts: "2026-11-27T16:05:00Z",
        conversationId: convPartial,
        kind: "file_write",
        category: "governance",
        headSha,
        ok: true,
        summary: "edit files",
        paths: files,
      },
      {
        schemaVersion: 1,
        ts: "2026-11-27T16:09:00Z",
        conversationId: convPartial,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);
    writeText(
      path.join(brainDir, convPartial, "astack-trust", "evidence.json"),
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        freshness: "fresh",
        riskTier: 3,
        riskLabel: "critical",
        reviewRound: 0,
        maxReviewRounds: 3,
        roundState: "open",
        riskAssessment: {
          tier: 3,
          score: 0.703,
          residual: "blocked",
          signals: [
            { id: "touches_governance", weight: 0.55, evidence: ".github/workflows/release.yml" },
            { id: "dependency_changed", weight: 0.25, evidence: "apps/desktop/src-tauri/Cargo.toml" },
            { id: "new_path", weight: 0.12, evidence: "apps/desktop/scripts/release-guard.test.js, apps/desktop/scripts/windows-build-guard.ps1" },
          ],
          satisfied: [],
          rollback: { kind: "revert", plan: "git revert 084812a" },
        },
      }),
    );

    const partialSnap = evaluateTimelineSnapshot({
      conversationId: convPartial,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-27T16:11:00Z"),
    });
    assert.equal(partialSnap.stages[1].status, "active");
    assert.equal(partialSnap.stages[1].collapsedSummary, "Edits & verify done · Still needed: clean diff (/deslop).");
    assert.match(partialSnap.stages[1].detail, /Still needed: clean the diff/);
    assert.equal(partialSnap.nextAction?.stageId, "build");
    assert.equal(partialSnap.nextAction?.command, "/deslop");
    assert.match(partialSnap.nextAction?.title ?? "", /1 step left.*clean diff/i);
    assert.match(partialSnap.nextAction?.instruction ?? "", /Risk 70% requires human review/i);
    assert.deepEqual(partialSnap.nextAction?.remaining, ["Clean diff"]);
    assert.match(partialSnap.nextAction?.prompt ?? "", /^\/deslop \/no-comments Clean the 5 changed files .*\/pre-pr on HEAD\.$/);
    assert.equal(partialSnap.nextAction?.alternative?.command, "/pre-pr");
    assert.equal(partialSnap.trust.riskPresentation?.headerBadge, "Review gate · Risk 70%");
    assert.equal(partialSnap.trust.riskPresentation?.headline, "Human review required · Risk 70%");
    assert.match(partialSnap.trust.riskPresentation?.nextHint ?? "", /Run \/pre-pr/i);
    assert.doesNotMatch(partialSnap.trust.riskPresentation?.nextHint ?? "", /approve or merge/i);

    const convDocVerify = "conv-doc-verify";
    writeReceipt(brainDir, convDocVerify, [
      {
        schemaVersion: 1,
        ts: "2026-11-27T15:59:00Z",
        conversationId: convDocVerify,
        kind: "file_write",
        category: "docs",
        headSha,
        ok: true,
        summary: "edit README.md",
        paths: ["README.md"],
      },
    ]);
    const docVerifySnap = evaluateTimelineSnapshot({
      conversationId: convDocVerify,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-27T16:10:00Z"),
    });
    assert.equal(docVerifySnap.stages[1].subChecks?.find((c) => c.id === "clean")?.optional, true);
    assert.deepEqual(docVerifySnap.nextAction?.remaining, ["Verify on HEAD"]);
    assert.doesNotMatch(docVerifySnap.nextAction?.prompt ?? "", /\/deslop/);

    const convVerifyLeft = "conv-verify-left";
    writeTranscript(brainDir, convVerifyLeft, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-27T16:00:00Z",
        tool_calls: [{ name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } }],
      },
    ]);
    writeReceipt(brainDir, convVerifyLeft, [
      {
        schemaVersion: 1,
        ts: "2026-11-27T15:59:00Z",
        conversationId: convVerifyLeft,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit src/a.js",
        paths: ["src/a.js"],
      },
    ]);
    const verifyLeftSnap = evaluateTimelineSnapshot({
      conversationId: convVerifyLeft,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-27T16:10:00Z"),
    });
    assert.equal(verifyLeftSnap.stages[1].collapsedSummary, "Edits & clean done · Still needed: verify on HEAD.");
    assert.equal(verifyLeftSnap.nextAction?.command, "/astack-mode");
    assert.match(verifyLeftSnap.nextAction?.title ?? "", /1 step left.*verify on HEAD/i);
    assert.match(verifyLeftSnap.nextAction?.prompt ?? "", /Verify the 1 changed file on HEAD/);

    const convBothLeft = "conv-both-left";
    writeReceipt(brainDir, convBothLeft, [
      {
        schemaVersion: 1,
        ts: "2026-11-27T15:59:00Z",
        conversationId: convBothLeft,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit src/a.js",
        paths: ["src/a.js", "src/b.js"],
      },
    ]);
    const bothLeftSnap = evaluateTimelineSnapshot({
      conversationId: convBothLeft,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-27T16:10:00Z"),
    });
    assert.equal(bothLeftSnap.stages[1].collapsedSummary, "Edits done · Still needed: clean diff & verify.");
    assert.match(bothLeftSnap.nextAction?.title ?? "", /2 steps left.*clean & verify/i);
    assert.match(bothLeftSnap.nextAction?.prompt ?? "", /Clean the 2 changed files with \/deslop and \/no-comments/);

    const convReviewReady = "conv-review-ready";
    writeTranscript(brainDir, convReviewReady, [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-27T16:00:00Z",
        tool_calls: [{ name: "read_file", args: { Path: "/plugin/skills/deslop/SKILL.md" } }],
      },
    ]);
    writeReceipt(brainDir, convReviewReady, [
      {
        schemaVersion: 1,
        ts: "2026-11-27T15:58:00Z",
        conversationId: convReviewReady,
        kind: "file_write",
        category: "ui",
        headSha,
        ok: true,
        summary: "edit files",
        paths: ["src/a.js", "src/b.js", "src/c.js"],
      },
      {
        schemaVersion: 1,
        ts: "2026-11-27T16:01:00Z",
        conversationId: convReviewReady,
        kind: "command",
        category: "test",
        headSha,
        ok: true,
        summary: "node --test",
        paths: [],
      },
    ]);
    const reviewReadySnap = evaluateTimelineSnapshot({
      conversationId: convReviewReady,
      brainDir,
      workspaceDir,
      nowMs: Date.parse("2026-11-27T16:10:00Z"),
    });
    assert.equal(reviewReadySnap.stages[2].status, "next");
    assert.equal(reviewReadySnap.nextAction?.stageId, "review");
    assert.equal(reviewReadySnap.nextAction?.command, "/pre-pr");
    assert.equal(reviewReadySnap.nextAction?.alternative?.command, "/run-workflow");
    assert.match(reviewReadySnap.nextAction?.alternative?.prompt ?? "", /Review the 3 changed files/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
