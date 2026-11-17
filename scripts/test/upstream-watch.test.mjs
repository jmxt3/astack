import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ROOT_DIR } from "../catalog.mjs";
import { assertExternalOutPath, watchUpstream } from "../upstream-watch.mjs";

const WATCH_CLI = path.join(DEFAULT_ROOT_DIR, "scripts", "upstream-watch.mjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitAll(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function hashTree(rootDir) {
  const hashes = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const rel = path.relative(rootDir, full).split(path.sep).join("/");
        hashes[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  }
  walk(rootDir);
  return hashes;
}

function createMockUpstreamFixture(tmp) {
  const upstreamRepo = path.join(tmp, "upstream-pstack");
  const fakeRoot = path.join(tmp, "astack-root");

  fs.mkdirSync(upstreamRepo, { recursive: true });
  git(upstreamRepo, ["init"]);

  writeFile(path.join(upstreamRepo, "pstack", "skills", "poteto-mode", "SKILL.md"), "# C0\n");
  writeFile(path.join(upstreamRepo, "pstack", "skills", "tdd", "SKILL.md"), "# TDD\n");
  writeFile(path.join(upstreamRepo, "pstack", ".cursor-plugin", "plugin.json"), "{}\n");
  const c0 = commitAll(upstreamRepo, "baseline c0");

  writeFile(path.join(upstreamRepo, "pstack", "skills", "poteto-mode", "SKILL.md"), "# C1 edit\n");
  writeFile(path.join(upstreamRepo, "pstack", ".cursor-plugin", "plugin.json"), "{\"v\":2}\n");
  commitAll(upstreamRepo, "c1 edit poteto-mode and ignored manifest");

  writeFile(path.join(upstreamRepo, "pstack", "skills", "brand-new", "SKILL.md"), "# Brand new\n");
  commitAll(upstreamRepo, "c2 add brand-new skill");

  writeFile(path.join(fakeRoot, "skills", "astack-mode", "SKILL.md"), "# Local counterpart\n");
  writeFile(path.join(fakeRoot, "skills", "tdd", "SKILL.md"), "# Local TDD\n");
  writeFile(
    path.join(fakeRoot, "scripts", "upstream-watch.json"),
    JSON.stringify({
      sources: {
        pstack: {
          id: "pstack",
          name: "pstack",
          repoUrl: upstreamRepo,
          subdir: "pstack",
          relationship: "code-derived (MIT)",
          lastReviewed: c0,
          skillRenames: { "poteto-mode": "astack-mode" },
          agentRenames: {},
          ignoredPaths: [".cursor-plugin"],
        },
        gstack: {
          id: "gstack",
          name: "gstack",
          repoUrl: upstreamRepo,
          subdir: "",
          relationship: "inspiration (MIT, no code copied)",
          lastReviewed: null,
          skillRenames: {},
          agentRenames: {},
          ignoredPaths: [],
        },
      },
    }),
  );

  return { upstreamRepo, fakeRoot, c0 };
}

