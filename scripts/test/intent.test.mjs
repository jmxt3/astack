import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  detectSessionTestRegression,
  evaluateIntentScope,
  readIntentCard,
  recordIntentCard,
  validateIntentCard,
} from "../trust/index.mjs";
import { dispatchToolCall } from "../mcp/tools.mjs";

test("validateIntentCard, recordIntentCard, evaluateIntentScope, and detectSessionTestRegression enforce scope and regression breakers", () => {
  assert.ok(validateIntentCard({}).length >= 3);
  assert.ok(validateIntentCard({ goal: "x", affectedGlobs: ["a.js"], rollbackPlan: "git revert", predictedRisk: 1.5 }).length > 0);
  assert.deepEqual(
    validateIntentCard({
      goal: "Add risk card to Timeline",
      affectedGlobs: ["sidecars/astack_timeline/**"],
      assumptions: ["Sidecar stays observe-only"],
      edgeCases: ["Non-git workspace"],
      rollbackPlan: "git revert HEAD",
      predictedRisk: 0.22,
      category: "ui",
    }),
    [],
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-intent-test-"));
  try {
    const { intent, targetPath } = recordIntentCard({
      trustDir: tmp,
      conversationId: "conv/42",
      headSha: "a".repeat(40),
      card: {
        goal: "Tighten timeline styles",
        affectedGlobs: ["sidecars/astack_timeline/**"],
        rollbackPlan: "git revert aaaaaaa",
        predictedRisk: "medium",
      },
    });
    assert.equal(fs.existsSync(targetPath), true);
    assert.equal(intent.category, "ui");
    const loaded = readIntentCard(tmp, "conv/42");
    assert.equal(loaded.goal, "Tighten timeline styles");

    const okScope = evaluateIntentScope(loaded, ["sidecars/astack_timeline/app.js"]);
    assert.equal(okScope.inScope, true);
    assert.equal(okScope.wideScope, false);

    const drifted = evaluateIntentScope(loaded, ["sidecars/astack_timeline/app.js", "hooks.json"]);
    assert.equal(drifted.inScope, false);
    assert.deepEqual(drifted.driftedFiles, ["hooks.json"]);

    const wide = evaluateIntentScope({ affectedGlobs: ["**/*"] }, ["README.md"]);
    assert.equal(wide.wideScope, true);
    assert.match(wide.wideScopeReason, /wildcard/);

    const reg = detectSessionTestRegression([
      { kind: "command", category: "test", summary: "node --run test:trust", ok: true },
      { kind: "command", category: "test", summary: "node --run test:trust", ok: false },
    ]);
    assert.equal(reg.regressed, true);
    assert.deepEqual(reg.commands, ["node --run test:trust"]);

    const recovered = detectSessionTestRegression([
      { kind: "command", category: "test", summary: "node --run test:trust", ok: true },
      { kind: "command", category: "test", summary: "node --run test:trust", ok: false },
      { kind: "command", category: "test", summary: "node --run test:trust", ok: true },
    ]);
    assert.equal(recovered.regressed, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("MCP declare_intent tool persists Intent Card and rollback receipt in git repos and rejects non-git folders", () => {
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "astack-intent-nogit-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "astack-intent-repo-"));
  const artDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-intent-art-"));
  try {
    const errRes = dispatchToolCall("declare_intent", {
      cwd: nonGit,
      goal: "Edit slides",
      affectedGlobs: ["deck.pptx"],
      rollbackPlan: "undo",
    });
    assert.equal(errRes.isError, true);
    assert.match(errRes.content[0].text, /git repository/i);

    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "index.js"), "export const v = 1;\n", "utf8");
    execFileSync("git", ["add", "index.js"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });

    const okRes = dispatchToolCall("declare_intent", {
      cwd: repo,
      artifactDir: artDir,
      conversationId: "conv-intent-1",
      goal: "Update index export",
      affectedGlobs: ["index.js"],
      assumptions: ["No external callers"],
      edgeCases: ["Empty input"],
      rollbackPlan: "git revert HEAD",
      predictedRisk: 0.15,
    });
    assert.equal(okRes.isError, undefined);
    assert.equal(okRes.structuredContent.ok, true);
    assert.equal(fs.existsSync(okRes.structuredContent.targetPath), true);
    assert.equal(fs.existsSync(path.join(artDir, "astack-trust", "receipts.conv-intent-1.jsonl")), true);

    const mixedRes = dispatchToolCall("declare_intent", {
      cwd: repo,
      artifactDir: artDir,
      conversationId: "conv-intent-mixed",
      goal: "Update docs and MCP tools",
      affectedGlobs: ["README.md", "scripts/mcp/tools.mjs"],
      rollbackPlan: "git revert HEAD",
    });
    assert.equal(mixedRes.structuredContent.intent.category, "core");

    const govRes = dispatchToolCall("declare_intent", {
      cwd: repo,
      artifactDir: artDir,
      conversationId: "conv-intent-gov",
      goal: "Update docs and trust engine",
      affectedGlobs: ["README.md", "scripts/trust/index.mjs"],
      rollbackPlan: "git revert HEAD",
    });
    assert.equal(govRes.structuredContent.intent.category, "governance");

    for (const badId of ["../escape", "/../../ledger", "..\\..\\evil"]) {
      const badRes = dispatchToolCall("declare_intent", {
        cwd: repo,
        artifactDir: artDir,
        conversationId: badId,
        goal: "Attempt traversal",
        affectedGlobs: ["index.js"],
        rollbackPlan: "git revert HEAD",
      });
      assert.equal(badRes.isError, true, `Expected traversal rejection for ${badId}`);
      assert.match(badRes.content[0].text, /Invalid conversationId/i);
    }
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artDir, { recursive: true, force: true });
  }
});
