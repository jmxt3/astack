import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyTrustSettingsAction,
  recordOutcomeWithTrustSync,
  recordReceipt,
  resolveWorkspaceScope,
  writeEvidenceSnapshotAtomic,
} from "../trust/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../..");
const statuslineScript = path.join(rootDir, "scripts", "cli", "statusline.mjs");
const titleScript = path.join(rootDir, "scripts", "cli", "title.mjs");

function runScript(scriptPath, inputText = "", env = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    input: inputText,
    encoding: "utf8",
    timeout: 3000,
    env: { ...process.env, ...env },
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

test("statusline.mjs renders L<x>, Beast, and fresh R on enrolled repos, guards stale evidence.headSha, and omits trust on non-git and unregistered repos", () => {
  const enrolledRepo = fs.mkdtempSync(path.join(os.tmpdir(), "astack-sl-enrolled-"));
  const unregRepo = fs.mkdtempSync(path.join(os.tmpdir(), "astack-sl-unreg-"));
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-sl-nongit-"));
  const convDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-sl-conv-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-sl-data-"));
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  const env = { ASTACK_PLUGIN_DATA: dataDir };

  try {
    const transcriptPath = path.join(convDir, ".system_generated", "logs", "transcript.jsonl");
    const trustDir = path.join(convDir, "astack-trust");
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, "{}\n", "utf8");

    execFileSync("git", ["init", "-b", "main"], { cwd: enrolledRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: enrolledRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: enrolledRepo, stdio: "ignore" });
    fs.mkdirSync(path.join(enrolledRepo, ".agents"), { recursive: true });
    const policy = {
      schemaVersion: 1,
      autonomy: {
        defaultCeiling: 2,
        ceilings: { docs: 3, tests: 3, ui: 3, skills: 3, tooling: 3, core: 3, governance: 2 },
      },
    };
    fs.writeFileSync(
      path.join(enrolledRepo, ".agents", "risk-policy.json"),
      `${JSON.stringify(policy, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(enrolledRepo, "app.js"), "console.log(1);\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: enrolledRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init enrolled"], { cwd: enrolledRepo, stdio: "ignore" });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: enrolledRepo, encoding: "utf8" }).trim();
    const scope = resolveWorkspaceScope(enrolledRepo);
    assert.equal(scope.kind, "enrolled_repo");

    for (let i = 0; i < 10; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: enrolledRepo,
        scope,
        policy,
        category: "ui",
        outcome: "clean",
        headSha,
        predictedR: 0.08,
        dataDir,
      });
    }
    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { beastOn: true, promotionMode: "auto" },
      dataDir,
    });

    writeEvidenceSnapshotAtomic(trustDir, {
      schemaVersion: 1,
      headSha,
      freshness: "fresh",
      riskTier: 2,
      riskAssessment: { category: "ui", score: 0.22, residual: "medium" },
    });

    const basePayload = {
      conversation_id: "sl-enrolled",
      transcript_path: transcriptPath,
      workspace: { project_dir: enrolledRepo },
      terminal_width: 120,
    };

    const enrolledWide = stripAnsi(runScript(statuslineScript, JSON.stringify(basePayload), env).stdout);
    assert.match(enrolledWide, /R 0\.22/);
    assert.match(enrolledWide, /Beast ui L2/);

    const enrolledNarrow = stripAnsi(
      runScript(statuslineScript, JSON.stringify({ ...basePayload, terminal_width: 55 }), env).stdout,
    );
    assert.match(enrolledNarrow, /Beast L2/);
    assert.match(enrolledNarrow, /R 0\.22/);

    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { beastOn: false },
      dataDir,
    });
    const beastOffWide = stripAnsi(runScript(statuslineScript, JSON.stringify(basePayload), env).stdout);
    assert.doesNotMatch(beastOffWide, /\bBeast\b/);
    assert.match(beastOffWide, /ui L2/);
    assert.match(beastOffWide, /R 0\.22/);

    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { beastOn: true },
      dataDir,
    });
    writeEvidenceSnapshotAtomic(trustDir, {
      schemaVersion: 1,
      headSha: "1".repeat(40),
      freshness: "stale_sha",
      riskTier: 2,
      riskAssessment: { category: "docs", score: 0.88, residual: "high" },
    });
    const staleWide = stripAnsi(runScript(statuslineScript, JSON.stringify(basePayload), env).stdout);
    assert.doesNotMatch(staleWide, /R 0\.88/);
    assert.doesNotMatch(staleWide, /\bdocs L/);
    assert.match(staleWide, /Beast ui L2/);

    execFileSync("git", ["init", "-b", "main"], { cwd: unregRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: unregRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: unregRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(unregRepo, "index.js"), "1\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: unregRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init unreg"], { cwd: unregRepo, stdio: "ignore" });
    const unregSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: unregRepo, encoding: "utf8" }).trim();
    fs.mkdirSync(path.join(unregRepo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(unregRepo, ".agents", "risk-policy.json"),
      `${JSON.stringify(policy, null, 2)}\n`,
      "utf8",
    );
    writeEvidenceSnapshotAtomic(trustDir, {
      schemaVersion: 1,
      headSha: unregSha,
      freshness: "fresh",
      riskTier: 1,
      riskAssessment: { category: "core", score: 0.35, residual: "medium" },
    });
    const unregWide = stripAnsi(
      runScript(
        statuslineScript,
        JSON.stringify({ ...basePayload, workspace: { project_dir: unregRepo } }),
        env,
      ).stdout,
    );
    assert.doesNotMatch(unregWide, /\bBeast\b/);
    assert.doesNotMatch(unregWide, /\bL[0-3]\b/);
    assert.doesNotMatch(unregWide, /\bR \d\.\d\d\b/);

    const nonGitWide = stripAnsi(
      runScript(
        statuslineScript,
        JSON.stringify({ cwd: nonGitDir, transcript_path: transcriptPath, terminal_width: 120 }),
        env,
      ).stdout,
    );
    assert.match(nonGitWide, /no_git/);
    assert.doesNotMatch(nonGitWide, /\bBeast\b/);
    assert.doesNotMatch(nonGitWide, /\bL[0-3]\b/);
    assert.doesNotMatch(nonGitWide, /\bR \d\.\d\d\b/);
  } finally {
    fs.rmSync(enrolledRepo, { recursive: true, force: true });
    fs.rmSync(unregRepo, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
    fs.rmSync(convDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
