import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_RISK_POLICY,
  applyTrustSettingsAction,
  evaluateCategoryState,
  evaluateDecisionTable,
  evaluateRepoTrust,
  evaluateStageContext,
  evaluateStageHandoff,
  evaluateTrustGate,
  isProtectedTrustShellCommand,
  isProtectedTrustStorePath,
  mapLegacyPolicyFlags,
  readOutcomeLedger,
  readTrustSettings,
  recordIntentCard,
  recordOutcomeWithTrustSync,
  recordReceipt,
  recordRollbackReceipt,
  recordVerifierReceipt,
  resolveBaseRef,
  resolveEffectiveAutonomy,
  resolvePrStatechart,
  resolveTrustDir,
  resolveTrustStoreDir,
  resolveWorkspaceScope,
  writeEvidenceSnapshotAtomic,
} from "../trust/index.mjs";
import { runWorkspaceDoctor } from "../../skills/setup-astack/scripts/setup-banner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const trustGateScript = path.resolve(here, "../hooks/trust-gate.mjs");
const stopScript = path.resolve(here, "../hooks/verify-reminder.mjs");
const prIntentScript = path.resolve(here, "../hooks/pr-intent.mjs");

function runHookCli(scriptPath, stdinObj, env = {}) {
  const stdout = execFileSync(process.execPath, [scriptPath], {
    input: JSON.stringify(stdinObj),
    encoding: "utf8",
    env: { ...process.env, CI: "", NON_INTERACTIVE: "", ...env },
  });
  return JSON.parse(stdout.trim());
}

