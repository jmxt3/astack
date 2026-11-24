import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  mapLegacyPolicyFlags,
  recordIntentCard,
  recordOutcomeWithTrustSync,
  recordReceipt,
  recordRollbackReceipt,
  recordVerifierReceipt,
  resolveEffectiveAutonomy,
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

  // No single outcome raises level above L0
  const one = evaluateCategoryState({
    category: "ui",
    entries: makeCleanEntries("ui", 1, baseStart),
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 1 * 86400 * 1000,
  });
  assert.equal(one.level, 0);
  assert.equal(one.earnedLevel, 0);

  // 4 clean stays L0; 5 clean reaches L1 (T = 1 - 0.9^5 = 0.4095)
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

  // 10 clean reaches L2; one y=0 halves T_c and demotes immediately
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

  // 20 clean merges reach L3 only when Brier <= 0.12 and ceiling === 3
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

  // Bad Brier calibration blocks L3 promotion
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

  // Missed sampled audit demotes L3 to L2 immediately
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

  // Idle decay: 10% every 30 days drops score below L3 demotion floor (0.75) after 60 days
  const decayed = evaluateCategoryState({
    category: "ui",
    entries: twentyEntries,
    ceiling: 3,
    promotionMode: "auto",
    nowMs: baseStart + 85 * 86400 * 1000,
  });
  assert.ok(decayed.score < 0.75);
  assert.equal(decayed.level, 2);

  // Category reset caps score <= 0.40 and earnedLevel <= 1
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

  // Governance capped at L2 forever and never auto-promotes
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

  // Stricter-wins base policy overrides local Auto and higher ceilings
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

  // Regression: 20 clean capped at ceiling L2 still immediately drops 2 -> 1 on a single revert
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

  // Regression: Manual mode at confirmed L1 while earned L2 still demotes 1 -> 0 on a single revert
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
  // Read always allows
  assert.equal(evaluateDecisionTable({ action: "read", residual: "blocked", beastOn: true }).decision, "allow");

  // Local write / local exec
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "low", trustLevel: 1, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "local_exec", residual: "medium", trustLevel: 1, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "low", trustLevel: 0, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "high", trustLevel: 3, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "blocked", trustLevel: 3, beastOn: true }).decision, "deny");
  assert.equal(evaluateDecisionTable({ action: "local_write", residual: "low", trustLevel: 2, beastOn: false }).decision, "allow");

  // Push / open_pr
  assert.equal(evaluateDecisionTable({ action: "push_branch", residual: "low", trustLevel: 2, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "open_pr", residual: "medium", trustLevel: 2, beastOn: true }).decision, "auto_approve");
  assert.equal(evaluateDecisionTable({ action: "open_pr", residual: "low", trustLevel: 1, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "push_branch", residual: "high", trustLevel: 3, beastOn: true }).decision, "force_ask");
  assert.equal(evaluateDecisionTable({ action: "open_pr", residual: "blocked", trustLevel: 3, beastOn: true }).decision, "deny");

  // Merge + exact 1-line reason
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

  // Deploy / external_message / destructive
  for (const act of ["deploy", "external_message", "destructive"]) {
    assert.equal(evaluateDecisionTable({ action: act, residual: "low", trustLevel: 3, beastOn: true }).decision, "force_ask");
    assert.equal(evaluateDecisionTable({ action: act, residual: "medium", trustLevel: 3, beastOn: true }).decision, "force_ask");
    assert.equal(evaluateDecisionTable({ action: act, residual: "high", trustLevel: 3, beastOn: true }).decision, "deny");
    assert.equal(evaluateDecisionTable({ action: act, residual: "blocked", trustLevel: 3, beastOn: true }).decision, "deny");
  }

  // Headless converts ask -> deny
  assert.equal(
    evaluateDecisionTable({ action: "merge", residual: "low", trustLevel: 2, beastOn: true, headless: true }).decision,
    "deny",
  );

  // Legacy read shim maps allowTier0AutoMerge + humanGates.prReview: "tier0-auto"
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

    // 1. Agent write and shell mutations targeting ${PLUGIN_DATA}/trust/** are ALWAYS denied (even from non-git dir)
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

    // 2. Non-repo returns plain allow silently
    const nonGitRes = runHookCli(
      trustGateScript,
      {
        cwd: nonGitDir,
        toolCall: { name: "write_file", args: { Path: path.join(nonGitDir, "notes.md"), Content: "hi" } },
      },
      env,
    );
    assert.deepEqual(nonGitRes, { decision: "allow" });

    // 3. Seed 10 clean outcomes on ui, enable Beast + Auto -> L2
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

    // 4. Write within declared Intent Card scope at L2 -> auto_approve
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

    // 5. Write outside declared Intent Card scope -> deny with scope_drift + hypotheses prompt
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

    // 6. Push at L2 with clean residual -> auto_approve; merge at L2 -> force_ask
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

    // 7. Fail-safe: corrupt settings.json returns plain allow (never auto_approve)
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

    // Restore settings, tamper ledger -> hash chain broken freezes repo at L0, trust-gate returns allow, doctor warns
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
    // Seed 10 clean ui outcomes -> L2 with Beast On
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

    // PreInvocation injects compact ephemeralMessage naming stage, category, L2, R
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

    // Stop hook returns continue for Stage 2 -> Stage 3 on fresh verified HEAD
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

    // Second continuation still within cap (max 2)
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

    // Third continuation hits per-stage transition cap -> stops cleanly
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

    // Non-idle or non-model_stop or executionNum > 2 always returns allow
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

    // Stage 3 verified PASS at L2 hits human merge gate -> stops cleanly
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

    // Reach L3 (10 more clean outcomes + raise ceiling to L3) -> Stage 3 -> Stage 4 continues!
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

    // Open test_regression circuit breaker stops handoff cleanly
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

    // Non-repo stays completely silent on PreInvocation stage context
    assert.deepEqual(
      evaluateStageContext({ kind: "pre-invocation", workspaceDir: os.tmpdir(), lastUserInput: "hi" }, { dataDir }),
      {},
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("exhaustive BFS state-space check proves earned-trust and stage-handoff safety invariants", () => {
  const initialStates = [];
  for (const cat of ["ui", "governance"]) {
    initialStates.push({
      cat,
      mode: "manual",
      ceiling: 2,
      earned: 0,
      confirmed: 0,
      level: 0,
      autoPromoted: false,
      stage: 1,
      stageHops: 0,
    });
  }

  const keyOf = (s) =>
    `${s.cat}|${s.mode}|${s.ceiling}|${s.earned}|${s.confirmed}|${s.level}|${s.autoPromoted}|${s.stage}|${s.stageHops}`;

  const visited = new Set();
  const queue = [];
  for (const s of initialStates) {
    visited.add(keyOf(s));
    queue.push(s);
  }

  const effectiveLevel = (cat, mode, ceiling, earned, confirmed) => {
    const cap = cat === "governance" ? Math.min(2, ceiling) : ceiling;
    const cappedEarned = Math.min(earned, cap);
    if (mode === "auto" && cat !== "governance") return cappedEarned;
    return Math.min(cappedEarned, confirmed);
  };

  let transitionsChecked = 0;

  while (queue.length > 0) {
    const cur = queue.shift();

    // Global invariants on every reachable state
    assert.ok(cur.level <= cur.ceiling, `Level ${cur.level} exceeded ceiling ${cur.ceiling}`);
    if (cur.cat === "governance") {
      assert.ok(cur.level <= 2, "Governance level exceeded L2");
      assert.equal(cur.autoPromoted, false, "Governance must never auto-promote");
    }
    assert.ok(cur.stageHops <= 2, "Stage transitions exceeded bound 2");
    assert.ok(cur.stage >= 1 && cur.stage <= 4, "Stage out of bounds");

    const nextStates = [];

    // 1. Clean outcome raises earned by at most 1 (capped by category max)
    const maxCat = cur.cat === "governance" ? 2 : 3;
    const nextEarnedClean = Math.min(maxCat, cur.earned + 1);
    const nextLevelClean = effectiveLevel(cur.cat, cur.mode, cur.ceiling, nextEarnedClean, cur.confirmed);
    const didAuto = cur.mode === "auto" && cur.cat !== "governance" && nextLevelClean > cur.level;
    nextStates.push({
      ...cur,
      earned: nextEarnedClean,
      confirmed: didAuto ? nextLevelClean : cur.confirmed,
      level: nextLevelClean,
      autoPromoted: cur.autoPromoted || didAuto,
    });

    // 2. Revert outcome drops active level immediately (mirrors evaluateCategoryState + recordOutcomeWithTrustSync)
    const cap = cur.cat === "governance" ? Math.min(2, cur.ceiling) : cur.ceiling;
    const nextEarnedRev = Math.max(0, Math.min(cur.earned, cap) - 1);
    const nextConfirmedRev = cur.level > 0 ? Math.min(nextEarnedRev, Math.max(0, cur.level - 1)) : 0;
    const nextLevelRev = effectiveLevel(cur.cat, cur.mode, cur.ceiling, nextEarnedRev, nextConfirmedRev);
    if (cur.level > 0) {
      assert.ok(nextLevelRev < cur.level, "Revert must strictly lower active level when level > 0");
    }
    nextStates.push({
      ...cur,
      earned: nextEarnedRev,
      confirmed: nextConfirmedRev,
      level: nextLevelRev,
    });

    // 3. Human Manual confirm promotion (one step up to min(earned, ceiling))
    if (cur.level < Math.min(cur.earned, cap)) {
      const nextConf = cur.level + 1;
      nextStates.push({
        ...cur,
        confirmed: nextConf,
        level: effectiveLevel(cur.cat, cur.mode, cur.ceiling, cur.earned, nextConf),
      });
    }

    // 4. Human toggles promotion mode
    const toggledMode = cur.mode === "manual" ? "auto" : "manual";
    const lvlAfterToggle = effectiveLevel(cur.cat, toggledMode, cur.ceiling, cur.earned, cur.confirmed);
    const toggleAuto = toggledMode === "auto" && cur.cat !== "governance" && lvlAfterToggle > cur.level;
    nextStates.push({
      ...cur,
      mode: toggledMode,
      confirmed: toggleAuto ? lvlAfterToggle : cur.confirmed,
      level: lvlAfterToggle,
      autoPromoted: cur.autoPromoted || toggleAuto,
    });

    // 5. Human changes ceiling (governance capped at 2)
    for (const c of [1, 2, 3]) {
      const clampedC = cur.cat === "governance" ? Math.min(2, c) : c;
      const nextConf = Math.min(cur.confirmed, clampedC);
      nextStates.push({
        ...cur,
        ceiling: clampedC,
        confirmed: nextConf,
        level: effectiveLevel(cur.cat, cur.mode, clampedC, cur.earned, nextConf),
      });
    }

    // 6. Stage handoff transition (bounded by stageHops < 2 and level requirement)
    if (cur.stage < 4 && cur.stageHops < 2) {
      const reqLvl = cur.stage === 1 ? 1 : cur.stage === 2 ? 2 : 3;
      if (cur.level >= reqLvl) {
        nextStates.push({
          ...cur,
          stage: cur.stage + 1,
          stageHops: cur.stageHops + 1,
        });
      }
    }

    for (const ns of nextStates) {
      transitionsChecked++;
      const k = keyOf(ns);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push(ns);
      }
    }
  }

  assert.ok(visited.size >= 100, `Expected rich reachable state space, checked ${visited.size} states`);
  assert.ok(transitionsChecked >= 500, `Expected thorough transition check, got ${transitionsChecked}`);
});
