import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendOutcome,
  classifyObservedOutcome,
  computeBrierScore,
  evaluateRepoTrust,
  isProtectedTrustStorePath,
  readOutcomeLedger,
  readTrustSettings,
  resolveWorkspaceScope,
  verifyLedgerChain,
} from "../trust/index.mjs";
import { createTimelineServer, startTimelineSidecar } from "../../sidecars/astack_timeline/main.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../..");
const trustCliPath = path.join(rootDir, "scripts", "trust", "cli.mjs");
const sidecarManifestPath = path.join(rootDir, "sidecars", "astack_timeline", "sidecar.json");

function makeEnrolledRepo(prefix = "astack-enrolled-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".agents", "risk-policy.json"),
    JSON.stringify({
      schemaVersion: 1,
      autonomy: {
        defaultCeiling: 2,
        ceilings: { docs: 3, tests: 3, ui: 3, skills: 3, tooling: 3, core: 3, governance: 2 },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init enrolled"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("appendOutcome enforces enrolled_repo and 40-hex SHA, builds verifiable hash chain, and freezes on tampering", () => {
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "astack-out-nogit-"));
  const unreg = fs.mkdtempSync(path.join(os.tmpdir(), "astack-out-unreg-"));
  const repo = makeEnrolledRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-out-data-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: unreg, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: unreg, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: unreg, stdio: "ignore" });
    fs.writeFileSync(path.join(unreg, "a.js"), "1\n", "utf8");
    execFileSync("git", ["add", "a.js"], { cwd: unreg, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: unreg, stdio: "ignore" });

    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    assert.throws(
      () => appendOutcome({ workspaceDir: nonGit, category: "docs", outcome: "clean", headSha: sha, dataDir }),
      /enrolled git repositories/i,
    );
    assert.throws(
      () => appendOutcome({ workspaceDir: unreg, category: "docs", outcome: "clean", headSha: sha, dataDir }),
      /enrolled git repositories/i,
    );
    assert.throws(
      () => appendOutcome({ workspaceDir: repo, category: "docs", outcome: "clean", headSha: "not-a-sha", dataDir }),
      /40-hex/i,
    );

    const scope = resolveWorkspaceScope(repo);
    assert.equal(scope.kind, "enrolled_repo");

    const r1 = appendOutcome({
      workspaceDir: repo,
      category: "ui",
      outcome: "clean",
      headSha: sha,
      predictedR: 0.12,
      prNumber: 24,
      now: "2026-11-22T10:00:00Z",
      dataDir,
    });
    const r2 = appendOutcome({
      workspaceDir: repo,
      category: "ui",
      outcome: "approved_with_edits",
      headSha: sha,
      predictedR: 0.3,
      prNumber: 25,
      now: "2026-11-22T11:00:00Z",
      dataDir,
    });
    assert.equal(r2.entry.prevHash, r1.entryHash);

    const readOk = readOutcomeLedger(scope.repoId, { dataDir });
    assert.equal(readOk.chainValid, true);
    assert.equal(readOk.entries.length, 2);
    assert.ok(computeBrierScore(readOk.entries) >= 0 && computeBrierScore(readOk.entries) < 0.1);
    assert.equal(isProtectedTrustStorePath(readOk.ledgerPath, { dataDir }), true);

    const rawLines = fs.readFileSync(readOk.ledgerPath, "utf8").trim().split("\n");
    const tampered = JSON.parse(rawLines[0]);
    tampered.outcome = "clean";
    tampered.predictedR = 0.99;
    rawLines[0] = JSON.stringify(tampered);
    fs.writeFileSync(readOk.ledgerPath, `${rawLines.join("\n")}\n`, "utf8");

    const broken = verifyLedgerChain(fs.readFileSync(readOk.ledgerPath, "utf8"));
    assert.equal(broken.chainValid, false);
    assert.equal(broken.brokenAtLine, 2);

    const frozenTrust = evaluateRepoTrust({ repoId: scope.repoId, dataDir });
    assert.equal(frozenTrust.frozen, true);
    assert.equal(frozenTrust.beastOn, false);
    assert.equal(frozenTrust.categories.ui.level, 0);

    assert.throws(
      () => appendOutcome({ workspaceDir: repo, category: "ui", outcome: "clean", headSha: sha, dataDir }),
      /Hash chain mismatch/i,
    );

    assert.equal(classifyObservedOutcome({ reverted: true }).outcome, "reverted");
    assert.equal(classifyObservedOutcome({ trunkBroken: true }).outcome, "trunk_broken");
    assert.equal(classifyObservedOutcome({ changesRequested: true }).outcome, "approved_with_edits");
    assert.equal(
      classifyObservedOutcome({ branchCommitShas: ["aaa", "bbb"], agentReceiptShas: ["aaa"] }).outcome,
      "approved_with_edits",
    );
    assert.equal(classifyObservedOutcome({}).outcome, "clean");
  } finally {
    fs.rmSync(nonGit, { recursive: true, force: true });
    fs.rmSync(unreg, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("scripts/trust/cli.mjs and Timeline POST /api/trust/settings manage settings atomically with token auth and observe-only sidecar.json", async () => {
  const manifest = JSON.parse(fs.readFileSync(sidecarManifestPath, "utf8"));
  assert.equal(manifest.agent_permissions?.allows_user_interactions, false);
  assert.equal(manifest.arguments, undefined);
  assert.equal(manifest.agent_permissions?.workspace_uris, undefined);
  assert.equal(manifest.agent_permissions?.access_grants, undefined);

  for (const flag of ["--help", "-h"]) {
    const h = spawnSync(process.execPath, [trustCliPath, flag], { encoding: "utf8" });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /Usage: node scripts\/trust\/cli\.mjs/);
  }

  const repo = makeEnrolledRepo("astack-cli-tl-");
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-trust-brain-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-trust-data-"));
  const convId = "55555555-6666-7777-8888-999999999999";
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const scope = resolveWorkspaceScope(repo);

  const runCli = (...args) =>
    spawnSync(process.execPath, [trustCliPath, ...args, "--cwd", repo, "--data-dir", dataDir, "--json"], {
      encoding: "utf8",
    });

  const srv = await createTimelineServer({
    brainDir,
    workspaceDir: repo,
    dataDir,
    token: "trust-secret-token",
    port: 0,
  });

  try {
    const st0 = runCli("status");
    assert.equal(st0.status, 0, st0.stderr);
    const parsed0 = JSON.parse(st0.stdout);
    assert.equal(parsed0.scope.kind, "enrolled_repo");
    assert.equal(parsed0.trust.beastOn, false);
    assert.equal(parsed0.trust.promotionMode, "manual");

    for (let i = 0; i < 5; i++) {
      const rec = runCli("record-outcome", "docs", "clean", "--sha", headSha, "--risk", "0.05");
      assert.equal(rec.status, 0, rec.stderr);
    }

    const after5 = JSON.parse(runCli("status").stdout);
    assert.equal(after5.trust.categories.docs.level, 0, "Manual mode must not auto-promote without confirm");
    assert.equal(after5.trust.categories.docs.promoReady, true);
    assert.equal(after5.trust.categories.docs.eligibleNextLevel, 1);

    assert.equal(runCli("beast", "on").status, 0);
    assert.equal(runCli("ceiling", "docs", "3").status, 0);
    assert.equal(runCli("ceiling", "governance", "3").status, 1, "governance ceiling must reject L3");

    const unauthPost = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beastOn: false }),
    });
    assert.equal(unauthPost.status, 401);

    const noTokenSrv = await createTimelineServer({
      brainDir,
      workspaceDir: repo,
      dataDir,
      token: "",
      port: 0,
    });
    try {
      const emptyTokPost = await fetch(`${noTokenSrv.url}api/trust/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beastOn: false }),
      });
      assert.equal(emptyTokPost.status, 401, "Empty token server must fail closed on POST /api/trust/settings");
    } finally {
      await noTokenSrv.close();
    }

    const headers = { "Content-Type": "application/json", "X-Sidecar-Token": "trust-secret-token" };
    const promoRes = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ promoteCategory: "docs" }),
    });
    assert.equal(promoRes.status, 200);
    const promoData = await promoRes.json();
    assert.equal(promoData.trust.categories.docs.level, 1);

    const autoRes = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ promotionMode: "auto" }),
    });
    assert.equal(autoRes.status, 200);
    assert.equal((await autoRes.json()).trust.promotionMode, "auto");

    const tlSnap = await (
      await fetch(`${srv.url}api/timeline?conversationId=${convId}`, {
        headers: { "X-Sidecar-Token": "trust-secret-token" },
      })
    ).json();
    assert.equal(tlSnap.trust.enrolled, true);
    assert.equal(tlSnap.trust.beastOn, true);
    assert.equal(tlSnap.trust.categories.find((c) => c.id === "docs").level, 1);

    const undoRes = runCli("undo");
    assert.equal(undoRes.status, 0, undoRes.stderr);
    const saved = readTrustSettings(scope.repoId, { dataDir }).settings;
    assert.equal(saved.promotionMode, "manual");

    const sdkRoutes = [];
    class MockResponse {
      constructor(body, opts = {}) {
        this.body = body;
        this.status = opts.status || 200;
        this.contentType = opts.contentType || "application/json";
      }
    }
    class MockSidecarApp {
      constructor() { this.config = { conversationId: convId }; }
      page() {}
      api(routePath, handler, method) { sdkRoutes.push({ routePath, handler, method }); }
      async run() {}
    }
    await startTimelineSidecar({
      brainDir,
      workspaceDir: repo,
      dataDir,
      sdk: { SidecarApp: MockSidecarApp, Response: MockResponse },
    });
    const settingsRoute = sdkRoutes.find((r) => r.routePath === "/api/trust/settings");
    assert.equal(settingsRoute?.method, "POST");
    const sdkResp = await settingsRoute.handler({ beastOn: false });
    assert.equal(sdkResp.status, 200);
    assert.equal(JSON.parse(sdkResp.body).trust.beastOn, false);
  } finally {
    await srv.close();
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(brainDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
