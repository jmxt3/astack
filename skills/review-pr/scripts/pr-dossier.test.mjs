import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compilePrDossier,
  recordReceipt,
  recordVerifierReceipt,
  validateFindingsDocument,
} from "../../../scripts/trust/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "pr-dossier.mjs");

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dossier-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# Demo\n", "utf8");
  fs.writeFileSync(path.join(dir, "REVIEW.md"), "- Reject assertion weakening\n", "utf8");
  fs.mkdirSync(path.join(dir, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "tests", "app.test.js"),
    "import assert from 'node:assert/strict';\nassert.equal(1, 1);\nassert.equal(2, 2);\n",
    "utf8",
  );
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "base"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("compilePrDossier classifies Risk Tiers, opt-in Tier 0 auto-merge, assertion weakening, and renders Mermaid + carousel", () => {
  const repo = makeRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dossier-artifacts-"));
  const trustDir = path.join(artifactDir, "astack-trust");
  try {
    execFileSync("git", ["checkout", "-b", "feat/docs"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "README.md"), "# Demo updated\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "docs update"], { cwd: repo, stdio: "ignore" });

    const headDocs = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const baseSha = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();
    const findingsPath = path.join(trustDir, "findings.json");
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(
      findingsPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha: headDocs,
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Clean docs edit",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );
    recordVerifierReceipt({ trustDir, headSha: headDocs, verdict: "PASS", findingsPath });

    const defaultTier0 = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath,
    });
    assert.equal(defaultTier0.evidence.riskTier, 0);
    assert.equal(defaultTier0.evidence.freshness, "fresh");
    assert.equal(defaultTier0.evidence.autoMergeEligible, false);

    execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agents", "risk-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        allowTier0AutoMerge: true,
        humanGates: { planApproval: "nontrivial", prReview: "tier0-auto" },
      }),
      "utf8",
    );
    execFileSync("git", ["add", ".agents/risk-policy.json"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "enable tier0 policy"], { cwd: repo, stdio: "ignore" });

    execFileSync("git", ["checkout", "-b", "feat/docs-2"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "README.md"), "# Demo v2\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "docs v2"], { cwd: repo, stdio: "ignore" });
    const headDocs2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    recordReceipt(
      {
        kind: "tool-command",
        conversationId: "runner",
        command: "node --test | cat",
        error: "",
        workspaceDir: repo,
      },
      { trustDir, headSha: headDocs2 },
    );

    const shot = path.join(artifactDir, "home.png");
    fs.writeFileSync(shot, "fake-png", "utf8");
    const outMd = path.join(artifactDir, "pr-review.md");

    const staleAttempt = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath,
      screenshots: [shot],
      outPath: outMd,
    });
    assert.equal(staleAttempt.evidence.verifier.stale, true);
    assert.notEqual(staleAttempt.evidence.roundState, "verified");
    assert.equal(staleAttempt.evidence.autoMergeEligible, false);
    assert.match(staleAttempt.markdown, /stale|older commit/i);

    fs.writeFileSync(
      findingsPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha: headDocs2,
        baseSha: execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim(),
        round: 1,
        verdict: "PASS",
        summary: "Clean v2 docs edit",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );

    const optedIn = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath,
      screenshots: [shot],
      outPath: outMd,
    });
    assert.equal(optedIn.evidence.riskTier, 0);
    assert.equal(optedIn.evidence.verifier.stale, false);
    assert.equal(optedIn.evidence.autoMergeEligible, true);
    assert.match(optedIn.markdown, /```mermaid/);
    assert.match(optedIn.markdown, /````carousel/);
    assert.match(optedIn.markdown, /file:\/\/\//);
    assert.match(optedIn.markdown, /!\[home\.png\]\([^\\\r\n]+\/home\.png\)/);
    assert.match(optedIn.markdown, /node --test \\\| cat/);

    const policyViolatingPath = path.join(trustDir, "findings-viol.json");
    fs.writeFileSync(
      policyViolatingPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha: headDocs2,
        baseSha: execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim(),
        round: 1,
        verdict: "PASS_WITH_NOTES",
        summary: "Review violation present",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: ["Weakened invariant"] },
      }),
      "utf8",
    );
    const violAttempt = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath: policyViolatingPath,
    });
    assert.equal(violAttempt.evidence.autoMergeEligible, false);
    assert.equal(violAttempt.evidence.verifier.reviewViolationCount, 1);

    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    fs.writeFileSync(path.join(repo, "docs", "old-note.md"), "# Old\n", "utf8");
    execFileSync("git", ["add", "docs/old-note.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add note"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["mv", "docs/old-note.md", "docs/new-note.md"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "staged-script.mjs"), "export const s = 1;\n", "utf8");
    execFileSync("git", ["add", "staged-script.mjs"], { cwd: repo, stdio: "ignore" });

    const stagedDossier = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
    });
    const allClusterFiles = stagedDossier.evidence.clusters.flatMap((c) => c.files);
    assert.ok(allClusterFiles.includes("staged-script.mjs"), `Expected staged-script.mjs in ${allClusterFiles}`);
    assert.ok(allClusterFiles.includes("docs/new-note.md"), `Expected docs/new-note.md in ${allClusterFiles}`);
    assert.ok(allClusterFiles.every((f) => !f.includes("=>") && !f.includes("->")), `Leaked rename syntax in ${allClusterFiles}`);

    execFileSync("git", ["checkout", "-b", "feat/risky"], { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "auth-login.js"), "export const allow = true;\n", "utf8");
    fs.writeFileSync(path.join(repo, "REVIEW.md"), "- Disabled\n", "utf8");
    fs.writeFileSync(
      path.join(repo, "tests", "app.test.js"),
      "import assert from 'node:assert/strict';\n",
      "utf8",
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "risky"], { cwd: repo, stdio: "ignore" });

    const riskyRes = JSON.parse(
      execFileSync(
        process.execPath,
        [cliPath, "--cwd", repo, "--base", "main", "--artifact-dir", artifactDir, "--json"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(riskyRes.evidence.riskTier, 3);
    assert.equal(riskyRes.evidence.autoMergeEligible, false);
    assert.equal(riskyRes.evidence.assertionDelta.flagged, true);
    assert.equal(riskyRes.evidence.baseReviewPolicy.modifiedInPr, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("validateFindingsDocument enforces schemaVersion, severity enum, and non-empty claims", () => {
  const errs = validateFindingsDocument({
    schemaVersion: 1,
    verdict: "FAIL",
    summary: "Found bug",
    findings: [
      {
        id: "F-1",
        severity: "important",
        category: "correctness",
        file: "src/app.js",
        line: 10,
        claim: "Null dereference on missing user",
        evidence: "node repro.mjs threw TypeError",
        suggestedFix: "Guard null user before dereference",
      },
    ],
    dropped: [{ claim: "Style preference", reason: "No runtime bug" }],
    reviewMdCompliance: { checked: true, violations: [] },
  });
  assert.deepEqual(errs, []);

  const badErrs = validateFindingsDocument({ schemaVersion: 2, verdict: "BOGUS", findings: "no" });
    assert.equal(badErrs.length >= 3, true);
});

test("compilePrDossier preserves rebase match across repeated runs, rejects stale unpassed --findings inheritance, and keeps hunk 1 line numbers", () => {
  const repo = makeRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dossier-prv-"));
  const trustDir = path.join(artifactDir, "astack-trust");
  const customFindings = path.join(artifactDir, "custom-findings.json");
  try {
    execFileSync("git", ["checkout", "-b", "feat/rebase-check"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "README.md"), "# R1\n\nline3\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "readme change"], { cwd: repo, stdio: "ignore" });
    const sha1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const baseSha = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();

    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(
      customFindings,
      JSON.stringify({
        schemaVersion: 1,
        headSha: sha1,
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Verified sha1",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );
    recordReceipt(
      { kind: "tool-command", conversationId: "exec", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha: sha1 },
    );
    const runSha1 = compilePrDossier({ cwd: repo, baseRef: "main", artifactDir, findingsPath: customFindings });
    assert.equal(runSha1.evidence.freshness, "fresh");
    assert.equal(runSha1.evidence.roundState, "verified");

    execFileSync("git", ["commit", "--amend", "-m", "rebased commit message"], { cwd: repo, stdio: "ignore" });
    const sha2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.notEqual(sha2, sha1);

    const rebaseRun1 = compilePrDossier({ cwd: repo, baseRef: "main", artifactDir, findingsPath: customFindings });
    assert.equal(rebaseRun1.evidence.freshness, "fresh_rebase_patch_id");
    assert.equal(rebaseRun1.evidence.verifier.stale, false);
    assert.equal(rebaseRun1.evidence.roundState, "verified");

    const rebaseRun2 = compilePrDossier({ cwd: repo, baseRef: "main", artifactDir, findingsPath: customFindings });
    assert.equal(rebaseRun2.evidence.freshness, "fresh_rebase_patch_id");
    assert.equal(rebaseRun2.evidence.verifier.stale, false);
    assert.equal(rebaseRun2.evidence.roundState, "verified");

    const manyLines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    fs.writeFileSync(path.join(repo, "multi.txt"), manyLines, "utf8");
    execFileSync("git", ["add", "multi.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add multi"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "multi.txt"), manyLines.replace("line 1\n", "line 1 edited\n").replace("line 38\n", "line 38 edited\n"), "utf8");
    execFileSync("git", ["add", "multi.txt"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "two hunks"], { cwd: repo, stdio: "ignore" });
    const sha3 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    recordReceipt(
      { kind: "tool-command", conversationId: "exec", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha: sha3 },
    );

    const afterNewCommitNoFindings = compilePrDossier({ cwd: repo, baseRef: "main", artifactDir });
    assert.equal(afterNewCommitNoFindings.evidence.verifier.stale, true);
    assert.notEqual(afterNewCommitNoFindings.evidence.roundState, "verified");

    fs.writeFileSync(path.join(repo, "NOTES.md"), "base line 1\n" + Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n") + "\n", "utf8");
    execFileSync("git", ["add", "NOTES.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base notes"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feat/hunk1", "HEAD"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(
      path.join(repo, "NOTES.md"),
      "edited line 1\n" + Array.from({ length: 29 }, (_, i) => `n${i}`).join("\n") + "\nn29 edited\n",
      "utf8",
    );
    execFileSync("git", ["add", "NOTES.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "two hunks at line 1 and 31"], { cwd: repo, stdio: "ignore" });

    const hunkRes = compilePrDossier({ cwd: repo, baseRef: "HEAD~1", artifactDir });
    const docsCluster = hunkRes.evidence.clusters.find((c) => c.id === "docs-and-generated");
    assert.equal(docsCluster.firstLines["NOTES.md"], 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});