function makeEnrolledRepo(prefix = "astack-trust-p4-", customPolicy = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
  const policy = {
    schemaVersion: 1,
    autonomy: {
      defaultCeiling: 2,
      auditSampleRate: 5,
      maxBrierScore: 0.12,
      ceilings: {
        docs: 3,
        tests: 3,
        ui: 3,
        skills: 3,
        tooling: 3,
        core: 3,
        governance: 2,
      },
    },
    ...customPolicy,
  };
  fs.writeFileSync(path.join(dir, ".agents", "risk-policy.json"), `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(dir, "sidecars", "astack_timeline"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sidecars", "astack_timeline", "app.js"), "console.log(1);\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const scope = resolveWorkspaceScope(dir);
  return { dir, headSha, scope, policy };
}

function makeCleanEntries(category, count, startMs = Date.UTC(2026, 0, 1)) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      ts: new Date(startMs + i * 86400 * 1000).toISOString(),
      category,
      outcome: "clean",
      y: 1,
      predictedR: 0.08,
      headSha: String(i + 1).padStart(40, "a"),
    });
  }
  return entries;
}

test("trust math properties: EMA gain, instant demotion on y=0, idle decay, category reset, Brier gate, and governance cap", () => {
  const baseStart = Date.UTC(2026, 0, 1);

  const one = evaluateCategoryState({
    category: "ui",
    entries: makeCleanEntries("ui", 1, baseStart),
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 1 * 86400 * 1000,
  });
  assert.equal(one.level, 0);
  assert.equal(one.earnedLevel, 0);

  const four = evaluateCategoryState({
    category: "ui",
    entries: makeCleanEntries("ui", 4, baseStart),
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 4 * 86400 * 1000,
  });
  assert.equal(four.earnedLevel, 0);
  const five = evaluateCategoryState({
    category: "ui",
    entries: makeCleanEntries("ui", 5, baseStart),
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 5 * 86400 * 1000,
  });
  assert.equal(five.earnedLevel, 1);
  assert.ok(Math.abs(five.score - 0.4095) < 0.001);

  const tenEntries = makeCleanEntries("ui", 10, baseStart);
  const ten = evaluateCategoryState({
    category: "ui",
    entries: tenEntries,
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 10 * 86400 * 1000,
  });
  assert.equal(ten.level, 2);
  assert.ok(Math.abs(ten.score - 0.6513) < 0.001);

  const afterRevert = evaluateCategoryState({
    category: "ui",
    entries: [
      ...tenEntries,
      {
        ts: new Date(baseStart + 11 * 86400 * 1000).toISOString(),
        category: "ui",
        outcome: "reverted",
        y: 0,
        predictedR: 0.1,
        headSha: "b".repeat(40),
      },
    ],
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 11 * 86400 * 1000,
  });
  assert.ok(afterRevert.score < ten.score / 2 + 0.002);
  assert.equal(afterRevert.level, 1);

  const twentyEntries = makeCleanEntries("ui", 20, baseStart);
  const twentyOk = evaluateCategoryState({
    category: "ui",
    entries: twentyEntries,
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 20 * 86400 * 1000,
  });
  assert.equal(twentyOk.level, 3);
  assert.ok(twentyOk.score >= 0.85);

  const badBrierEntries = twentyEntries.map((e) => ({ ...e, predictedR: 0.9 }));
  const badBrier = evaluateCategoryState({
    category: "ui",
    entries: badBrierEntries,
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 20 * 86400 * 1000,
  });
  assert.ok(badBrier.brier > 0.12);
  assert.equal(badBrier.level, 2);

  const missedAudit = evaluateCategoryState({
    category: "ui",
    entries: [
      ...twentyEntries,
      {
        ts: new Date(baseStart + 21 * 86400 * 1000).toISOString(),
        category: "ui",
        outcome: "clean",
        y: 1,
        predictedR: 0.05,
        sampledAudit: true,
        auditCompleted: false,
        headSha: "c".repeat(40),
      },
    ],
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 21 * 86400 * 1000,
  });
  assert.equal(missedAudit.missedAudit, true);
  assert.equal(missedAudit.level, 2);

  const decayed = evaluateCategoryState({
    category: "ui",
    entries: twentyEntries,
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 85 * 86400 * 1000,
  });
  assert.ok(decayed.score < 0.75);
  assert.equal(decayed.level, 2);

  const reset = evaluateCategoryState({
    category: "ui",
    entries: twentyEntries,
    ceiling: 3,
    promotionMode: "auto",
    policyReset: true,
    nowMs: baseStart + 20 * 86400 * 1000,
  });
  assert.ok(reset.score <= 0.4);
  assert.equal(reset.earnedLevel, 1);

  const gov = evaluateCategoryState({
    category: "governance",
    entries: makeCleanEntries("governance", 25, baseStart),
    ceiling: 3,
    maxCeiling: 3,
    promotionMode: "auto",
    confirmedLevel: 0,
    nowMs: baseStart + 25 * 86400 * 1000,
  });
  assert.equal(gov.ceiling, 2);
  assert.equal(gov.maxCeiling, 2);
  assert.equal(gov.earnedLevel, 2);
  assert.equal(gov.level, 0);
  assert.equal(gov.promoReady, true);
  assert.equal(gov.eligibleNextLevel, 1);

  const stricter = resolveEffectiveAutonomy(
    {
      ...DEFAULT_RISK_POLICY,
      autonomy: {
        defaultCeiling: 2,
        promotion: "manual",
        ceilings: { docs: 2, ui: 1, governance: 3 },
      },
    },
    {
      promotionMode: "auto",
      ceilings: { docs: 3, ui: 3, governance: 3 },
    },
  );
  assert.equal(stricter.promotionMode, "manual");
  assert.equal(stricter.promotionLockedByPolicy, true);
  assert.equal(stricter.ceilings.ui, 1);
  assert.equal(stricter.ceilings.docs, 2);
  assert.equal(stricter.ceilings.governance, 2);

  const cappedRevert = evaluateCategoryState({
    category: "ui",
    entries: [
      ...twentyEntries,
      {
        ts: new Date(baseStart + 21 * 86400 * 1000).toISOString(),
        category: "ui",
        outcome: "reverted",
        y: 0,
        predictedR: 0.05,
        headSha: "d".repeat(40),
      },
    ],
    ceiling: 2,
    promotionMode: "auto",
    nowMs: baseStart + 21 * 86400 * 1000,
  });
  assert.equal(cappedRevert.level, 1);

  const manualRepo = makeEnrolledRepo("astack-manual-rev-");
  const manualData = fs.mkdtempSync(path.join(os.tmpdir(), "astack-manual-rev-data-"));
  try {
    for (let i = 0; i < 12; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: manualRepo.dir,
        scope: manualRepo.scope,
        policy: manualRepo.policy,
        category: "ui",
        outcome: "clean",
        headSha: manualRepo.headSha,
        predictedR: 0.08,
        dataDir: manualData,
      });
    }
    const promoted = applyTrustSettingsAction({
      repoId: manualRepo.scope.repoId,
      policy: manualRepo.policy,
      action: { promoteCategory: "ui" },
      dataDir: manualData,
    });
    assert.equal(promoted.trust.categories.ui.level, 1);
    assert.equal(promoted.trust.categories.ui.earnedLevel, 2);
    const afterManualRevert = recordOutcomeWithTrustSync({
      workspaceDir: manualRepo.dir,
      scope: manualRepo.scope,
      policy: manualRepo.policy,
      category: "ui",
      outcome: "reverted",
      headSha: manualRepo.headSha,
      predictedR: 0.08,
      dataDir: manualData,
    });
    assert.equal(afterManualRevert.trust.categories.ui.level, 0);
  } finally {
    fs.rmSync(manualRepo.dir, { recursive: true, force: true });
    fs.rmSync(manualData, { recursive: true, force: true });
  }
});

test("decision table matrix, exact pause reason, pure revert at L2+, and legacy allowTier0AutoMerge read shim", () => {
  assert.equal(evaluateDecisionTable({ action: "read", residual: "blocked", beastOn: true }).decision, "allow");

  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "low", trustLevel: 1, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "local_exec", residual: "medium", trustLevel: 1, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "low", trustLevel: 0, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "high", trustLevel: 3, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "blocked", trustLevel: 3, beastOn: true }).decision, "deny");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "low", trustLevel: 2, beastOn: false }).decision, "allow");

  assert.equal(evaluateDecisionTable({ action: "push_branch", residual: "low", trustLevel: 2, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "open_pr", residual: "medium", trustLevel: 2, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "open_pr", residual: "low", trustLevel: 1, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "push_branch", residual: "high", trustLevel: 3, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "open_pr", residual: "blocked", trustLevel: 3, beastOn: true }).decision, "deny");

  const mergePaused = evaluateDecisionTable({
    action: "merge",
    residual: "medium",
    trustLevel: 2,
    category: "ui",
    trustScore: 0.71,
    riskScore: 0.22,
    signals: [{ id: "public_surface_changed" }],
    beastOn: true,
  });
  assert.equal(mergePaused.decision, "force_ask");
  assert.equal(
    mergePaused.reason,
    "Paused. Merge needs L3 for ui, current L2 (T 0.71). Residual medium (R 0.22) from public_surface_changed.",
  );
  assert.equal(
    evaluateDecisionTable({ action: "merge", residual: "low", trustLevel: 3, category: "ui", beastOn: true }).decision,
    "auto_approve",
  );
  assert.equal(
    evaluateDecisionTable({ action: "merge", residual: "low", trustLevel: 3, category: "governance", beastOn: true }).decision,
    "force_ask",
  );
  assert.equal(
    evaluateDecisionTable({ action: "merge", residual: "low", trustLevel: 2, category: "ui", beastOn: true, isOwnRevert: true }).decision,
    "auto_approve",
  );

  for (const act of ["deploy", "external_message", "destructive"]) {
    assert.equal(evaluateDecisionTable({ action: act, residual: "low", trustLevel: 3, beastOn: true }).decision, "force_ask");
    assert.equal(evaluateDecisionTable({ action: act, residual: "medium", trustLevel: 3, beastOn: true }).decision, "force_ask");
    assert.equal(evaluateDecisionTable({ action: act, residual: "high", trustLevel: 3, beastOn: true }).decision, "deny");
    assert.equal(evaluateDecisionTable({ action: act, residual: "blocked", trustLevel: 3, beastOn: true }).decision, "deny");
  }

  assert.equal(
    evaluateDecisionTable({ action: "merge", residual: "low", trustLevel: 2, beastOn: true, headless: true }).decision,
    "deny",
  );

  const legacyPolicy = {
    ...DEFAULT_RISK_POLICY,
    allowTier0AutoMerge: true,
    humanGates: { planApproval: "nontrivial", prReview: "tier0-auto" },
  };
  assert.equal(mapLegacyPolicyFlags(legacyPolicy).tier0AutoMerge, true);
  const shimMerge = evaluateDecisionTable({
    action: "merge",
    residual: "low",
    trustLevel: 1,
    category: "docs",
    beastOn: true,
    policy: legacyPolicy,
  });
  assert.equal(shimMerge.decision, "auto_approve");
  assert.equal(shimMerge.viaLegacyShim, true);
  const shimCore = evaluateDecisionTable({
    action: "merge",
    residual: "low",
    trustLevel: 1,
    category: "core",
    beastOn: true,
    policy: legacyPolicy,
  });
  assert.equal(shimCore.decision, "force_ask");
});

test("trust-gate CLI hook denies protected trust store edits, fails safe on corrupt files, and enforces scope + decision table", () => {
  const { dir, headSha, scope, policy } = makeEnrolledRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-trust-data-"));
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-nongit-p4-"));
  const env = { ASTACK_PLUGIN_DATA: dataDir };
  try {
    const storeDir = resolveTrustStoreDir(scope.repoId, { dataDir });

    const writeProtected = runHookCli(
      trustGateScript,
      {
        cwd: nonGitDir,
        toolCall: {
          name: "write_file",
          args: { Path: path.join(storeDir, "settings.json"), Content: '{"beastOn":true}' },
        },
      },
      env,
    );
    assert.equal(writeProtected.decision, "deny");
    assert.match(writeProtected.reason, /forbidden/i);

    const shellCliPromote = runHookCli(
      trustGateScript,
      {
        cwd: dir,
        toolCall: {
          name: "run_command",
          args: { CommandLine: "node scripts/trust/cli.mjs promotion auto" },
        },
      },
      env,
    );
    assert.equal(shellCliPromote.decision, "deny");

    const shellEditLedger = runHookCli(
      trustGateScript,
      {
        cwd: dir,
        toolCall: {
          name: "run_command",
          args: { CommandLine: `echo '{}' >> "${path.join(storeDir, "ledger.jsonl")}"` },
        },
      },
      env,
    );
    assert.equal(shellEditLedger.decision, "deny");
    assert.equal(isProtectedTrustShellCommand("node scripts/trust/cli.mjs status", { dataDir }), false);

    const nonGitRes = runHookCli(
      trustGateScript,
      {
        cwd: nonGitDir,
        toolCall: { name: "write_file", args: { Path: path.join(nonGitDir, "notes.md"), Content: "hi" } },
      },
      env,
    );
    assert.deepEqual(nonGitRes, { decision: "allow" });

    for (let i = 0; i < 10; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: dir,
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
    const trustDir = resolveTrustDir({ workspaceDir: dir });

    recordIntentCard({
      trustDir,
      conversationId: "conv-gate",
      headSha,
      card: {
        goal: "Polish Timeline tooltip",
        affectedGlobs: ["sidecars/astack_timeline/**"],
        rollbackPlan: `git revert ${headSha.slice(0, 7)}`,
        category: "ui",
        approved: true,
      },
    });
    recordReceipt({
      kind: "tool-command",
      phase: "post",
      conversationId: "conv-gate",
      command: "node --test sidecars/astack_timeline/timeline.test.mjs",
      error: "",
      workspaceDir: dir,
    });
    const inScopeWrite = runHookCli(
      trustGateScript,
      {
        conversationId: "conv-gate",
        cwd: dir,
        toolCall: {
          name: "edit_file",
          args: {
            Path: path.join(dir, "sidecars", "astack_timeline", "app.js"),
            Replacement: "console.log(2);\n",
          },
        },
      },
      env,
    );
    assert.equal(inScopeWrite.decision, "auto_approve");

    const driftWrite = runHookCli(
      trustGateScript,
      {
        conversationId: "conv-gate",
        cwd: dir,
        toolCall: {
          name: "edit_file",
          args: {
            Path: path.join(dir, "scripts", "other.mjs"),
            Replacement: "export const x = 1;\n",
          },
        },
      },
      env,
    );
    assert.equal(driftWrite.decision, "deny");
    assert.match(driftWrite.reason, /scope_drift/);
    assert.match(driftWrite.reason, /hypotheses/i);

    const pushRes = runHookCli(
      trustGateScript,
      {
        conversationId: "conv-gate",
        cwd: dir,
        toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/ui" } },
      },
      env,
    );
    assert.equal(pushRes.decision, "auto_approve");

    const mergeRes = runHookCli(
      trustGateScript,
      {
        conversationId: "conv-gate",
        cwd: dir,
        toolCall: { name: "run_command", args: { CommandLine: "gh pr merge 12 --squash" } },
      },
      env,
    );
    assert.equal(mergeRes.decision, "force_ask");
    assert.match(mergeRes.reason, /Merge needs L3 for ui, current L2/);

    fs.writeFileSync(path.join(storeDir, "settings.json"), "{corrupt json", "utf8");
    const corruptSettingsRes = runHookCli(
      trustGateScript,
      {
        conversationId: "conv-gate",
        cwd: dir,
        toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/ui" } },
      },
      env,
    );
    assert.deepEqual(corruptSettingsRes, { decision: "allow" });

    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { beastOn: true, promotionMode: "auto" },
      dataDir,
    });
    const ledgerFile = path.join(storeDir, "ledger.jsonl");
    const tampered = fs.readFileSync(ledgerFile, "utf8").replace('"clean"', '"reverted"');
    fs.writeFileSync(ledgerFile, tampered, "utf8");
    const frozenTrust = evaluateRepoTrust({ repoId: scope.repoId, policy, dataDir });
    assert.equal(frozenTrust.frozen, true);
    assert.equal(frozenTrust.beastOn, false);
    assert.equal(frozenTrust.categories.ui.level, 0);

    const tamperedGate = runHookCli(
      trustGateScript,
      {
        conversationId: "conv-gate",
        cwd: dir,
        toolCall: { name: "run_command", args: { CommandLine: "git push origin feat/ui" } },
      },
      env,
    );
    assert.deepEqual(tamperedGate, { decision: "allow" });

    const prevEnv = process.env.ASTACK_PLUGIN_DATA;
    process.env.ASTACK_PLUGIN_DATA = dataDir;
    try {
      const doctor = runWorkspaceDoctor({ cwd: dir });
      const ledgerCheck = doctor.checks.find((c) => c.id === "trust-ledger");
      assert.equal(ledgerCheck?.status, "warn");
      assert.match(ledgerCheck?.detail ?? "", /hash chain broken/i);
    } finally {
      if (prevEnv === undefined) delete process.env.ASTACK_PLUGIN_DATA;
      else process.env.ASTACK_PLUGIN_DATA = prevEnv;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});

test("Stop stage-handoff and PreInvocation stage context via control-cli respect gates, breakers, and transition caps", () => {
  const { dir, headSha, scope, policy } = makeEnrolledRepo("astack-handoff-");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-handoff-data-"));
  const env = { ASTACK_PLUGIN_DATA: dataDir };
  try {
    for (let i = 0; i < 10; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: dir,
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

    const trustDir = resolveTrustDir({ workspaceDir: dir });
    recordIntentCard({
      trustDir,
      conversationId: "conv-hand",
      headSha,
      card: {
        goal: "Update Timeline badge",
        affectedGlobs: ["sidecars/astack_timeline/**"],
        rollbackPlan: `git revert ${headSha.slice(0, 7)}`,
        category: "ui",
        approved: true,
      },
    });
    recordReceipt({
      kind: "tool-write",
      phase: "post",
      conversationId: "conv-hand",
      filePath: path.join(dir, "sidecars", "astack_timeline", "app.js"),
      chunks: ["console.log(2);"],
      error: "",
      workspaceDir: dir,
    });
    recordReceipt({
      kind: "tool-command",
      phase: "post",
      conversationId: "conv-hand",
      command: "node --test sidecars/astack_timeline/timeline.test.mjs",
      error: "",
      workspaceDir: dir,
    });

    const preRes = runHookCli(
      prIntentScript,
      {
        conversationId: "conv-hand",
        cwd: dir,
        lastUserInput: "continue building",
      },
      env,
    );
    assert.equal(preRes.injectSteps?.length, 1);
    assert.match(preRes.injectSteps[0].ephemeralMessage, /AStack Beast Mode active/);
    assert.match(preRes.injectSteps[0].ephemeralMessage, /category=ui, L2/);

    const stop1 = runHookCli(
      stopScript,
      {
        conversationId: "conv-hand",
        cwd: dir,
        fullyIdle: true,
        terminationReason: "model_stop",
        continuationActive: false,
        executionNum: 1,
      },
      env,
    );
    assert.equal(stop1.decision, "continue");
    assert.match(stop1.reason, /Stage 2 -> Stage 3/);

    const stop2 = runHookCli(
      stopScript,
      {
        conversationId: "conv-hand",
        cwd: dir,
        fullyIdle: true,
        terminationReason: "model_stop",
        continuationActive: false,
        executionNum: 2,
      },
      env,
    );
    assert.equal(stop2.decision, "continue");

    const stop3 = runHookCli(
      stopScript,
      {
        conversationId: "conv-hand",
        cwd: dir,
        fullyIdle: true,
        terminationReason: "model_stop",
        continuationActive: false,
        executionNum: 1,
      },
      env,
    );
    assert.deepEqual(stop3, { decision: "allow" });

    assert.deepEqual(
      evaluateStageHandoff(
        {
          kind: "stop",
          conversationId: "conv-other",
          workspaceDir: dir,
          fullyIdle: false,
          terminationReason: "model_stop",
          continuationActive: false,
          executionNum: 1,
        },
        { dataDir },
      ),
      { decision: "allow" },
    );

    recordVerifierReceipt({
      trustDir,
      headSha,
      verdict: "PASS",
      summary: "pr-verifier PASS",
    });
    recordRollbackReceipt({
      trustDir,
      headSha,
      plan: `git revert ${headSha.slice(0, 7)}`,
    });
    writeEvidenceSnapshotAtomic(trustDir, {
      headSha,
      freshness: "fresh",
      roundState: "verified",
      verifier: { verdict: "PASS", headSha, stale: false, importantCount: 0, reviewViolationCount: 0 },
      riskAssessment: { category: "ui", residual: "low", score: 0.05, signals: [], rollback: { kind: "revert", plan: `git revert ${headSha.slice(0, 7)}` } },
    });

    const l2MergeStop = runHookCli(
      stopScript,
      {
        conversationId: "conv-l2-merge",
        cwd: dir,
        fullyIdle: true,
        terminationReason: "model_stop",
        continuationActive: false,
        executionNum: 1,
      },
      env,
    );
    assert.deepEqual(l2MergeStop, { decision: "allow" });

    for (let i = 0; i < 10; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: dir,
        scope,
        policy,
        category: "ui",
        outcome: "clean",
        headSha,
        predictedR: 0.05,
        dataDir,
      });
    }
    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { setCeiling: { category: "ui", ceiling: 3 } },
      dataDir,
    });
    const l3MergeStop = runHookCli(
      stopScript,
      {
        conversationId: "conv-l3-merge",
        cwd: dir,
        fullyIdle: true,
        terminationReason: "model_stop",
        continuationActive: false,
        executionNum: 1,
      },
      env,
    );
    assert.equal(l3MergeStop.decision, "continue");
    assert.match(l3MergeStop.reason, /Stage 3 -> Stage 4/);

    recordReceipt({
      kind: "tool-command",
      phase: "post",
      conversationId: "conv-l3-merge",
      command: "node --test sidecars/astack_timeline/timeline.test.mjs",
      error: "exit 1",
      workspaceDir: dir,
    });
    const regStop = runHookCli(
      stopScript,
      {
        conversationId: "conv-l3-breaker",
        cwd: dir,
        fullyIdle: true,
        terminationReason: "model_stop",
        continuationActive: false,
        executionNum: 1,
      },
      env,
    );
    assert.deepEqual(regStop, { decision: "allow" });

    assert.deepEqual(
      evaluateStageContext({ kind: "pre-invocation", workspaceDir: os.tmpdir(), lastUserInput: "hi" }, { dataDir }),
      {},
    );

    const staleSha = "1".repeat(40);
    const staleWithGovReceipts = evaluateStageContext(
      { kind: "pre-invocation", conversationId: "conv-stale", workspaceDir: dir, lastUserInput: "continue" },
      {
        dataDir,
        headSha,
        evidence: {
          headSha: staleSha,
          riskAssessment: {
            headSha: staleSha,
            category: "docs",
            residual: "low",
            score: 0.02,
            requiredMitigations: [],
            satisfied: [],
          },
        },
        receipts: [
          {
            kind: "file_write",
            ts: "2026-11-24T00:00:01Z",
            headSha,
            ok: true,
            paths: ["hooks.json"],
          },
        ],
        intent: null,
      },
    );
    assert.equal(staleWithGovReceipts.injectSteps?.length, 1);
    assert.match(staleWithGovReceipts.injectSteps[0].ephemeralMessage, /category=governance/);
    assert.match(staleWithGovReceipts.injectSteps[0].ephemeralMessage, /residual=blocked/);
    assert.doesNotMatch(staleWithGovReceipts.injectSteps[0].ephemeralMessage, /category=docs/);
    assert.doesNotMatch(staleWithGovReceipts.injectSteps[0].ephemeralMessage, /R=0\.02/);

    const staleWithoutChanges = evaluateStageContext(
      { kind: "pre-invocation", conversationId: "conv-stale-empty", workspaceDir: dir, lastUserInput: "continue" },
      {
        dataDir,
        headSha,
        evidence: {
          headSha: staleSha,
          riskAssessment: {
            headSha: staleSha,
            category: "docs",
            residual: "high",
            score: 0.77,
            requiredMitigations: [],
            satisfied: [],
          },
        },
        receipts: [],
        intent: null,
      },
    );
    assert.equal(staleWithoutChanges.injectSteps?.length, 1);
    assert.doesNotMatch(staleWithoutChanges.injectSteps[0].ephemeralMessage, /category=docs/);
    assert.doesNotMatch(staleWithoutChanges.injectSteps[0].ephemeralMessage, /R=0\.77/);
    assert.match(staleWithoutChanges.injectSteps[0].ephemeralMessage, /category=core/);
    assert.match(staleWithoutChanges.injectSteps[0].ephemeralMessage, /R=0\.00/);

    const dirtyAfterEvidenceReceipts = [
      {
        kind: "file_write",
        ts: "2026-11-24T10:05:00Z",
        headSha,
        ok: true,
        paths: ["hooks.json"],
      },
      {
        kind: "command",
        category: "test",
        ts: "2026-11-24T10:06:00Z",
        headSha,
        ok: true,
        summary: "node --test",
      },
    ];
    const olderEvidenceSameSha = {
      headSha,
      generatedAt: "2026-11-24T10:00:00Z",
      riskAssessment: {
        headSha,
        category: "docs",
        residual: "low",
        score: 0,
        signals: [],
        requiredMitigations: [],
        satisfied: [],
      },
    };
    const dirtyCtx = evaluateStageContext(
      { kind: "pre-invocation", conversationId: "conv-dirty-ev", workspaceDir: dir, lastUserInput: "continue" },
      { dataDir, headSha, evidence: olderEvidenceSameSha, receipts: dirtyAfterEvidenceReceipts, intent: null },
    );
    assert.match(dirtyCtx.injectSteps[0].ephemeralMessage, /category=governance/);
    assert.match(dirtyCtx.injectSteps[0].ephemeralMessage, /residual=blocked/);

    const dirtyHandoff = evaluateStageHandoff(
      { kind: "stop", conversationId: "conv-dirty-stop", workspaceDir: dir, fullyIdle: true, terminationReason: "model_stop" },
      { dataDir, headSha, evidence: olderEvidenceSameSha, receipts: dirtyAfterEvidenceReceipts, intent: null },
    );
    assert.deepEqual(dirtyHandoff, { decision: "allow" });

    const dirtyPushGate = evaluateTrustGate(
      { kind: "tool-command", conversationId: "conv-dirty-push", workspaceDir: dir, command: "git push origin feat/x" },
      { dataDir, headSha, evidence: olderEvidenceSameSha, receipts: dirtyAfterEvidenceReceipts, intent: null },
    );
    assert.equal(dirtyPushGate.decision, "deny");

    const innerMismatchCtx = evaluateStageContext(
      { kind: "pre-invocation", conversationId: "conv-inner-mismatch", workspaceDir: dir, lastUserInput: "continue" },
      {
        dataDir,
        headSha,
        evidence: {
          headSha,
          riskAssessment: { headSha: staleSha, category: "docs", residual: "low", score: 0.01 },
        },
        receipts: [{ kind: "file_write", ts: "2026-11-24T10:01:00Z", headSha, ok: true, paths: ["hooks.json"] }],
        intent: null,
      },
    );
    assert.match(innerMismatchCtx.injectSteps[0].ephemeralMessage, /category=governance/);
    assert.match(innerMismatchCtx.injectSteps[0].ephemeralMessage, /residual=blocked/);

    const unanchoredEvCtx = evaluateStageContext(
      { kind: "pre-invocation", conversationId: "conv-unanchored", workspaceDir: dir, lastUserInput: "continue" },
      {
        dataDir,
        headSha,
        evidence: { riskAssessment: { category: "docs", residual: "high", score: 0.77 } },
        receipts: [],
        intent: null,
      },
    );
    assert.doesNotMatch(unanchoredEvCtx.injectSteps[0].ephemeralMessage, /R=0\.77/);
    assert.match(unanchoredEvCtx.injectSteps[0].ephemeralMessage, /category=core/);

    const resolvedCtx = evaluateStageContext(
      { kind: "pre-invocation", conversationId: "conv-resolved", workspaceDir: dir, lastUserInput: "continue" },
      {
        dataDir,
        headSha,
        evidence: {
          headSha,
          generatedAt: "2026-11-24T10:00:00Z",
          riskAssessment: {
            headSha,
            category: "tooling",
            residual: "medium",
            score: 0.28,
            signals: [{ id: "untested_change", severity: 2, weight: 0.28, evidence: "scripts/cli/title.mjs" }],
            requiredMitigations: ["targeted_tests", "test_coverage"],
            satisfied: [],
          },
        },
        receipts: [
          { kind: "file_write", ts: "2026-11-24T09:59:00Z", headSha, ok: true, paths: ["scripts/cli/title.mjs"] },
          { kind: "command", category: "test", ts: "2026-11-24T10:01:00Z", headSha, ok: true, summary: "node --test" },
        ],
        intent: null,
      },
    );
    assert.match(resolvedCtx.injectSteps[0].ephemeralMessage, /residual=low R=0\.07/);
    assert.doesNotMatch(resolvedCtx.injectSteps[0].ephemeralMessage, /missing mitigations/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("zero-Java formal verifier verifies real scripts/trust/index.mjs exports and emits formal-ts statechart", () => {
  const verifierScript = path.resolve(
    here,
    "../../.agents/skills/verify-earned-trust-formal/scripts/verify-trust.ts",
  );
  assert.equal(fs.existsSync(verifierScript), true, "Missing verify-trust.ts");

  const helpOut = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", verifierScript, "--help"],
    { encoding: "utf8" },
  );
  assert.match(helpOut, /Usage:/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-trust-formal-"));
  const mmdPath = path.join(tmpDir, "earned-trust.mmd");
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        verifierScript,
        "--emit-mermaid",
        mmdPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true, JSON.stringify(report.findings));
    assert.deepEqual(report.findings, []);
    assert.equal(report.properties.EffectiveAutonomyPolicyPrecedence.status, "pass");
    assert.ok(report.properties.EffectiveAutonomyPolicyPrecedence.statesChecked >= 378);
    assert.equal(report.properties.DecisionTableSafetyMatrix.status, "pass");
    assert.ok(report.properties.DecisionTableSafetyMatrix.statesChecked >= 3072);
    assert.equal(report.properties.CategoryStateAndDemotionInvariants.status, "pass");
    assert.ok(report.properties.CategoryStateAndDemotionInvariants.statesChecked >= 2300);
    assert.equal(report.properties.EarnedTrustLifecycleBFS.status, "pass");
    assert.ok(report.properties.EarnedTrustLifecycleBFS.visitedStates >= 400);
    assert.ok(report.properties.EarnedTrustLifecycleBFS.transitions >= 2000);

    const chart = resolvePrStatechart({ statechartPath: mmdPath });
    assert.equal(chart.source, "formal-ts");
    assert.match(chart.mermaid, /stateDiagram-v2/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("security regressions: trust-gate blocks flag-prefixed cli.mjs, cd+cli.mjs, env vars, symlinks, workspace-relative paths, unverified merges, and governance handoff", () => {
  const { dir, headSha } = makeEnrolledRepo("astack-trust-sec-reg-");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-trust-sec-pd-"));
  try {
    const scope = resolveWorkspaceScope(dir, { baseRef: "main" });
    const policy = DEFAULT_RISK_POLICY;

    assert.equal(isProtectedTrustShellCommand("node scripts/trust/cli.mjs --cwd . beast on", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("node scripts/trust/cli.mjs --data-dir /tmp/x promote core", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("cd scripts/trust && node cli.mjs beast on", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("echo {} > $ASTACK_PLUGIN_DATA/trust/abc/settings.json", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("echo {} > %ASTACK_PLUGIN_DATA%\\trust\\abc\\settings.json", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("node scripts/trust/cli.mjs --cwd . status --json", { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand('node -e "console.log(1 + 1)"', { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand('/bin/bash -c "node scripts/trust/cli.mjs beast on"', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('env -i /bin/bash -c "node scripts/trust/cli.mjs promote ui"', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("node scripts/trust/./cli.mjs beast on", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("cd scripts/trust/internal && node ../cli.mjs beast on", { dataDir }), true);
    assert.equal(
      isProtectedTrustShellCommand('node -e "import(\'./scripts/trust/index.mjs\').then(m => m.applyTrustSettingsAction({}))"', { dataDir }),
      true,
    );
    assert.equal(
      isProtectedTrustShellCommand("python -c \"open('plugin-data/astack/trust/a/settings.json','w').write('{}')\"", { dataDir }),
      true,
    );
    assert.equal(isProtectedTrustShellCommand("pwsh -EncodedCommand SQBFAFgA", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("pwsh -EncodedCommand:SQBFAFgA", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("T=trust; echo {} > /tmp/plugin-data/astack/$T/a/settings.json", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('echo {} > /tmp/plugin-data/astack/t"r"ust/a/settings.json', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('node "scripts/trust/"cli.mjs beast on', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('node scripts/trust/cli.mjs "b"east on', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('node scripts/trust/cli.mjs b"e"ast on', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand("node scripts/trust/cli.mjs b\\east on", { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('sh -c "$0 $@" node scripts/trust/cli.mjs beast on', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('sh -c \'"$@"\' _ node scripts/trust/cli.mjs beast on', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('eval "node" "scripts/trust/cli.mjs" "beast" "on"', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('env -u UNUSED /bin/bash -c "node scripts/trust/cli.mjs beast on"', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('bash -c"node scripts/trust/cli.mjs beast on"', { dataDir }), true);
    assert.equal(isProtectedTrustShellCommand('echo "node scripts/trust/cli.mjs beast on" | bash', { dataDir }), true);
    assert.equal(
      isProtectedTrustShellCommand('printf "import(\'./scripts/trust/index.mjs\').then(m=>m.applyTrustSettingsAction({}))" | node --input-type=module', { dataDir }),
      true,
    );
    assert.equal(
      isProtectedTrustShellCommand("node -e \"import('./scripts/' + 'trust/index.mjs').then(m=>m['applyTrust'+'SettingsAction']({}))\"", { dataDir }),
      true,
    );
    assert.equal(isProtectedTrustShellCommand("node scripts/trust/cli.mjs status", { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand('echo "hello" | bash', { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand("node -e \"console.log('a' + 'b')\"", { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand("cat scripts/trust/cli.mjs | grep beast", { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand('grep foo <<< "bar"', { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand("echo hi | xargs echo", { dataDir }), false);
    assert.equal(isProtectedTrustShellCommand('bash -c "node scripts/trust/cli.mjs status"', { dataDir }), false);

    for (const bypassCmd of [
      'env -S "node scripts/trust/cli.mjs beast on"',
      'env --split-string="node scripts/trust/cli.mjs beast on"',
      "env -C scripts/trust node cli.mjs beast on",
      "bash -c 'echo \"node scripts/trust/cli.mjs beast on\" | bash'",
      "bash -c 'printf \"import(\\\"./scripts/trust/index.mjs\\\").then(m=>m.applyTrustSettingsAction({}))\" | node --input-type=module'",
      "sh -c 'echo bm9kZSBzY3JpcHRzL3RydXN0L2NsaS5tanMgYmVhc3Qgb24= | base64 -d | bash'",
      'exec bash -c "node scripts/trust/cli.mjs beast on"',
      'exec node -e "import(\'./scripts/trust/index.mjs\').then(m=>m.applyTrustSettingsAction({}))"',
      "exec pwsh -EncodedCommand SQBFAFgA",
      'timeout 10 bash -c "node scripts/trust/cli.mjs beast on"',
      'bash -c -- "node scripts/trust/cli.mjs beast on"',
      'bash -c -e "node scripts/trust/cli.mjs beast on"',
      'bash --rcfile /dev/null -c "node scripts/trust/cli.mjs beast on"',
      "sh -c 'node scripts/trust/cli.mjs $1 on' _ beast",
      "node scripts/trust/cli.mjs $'beast' on",
      "(node scripts/trust/cli.mjs undo)",
      "powershell /EncodedCommand SQBFAFgA",
      'pwsh /c "node scripts/trust/cli.mjs beast on"',
      "node scripts/trust/cli.mjs be`ast on",
      "node scripts/trust/cli.mjs \u201cb\u201deast on",
      'bash <<< "node scripts/trust/cli.mjs beast on"',
      "node --input-type=module <<< \"import('./scripts/trust/index.mjs').then(m=>m.applyTrustSettingsAction({}))\"",
      'printf "beast on" | xargs node scripts/trust/cli.mjs',
      'source <(echo "node scripts/trust/cli.mjs beast on")',
      "deno eval \"import('./scripts/trust/index.mjs').then(m=>m.applyTrustSettingsAction({}))\"",
      "node --import \"data:text/javascript,import('./scripts/trust/index.mjs').then(m=>m.applyTrustSettingsAction({}))\"",
      "node -e \"const x='';import(`./scri${x}pts/tr${x}ust/index.mjs`).then(m=>m[`applyTr${x}ustSettingsAction`]({}))\"",
      'echo "no tsaeb sjm.ilc/tsurt/stpircs edon" | rev | bash',
      'cd "$ASTACK_PLUGIN_DATA" && echo \'{"beastOn":true}\' > trust/abc/settings.json',
      "$D = $env:ASTACK_PLUGIN_DATA; Set-Content \"$D/trust/abc/settings.json\" '{}'",
      'env -S"node scripts/trust/cli.mjs beast on"',
      "env -Cscripts/trust node cli.mjs beast on",
      'echo "node scripts/trust/cli.mjs beast on" | env -S "bash"',
      'echo "bm9kZSBzY3JpcHRzL3RydXN0L2NsaS5tanMgYmVhc3Qgb24=" | base64 -d | env -S "bash -s"',
      'echo \u2018; node -e "import(\'./scripts/trust/index.mjs\').then(m=>m.applyTrustSettingsAction({}))"',
      'echo $\'\\\'\'; node -e "import(\'./scripts/trust/index.mjs\').then(m=>m.applyTrustSettingsAction({}))"',
      'cat $(cp /tmp/fake "$ASTACK_PLUGIN_DATA/trust/abc/settings.json")',
      'echo "$(node scripts/trust/cli.mjs beast on)"',
      'bash -O extglob -c "node scripts/trust/cli.mjs beast on"',
      'time node -e "import(\'./scripts/trust/index.mjs\').then(m=>m.applyTrustSettingsAction({}))"',
      'n\\ode -e "import(\'./scripts/trust/index.mjs\').then(m=>m.applyTrustSettingsAction({}))"',
      'powershell "node scripts/trust/cli.mjs beast on"',
      'pwsh -cwa "node scripts/trust/cli.mjs beast on"',
      'printf "beast on" | xargs -I{} node scripts/trust/cli.mjs {}',
      'python3 -Bc "open(\'plugin-data/\' \'astack/\' \'trust/abc/settings.json\',\'w\').write(\'{}\')"',
      'source <(echo "bm9kZSBzY3JpcHRzL3RydXN0L2NsaS5tanMgYmVhc3Qgb24=" | base64 -d)',
      "python -c \"open('plugin_data/astack/trust/a/settings.json','w').write('{}')\"",
      "cd ~/.gemini/antigravity/plugin_data && cd astack && echo '{}' > trust/abc/settings.json",
      "cd ~/.gemini/antigravity/plugin-data && cd astack && echo '{}' > trust/abc/settings.json",
      "cd /d %ASTACK_PLUGIN_DATA% && echo {} > trust\\abc\\settings.json",
      "node --input-type=module << 'EOF'\nimport m from './scripts/trust/index.mjs';\nm.applyTrustSettingsAction({});\nEOF",
      "node scripts/trust/cli.mjs $'\\142east' on",
      "echo {} > ${env:ASTACK_PLUGIN_DATA}\\trust\\abc\\settings.json",
      "printf '\\x6eode scripts/\\x74rust/cli.mjs beast on' | bash",
    ]) {
      assert.equal(isProtectedTrustShellCommand(bypassCmd, { dataDir }), true, `Expected block for: ${bypassCmd}`);
    }

    const storeDir = resolveTrustStoreDir(scope.repoId, { dataDir });
    fs.mkdirSync(storeDir, { recursive: true });
    const realSettings = path.join(storeDir, "settings.json");
    fs.writeFileSync(realSettings, "{}\n", "utf8");
    const relFromRepo = path.relative(dir, realSettings);
    assert.equal(isProtectedTrustStorePath(relFromRepo, { dataDir, workspaceDir: dir }), true);

    const symPath = path.join(dir, "innocent-link.json");
    let symlinkCreated = false;
    try {
      fs.symlinkSync(realSettings, symPath);
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      assert.equal(isProtectedTrustStorePath(symPath, { dataDir, workspaceDir: dir }), true);
      const symDecision = evaluateTrustGate(
        { kind: "tool-write", filePath: symPath, chunks: ["{}"], workspaceDir: dir },
        { dataDir, baseRef: "main" },
      );
      assert.equal(symDecision.decision, "deny");

      const danglingTarget = path.join(storeDir, "future-settings.json");
      const danglingPath = path.join(dir, "dangling-link.json");
      fs.symlinkSync(danglingTarget, danglingPath);
      assert.equal(isProtectedTrustStorePath(danglingPath, { dataDir, workspaceDir: dir }), true);
      const danglingDecision = evaluateTrustGate(
        { kind: "tool-write", filePath: danglingPath, chunks: ["{}"], workspaceDir: dir },
        { dataDir, baseRef: "main" },
      );
      assert.equal(danglingDecision.decision, "deny");

      const subDir = path.join(path.dirname(path.dirname(storeDir)), "sub");
      fs.mkdirSync(subDir, { recursive: true });
      const relLeafTarget = path.join("..", "trust", scope.repoId, "settings.json");
      fs.symlinkSync(relLeafTarget, path.join(subDir, "p.json"));
      const symDir = path.join(dir, "sym");
      fs.symlinkSync(subDir, symDir, "dir");
      const nestedSymPath = path.join(symDir, "p.json");
      assert.equal(isProtectedTrustStorePath(nestedSymPath, { dataDir, workspaceDir: dir }), true);
      const nestedDecision = evaluateTrustGate(
        { kind: "tool-write", filePath: nestedSymPath, chunks: ["{}"], workspaceDir: dir },
        { dataDir, baseRef: "main" },
      );
      assert.equal(nestedDecision.decision, "deny");
    }

    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      dataDir,
      action: { beastOn: true, promotionMode: "auto", setCeiling: { category: "docs", ceiling: 3 } },
    });
    for (let i = 0; i < 20; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: dir,
        scope,
        policy,
        category: "docs",
        outcome: "clean",
        headSha,
        predictedR: 0.05,
        dataDir,
      });
    }

    const trustDir = resolveTrustDir({ workspaceDir: dir });
    recordIntentCard({
      trustDir,
      conversationId: "conv-unver",
      headSha,
      card: { goal: "update docs", affectedGlobs: ["README.md"], rollbackPlan: "git revert HEAD", category: "docs" },
    });

    const unverifiedMerge = evaluateTrustGate(
      { kind: "tool-command", command: "gh pr merge 1", workspaceDir: dir, conversationId: "conv-unver" },
      { dataDir, baseRef: "main", headless: false },
    );
    assert.notEqual(unverifiedMerge.decision, "auto_approve");
    assert.equal(unverifiedMerge.decision, "force_ask");

    const unverifiedMergeHeadless = evaluateTrustGate(
      { kind: "tool-command", command: "gh pr merge 1", workspaceDir: dir, conversationId: "conv-unver" },
      { dataDir, baseRef: "main", headless: true },
    );
    assert.equal(unverifiedMergeHeadless.decision, "deny");

    const mixedReceipts = [
      { kind: "file_write", ts: "2026-11-24T00:00:01Z", headSha, ok: true, paths: ["README.md", "hooks.json"] },
      { kind: "command", category: "test", ts: "2026-11-24T00:00:02Z", headSha, ok: true, summary: "node --test" },
    ];
    const govStop = evaluateStageHandoff(
      { kind: "stop", fullyIdle: true, terminationReason: "model_stop", workspaceDir: dir, conversationId: "conv-gov" },
      { dataDir, baseRef: "main", receipts: mixedReceipts, evidence: null, intent: null, headSha },
    );
    assert.deepEqual(govStop, { decision: "allow" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("policyReset and missedAudit recover cleanly on subsequent clean outcomes and completed audits", () => {
  const { dir, headSha } = makeEnrolledRepo("astack-trust-rec-");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-trust-rec-pd-"));
  try {
    const scope = resolveWorkspaceScope(dir, { baseRef: "main" });
    const policy = structuredClone(DEFAULT_RISK_POLICY);
    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      dataDir,
      action: { beastOn: true, promotionMode: "auto", setCeiling: { category: "docs", ceiling: 3 } },
      now: "2026-01-01T00:00:00Z",
    });
    for (let i = 0; i < 20; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: dir,
        scope,
        policy,
        category: "docs",
        outcome: "clean",
        headSha,
        predictedR: 0.05,
        dataDir,
        now: `2026-01-${String(i + 2).padStart(2, "0")}T00:00:00Z`,
      });
    }

    const updatedPolicy = structuredClone(policy);
    updatedPolicy.autonomy.ceilings.docs = 2;
    const rightAfterChange = evaluateRepoTrust({
      repoId: scope.repoId,
      policy: updatedPolicy,
      dataDir,
      nowMs: Date.parse("2026-01-25T00:00:00Z"),
    });
    assert.equal(rightAfterChange.categories.docs.policyReset, true);
    assert.ok(rightAfterChange.categories.docs.score <= 0.4);
    assert.ok(rightAfterChange.categories.docs.level <= 1);

    for (let i = 0; i < 15; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: dir,
        scope,
        policy: updatedPolicy,
        category: "docs",
        outcome: "clean",
        headSha,
        predictedR: 0.05,
        dataDir,
        now: `2026-02-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    const afterRecovery = evaluateRepoTrust({
      repoId: scope.repoId,
      policy: updatedPolicy,
      dataDir,
      nowMs: Date.parse("2026-02-20T00:00:00Z"),
    });
    assert.equal(afterRecovery.categories.docs.policyReset, false);
    assert.ok(afterRecovery.categories.docs.score > 0.8);
    assert.equal(afterRecovery.categories.docs.level, 2);

    const entries = [];
    for (let i = 0; i < 20; i++) {
      entries.push({ category: "tests", outcome: "clean", y: 1, predictedR: 0.05, ts: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` });
    }
    entries.push({ category: "tests", outcome: "clean", y: 1, predictedR: 0.05, sampledAudit: true, auditCompleted: false, ts: "2026-02-01T00:00:00Z" });
    const demoted = evaluateCategoryState({ category: "tests", entries, ceiling: 3, maxCeiling: 3, promotionMode: "auto", nowMs: Date.parse("2026-02-02T00:00:00Z") });
    assert.equal(demoted.level, 2);
    assert.equal(demoted.missedAudit, true);

    entries.push({ category: "tests", outcome: "clean", y: 1, predictedR: 0.05, sampledAudit: true, auditCompleted: true, ts: "2026-02-05T00:00:00Z" });
    const recovered = evaluateCategoryState({ category: "tests", entries, ceiling: 3, maxCeiling: 3, promotionMode: "auto", nowMs: Date.parse("2026-02-06T00:00:00Z") });
    assert.equal(recovered.missedAudit, false);
    assert.equal(recovered.level, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent trust CLI outcome appends and settings writes remain serialized with valid hash chain and zero lost updates", async () => {
  const { dir, headSha } = makeEnrolledRepo("astack-trust-race-");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-trust-race-pd-"));
  const cliPath = path.resolve(here, "../trust/cli.mjs");
  const runCliAsync = (args) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [cliPath, ...args, "--cwd", dir, "--data-dir", dataDir, "--base", "main", "--json"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
    });

  try {
    const scope = resolveWorkspaceScope(dir, { baseRef: "main" });
    const outcomeRuns = await Promise.all([
      runCliAsync(["record-outcome", "ui", "clean", "--sha", headSha]),
      runCliAsync(["record-outcome", "ui", "clean", "--sha", headSha]),
      runCliAsync(["record-outcome", "ui", "clean", "--sha", headSha]),
      runCliAsync(["record-outcome", "ui", "clean", "--sha", headSha]),
    ]);
    for (const r of outcomeRuns) {
      assert.equal(r.code, 0, `Concurrent record-outcome failed: ${r.err}`);
    }
    const ledger = readOutcomeLedger(scope.repoId, { dataDir });
    assert.equal(ledger.chainValid, true, ledger.reason ?? "");
    assert.equal(ledger.entries.length, 4);

    const settingRuns = await Promise.all([
      runCliAsync(["beast", "on"]),
      runCliAsync(["ceiling", "ui", "3"]),
      runCliAsync(["ceiling", "docs", "3"]),
    ]);
    for (const r of settingRuns) {
      assert.equal(r.code, 0, `Concurrent settings write failed: ${r.err}`);
    }
    const { settings } = readTrustSettings(scope.repoId, { dataDir });
    assert.equal(settings.beastOn, true);
    assert.equal(settings.ceilings.ui, 3);
    assert.equal(settings.ceilings.docs, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("setCeiling in auto mode syncs confirmedLevels and lastAutoPromo for Undo, and clamping down clears stale Undo", () => {
  const { dir, headSha, scope, policy } = makeEnrolledRepo("astack-ceil-undo-");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-ceil-undo-data-"));
  try {
    for (let i = 0; i < 20; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: dir,
        scope,
        policy,
        category: "ui",
        outcome: "clean",
        headSha,
        predictedR: 0.05,
        dataDir,
      });
    }
    const autoOn = applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { promotionMode: "auto" },
      dataDir,
    });
    assert.equal(autoOn.trust.categories.ui.level, 2);

    const raised = applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { setCeiling: { category: "ui", ceiling: 3 } },
      dataDir,
    });
    assert.equal(raised.trust.categories.ui.level, 3);
    assert.equal(raised.trust.lastAutoPromo?.catId, "ui");
    assert.equal(raised.trust.lastAutoPromo?.fromLvl, 2);
    assert.equal(raised.trust.lastAutoPromo?.toLvl, 3);

    const undone = applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { undoAutoPromo: true },
      dataDir,
    });
    assert.equal(undone.trust.promotionMode, "manual");
    assert.equal(undone.trust.categories.ui.level, 2);
    assert.equal(undone.trust.lastAutoPromo, null);

    applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { promotionMode: "auto" },
      dataDir,
    });
    const clamped = applyTrustSettingsAction({
      repoId: scope.repoId,
      policy,
      action: { setCeiling: { category: "ui", ceiling: 1 } },
      dataDir,
    });
    assert.equal(clamped.trust.categories.ui.level, 1);
    assert.equal(clamped.trust.lastAutoPromo, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Round 6 hardening blocks symlink-before-.. traversal, quote-aware subshells, env -S flags, heredocs, rev|b64, perl -e, and xargs -i", () => {
  const { dir, scope } = makeEnrolledRepo("astack-r6-sec-");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-r6-pd-"));
  try {
    const storeDir = resolveTrustStoreDir(scope.repoId, { dataDir });
    fs.mkdirSync(storeDir, { recursive: true });
    const storePosix = storeDir.replace(/\\/g, "/");
    const subDir = path.join(path.dirname(storeDir), "..", "sub");
    fs.mkdirSync(subDir, { recursive: true });
    const lnkPath = path.join(dir, "lnk");
    fs.symlinkSync(subDir, lnkPath, "dir");

    const relDotDot = `lnk/../trust/${scope.repoId}/settings.json`;
    const absDotDot = `${lnkPath}${path.sep}..${path.sep}trust${path.sep}${scope.repoId}${path.sep}settings.json`;
    assert.equal(isProtectedTrustStorePath(relDotDot, { dataDir, workspaceDir: dir }), true);
    assert.equal(isProtectedTrustStorePath(absDotDot, { dataDir, workspaceDir: dir }), true);
    assert.equal(
      evaluateTrustGate({ kind: "tool-write", filePath: relDotDot, chunks: ["{}"], workspaceDir: dir }, { dataDir, baseRef: "main" }).decision,
      "deny",
    );

    const payload = `rm -rf "${storePosix}"`;
    const b64 = Buffer.from(payload, "utf8").toString("base64");
    const revB64 = [...b64].reverse().join("");
    const unpaddedRaw = Buffer.from(`rm -rf "${storePosix}"`, "utf8").toString("base64").replace(/=+$/, "");
    const unpaddedB64 =
      unpaddedRaw.length % 4 !== 0
        ? unpaddedRaw
        : Buffer.from(`rm -rf "${storePosix}" `, "utf8").toString("base64").replace(/=+$/, "");
    const cliB64 = Buffer.from("node scripts/trust/cli.mjs beast on", "utf8").toString("base64");
    const revPayload = [...payload].reverse().join("");
    const relRmB64 = Buffer.from(`rm -rf "../trust/${scope.repoId}/settings.json"`, "utf8").toString("base64");
    const bareLinkPath = path.join(dir, "innocent-link.json");
    fs.symlinkSync(path.join(storeDir, "settings.json"), bareLinkPath);

    const sameLineMultiHeredoc = [
      "cat << A; cat << B | base64 -d | sh",
      "hi",
      "A",
      b64,
      "B",
    ].join("\n");
    const indentedHeredoc = [
      "python3 << EOF",
      'doc = """',
      "  EOF",
      '"""',
      `open("${storePosix}/settings.json", "w")`,
      "EOF",
    ].join("\n");

    const blockedCommands = [
      `source <(true ")"; ${payload})`,
      `source <(true ")"; echo "${b64}" | base64 -d)`,
      `cat <(echo $'\\''); rm -rf "${storePosix}"`,
      `echo "${b64}" $(true $'\\'') | base64 -d | sh`,
      `sh <(echo "${b64}" | base64 -d; true)`,
      `D="$ASTACK_PLUGIN_DATA"; cat <(mv "$D/trust/${scope.repoId}/settings.json" /tmp/out)`,
      `echo "${payload}" | env -S "-u FOO sh"`,
      `echo "${b64}" | base64 -d | env -S "-u FOO sh"`,
      `powershell -Exec Bypass "Remove-Item '${storePosix}/settings.json'"`,
      `pwsh /ep Bypass "Remove-Item '${storePosix}/settings.json'"`,
      `cat << 'EOF' | sh\nrm -rf "${storePosix}"\nEOF`,
      `cat << 'EOF' | base64 -d | sh\n${b64}\nEOF`,
      `true && python3 << 'EOF'\nopen("${storePosix}/settings.json", "w")\nEOF`,
      `python3 << \\EOF\nopen("${storePosix}/settings.json", "w")\nEOF`,
      `echo "${revB64}" | rev | base64 -d | sh`,
      `perl -e'unlink("${storePosix}/settings.json")'`,
      `echo "${b64}" | base64 -d | xargs -i sh`,
      `echo "${storePosix}/settings.json" | xargs -i rm -f {}`,
      `X="$(echo '"')" node scripts/trust/cli.mjs promotion auto`,
      `sh -s "$(echo '"')" < <(echo "${cliB64}" | base64 -d)`,
      `cat \`rm -rf "${storePosix}"; true\``,
      `cd lnk && echo '{}' > ../trust/${scope.repoId}/settings.json`,
      `cd lnk && cd .. && echo '{}' > trust/${scope.repoId}/settings.json`,
      `env -C lnk sh -c "echo '{}' > ../trust/${scope.repoId}/settings.json"`,
      `ln -s "$ASTACK_PLUGIN_DATA/sub" evil-lnk`,
      `env -S "-u FOO" sh -c "node scripts/trust/cli.mjs beast on"`,
      `true <<< x; cat << 'EOF' | base64 -d | sh\n${b64}\nEOF`,
      `cat << 'A'\nhi\nA\ncat << 'B' | base64 -d | sh\n${b64}\nB`,
      `cat << 'EOF' | base64 -d | node\n${cliB64}\nEOF`,
      `echo "${unpaddedB64}" | base64 -d | sh`,
      "node scripts/trust/cli.mjs bea`st `on",
      'echo "a`b"; node scripts/trust/cli.mjs beast on; echo "c`d"',
      `base64 -d << 'EOF' | sh\n${cliB64}\nEOF`,
      `rev << 'EOF' | sh\n${revPayload}\nEOF`,
      sameLineMultiHeredoc,
      `cat << 1 | base64 -d | sh\n${b64}\n1`,
      `cat << 'E.1' | base64 -d | sh\n${b64}\nE.1`,
      indentedHeredoc,
      `cd lnk\nbase64 -d << 'EOF' | sh\n${relRmB64}\nEOF`,
      `env -iC lnk sh -c "echo '{}' > ../trust/${scope.repoId}/settings.json"`,
      `echo '{}' > innocent-link.json`,
      `3<>./lnk/../trust/${scope.repoId}/settings.json`,
      `ni -ItemType SymbolicLink -Path evil2 -Target "$ASTACK_PLUGIN_DATA/sub"`,
      `cp -s "$ASTACK_PLUGIN_DATA/sub" evil3`,
      `sh <<< "$(echo '${cliB64}' | base64 -d)"`,
    ];
    for (const cmd of blockedCommands) {
      assert.equal(isProtectedTrustShellCommand(cmd, { dataDir, workspaceDir: dir }), true, cmd);
      const gate = evaluateTrustGate({ kind: "tool-command", command: cmd, workspaceDir: dir }, { dataDir, baseRef: "main" });
      assert.equal(gate.decision, "deny", cmd);
    }

    assert.equal(resolveBaseRef(dir, "0123456789abcdef0123456789abcdef01234567"), null);
    assert.equal(resolveBaseRef(dir, " main "), "main");
    if (process.platform === "win32") {
      assert.equal(
        isProtectedTrustStorePath(`\\\\?\\${path.join(storeDir, "future-settings.json")}`, { dataDir, workspaceDir: dir }),
        true,
      );
      assert.equal(
        isProtectedTrustStorePath(`\\\\.\\${path.join(storeDir, "future-settings.json")}`, { dataDir, workspaceDir: dir }),
        true,
      );
    }

    const blockedAssessment = {
      residual: "blocked",
      category: "core",
      score: 0.9,
      signals: [{ id: "test_regression", severity: 3, label: "Suite regressed" }],
    };
    assert.equal(
      evaluateTrustGate(
        { kind: "tool-command", command: "node --test", workspaceDir: dir },
        { dataDir, baseRef: "main", headless: true, assessment: blockedAssessment },
      ).decision,
      "allow",
    );
    assert.equal(
      evaluateTrustGate(
        { kind: "tool-command", command: "node --test && node evil.js", workspaceDir: dir },
        { dataDir, baseRef: "main", headless: true, assessment: blockedAssessment },
      ).decision,
      "deny",
    );

    const safeCommands = [
      `echo "${b64}" | base64 -d | cat`,
      `powershell -Exec Bypass "Get-Location"`,
      `perl -e'print 1'`,
      `echo hi | xargs -i echo {}`,
      `ln -s README.md docs-link.md`,
    ];
    for (const cmd of safeCommands) {
      assert.equal(isProtectedTrustShellCommand(cmd, { dataDir, workspaceDir: dir }), false, cmd);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
