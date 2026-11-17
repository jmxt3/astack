import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSafeEnv, probeSandboxTier, promoteArtifact, runInSandbox } from "./sandbox-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerCli = path.join(here, "sandbox-runner.mjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("probeSandboxTier distinguishes Tier 2 OpenSandbox, Tier 1 Antigravity Sandbox, and Tier 0 fallback", async () => {
  const tier2 = await probeSandboxTier({
    env: { OPENSANDBOX_DOMAIN: "localhost:8080" },
    hasCommand: () => true,
  });
  assert.equal(tier2.tier, 2);
  assert.equal(tier2.mode, "opensandbox");
  assert.equal(tier2.canExecuteTargetCode, true);

  const tier1 = await probeSandboxTier({
    platform: "linux",
    osRelease: "6.8.0",
    env: {},
    homeDir: "/nonexistent-home",
    hasCommand: () => false,
    connectTcp: async () => ({ blocked: true, reason: "EACCES" }),
    statSync: () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
  });
  assert.equal(tier1.tier, 1);
  assert.equal(tier1.mode, "antigravity-terminal-sandbox");
  assert.equal(tier1.canExecuteTargetCode, true);

  const tier0OfflineTrap = await probeSandboxTier({
    platform: "win32",
    osRelease: "10.0.26100",
    env: {},
    homeDir: "C:\\Users\\example",
    hasCommand: () => false,
    connectTcp: async () => ({ blocked: true, reason: "ENETUNREACH" }),
    statSync: () => ({ isDirectory: () => true }),
  });
  assert.equal(tier0OfflineTrap.tier, 0);
  assert.equal(tier0OfflineTrap.canExecuteTargetCode, false);

  const tier0LegacyWin = await probeSandboxTier({
    platform: "win32",
    osRelease: "10.0.19045",
    env: {},
    homeDir: "C:\\Users\\example",
    hasCommand: () => false,
    connectTcp: async () => ({ blocked: true, reason: "EACCES" }),
    statSync: () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
  });
  assert.equal(tier0LegacyWin.tier, 0);
  assert.equal(tier0LegacyWin.canExecuteTargetCode, false);
});

test("buildSafeEnv strips ambient secrets and rejects secret-like allowEnv keys", () => {
  const tmp = makeTempDir("astack-safe-env-");
  try {
    const env = buildSafeEnv(tmp, { APP_MODE: "test" }, { PATH: "/usr/bin", GITHUB_TOKEN: "ambient-secret" });
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.HOME, tmp);
    assert.equal(env.APP_MODE, "test");
    assert.throws(() => buildSafeEnv(tmp, { API_SECRET: "x" }, {}), /Refusing secret-like allowEnv key/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("promoteArtifact enforces race-safe copy and rejects traversal, reserved names, size bounds, hardlinks, and symlinks", (t) => {
  const tmp = makeTempDir("astack-promote-");
  const scratch = path.join(tmp, "scratch");
  const artifacts = path.join(tmp, "artifacts");
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(artifacts, { recursive: true });

  try {
    fs.mkdirSync(path.join(scratch, "sub"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "sub", "proof.txt"), "observed-boundary-violation\n", "utf8");

    const ok = promoteArtifact({
      scratchRoot: scratch,
      artifactsRoot: artifacts,
      relativePath: "sub/proof.txt",
    });
    assert.equal(ok.promoted, true);
    assert.equal(fs.readFileSync(ok.destination, "utf8"), "observed-boundary-violation\n");

    assert.throws(
      () => promoteArtifact({ scratchRoot: scratch, artifactsRoot: artifacts, relativePath: "sub/proof.txt" }),
      /EEXIST/,
    );
    assert.throws(
      () => promoteArtifact({ scratchRoot: scratch, artifactsRoot: artifacts, relativePath: "../escape.txt" }),
      /unsafe|forbidden/i,
    );
    assert.throws(
      () => promoteArtifact({ scratchRoot: scratch, artifactsRoot: artifacts, relativePath: "con.txt" }),
      /forbidden/i,
    );

    fs.writeFileSync(path.join(scratch, "big.bin"), "x".repeat(200), "utf8");
    assert.throws(
      () => promoteArtifact({ scratchRoot: scratch, artifactsRoot: artifacts, relativePath: "big.bin", maxFileBytes: 50 }),
      /exceeds 50 byte limit/,
    );

    const hardOrig = path.join(scratch, "hard-a.txt");
    const hardLink = path.join(scratch, "hard-b.txt");
    fs.writeFileSync(hardOrig, "link-test", "utf8");
    fs.linkSync(hardOrig, hardLink);
    assert.throws(
      () => promoteArtifact({ scratchRoot: scratch, artifactsRoot: artifacts, relativePath: "hard-b.txt" }),
      /link count exactly 1/,
    );

    const symTarget = path.join(tmp, "outside.txt");
    const symLink = path.join(scratch, "sym.txt");
    fs.writeFileSync(symTarget, "secret", "utf8");
    try {
      fs.symlinkSync(symTarget, symLink);
      assert.throws(
        () => promoteArtifact({ scratchRoot: scratch, artifactsRoot: artifacts, relativePath: "sym.txt" }),
        /must not be a symlink/,
      );
    } catch (err) {
      if (!(process.platform === "win32" && (err.code === "EPERM" || err.code === "EACCES"))) {
        throw err;
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runInSandbox fails closed on Tier 0 and executes clean-env commands when Tier >= 1", async () => {
  const tmp = makeTempDir("astack-run-sandbox-");
  try {
    const blocked = await runInSandbox({
      command: process.execPath,
      args: ["-e", "console.log('should-not-run')"],
      scratchDir: tmp,
      probe: { tier: 0, mode: "unsandboxed-static-only", canExecuteTargetCode: false, reason: "no sandbox" },
    });
    assert.equal(blocked.status, "needs_validation");
    assert.equal(blocked.stdout, "");

    const allowed = await runInSandbox({
      command: process.execPath,
      args: ["-e", "console.log(process.env.GITHUB_TOKEN || 'clean')"],
      scratchDir: tmp,
      probe: { tier: 1, mode: "antigravity-terminal-sandbox", canExecuteTargetCode: true, reason: "tier1" },
    });
    assert.equal(allowed.status, "ok");
    assert.equal(allowed.stdout.trim(), "clean");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sandbox-runner CLI supports --help, -h, and --probe --json", () => {
  for (const flag of ["--help", "-h"]) {
    const help = spawnSync(process.execPath, [runnerCli, flag], { encoding: "utf8" });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage: node sandbox-runner\.mjs/);
  }
  const probe = spawnSync(process.execPath, [runnerCli, "--probe", "--json"], { encoding: "utf8" });
  assert.equal(probe.status, 0);
  const parsed = JSON.parse(probe.stdout);
  assert.ok([0, 1, 2].includes(parsed.tier));
});
