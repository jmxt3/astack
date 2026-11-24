import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assessChange,
  classifyActionClass,
  compilePrDossier,
  parseHookPayload,
  recordReceipt,
  recordRollbackReceipt,
  recordVerifierReceipt,
  resolveResidual,
} from "../trust/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const evidenceGateScript = path.resolve(here, "../hooks/evidence-gate.mjs");
const dossierCli = path.resolve(here, "../../skills/review-pr/scripts/pr-dossier.mjs");

function runHook(scriptPath, stdinObj, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [scriptPath], {
    input: JSON.stringify(stdinObj),
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return JSON.parse(stdout.trim());
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-mit-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.js"), "export const v = 1;\n", "utf8");
  execFileSync("git", ["add", "app.js"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("classifyActionClass maps write, exec, push, PR, merge, deploy, external, and destructive events", () => {
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "read_file", args: { Path: "README.md" } } })), "read");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "write_file", args: { Path: "a.js", Content: "1" } } })), "local_write");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } })), "read");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "node --test" } } })), "local_exec");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/a" } } })), "push_branch");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "gh pr create --title x --body y" } } })), "open_pr");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "gh pr merge 24 --squash" } } })), "merge");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "vercel --prod" } } })), "destructive");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "npm publish" } } })), "deploy");
  assert.equal(classifyActionClass(parseHookPayload({ toolCall: { name: "run_command", args: { CommandLine: "gh pr comment 24 --body hi" } } })), "external_message");
  assert.equal(
    classifyActionClass(
      parseHookPayload({
        toolCall: {
          name: "call_mcp_tool",
          args: { ServerName: "github-mcp-server", ToolName: "merge_pull_request", Arguments: { pull_number: 24 } },
        },
      }),
    ),
    "merge",
  );
  assert.equal(
    classifyActionClass(
      parseHookPayload({
        toolCall: { name: "mcp_github_merge_pull_request", args: { pull_number: 24 } },
      }),
    ),
    "merge",
  );
});

test("resolveResidual reduces score only with fresh HEAD mitigation receipts and keeps governance blocked", () => {
  const head = "a".repeat(40);
  const diff = [
    "diff --git a/scripts/mcp/tools.mjs b/scripts/mcp/tools.mjs",
    "--- a/scripts/mcp/tools.mjs",
    "+++ b/scripts/mcp/tools.mjs",
    "@@ -1,2 +1,3 @@",
    " export const a = 1;",
    "+export const b = 2;",
  ].join("\n");

  const raw = assessChange({ diffText: diff, headSha: head, action: "merge" });
  const unmitigated = resolveResidual(raw, [], { headSha: head });
  assert.ok(unmitigated.requiredMitigations.includes("blast_radius_proof"));
  assert.ok(unmitigated.requiredMitigations.includes("verifier_pass"));
  assert.ok(unmitigated.missingMitigations.includes("verifier_pass"));
  assert.equal(unmitigated.residual, "high");

  const staleReceipts = [
    { kind: "command", category: "test", ok: true, summary: "node --test", headSha: "b".repeat(40), ts: "2026-11-22T10:00:00Z" },
  ];
  const staleRes = resolveResidual(raw, staleReceipts, { headSha: head });
  assert.equal(staleRes.satisfied.some((s) => s.id === "targeted_tests"), false);

  const freshReceipts = [
    { kind: "command", category: "test", ok: true, summary: "node --test", headSha: head, ts: "2026-11-22T10:01:00Z" },
    { kind: "command", category: "verify", ok: true, summary: "blast-radius check", headSha: head, ts: "2026-11-22T10:02:00Z" },
    { kind: "verifier", category: "verify", ok: true, verdict: "PASS", summary: "pr-verifier PASS", headSha: head, ts: "2026-11-22T10:03:00Z" },
  ];
  const mitigated = resolveResidual(raw, freshReceipts, { headSha: head });
  assert.ok(mitigated.score < unmitigated.score, `Expected score drop (${mitigated.score} < ${unmitigated.score})`);
  assert.equal(mitigated.missingMitigations.length, 0);
  assert.equal(mitigated.residual, "medium");

  const govDiff = "diff --git a/hooks.json b/hooks.json\n--- a/hooks.json\n+++ b/hooks.json\n@@ -1 +1 @@\n-{}\n+{\"a\":1}\n";
  const govRaw = assessChange({ diffText: govDiff, headSha: head, action: "merge" });
  const govMit = resolveResidual(govRaw, freshReceipts, { headSha: head });
  assert.equal(govMit.residual, "blocked", "Governance changes must stay blocked regardless of receipts");

  const trustGovDiff = "diff --git a/scripts/trust/index.mjs b/scripts/trust/index.mjs\n--- a/scripts/trust/index.mjs\n+++ b/scripts/trust/index.mjs\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n";
  const trustGovRaw = assessChange({ diffText: trustGovDiff, headSha: head, action: "merge" });
  const trustGovMit = resolveResidual(trustGovRaw, freshReceipts, { headSha: head });
  assert.equal(trustGovRaw.category, "governance");
  assert.equal(trustGovMit.residual, "blocked", "scripts/trust/** edits must stay blocked in governance regardless of receipts");
});

