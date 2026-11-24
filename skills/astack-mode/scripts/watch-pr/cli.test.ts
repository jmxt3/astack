import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "../test-compat.ts";
import {
  applyTrustSettingsAction,
  evaluateRepoTrust,
  readOutcomeLedger,
  recordOutcomeWithTrustSync,
  recordReceipt,
  resolveTrustDir,
  resolveWorkspaceScope,
  writeEvidenceSnapshotAtomic,
} from "../../../../scripts/trust/index.mjs";
import { type CliRuntime, main, parseArgs } from "./cli.ts";
import { fakeReader, passingCheck } from "./fakes.test-helper.ts";
import { renderJson, renderPretty } from "./render.ts";
import type { GitHubReader, WatcherVerdict } from "./types.ts";
import { parsePrNumber } from "./types.ts";

const silentIo = { stdout: () => {}, stderr: () => {} };

function testRuntime(reader: GitHubReader): {
  readonly runtime: CliRuntime;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    runtime: {
      reader,
      clock: {
        now: () => 0,
        observedAt: () => "2026-07-26T00:00:00.000Z",
        async sleep() {
          throw new Error("test unexpectedly slept");
        },
      },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe("parseArgs", () => {
  it("uses the specified defaults", () => {
    expect(parseArgs([], silentIo)).toMatchObject({
      owner: null,
      repo: null,
      pr: null,
      mode: "single",
      stackPrs: [],
      statusOnly: false,
      pretty: false,
      polling: {
        interval: 60,
        sweepInterval: 300,
        timeout: 0,
        maxQueryErrors: 5,
        allowDraft: false,
      },
    });
  });

  it("parses a frozen queued stack bottom-to-top", () => {
    const parsed = parseArgs(
      [
        "--queued-stack",
        "--stack-prs",
        "#10, 11,#12",
        "--interval",
        "2.5",
        "--sweep-interval",
        "30",
        "--timeout",
        "0",
        "--max-query-errors",
        "3",
        "--allow-draft",
        "--pretty",
      ],
      silentIo
    );
    expect(parsed.mode).toBe("queued-stack");
    expect(parsed.stackPrs.map(Number)).toEqual([10, 11, 12]);
    expect(parsed.polling).toEqual({
      interval: 2.5,
      sweepInterval: 30,
      timeout: 0,
      maxQueryErrors: 3,
      allowDraft: true,
    });
    expect(parsed.pretty).toBe(true);
  });

  it("rejects every invalid mode and numeric shape as usage", async () => {
    const invalid = [
      ["--unknown"],
      ["--interval", "0"],
      ["--sweep-interval", "-1"],
      ["--timeout", "-1"],
      ["--max-query-errors", "1.5"],
      ["--stack", "--queued-stack"],
      ["--stack-prs", "1,2"],
      ["--queued-stack", "--stack-prs", "1,1"],
      ["--category", "bogus"],
      ["--risk", "-0.1"],
      ["--risk", "1.5"],
      ["--risk", "NaN"],
      ["--risk", ""],
    ];
    for (const argv of invalid) {
      const harness = testRuntime(fakeReader());
      expect(await main(argv, harness.runtime)).toBe(64);
      expect(harness.stdout).toEqual([]);
      expect(harness.stderr.join("")).toContain("error:");
    }
  });
});

describe("rendering", () => {
  const context = {
    owner: "owner",
    repo: "repo",
    number: parsePrNumber(1),
  };
  const status = {
    schemaVersion: 1,
    sequence: 1,
    observedAt: "2026-07-26T00:00:00.000Z",
    mode: "single",
    kind: "STATUS",
    terminal: true,
    exitCode: 0,
    reason: "status-only",
    rows: [
      {
        kind: "merged",
        context,
        facts: {
          context,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          headRefOid: "head",
          headRefName: "feature",
          baseRefName: "main",
          state: "MERGED",
          mergedAt: "now",
          isDraft: false,
        },
      },
    ],
  } satisfies WatcherVerdict;

  it("emits compact valid JSON by default", () => {
    const rendered = renderJson(status);
    expect(rendered.endsWith("\n")).toBe(true);
    expect(JSON.parse(rendered)).toEqual(status);
  });

  it("renders the Markdown table from the same verdict only", () => {
    const rendered = renderPretty(status);
    expect(rendered).toContain("| PR | CI | Review | Merge |");
    expect(rendered).toContain(
      "| [#1](https://github.com/owner/repo/pull/1) | \u2014 | \u2014 | ✅ merged |"
    );
  });
});

describe("main", () => {
  it("returns EX_USAGE 64 and writes usage errors only to stderr", async () => {
    const harness = testRuntime(fakeReader());
    expect(await main(["--interval", "0"], harness.runtime)).toBe(64);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join("")).toContain(
      "option '--interval <seconds>' argument '0' is invalid"
    );
  });

  it("bypasses the queue machine for queued-stack status-only", async () => {
    const reader = fakeReader();
    const harness = testRuntime(reader);
    const code = await main(
      [
        "--owner",
        "owner",
        "--repo",
        "repo",
        "--queued-stack",
        "--stack-prs",
        "1",
        "--status-only",
      ],
      harness.runtime
    );
    expect(code).toBe(0);
    expect(harness.stdout).toHaveLength(1);
    const verdict: unknown = JSON.parse(harness.stdout[0]);
    expect(verdict).toMatchObject({
      kind: "STATUS",
      terminal: true,
      exitCode: 0,
      mode: "queued-stack",
    });
    expect(harness.stdout[0]).not.toContain('"kind":"QUEUE"');
  });

  it("returns exit 4 for a hidden GitHub-side CI refusal", async () => {
    const reader = fakeReader({
      facts: { mergeStateStatus: "BLOCKED" },
      fastPath: { kind: "checks", checks: [passingCheck()] },
      commitRollups: [{ oid: "head", state: "FAILURE" }],
    });
    const harness = testRuntime(reader);
    const code = await main(
      ["--owner", "owner", "--repo", "repo", "--pr", "1"],
      harness.runtime
    );
    expect(code).toBe(4);
    expect(harness.stdout).toHaveLength(1);
    expect(JSON.parse(harness.stdout[0])).toMatchObject({
      kind: "BLOCKER",
      exitCode: 4,
      blocker: {
        kind: "failing-checks",
        ci: { kind: "ci-github-rejected" },
      },
    });
  });

  it("shows help without touching the reader", async () => {
    const reader = fakeReader();
    const harness = testRuntime(reader);
    expect(await main(["--help"], harness.runtime)).toBe(0);
    expect(harness.stdout.join("")).toContain("JSON (NDJSON while polling)");
    expect(harness.stdout.join("")).toContain("--record-outcome");
    expect(reader.calls).toEqual([]);
  });
});

function makeEnrolledTempRepo(prefix: string): {
  readonly dir: string;
  readonly headSha: string;
  readonly policy: Record<string, unknown>;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  const policy = {
    schemaVersion: 1,
    autonomy: {
      defaultCeiling: 2,
      ceilings: { docs: 3, tests: 3, ui: 3, skills: 3, tooling: 3, core: 3, governance: 2 },
    },
  };
  fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".agents", "risk-policy.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  return { dir, headSha, policy };
}

describe("opt-in outcome recording (--record-outcome)", () => {
  it("records clean, approved_with_edits (changes requested or human commits), and human_override with trust sync", async () => {
    const { dir, headSha, policy } = makeEnrolledTempRepo("astack-watch-pr-out-");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-watch-pr-data-"));
    try {
      const scope = resolveWorkspaceScope(dir);
      expect(scope.kind).toBe("enrolled_repo");
      if (scope.kind !== "enrolled_repo") throw new Error("expected enrolled_repo");

      const shaClean = "1".repeat(40);
      const cleanReader = fakeReader({
        facts: {
          state: "MERGED",
          mergedAt: "2026-07-26T00:00:00Z",
          headRefOid: shaClean,
          reviewDecision: "APPROVED",
        },
        reviews: [{ state: "APPROVED" }],
        commitRollups: [{ oid: shaClean, state: "SUCCESS" }],
      });
      const cleanHarness = testRuntime(cleanReader);
      const cleanCode = await main(
        [
          "--owner",
          "owner",
          "--repo",
          "repo",
          "--pr",
          "41",
          "--record-outcome",
          "--cwd",
          dir,
          "--data-dir",
          dataDir,
          "--category",
          "ui",
          "--risk",
          "0.12",
        ],
        cleanHarness.runtime
      );
      expect(cleanCode).toBe(0);
      expect(cleanHarness.stderr).toEqual([]);
      expect(JSON.parse(cleanHarness.stdout[0])).toMatchObject({ kind: "READY", exitCode: 0 });

      const shaChanges = "2".repeat(40);
      const changesReqReader = fakeReader({
        facts: {
          state: "MERGED",
          mergedAt: "2026-07-26T01:00:00Z",
          headRefOid: shaChanges,
          reviewDecision: "APPROVED",
        },
        reviews: [{ state: "CHANGES_REQUESTED" }, { state: "APPROVED" }],
        commitRollups: [{ oid: shaChanges, state: "SUCCESS" }],
      });
      const changesHarness = testRuntime(changesReqReader);
      expect(
        await main(
          [
            "--owner",
            "owner",
            "--repo",
            "repo",
            "--pr",
            "42",
            "--record-outcome",
            "--cwd",
            dir,
            "--data-dir",
            dataDir,
            "--category",
            "ui",
            "--risk",
            "0.25",
          ],
          changesHarness.runtime
        )
      ).toBe(0);

      const trustDir = resolveTrustDir({ workspaceDir: dir });
      if (trustDir === null) throw new Error("expected trustDir");
      const shaAgent = "3".repeat(40);
      const shaHuman = "4".repeat(40);
      recordReceipt(
        { kind: "tool-write", conversationId: "wpr", filePath: "sidecars/astack_timeline/app.js", workspaceDir: dir },
        { trustDir, headSha: shaAgent, now: "2026-07-26T02:00:00Z" }
      );
      writeEvidenceSnapshotAtomic(trustDir, {
        headSha: shaHuman,
        riskAssessment: { category: "ui", score: 0.31 },
      });
      const humanCommitReader = fakeReader({
        facts: {
          state: "MERGED",
          mergedAt: "2026-07-26T02:30:00Z",
          headRefOid: shaHuman,
          reviewDecision: "APPROVED",
        },
        reviews: [{ state: "APPROVED" }],
        commitRollups: [
          { oid: shaAgent, state: "SUCCESS" },
          { oid: shaHuman, state: "SUCCESS" },
        ],
      });
      const humanHarness = testRuntime(humanCommitReader);
      expect(
        await main(
          [
            "--owner",
            "owner",
            "--repo",
            "repo",
            "--pr",
            "43",
            "--record-outcome",
            "--cwd",
            dir,
            "--data-dir",
            dataDir,
          ],
          humanHarness.runtime
        )
      ).toBe(0);

      for (let i = 0; i < 6; i++) {
        recordOutcomeWithTrustSync({
          workspaceDir: dir,
          scope,
          policy,
          category: "ui",
          outcome: "clean",
          headSha,
          predictedR: 0.05,
          now: `2026-07-25T0${i}:00:00.000Z`,
          dataDir,
        });
      }
      applyTrustSettingsAction({
        repoId: scope.repoId,
        policy,
        action: { promotionMode: "auto" },
        now: "2026-07-25T12:00:00.000Z",
        dataDir,
      });
      const beforeClose = evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir,
        nowMs: Date.parse("2026-07-26T00:00:00.000Z"),
      });
      expect(beforeClose.categories.ui.level).toBe(1);

      const shaClosed = "5".repeat(40);
      const closedReader = fakeReader({
        facts: {
          state: "CLOSED",
          mergedAt: null,
          headRefOid: shaClosed,
          reviewDecision: null,
        },
      });
      const closedHarness = testRuntime(closedReader);
      const closedCode = await main(
        [
          "--owner",
          "owner",
          "--repo",
          "repo",
          "--pr",
          "44",
          "--record-outcome",
          "--cwd",
          dir,
          "--data-dir",
          dataDir,
          "--category",
          "ui",
          "--risk",
          "0.2",
        ],
        closedHarness.runtime
      );
      expect(closedCode).toBe(6);
      expect(JSON.parse(closedHarness.stdout[0])).toMatchObject({
        kind: "BLOCKER",
        exitCode: 6,
        blocker: { kind: "merge-gate", reason: "closed-without-merge" },
      });

      const afterClose = evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir,
        nowMs: Date.parse("2026-07-26T00:00:01.000Z"),
      });
      expect(afterClose.categories.ui.level).toBe(0);

      const ledger = readOutcomeLedger(scope.repoId, { dataDir });
      expect(ledger.chainValid).toBe(true);
      const watchEntries = ledger.entries.filter((e) => e.source === "watch-pr");
      expect(watchEntries).toHaveLength(4);
      expect(watchEntries[0]).toMatchObject({
        prNumber: 41,
        headSha: shaClean,
        category: "ui",
        outcome: "clean",
        y: 1,
        predictedR: 0.12,
      });
      expect(watchEntries[1]).toMatchObject({
        prNumber: 42,
        headSha: shaChanges,
        category: "ui",
        outcome: "approved_with_edits",
        y: 0.5,
        predictedR: 0.25,
      });
      expect(watchEntries[2]).toMatchObject({
        prNumber: 43,
        headSha: shaHuman,
        category: "ui",
        outcome: "approved_with_edits",
        y: 0.5,
        predictedR: 0.31,
      });
      expect(watchEntries[3]).toMatchObject({
        prNumber: 44,
        headSha: shaClosed,
        category: "ui",
        outcome: "human_override",
        y: 0,
        predictedR: 0.2,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated --status-only polls, records queued-stack COMPLETE merges, skips open PRs, and stays silent on non-git/unregistered repos", async () => {
    const { dir } = makeEnrolledTempRepo("astack-watch-pr-edge-");
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-watch-pr-nogit-"));
    const unregDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-watch-pr-unreg-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-watch-pr-edge-data-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: unregDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: unregDir, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Tester"], { cwd: unregDir, stdio: "ignore" });
      fs.writeFileSync(path.join(unregDir, "a.txt"), "1\n", "utf8");
      execFileSync("git", ["add", "."], { cwd: unregDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: unregDir, stdio: "ignore" });

      const scope = resolveWorkspaceScope(dir);
      if (scope.kind !== "enrolled_repo") throw new Error("expected enrolled_repo");

      const openReader = fakeReader({
        facts: { state: "OPEN", headRefOid: "6".repeat(40) },
      });
      const openHarness = testRuntime(openReader);
      expect(
        await main(
          [
            "--owner",
            "owner",
            "--repo",
            "repo",
            "--pr",
            "50",
            "--record-outcome",
            "--cwd",
            dir,
            "--data-dir",
            dataDir,
            "--category",
            "docs",
          ],
          openHarness.runtime
        )
      ).toBe(0);
      expect(readOutcomeLedger(scope.repoId, { dataDir }).entries).toHaveLength(0);

      const shaMerged = "7".repeat(40);
      const statusReader = fakeReader({
        facts: {
          state: "MERGED",
          mergedAt: "2026-07-26T00:00:00Z",
          headRefOid: shaMerged,
        },
        commitRollups: [{ oid: shaMerged, state: "SUCCESS" }],
      });
      const pollArgs = [
        "--owner",
        "owner",
        "--repo",
        "repo",
        "--pr",
        "51",
        "--status-only",
        "--record-outcome",
        "--cwd",
        dir,
        "--data-dir",
        dataDir,
        "--category",
        "docs",
      ];
      expect(await main(pollArgs, testRuntime(statusReader).runtime)).toBe(0);
      expect(await main(pollArgs, testRuntime(statusReader).runtime)).toBe(0);
      expect(readOutcomeLedger(scope.repoId, { dataDir }).entries).toHaveLength(1);

      const shaQ1 = "8".repeat(40);
      const shaQ2 = "9".repeat(40);
      const baseQueueReader = fakeReader({
        facts: { state: "MERGED", mergedAt: "2026-07-26T00:00:00Z" },
      });
      const queuedReader: GitHubReader = {
        ...baseQueueReader,
        async pullRequest(context) {
          return {
            ...(await baseQueueReader.pullRequest(context)),
            headRefOid: Number(context.number) === 61 ? shaQ1 : shaQ2,
          };
        },
        async commitRollups(context) {
          return [{ oid: Number(context.number) === 61 ? shaQ1 : shaQ2, state: "SUCCESS" }];
        },
      };
      const queueHarness = testRuntime(queuedReader);
      expect(
        await main(
          [
            "--owner",
            "owner",
            "--repo",
            "repo",
            "--queued-stack",
            "--stack-prs",
            "61,62",
            "--record-outcome",
            "--cwd",
            dir,
            "--data-dir",
            dataDir,
            "--category",
            "docs",
          ],
          queueHarness.runtime
        )
      ).toBe(0);
      const ledgerAfterQueue = readOutcomeLedger(scope.repoId, { dataDir });
      expect(ledgerAfterQueue.chainValid).toBe(true);
      expect(ledgerAfterQueue.entries.map((e) => e.prNumber)).toEqual([51, 61, 62]);

      const trustDirEdge = resolveTrustDir({ workspaceDir: dir });
      if (trustDirEdge === null) throw new Error("expected trustDir");
      writeEvidenceSnapshotAtomic(trustDirEdge, {
        headSha: "b".repeat(40),
        riskAssessment: { category: "governance", score: 0.99 },
      });
      const shaFreshPr = "c".repeat(40);
      const staleEvReader = fakeReader({
        facts: {
          state: "MERGED",
          mergedAt: "2026-07-26T00:00:00Z",
          headRefOid: shaFreshPr,
        },
        commitRollups: [{ oid: shaFreshPr, state: "SUCCESS" }],
      });
      expect(
        await main(
          [
            "--owner",
            "owner",
            "--repo",
            "repo",
            "--pr",
            "63",
            "--record-outcome",
            "--cwd",
            dir,
            "--data-dir",
            dataDir,
          ],
          testRuntime(staleEvReader).runtime
        )
      ).toBe(0);
      const entry63 = readOutcomeLedger(scope.repoId, { dataDir }).entries.find(
        (e) => e.prNumber === 63
      );
      expect(entry63).toMatchObject({
        prNumber: 63,
        category: "core",
        predictedR: 0,
        outcome: "clean",
      });

      const noFlagReader = fakeReader({
        facts: { state: "MERGED", mergedAt: "2026-07-26T00:00:00Z", headRefOid: "a".repeat(40) },
      });
      expect(
        await main(
          ["--owner", "owner", "--repo", "repo", "--pr", "70"],
          testRuntime(noFlagReader).runtime
        )
      ).toBe(0);
      expect(noFlagReader.calls).not.toContain("pullRequestReviews");

      for (const badDir of [nonGitDir, unregDir]) {
        const harness = testRuntime(statusReader);
        expect(
          await main(
            [
              "--owner",
              "owner",
              "--repo",
              "repo",
              "--pr",
              "80",
              "--record-outcome",
              "--cwd",
              badDir,
              "--data-dir",
              dataDir,
              "--category",
              "docs",
            ],
            harness.runtime
          )
        ).toBe(0);
        expect(harness.stderr.join("")).toContain("skipped outcome recording");
        expect(JSON.parse(harness.stdout[0])).toMatchObject({ kind: "READY", exitCode: 0 });
      }
      expect(readOutcomeLedger(scope.repoId, { dataDir }).entries).toHaveLength(4);

      const failingReviewsReader: GitHubReader = {
        ...statusReader,
        async pullRequestReviews() {
          throw new Error("gh reviews unavailable");
        },
      };
      const failRevHarness = testRuntime(failingReviewsReader);
      expect(
        await main(
          [
            "--owner",
            "owner",
            "--repo",
            "repo",
            "--pr",
            "81",
            "--record-outcome",
            "--cwd",
            dir,
            "--data-dir",
            dataDir,
            "--category",
            "docs",
          ],
          failRevHarness.runtime
        )
      ).toBe(0);
      expect(failRevHarness.stderr.join("")).toContain("failed to record outcome");
      expect(readOutcomeLedger(scope.repoId, { dataDir }).entries).toHaveLength(4);

      const ledgerPath = readOutcomeLedger(scope.repoId, { dataDir }).ledgerPath;
      if (ledgerPath === null) throw new Error("expected ledgerPath");
      fs.writeFileSync(
        ledgerPath,
        fs.readFileSync(ledgerPath, "utf8").replace('"clean"', '"reverted"'),
        "utf8"
      );
      const tamperedHarness = testRuntime(statusReader);
      expect(
        await main(
          [
            "--owner",
            "owner",
            "--repo",
            "repo",
            "--pr",
            "82",
            "--record-outcome",
            "--cwd",
            dir,
            "--data-dir",
            dataDir,
            "--category",
            "docs",
          ],
          tamperedHarness.runtime
        )
      ).toBe(0);
      expect(tamperedHarness.stderr.join("")).toContain("skipped outcome recording");
      expect(JSON.parse(tamperedHarness.stdout[0])).toMatchObject({ kind: "READY", exitCode: 0 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(nonGitDir, { recursive: true, force: true });
      fs.rmSync(unregDir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("prevents cross-PR receipt contamination, local-HEAD fabrication, unanchored evidence, foreign-repo writes, conflicting re-polls, and concurrent duplicate appends", async () => {
    const { dir } = makeEnrolledTempRepo("astack-watch-pr-hard-");
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-watch-pr-hard-data-"));
    try {
      execFileSync("git", ["remote", "add", "origin", "https://github.com/my-org/my-repo.git"], {
        cwd: dir,
        stdio: "ignore",
      });
      const scope = resolveWorkspaceScope(dir);
      if (scope.kind !== "enrolled_repo") throw new Error("expected enrolled_repo");
      const trustDir = resolveTrustDir({ workspaceDir: dir });
      if (trustDir === null) throw new Error("expected trustDir");

      const shaPriorAgent = "1".repeat(40);
      const shaPriorHuman = "2".repeat(40);
      recordReceipt(
        { kind: "tool-write", conversationId: "prev", filePath: "sidecars/astack_timeline/app.js", workspaceDir: dir },
        { trustDir, headSha: shaPriorAgent, now: "2026-07-26T00:00:00Z" }
      );

      const priorEditedReader = fakeReader({
        facts: { state: "MERGED", mergedAt: "2026-07-26T00:10:00Z", headRefOid: shaPriorHuman },
        reviews: [{ state: "APPROVED" }],
        commitRollups: [
          { oid: shaPriorAgent, state: "SUCCESS" },
          { oid: shaPriorHuman, state: "SUCCESS" },
        ],
      });
      expect(
        await main(
          [
            "--owner", "my-org", "--repo", "my-repo", "--pr", "91",
            "--record-outcome", "--cwd", dir, "--data-dir", dataDir,
          ],
          testRuntime(priorEditedReader).runtime
        )
      ).toBe(0);
      const entry91 = readOutcomeLedger(scope.repoId, { dataDir }).entries.find((e) => e.prNumber === 91);
      expect(entry91).toMatchObject({ prNumber: 91, category: "ui", outcome: "approved_with_edits", y: 0.5 });

      const shaUnrelatedClean = "3".repeat(40);
      writeEvidenceSnapshotAtomic(trustDir, {
        headSha: null,
        riskAssessment: { category: "governance", score: 0.95 },
      });
      const cleanAfterPriorReader = fakeReader({
        facts: { state: "MERGED", mergedAt: "2026-07-26T01:00:00Z", headRefOid: shaUnrelatedClean },
        reviews: [{ state: "APPROVED" }],
        commitRollups: [{ oid: shaUnrelatedClean, state: "SUCCESS" }],
      });
      expect(
        await main(
          [
            "--owner", "my-org", "--repo", "my-repo", "--pr", "92",
            "--record-outcome", "--cwd", dir, "--data-dir", dataDir,
          ],
          testRuntime(cleanAfterPriorReader).runtime
        )
      ).toBe(0);
      const entry92 = readOutcomeLedger(scope.repoId, { dataDir }).entries.find((e) => e.prNumber === 92);
      expect(entry92).toMatchObject({
        prNumber: 92,
        category: "core",
        outcome: "clean",
        y: 1,
        predictedR: 0,
      });

      const repollClean91Reader = fakeReader({
        facts: { state: "MERGED", mergedAt: "2026-07-26T00:10:00Z", headRefOid: shaPriorHuman },
        reviews: [{ state: "APPROVED" }],
        commitRollups: [{ oid: shaPriorHuman, state: "SUCCESS" }],
      });
      expect(
        await main(
          [
            "--owner", "my-org", "--repo", "my-repo", "--pr", "91",
            "--status-only", "--record-outcome", "--cwd", dir, "--data-dir", dataDir,
          ],
          testRuntime(repollClean91Reader).runtime
        )
      ).toBe(0);
      expect(
        readOutcomeLedger(scope.repoId, { dataDir }).entries.filter((e) => e.prNumber === 91)
      ).toHaveLength(1);

      const noShaReader = fakeReader({
        facts: { state: "MERGED", mergedAt: "2026-07-26T02:00:00Z", headRefOid: null },
        reviews: [{ state: "APPROVED" }],
        commitRollups: [],
      });
      const noShaHarness = testRuntime(noShaReader);
      expect(
        await main(
          [
            "--owner", "my-org", "--repo", "my-repo", "--pr", "93",
            "--record-outcome", "--cwd", dir, "--data-dir", dataDir, "--category", "docs",
          ],
          noShaHarness.runtime
        )
      ).toBe(0);
      expect(noShaHarness.stderr.join("")).toContain("no valid 40-hex headSha");
      expect(
        readOutcomeLedger(scope.repoId, { dataDir }).entries.filter((e) => e.prNumber === 93)
      ).toHaveLength(0);

      const foreignHarness = testRuntime(cleanAfterPriorReader);
      expect(
        await main(
          [
            "--owner", "other-org", "--repo", "other-repo", "--pr", "94",
            "--record-outcome", "--cwd", dir, "--data-dir", dataDir, "--category", "docs",
          ],
          foreignHarness.runtime
        )
      ).toBe(0);
      expect(foreignHarness.stderr.join("")).toContain("does not match local origin");
      expect(
        readOutcomeLedger(scope.repoId, { dataDir }).entries.filter((e) => e.prNumber === 94)
      ).toHaveLength(0);

      const shaRace = "4".repeat(40);
      const raceReader = fakeReader({
        facts: { state: "MERGED", mergedAt: "2026-07-26T03:00:00Z", headRefOid: shaRace },
        reviews: [{ state: "APPROVED" }],
        commitRollups: [{ oid: shaRace, state: "SUCCESS" }],
      });
      const raceArgs = [
        "--owner", "my-org", "--repo", "my-repo", "--pr", "95",
        "--status-only", "--record-outcome", "--cwd", dir, "--data-dir", dataDir, "--category", "docs",
      ];
      await Promise.all([
        main(raceArgs, testRuntime(raceReader).runtime),
        main(raceArgs, testRuntime(raceReader).runtime),
        main(raceArgs, testRuntime(raceReader).runtime),
      ]);
      const finalLedger = readOutcomeLedger(scope.repoId, { dataDir });
      expect(finalLedger.chainValid).toBe(true);
      expect(finalLedger.entries.filter((e) => e.prNumber === 95)).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
