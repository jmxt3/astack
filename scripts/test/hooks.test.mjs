import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const guardScript = path.resolve(here, "../hooks/irreversible-guard.mjs");
const stopScript = path.resolve(here, "../hooks/verify-reminder.mjs");
const hooksJsonPath = path.resolve(here, "../../hooks.json");

function runHook(scriptPath, stdinText, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [scriptPath], {
    input: stdinText,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return JSON.parse(stdout.trim());
}

test("hooks.json declares both hooks opt-in (enabled: false) using Stop flat format", () => {
  const cfg = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"));
  assert.equal(cfg["astack-irreversible-guard"]?.enabled, false);
  assert.equal(cfg["astack-verify-reminder"]?.enabled, false);
  assert.ok(Array.isArray(cfg["astack-irreversible-guard"]?.PreToolUse));
  assert.ok(Array.isArray(cfg["astack-verify-reminder"]?.Stop));
  assert.equal(cfg["astack-verify-reminder"].Stop[0]?.type, "command");
});

test("irreversible-guard allows safe commands and malformed JSON", () => {
  assert.deepEqual(
    runHook(
      guardScript,
      JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } }),
    ),
    { decision: "allow" },
  );
  assert.deepEqual(runHook(guardScript, "{not valid json"), { decision: "allow" });
});

test("irreversible-guard flags destructive commands with force_ask", () => {
  for (const cmd of [
    "git push origin main --force",
    "git reset --hard HEAD~3",
    "rm -rf /",
    "psql -c 'DROP TABLE users;'",
    "terraform destroy -auto-approve",
  ]) {
    const out = runHook(
      guardScript,
      JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: cmd } } }),
    );
    assert.equal(out.decision, "force_ask", cmd);
    assert.match(out.reason, /irreversible-guard/);
  }
});

test("verify-reminder allows continuationActive, non-NO_TOOL_CALL, default env, and clean repo", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-hook-"));
  execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
  fs.writeFileSync(path.join(tmp, "app.js"), "console.log(1);\n");
  execFileSync("git", ["add", "app.js"], { cwd: tmp, stdio: "ignore" });
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "init"], {
    cwd: tmp,
    stdio: "ignore",
  });

  // Clean repo even with ASTACK_REQUIRE_VERIFY=1 -> allow
  assert.deepEqual(
    runHook(
      stopScript,
      JSON.stringify({ cwd: tmp, continuationActive: false, terminationReason: "NO_TOOL_CALL" }),
      { ASTACK_REQUIRE_VERIFY: "1" },
    ),
    { decision: "allow" },
  );

  // Dirty code file with default env -> allow
  fs.writeFileSync(path.join(tmp, "app.js"), "console.log(2);\n");
  assert.deepEqual(
    runHook(
      stopScript,
      JSON.stringify({ cwd: tmp, continuationActive: false, terminationReason: "NO_TOOL_CALL" }),
      { ASTACK_REQUIRE_VERIFY: "" },
    ),
    { decision: "allow" },
  );

  // Dirty code file with ASTACK_REQUIRE_VERIFY=1 + NO_TOOL_CALL + !continuationActive -> continue
  const cont = runHook(
    stopScript,
    JSON.stringify({ cwd: tmp, continuationActive: false, terminationReason: "NO_TOOL_CALL" }),
    { ASTACK_REQUIRE_VERIFY: "1" },
  );
  assert.equal(cont.decision, "continue");

  // continuationActive: true MUST break the loop and return allow
  assert.deepEqual(
    runHook(
      stopScript,
      JSON.stringify({ cwd: tmp, continuationActive: true, terminationReason: "NO_TOOL_CALL" }),
      { ASTACK_REQUIRE_VERIFY: "1" },
    ),
    { decision: "allow" },
  );

  // Non-NO_TOOL_CALL MUST allow
  assert.deepEqual(
    runHook(
      stopScript,
      JSON.stringify({ cwd: tmp, continuationActive: false, terminationReason: "MAX_INVOCATIONS" }),
      { ASTACK_REQUIRE_VERIFY: "1" },
    ),
    { decision: "allow" },
  );

  fs.rmSync(tmp, { recursive: true, force: true });
});