test("evidence-gate hook denies unverified gh pr merge and MCP merge_pull_request and allows once verified with rollback receipt", () => {
  const repo = makeTempRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-merge-gate-art-"));
  const trustDir = path.join(artifactDir, "astack-trust");
  try {
    execFileSync("git", ["checkout", "-b", "feat/clean-ui"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "README.md"), "# Updated docs\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "docs update"], { cwd: repo, stdio: "ignore" });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const baseSha = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();

    const deniedCli = runHook(
      evidenceGateScript,
      {
        conversationId: "merge-1",
        workspacePaths: [repo],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: "gh pr merge 24 --squash" } },
      },
      { CI: "", NON_INTERACTIVE: "" },
    );
    assert.equal(deniedCli.decision, "deny");
    assert.match(deniedCli.reason, /pr-verifier PASS/i);

    const deniedMcp = runHook(
      evidenceGateScript,
      {
        conversationId: "merge-1",
        workspacePaths: [repo],
        artifactDirectoryPath: artifactDir,
        toolCall: {
          name: "call_mcp_tool",
          args: { ServerName: "github-mcp-server", ToolName: "merge_pull_request", Arguments: { pull_number: 24 } },
        },
      },
      { CI: "", NON_INTERACTIVE: "" },
    );
    assert.equal(deniedMcp.decision, "deny");

    recordReceipt(
      { kind: "tool-command", conversationId: "merge-1", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha, now: "2026-11-22T12:00:00Z" },
    );
    const findingsPath = path.join(trustDir, "findings.json");
    fs.writeFileSync(
      findingsPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Verified docs edit",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );

    const recordRun = execFileSync(
      process.execPath,
      [dossierCli, "--cwd", repo, "--base", "main", "--artifact-dir", artifactDir, "--findings", findingsPath, "--record-verifier", "--json"],
      { encoding: "utf8" },
    );
    const parsedDossier = JSON.parse(recordRun);
    assert.equal(parsedDossier.evidence.verifier.verdict, "PASS");

    recordRollbackReceipt({
      trustDir,
      conversationId: "merge-1",
      headSha,
      plan: `git revert ${headSha.slice(0, 7)}`,
      now: "2026-11-22T12:01:00Z",
    });

    const allowedCli = runHook(
      evidenceGateScript,
      {
        conversationId: "merge-1",
        workspacePaths: [repo],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: "gh pr merge 24 --squash" } },
      },
      { CI: "true" },
    );
    assert.deepEqual(allowedCli, { decision: "allow" });

    const allowedMcp = runHook(
      evidenceGateScript,
      {
        conversationId: "merge-1",
        workspacePaths: [repo],
        artifactDirectoryPath: artifactDir,
        toolCall: {
          name: "call_mcp_tool",
          args: { ServerName: "github-mcp-server", ToolName: "merge_pull_request", Arguments: { pull_number: 24 } },
        },
      },
      { CI: "true" },
    );
    assert.deepEqual(allowedMcp, { decision: "allow" });

    fs.writeFileSync(path.join(repo, "hooks.json"), "{}\n", "utf8");
    execFileSync("git", ["add", "hooks.json"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "touch governance"], { cwd: repo, stdio: "ignore" });
    const govSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    recordReceipt(
      { kind: "tool-command", conversationId: "merge-1", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha: govSha, now: "2026-11-22T12:05:00Z" },
    );
    recordVerifierReceipt({ trustDir, conversationId: "pr-verifier", headSha: govSha, verdict: "PASS", now: "2026-11-22T12:06:00Z" });
    compilePrDossier({ cwd: repo, baseRef: "main", artifactDir });

    const blockedGovMerge = runHook(
      evidenceGateScript,
      {
        conversationId: "merge-1",
        workspacePaths: [repo],
        artifactDirectoryPath: artifactDir,
        toolCall: { name: "run_command", args: { CommandLine: "gh pr merge 24 --squash" } },
      },
      { CI: "true" },
    );
    assert.equal(blockedGovMerge.decision, "deny");
    assert.match(blockedGovMerge.reason, /residual risk is blocked/i);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("classifyActionClass never classifies compound/redirected commands or remote write MCP tools as read", () => {
  assert.equal(classifyActionClass({ kind: "tool-command", command: "ls && node evil.js" }), "local_exec");
  assert.equal(classifyActionClass({ kind: "tool-command", command: "cat README.md > hacked.txt" }), "local_exec");
  assert.equal(classifyActionClass({ kind: "tool-command", command: "git status; echo pwn > x" }), "local_exec");
  assert.equal(classifyActionClass({ kind: "tool-command", command: "git -C repo merge feat" }), "merge");
  assert.equal(classifyActionClass({ kind: "tool-command", command: "gh -R org/repo pr merge 12" }), "merge");
  assert.equal(classifyActionClass({ kind: "tool-command", command: "g\\it push origin feat" }), "push_branch");
  assert.equal(classifyActionClass({ kind: "tool-command", command: "gh p\\r m\\erge 1" }), "merge");
  assert.equal(classifyActionClass({ kind: "tool-command", command: "git status && git diff --stat" }), "read");
  assert.equal(classifyActionClass({ kind: "tool-mcp", toolName: "push_files" }), "push_branch");
  assert.equal(classifyActionClass({ kind: "tool-mcp", toolName: "create_or_update_file" }), "push_branch");
  assert.equal(classifyActionClass({ kind: "tool-mcp", toolName: "create_branch" }), "push_branch");
});
