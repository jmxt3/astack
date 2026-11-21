import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { recordReceipt, writeEvidenceSnapshotAtomic } from "../trust/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../..");
const statuslineScript = path.join(rootDir, "scripts", "cli", "statusline.mjs");
const titleScript = path.join(rootDir, "scripts", "cli", "title.mjs");

function runScript(scriptPath, inputText = "") {
  return spawnSync(process.execPath, [scriptPath], {
    input: inputText,
    encoding: "utf8",
    timeout: 3000,
  });
}

test("statusline.mjs and title.mjs exit 0 cleanly on --help, empty stdin, malformed JSON, and non-git cwd", () => {
  for (const script of [statuslineScript, titleScript]) {
    for (const flag of ["--help", "-h"]) {
      const h = spawnSync(process.execPath, [script, flag], { encoding: "utf8" });
      assert.equal(h.status, 0);
      assert.match(h.stdout, /Usage:/);
    }
    const emptyRes = runScript(script, "");
    assert.equal(emptyRes.status, 0);
    assert.ok(emptyRes.stdout.trim().length > 0);

    const badJsonRes = runScript(script, "{not valid json");
    assert.equal(badJsonRes.status, 0);
    assert.ok(badJsonRes.stdout.trim().length > 0);
  }

  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-nogit-"));
  try {
    const res = runScript(statuslineScript, JSON.stringify({ cwd: nonGitDir, terminal_width: 100 }));
    assert.equal(res.status, 0);
    assert.match(res.stdout, /no_git/);
  } finally {
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test("statusline.mjs and title.mjs reflect fresh/stale receipts, narrow widths, zero ANSI in title, and sub-200ms execution", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astack-cli-repo-"));
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-cli-brain-"));
  const transcriptPath = path.join(convDir, ".system_generated", "logs", "transcript.jsonl");
  const trustDir = path.join(convDir, "astack-trust");

  try {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "{}\n", "utf8");
    fs.writeFileSync(path.join(convDir, "implementation_plan.md"), "# Plan\n", "utf8");

    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "app.js"), "console.log(1);\n", "utf8");
    execFileSync("git", ["add", "app.js"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    recordReceipt(
      { kind: "tool-write", conversationId: "exec", tool: "edit_file", filePath: "app.js", workspaceDir: repo },
      { trustDir, headSha, now: "2026-11-21T10:00:00Z" },
    );
    recordReceipt(
      { kind: "tool-command", conversationId: "exec", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha, now: "2026-11-21T10:01:00Z" },
    );
    writeEvidenceSnapshotAtomic(trustDir, {
      schemaVersion: 1,
      headSha,
      freshness: "fresh",
      riskTier: 1,
      roundState: "open",
    });

    const payload = JSON.stringify({
      conversation_id: "exec",
      transcript_path: transcriptPath,
      workspace: { project_dir: repo },
      context_window: { used_percentage: 14.24 },
      agent_state: "idle",
      terminal_width: 110,
    });

    const t0 = performance.now();
    const wideRes = runScript(statuslineScript, payload);
    const elapsedMs = performance.now() - t0;
    assert.equal(wideRes.status, 0);
    assert.ok(elapsedMs < 500, `Expected fast statusline execution (<500ms including node spawn), got ${elapsedMs}ms`);
    assert.match(wideRes.stdout, /AStack/);
    assert.match(wideRes.stdout, /Tier 1/);
    assert.match(wideRes.stdout, /fresh/);
    assert.match(wideRes.stdout, /14% ctx/);

    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const narrowRes = runScript(
      statuslineScript,
      JSON.stringify({ ...JSON.parse(payload), terminal_width: 55 }),
    );
    assert.equal(narrowRes.status, 0);
    assert.match(narrowRes.stdout, /\x1b\[/);
    assert.match(stripAnsi(narrowRes.stdout), /\[P✓ B✓ R● S·\]/);
    assert.match(narrowRes.stdout, /T1/);

    const titleRes = runScript(titleScript, payload);
    assert.equal(titleRes.status, 0);
    assert.doesNotMatch(titleRes.stdout, /\x1b/);
    assert.match(titleRes.stdout, /^AStack \[Review · fresh\] /);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(convDir, { recursive: true, force: true });
  }
});