test("watchUpstream classifies counterparts, new skills, and ignored files while leaving rootDir byte-identical", () => {
  const tmp = makeTempDir("astack-watch-test-");
  try {
    const { upstreamRepo, fakeRoot, c0 } = createMockUpstreamFixture(tmp);
    const beforeHashes = hashTree(fakeRoot);

    const report = watchUpstream({
      rootDir: fakeRoot,
      sourceId: "pstack",
      sourceDir: upstreamRepo,
    });

    assert.equal(report.readOnly, true);
    assert.equal(report.hasUpdates, true);
    assert.equal(report.sources.length, 1);

    const src = report.sources[0];
    assert.equal(src.since, c0);
    assert.equal(src.aheadCount, 2);
    assert.equal(src.status, "updates-available");

    const byPath = Object.fromEntries(src.changes.map((c) => [c.upstreamPath, c]));
    assert.equal(byPath["skills/poteto-mode/SKILL.md"]?.category, "has-counterpart");
    assert.equal(byPath["skills/poteto-mode/SKILL.md"]?.counterpart, "skills/astack-mode/SKILL.md");
    assert.equal(byPath["skills/brand-new/SKILL.md"]?.category, "new-upstream-file");
    assert.equal(byPath["skills/brand-new/SKILL.md"]?.counterpart, "skills/brand-new/SKILL.md");
    assert.equal(byPath[".cursor-plugin/plugin.json"]?.category, "ignored");

    const externalOut = path.join(tmp, "outside", "watch-report.json");
    assertExternalOutPath(externalOut, fakeRoot);
    fs.mkdirSync(path.dirname(externalOut), { recursive: true });
    fs.writeFileSync(externalOut, JSON.stringify(report, null, 2), "utf8");
    assert.equal(fs.existsSync(externalOut), true);

    const afterHashes = hashTree(fakeRoot);
    assert.deepEqual(afterHashes, beforeHashes);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("upstream-watch CLI honors --fail-on-updates and refuses --out inside the AStack repository", () => {
  const tmp = makeTempDir("astack-watch-cli-");
  try {
    const { upstreamRepo, c0 } = createMockUpstreamFixture(tmp);
    const externalOut = path.join(tmp, "external", "report.json");

    const ahead = spawnSync(
      process.execPath,
      [
        WATCH_CLI,
        "--source-id",
        "pstack",
        "--source",
        upstreamRepo,
        "--since",
        c0,
        "--json",
        "--out",
        externalOut,
        "--fail-on-updates",
      ],
      { encoding: "utf8" },
    );
    assert.equal(ahead.status, 1, ahead.stderr);
    const parsed = JSON.parse(ahead.stdout);
    assert.equal(parsed.hasUpdates, true);
    assert.equal(fs.existsSync(externalOut), true);

    const atHead = spawnSync(
      process.execPath,
      [
        WATCH_CLI,
        "--source-id",
        "pstack",
        "--source",
        upstreamRepo,
        "--since",
        "HEAD",
        "--json",
        "--fail-on-updates",
      ],
      { encoding: "utf8" },
    );
    assert.equal(atHead.status, 0, atHead.stderr);
    assert.equal(JSON.parse(atHead.stdout).hasUpdates, false);

    for (const badOut of [
      path.join(DEFAULT_ROOT_DIR, "README.md"),
      path.join(DEFAULT_ROOT_DIR, ".tmp", "should-not-write.json"),
      DEFAULT_ROOT_DIR,
    ]) {
      const blocked = spawnSync(
        process.execPath,
        [WATCH_CLI, "--source", upstreamRepo, "--out", badOut],
        { encoding: "utf8" },
      );
      assert.equal(blocked.status, 2, `Expected exit 2 for internal --out: ${badOut}`);
      assert.match(blocked.stderr, /Refusing --out inside rootDir/);
    }
    assert.equal(fs.existsSync(path.join(DEFAULT_ROOT_DIR, ".tmp", "should-not-write.json")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("mapUpstreamPathToCounterpart maps security-audit-skill files into references and scripts", async () => {
  const { mapUpstreamPathToCounterpart } = await import("../upstream-watch.mjs");
  const cfg = { id: "security-audit-skill", skillRenames: {}, agentRenames: {} };
  assert.equal(mapUpstreamPathToCounterpart("skills/security-audit/SKILL.md", cfg), "skills/security-audit/SKILL.md");
  assert.equal(
    mapUpstreamPathToCounterpart("skills/security-audit/HUNTING.md", cfg),
    "skills/security-audit/references/HUNTING.md",
  );
  assert.equal(
    mapUpstreamPathToCounterpart("skills/security-audit/validate-findings.cjs", cfg),
    "skills/security-audit/scripts/validate-findings.cjs",
  );
  assert.equal(
    mapUpstreamPathToCounterpart("skills/security-audit/report-schema.json", cfg),
    "skills/security-audit/scripts/report-schema.json",
  );
});
