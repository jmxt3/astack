import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  TOOL_MATCHERS,
  compilePrDossier,
  recordReceipt,
  writeEvidenceSnapshotAtomic,
} from "../trust/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const guardScript = path.resolve(here, "../hooks/irreversible-guard.mjs");
const stopScript = path.resolve(here, "../hooks/verify-reminder.mjs");
const secretScript = path.resolve(here, "../hooks/secret-guard.mjs");
const receiptScript = path.resolve(here, "../hooks/receipt-ledger.mjs");
const sessionScript = path.resolve(here, "../hooks/session-context.mjs");
const prIntentScript = path.resolve(here, "../hooks/pr-intent.mjs");
const evidenceScript = path.resolve(here, "../hooks/evidence-gate.mjs");
const boundaryScript = path.resolve(here, "../hooks/boundary-guard.mjs");
const roundScript = path.resolve(here, "../hooks/round-limiter.mjs");
const hooksJsonPath = path.resolve(here, "../../hooks.json");

function runHook(scriptPath, stdinText, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [scriptPath], {
    input: stdinText,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return JSON.parse(stdout.trim());
}

function makeTempGitRepo(prefix = "astack-hook-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmp, stdio: "ignore" });
  fs.writeFileSync(path.join(tmp, "app.js"), "console.log(1);\n", "utf8");
  execFileSync("git", ["add", "app.js"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: tmp, stdio: "ignore" });
  return tmp;
}

test("hooks.json uses split defaults (3 passive + dirty-only verify-reminder enabled, 6 blocking opt-in) and synced tool matchers", () => {
  const cfg = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
  assert.equal(cfg["astack-receipt-ledger"]?.enabled, true);
  assert.equal(cfg["astack-session-context"]?.enabled, true);
  assert.equal(cfg["astack-pr-intent"]?.enabled, true);
  assert.equal(cfg["astack-verify-reminder"]?.enabled, true);
  assert.ok(Array.isArray(cfg["astack-receipt-ledger"]?.PostToolUse));
  assert.ok(Array.isArray(cfg["astack-session-context"]?.SessionStart));
  assert.ok(Array.isArray(cfg["astack-pr-intent"]?.PreInvocation));
  assert.equal(cfg["astack-receipt-ledger"].PostToolUse[0]?.matcher, TOOL_MATCHERS.receiptLedger);

  for (const key of [
    "astack-irreversible-guard",
    "astack-secret-guard",
    "astack-evidence-gate",
    "astack-boundary-guard",
    "astack-round-limiter",
    "astack-trust-gate",
  ]) {
    assert.equal(cfg[key]?.enabled, false, `${key} must ship disabled`);
  }
  assert.equal(cfg["astack-secret-guard"].PreToolUse[0]?.matcher, TOOL_MATCHERS.secretGuard);
  assert.equal(cfg["astack-evidence-gate"].PreToolUse[0]?.matcher, TOOL_MATCHERS.evidenceGate);
  assert.equal(cfg["astack-trust-gate"].PreToolUse[0]?.matcher, TOOL_MATCHERS.trustGate);
  assert.equal(cfg["astack-boundary-guard"].PreToolUse[0]?.matcher, TOOL_MATCHERS.fileWrite);
  assert.equal(cfg["astack-round-limiter"].PreToolUse[0]?.matcher, TOOL_MATCHERS.fileWrite);
  assert.equal(cfg["astack-verify-reminder"].Stop[0]?.type, "command");
  assert.equal(cfg["astack-verify-reminder"].Stop[0]?.command, "node ./scripts/hooks/verify-reminder.mjs --dirty-only");
});

test("irreversible-guard allows safe commands and flags destructive/trunk commands", () => {
  for (const cmd of [
    "git status",
    'rg "DROP TABLE" scripts/',
    'Select-String -Pattern "DROP DATABASE" scripts/',
    'git log -S "TRUNCATE TABLE"',
    'echo "SELECT 1; DROP TABLE users;"',
    "git push --force-with-lease origin feat/v0.2-native-identity",
    "git push origin main",
    'bash -c "rg \'DROP TABLE\' src/"',
  ]) {
    assert.deepEqual(
      runHook(
        guardScript,
        JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
        { CI: "", NON_INTERACTIVE: "" },
      ),
      { decision: "allow" },
      cmd,
    );
  }
  assert.deepEqual(runHook(guardScript, "{not valid json", { CI: "", NON_INTERACTIVE: "" }), { decision: "allow" });

  for (const cmd of [
    "git push origin main --force",
    "git push origin +main",
    'env -S "git push --force origin main"',
    'env -S"git push --force origin main"',
    'echo \u2018; git push --force origin main',
    'echo $(git push --force origin main)',
    'time git push --force origin main',
    'g\\it push --force origin main',
    'timeout 10 git push --force origin main',
    "git reset --hard HEAD~3",
    "rm -rf /",
    'bash -c "rm -rf /"',
    "Remove-Item -Recurse -Force C:\\",
    "psql -c 'DROP TABLE users;'",
    'echo "DROP DATABASE app;" | psql',
  ]) {
    const interactive = runHook(
      guardScript,
      JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
      { CI: "", NON_INTERACTIVE: "" },
    );
    assert.equal(interactive.decision, "force_ask", cmd);
    const headless = runHook(
      guardScript,
      JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
      { CI: "true" },
    );
    assert.equal(headless.decision, "deny", cmd);
  }
  for (const cmd of [
    `echo <(echo $'\\''); git push --force origin main`,
    `echo <(git push --force origin main)`,
    `env -S "-u FOO git push --force origin main"`,
    `git push --f\\orce origin main`,
    `g\\it.exe push --force origin main`,
    `X="$(echo '"')" git push --force origin main`,
    "echo `git push --force origin main; true`",
    'env -S "-u FOO" sh -c "git push --force origin main"',
    "g`it `push --force origin main",
    "git pu`sh --force origin main",
    "git push --for`ce origin main",
    'echo "a`b"; git push --force origin main; echo "c`d"',
    "env -iC . git push --force origin main",
  ]) {
    const interactive = runHook(
      guardScript,
      JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
      { CI: "", NON_INTERACTIVE: "" },
    );
    assert.equal(interactive.decision, "force_ask", cmd);
    const headless = runHook(
      guardScript,
      JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
      { CI: "true" },
    );
    assert.equal(headless.decision, "deny", cmd);
  }
});

test("verify-reminder backs Stop hook with ledger freshness, executionNum cap, and ASTACK_REQUIRE_VERIFY=0 override", () => {
  const tmp = makeTempGitRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-stop-art-"));
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
  try {
    assert.deepEqual(
      runHook(
        stopScript,
        JSON.stringify({
          conversationId: "stop-1",
          workspacePaths: [tmp],
          artifactDirectoryPath: artifactDir,
          continuationActive: false,
          terminationReason: "model_stop",
          fullyIdle: true,
        }),
      ),
      { decision: "allow" },
    );

    fs.writeFileSync(path.join(tmp, "app.js"), "console.log(2);\n", "utf8");

    const antigravityCont = runHook(
      stopScript,
      JSON.stringify({
        conversationId: "stop-1",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        continuationActive: false,
        terminationReason: "model_stop",
        fullyIdle: true,
        executionNum: 0,
      }),
    );
    assert.equal(antigravityCont.decision, "continue");

    const legacyCont = runHook(
      stopScript,
      JSON.stringify({ cwd: tmp, continuationActive: false, terminationReason: "NO_TOOL_CALL" }),
    );
    assert.equal(legacyCont.decision, "continue");

    assert.deepEqual(
      runHook(
        stopScript,
        JSON.stringify({ workspacePaths: [tmp], continuationActive: false, terminationReason: "model_stop", fullyIdle: true }),
        { ASTACK_REQUIRE_VERIFY: "0" },
      ),
      { decision: "allow" },
    );

    assert.deepEqual(
      runHook(
        stopScript,
        JSON.stringify({
          workspacePaths: [tmp],
          continuationActive: false,
          terminationReason: "model_stop",
          fullyIdle: true,
          executionNum: 3,
        }),
      ),
      { decision: "allow" },
    );

    execFileSync("git", ["add", "app.js"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "update app"], { cwd: tmp, stdio: "ignore" });
    const committedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    recordReceipt(
      { kind: "tool-write", conversationId: "stop-1", tool: "edit_file", filePath: "app.js", workspaceDir: tmp, artifactDir },
      { headSha: committedSha, now: "2026-11-21T10:00:00Z" },
    );
    const committedUnverified = runHook(
      stopScript,
      JSON.stringify({
        conversationId: "stop-1",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        continuationActive: false,
        terminationReason: "model_stop",
        fullyIdle: true,
      }),
    );
    assert.equal(committedUnverified.decision, "continue");

    recordReceipt(
      { kind: "tool-command", conversationId: "stop-1", command: "node --test", error: "", workspaceDir: tmp, artifactDir, modelName: "gemini-4-neon" },
      { headSha: committedSha, now: "2026-11-21T10:01:00Z" },
    );
    assert.deepEqual(
      runHook(
        stopScript,
        JSON.stringify({
          conversationId: "stop-1",
          workspacePaths: [tmp],
          artifactDirectoryPath: artifactDir,
          continuationActive: false,
          terminationReason: "model_stop",
          fullyIdle: true,
        }),
      ),
      { decision: "allow" },
    );

    assert.deepEqual(
      runHook(
        stopScript,
        JSON.stringify({ workspacePaths: [tmp], continuationActive: false, terminationReason: "model_stop", fullyIdle: false, headSha }),
      ),
      { decision: "allow" },
    );

    assert.deepEqual(
      runHook(
        stopScript,
        JSON.stringify({ workspacePaths: [tmp], continuationActive: true, terminationReason: "model_stop", fullyIdle: true }),
      ),
      { decision: "allow" },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("verify-reminder --dirty-only auto-continues only on dirty_after_verify and stays silent otherwise", () => {
  const tmp = makeTempGitRepo("astack-dirty-only-");
  const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dirty-nonrepo-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dirty-art-"));
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
  const runDirtyStop = (payload, extraEnv = {}) =>
    JSON.parse(
      execFileSync(process.execPath, [stopScript, "--dirty-only"], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, ...extraEnv },
      }).trim(),
    );

  try {
    assert.deepEqual(
      runDirtyStop({
        conversationId: "dirty-nonrepo",
        workspacePaths: [nonRepo],
        continuationActive: false,
        terminationReason: "model_stop",
        fullyIdle: true,
      }),
      { decision: "allow" },
    );

    fs.writeFileSync(path.join(tmp, "app.js"), "console.log(2);\n", "utf8");
    recordReceipt(
      { kind: "tool-command", conversationId: "dirty-1", command: "node --test", error: "", workspaceDir: tmp, artifactDir },
      { headSha, now: "2026-11-27T10:00:00Z" },
    );
    recordReceipt(
      { kind: "tool-write", conversationId: "dirty-1", tool: "edit_file", filePath: "app.js", workspaceDir: tmp, artifactDir },
      { headSha, now: "2026-11-27T10:01:00Z" },
    );

    assert.deepEqual(
      runDirtyStop({
        conversationId: "dirty-1",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        continuationActive: false,
        terminationReason: "model_stop",
        fullyIdle: true,
      }),
      { decision: "allow" },
      "Pre-edit investigation test followed by first edit must not trigger --dirty-only",
    );

    assert.deepEqual(
      runDirtyStop({
        conversationId: "dirty-no-verify",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        continuationActive: false,
        terminationReason: "model_stop",
        fullyIdle: true,
      }),
      { decision: "allow" },
      "missing_receipts must not trigger --dirty-only",
    );

    recordReceipt(
      { kind: "tool-command", conversationId: "dirty-1", command: "node --test", error: "", workspaceDir: tmp, artifactDir },
      { headSha, now: "2026-11-27T10:02:00Z" },
    );
    recordReceipt(
      { kind: "tool-write", conversationId: "dirty-1", tool: "edit_file", filePath: "app.js", workspaceDir: tmp, artifactDir },
      { headSha, now: "2026-11-27T10:03:00Z" },
    );

    const autoContinue = runDirtyStop({
      conversationId: "dirty-1",
      workspacePaths: [tmp],
      artifactDirectoryPath: artifactDir,
      continuationActive: false,
      terminationReason: "model_stop",
      fullyIdle: true,
      executionNum: 0,
    });
    assert.equal(autoContinue.decision, "continue");
    assert.match(autoContinue.reason, /dirty_after_verify/);

    assert.deepEqual(
      runDirtyStop({
        conversationId: "dirty-1",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        continuationActive: false,
        terminationReason: "model_stop",
        fullyIdle: false,
      }),
      { decision: "allow" },
    );
    assert.deepEqual(
      runDirtyStop(
        {
          conversationId: "dirty-1",
          workspacePaths: [tmp],
          artifactDirectoryPath: artifactDir,
          continuationActive: false,
          terminationReason: "model_stop",
          fullyIdle: true,
        },
        { ASTACK_REQUIRE_VERIFY: "0" },
      ),
      { decision: "allow" },
    );
    assert.deepEqual(
      runDirtyStop({
        conversationId: "dirty-1",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        continuationActive: false,
        terminationReason: "model_stop",
        fullyIdle: true,
        executionNum: 3,
      }),
      { decision: "allow" },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(nonRepo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("secret-guard covers CLI and App/IDE file write tools plus run_command", () => {
  const fakePat = ["ghp", "A".repeat(36)].join("_");

  assert.deepEqual(
    runHook(
      secretScript,
      JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: "tests/auth.test.js", CodeContent: fakePat } } }),
      { CI: "", NON_INTERACTIVE: "" },
    ),
    { decision: "allow" },
  );

  const writeToEnv = runHook(
    secretScript,
    JSON.stringify({ toolCall: { name: "write_to_file", args: { TargetFile: ".env", CodeContent: "PORT=3000\n" } } }),
    { CI: "true" },
  );
  assert.equal(writeToEnv.decision, "deny");

  const replaceSecret = runHook(
    secretScript,
    JSON.stringify({ toolCall: { name: "replace_file_content", args: { TargetFile: "src/cfg.ts", ReplacementContent: `const t = "${fakePat}";` } } }),
    { CI: "", NON_INTERACTIVE: "" },
  );
  assert.equal(replaceSecret.decision, "force_ask");

  const multiSecret = runHook(
    secretScript,
    JSON.stringify({
      toolCall: {
        name: "multi_replace_file_content",
        args: {
          TargetFile: "src/cfg.ts",
          ReplacementChunks: [
            { ReplacementContent: "const ok = true;" },
            { ReplacementContent: `export const key = "${fakePat}";` },
          ],
        },
      },
    }),
    { NON_INTERACTIVE: "1" },
  );
  assert.equal(multiSecret.decision, "deny");
});

test("receipt-ledger and session-context passive hooks return {} / base-branch injectSteps", () => {
  const tmp = makeTempGitRepo("astack-passive-");
  const artifactDir = path.join(tmp, ".tmp", "artifacts");
  try {
    fs.writeFileSync(path.join(tmp, "REVIEW.md"), "- Never weaken tests\n", "utf8");
    fs.writeFileSync(path.join(tmp, "GLOSSARY.md"), "- Workspace: active git repo\n", "utf8");
    execFileSync("git", ["add", "REVIEW.md", "GLOSSARY.md"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "docs"], { cwd: tmp, stdio: "ignore" });

    execFileSync("git", ["checkout", "-b", "feat/weaken"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(path.join(tmp, "REVIEW.md"), "- Skip all checks\n", "utf8");

    const sessionOut = runHook(
      sessionScript,
      JSON.stringify({ conversationId: "s-1", workspacePaths: [tmp], artifactDirectoryPath: artifactDir }),
    );
    assert.ok(Array.isArray(sessionOut.injectSteps));
    const injected = sessionOut.injectSteps[0].systemMessage.systemMessage;
    assert.match(injected, /Never weaken tests/);
    assert.match(injected, /Workspace: active git repo/);
    assert.match(injected, /WARNING: Working branch edits REVIEW\.md/);
    assert.doesNotMatch(injected, /Skip all checks/);

    const postOut = runHook(
      receiptScript,
      JSON.stringify({
        conversationId: "s-1",
        modelName: "gemini-4-hydrogen",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: "node --test" } },
        error: "",
      }),
    );
    assert.deepEqual(postOut, {});
    const subOut = runHook(
      receiptScript,
      JSON.stringify({
        conversationId: "s-1",
        modelName: "gemini-4-neon",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "invoke_subagent", args: { TypeName: "research", Role: "Codebase Reader" } },
        error: "",
      }),
    );
    assert.deepEqual(subOut, {});
    const wfOut = runHook(
      receiptScript,
      JSON.stringify({
        conversationId: "s-1",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_workflow", args: { Description: "Fanout audit", ScriptPath: "scripts/wf.py" } },
        error: "",
      }),
    );
    assert.deepEqual(wfOut, {});
    const receiptPath = path.join(artifactDir, "astack-trust", "receipts.s-1.jsonl");
    assert.equal(fs.existsSync(receiptPath), true);
    const receiptRaw = fs.readFileSync(receiptPath, "utf8");
    assert.match(receiptRaw, /"category":"test"/);
    assert.match(receiptRaw, /"modelName":"gemini-4-hydrogen"/);
    assert.match(receiptRaw, /"kind":"subagent"/);
    assert.match(receiptRaw, /"kind":"workflow"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const tmpPolicyOnly = makeTempGitRepo("astack-policy-warn-");
  try {
    execFileSync("git", ["checkout", "-b", "feat/policy-edit"], { cwd: tmpPolicyOnly, stdio: "ignore" });
    fs.mkdirSync(path.join(tmpPolicyOnly, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(tmpPolicyOnly, ".agents", "risk-policy.json"), '{"allowTier0AutoMerge":true}\n', "utf8");
    const sessionPolicyWarn = runHook(
      sessionScript,
      JSON.stringify({ conversationId: "s-2", workspacePaths: [tmpPolicyOnly] }),
    );
    assert.ok(Array.isArray(sessionPolicyWarn.injectSteps));
    assert.match(
      sessionPolicyWarn.injectSteps[0].systemMessage.systemMessage,
      /WARNING: Working branch edits \.agents\/risk-policy\.json/,
    );
  } finally {
    fs.rmSync(tmpPolicyOnly, { recursive: true, force: true });
  }
});

test("evidence-gate, boundary-guard, and round-limiter block violations and honor headless mode", () => {
  const tmp = makeTempGitRepo("astack-gates-");
  const artifactDir = path.join(tmp, ".tmp", "artifacts");
  try {
    fs.mkdirSync(path.join(tmp, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".agents", "boundaries.json"),
      JSON.stringify({
        schemaVersion: 1,
        zones: {
          coreInternal: { include: ["src/core/internal/**"] },
          app: { include: ["src/app/**"] },
        },
        importRules: [
          {
            id: "no-core-internal",
            from: "app",
            forbidImportFrom: ["coreInternal"],
            reason: "Import from src/core/index.js instead",
          },
        ],
      }),
      "utf8",
    );

    const badBoundary = runHook(
      boundaryScript,
      JSON.stringify({
        workspacePaths: [tmp],
        toolCall: {
          name: "write_to_file",
          args: { TargetFile: "src/app/main.js", CodeContent: 'import { x } from "../core/internal/secret.js";\n' },
        },
      }),
      { CI: "true" },
    );
    assert.equal(badBoundary.decision, "deny");
    assert.match(badBoundary.reason, /no-core-internal/);

    const badPush = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/x" } },
      }),
      { CI: "", NON_INTERACTIVE: "" },
    );
    assert.equal(badPush.decision, "force_ask");

    const wrappedMerge = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: "exec gh pr merge 1" } },
      }),
      { NON_INTERACTIVE: "1" },
    );
    assert.equal(wrappedMerge.decision, "deny");

    writeEvidenceSnapshotAtomic(path.join(artifactDir, "astack-trust"), {
      schemaVersion: 1,
      headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim(),
      freshness: "fresh",
      roundState: "escalated",
      reviewRound: 3,
      verifier: { verdict: "FAIL" },
      assertionDelta: { flagged: false, weakeningRatio: 0 },
    });

    const limitHit = runHook(
      roundScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "replace_file_content", args: { TargetFile: "app.js", ReplacementContent: "x" } },
      }),
      { NON_INTERACTIVE: "1" },
    );
    assert.equal(limitHit.decision, "deny");
    assert.match(limitHit.reason, /3\/3 failed review rounds/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pr-intent PreInvocation injects PR proof workflow once per prompt and ignores non-PR prompts", () => {
  const tmp = makeTempGitRepo("astack-pr-intent-");
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-pr-intent-art-"));
  try {
    const nonPr = runHook(
      prIntentScript,
      JSON.stringify({
        conversationId: "c-intent",
        hookEventName: "PreInvocation",
        invocationNum: 1,
        lastUserInput: "Fix the failing unit test",
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
      }),
    );
    assert.deepEqual(nonPr, {});

    fs.mkdirSync(path.join(tmp, ".agents", "skills", "verify-demo", "features"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".agents", "skills", "verify-demo", "features", "demo.md"),
      "# Demo Feature\n\n## Sub-features\n\n- Demo step\n",
      "utf8",
    );

    const prPayload = JSON.stringify({
      conversationId: "c-intent",
      hookEventName: "PreInvocation",
      invocationNum: 2,
      lastUserInput: "okay, open a PR",
      workspacePaths: [tmp],
      artifactDirectoryPath: artifactDir,
    });
    const first = runHook(prIntentScript, prPayload);
    assert.ok(Array.isArray(first.injectSteps));
    const injected = first.injectSteps[0].ephemeralMessage;
    assert.equal(typeof injected, "string");
    assert.equal(first.injectSteps[0].systemMessage, undefined);
    assert.match(injected, /pr-dossier\.mjs --format github/);
    assert.match(injected, /--artifact-dir/);
    assert.doesNotMatch(injected, /--feature-map/);

    const second = runHook(prIntentScript, prPayload);
    assert.deepEqual(second, {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("evidence-gate validates gh CLI and MCP PR bodies against base-branch policy without false positives", () => {
  const tmp = makeTempGitRepo("astack-pr-gate-");
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-pr-gate-art-"));
  const trustDir = path.join(artifactDir, "astack-trust");
  try {
    fs.mkdirSync(path.join(tmp, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, ".agents", "risk-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        prDescriptionContract: {
          enabled: true,
          requireStatechart: true,
          requireProofTable: true,
          forbidLocalLinks: true,
        },
      }),
      "utf8",
    );
    execFileSync("git", ["add", ".agents/risk-policy.json"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "enable pr description contract"], { cwd: tmp, stdio: "ignore" });

    execFileSync("git", ["checkout", "-b", "feat/pr-gate"], { cwd: tmp, stdio: "ignore" });
    fs.writeFileSync(
      path.join(tmp, ".agents", "risk-policy.json"),
      JSON.stringify({ schemaVersion: 1, prDescriptionContract: { enabled: false } }),
      "utf8",
    );
    fs.writeFileSync(path.join(tmp, "app.js"), "console.log(42);\n", "utf8");
    execFileSync("git", ["add", ".agents/risk-policy.json", "app.js"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "attempt tamper and update app"], { cwd: tmp, stdio: "ignore" });

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    recordReceipt(
      { kind: "tool-command", conversationId: "exec", command: "node --test", error: "", workspaceDir: tmp },
      { trustDir, headSha },
    );
    const bodyFile = path.join(artifactDir, "compiled-pr-body.md");
    compilePrDossier({
      cwd: tmp,
      baseRef: "main",
      artifactDir,
      format: "github",
      outPath: bodyFile,
    });
    const compiledBody = fs.readFileSync(bodyFile, "utf8");

    assert.deepEqual(
      runHook(
        evidenceScript,
        JSON.stringify({
          workspacePaths: [tmp],
          artifactDirectoryPath: artifactDir,
          toolCall: { name: "run_command", args: { CommandLine: 'echo "gh pr create"' } },
        }),
        { CI: "true" },
      ),
      { decision: "allow" },
    );

    assert.deepEqual(
      runHook(
        evidenceScript,
        JSON.stringify({
          workspacePaths: [tmp],
          artifactDirectoryPath: artifactDir,
          toolCall: { name: "run_command", args: { CommandLine: "gh pr edit 12 --add-label docs" } },
        }),
        { CI: "true" },
      ),
      { decision: "allow" },
    );

    const fillBlocked = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: "gh pr create --title Test --fill" } },
      }),
      { CI: "true" },
    );
    assert.equal(fillBlocked.decision, "deny");
    assert.match(fillBlocked.reason, /--fill/);

    const newPlainBlocked = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: 'gh pr new --title Test --body "plain"' } },
      }),
      { CI: "", NON_INTERACTIVE: "" },
    );
    assert.equal(newPlainBlocked.decision, "force_ask");
    assert.match(newPlainBlocked.reason, /PR description contract violation/);

    const editBodyBlocked = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: 'gh pr edit 12 --body "plain"' } },
      }),
      { CI: "true" },
    );
    assert.equal(editBodyBlocked.decision, "deny");

    const cliAllowed = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: `gh pr create --title Test --body-file "${bodyFile}"` } },
      }),
      { CI: "true" },
    );
    assert.deepEqual(cliAllowed, { decision: "allow" });

    const mcpBlocked = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "github-mcp-server",
            ToolName: "create_pull_request",
            Arguments: { owner: "acme", repo: "demo", title: "Test", head: "feat/pr-gate", base: "main", body: "plain" },
          },
        },
      }),
      { CI: "true" },
    );
    assert.equal(mcpBlocked.decision, "deny");
    assert.match(mcpBlocked.reason, /PR description contract violation/);

    const mcpAllowed = runHook(
      evidenceScript,
      JSON.stringify({
        workspacePaths: [tmp],
        artifactDirectoryPath: artifactDir,
        toolCall: {
          name: "call_mcp_tool",
          args: {
            ServerName: "github-mcp-server",
            ToolName: "create_pull_request",
            Arguments: { owner: "acme", repo: "demo", title: "Test", head: "feat/pr-gate", base: "main", body: compiledBody },
          },
        },
      }),
      { CI: "true" },
    );
    assert.deepEqual(mcpAllowed, { decision: "allow" });

    for (const cmd of [
      "gh pr edit 12 -b\"plain\"",
      "gh pr edit 12 -Fmissing-body.md",
      "echo <(gh pr merge 1)",
      "env -S \"-u FOO gh pr merge 1\"",
      "gh p\\r m\\erge 1",
      "pnpm exec gh pr merge 1",
      "pnpm e\\xec gh pr merge 1",
      'pnpm exec env -S "-u FOO gh pr merge 1"',
      "npx -y --package @cli/gh gh pr merge 1",
      "uvx --from pkg gh pr merge 1",
      'X="$(echo \'"\')" gh pr merge 1',
      "echo `gh pr merge 1; true`",
      'env -S "-u FOO" sh -c "gh pr merge 1"',
      'gh pr edit 12 --b\\ody "plain"',
      "gh `pr mer`ge 1",
      "gh pr mer`ge 1",
      'gh pr edit 12 --bo`dy "plain"',
      'echo "a`b"; gh pr merge 1; echo "c`d"',
      "env -iC . gh pr merge 1",
      "gh pr create --body-file .",
      "git push origin feat/x && gh pr create --body-file",
    ]) {
      const blocked = runHook(
        evidenceScript,
        JSON.stringify({
          workspacePaths: [tmp],
          artifactDirectoryPath: artifactDir,
          toolCall: { name: "run_command", args: { CommandLine: cmd } },
        }),
        { CI: "true" },
      );
      assert.equal(blocked.decision, "deny", cmd);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("non-git workspaces keep all 7 workflow hooks silent with zero disk writes while workstation safety guards stay active", () => {
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "astack-non-swe-ws-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-non-swe-art-"));
  const repo = makeTempGitRepo("astack-mcp-filter-repo-");
  const repoArtDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-mcp-filter-art-"));
  try {
    assert.deepEqual(
      runHook(
        receiptScript,
        JSON.stringify({
          conversationId: "non-swe-1",
          workspacePaths: [nonGit],
          artifactDirectoryPath: artifactDir,
          toolCall: { name: "run_command", args: { CommandLine: "node --test" } },
          error: "",
        }),
      ),
      {},
    );
    assert.deepEqual(
      runHook(
        sessionScript,
        JSON.stringify({
          conversationId: "non-swe-1",
          workspacePaths: [nonGit],
          artifactDirectoryPath: artifactDir,
        }),
      ),
      {},
    );
    assert.deepEqual(
      runHook(
        prIntentScript,
        JSON.stringify({
          conversationId: "non-swe-1",
          hookEventName: "PreInvocation",
          invocationNum: 1,
          lastUserInput: "prepare a PR for my video slides",
          workspacePaths: [nonGit],
          artifactDirectoryPath: artifactDir,
        }),
      ),
      {},
    );
    assert.deepEqual(
      runHook(
        stopScript,
        JSON.stringify({
          conversationId: "non-swe-1",
          workspacePaths: [nonGit],
          artifactDirectoryPath: artifactDir,
          terminationReason: "model_stop",
          fullyIdle: true,
        }),
      ),
      { decision: "allow" },
    );
    assert.deepEqual(
      runHook(
        evidenceScript,
        JSON.stringify({
          conversationId: "non-swe-1",
          workspacePaths: [nonGit],
          artifactDirectoryPath: artifactDir,
          toolCall: { name: "run_command", args: { CommandLine: "git push origin main" } },
        }),
        { CI: "true" },
      ),
      { decision: "allow" },
    );
    assert.deepEqual(
      runHook(
        boundaryScript,
        JSON.stringify({
          conversationId: "non-swe-1",
          workspacePaths: [nonGit],
          artifactDirectoryPath: artifactDir,
          toolCall: { name: "write_file", args: { Path: "notes.js", Content: "export const x = 1;\n" } },
        }),
        { CI: "true" },
      ),
      { decision: "allow" },
    );
    assert.deepEqual(
      runHook(
        roundScript,
        JSON.stringify({
          conversationId: "non-swe-1",
          workspacePaths: [nonGit],
          artifactDirectoryPath: artifactDir,
          toolCall: { name: "edit_file", args: { Path: "notes.js", Replacement: "x" } },
        }),
        { CI: "true" },
      ),
      { decision: "allow" },
    );

    assert.equal(fs.existsSync(path.join(nonGit, ".tmp", "astack-trust")), false);
    assert.equal(fs.existsSync(path.join(artifactDir, "astack-trust")), false);

    const secretBlocked = runHook(
      secretScript,
      JSON.stringify({
        workspacePaths: [nonGit],
        toolCall: { name: "write_file", args: { Path: ".env", Content: "API_KEY=secret\n" } },
      }),
      { CI: "true" },
    );
    assert.equal(secretBlocked.decision, "deny");

    const irrevBlocked = runHook(
      guardScript,
      JSON.stringify({
        workspacePaths: [nonGit],
        toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } },
      }),
      { CI: "true" },
    );
    assert.equal(irrevBlocked.decision, "deny");

    for (const serverName of ["tella", "gslides"]) {
      assert.deepEqual(
        runHook(
          receiptScript,
          JSON.stringify({
            conversationId: "mixed-session",
            workspacePaths: [repo],
            artifactDirectoryPath: repoArtDir,
            toolCall: {
              name: "call_mcp_tool",
              args: { ServerName: serverName, ToolName: "update_deck", Arguments: {} },
            },
            error: "",
          }),
        ),
        {},
      );
    }
    assert.equal(
      fs.existsSync(path.join(repoArtDir, "astack-trust", "receipts.mixed-session.jsonl")),
      false,
      "Non-SWE MCP tools inside a git repo must not write receipts",
    );
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(repoArtDir, { recursive: true, force: true });
  }
});
