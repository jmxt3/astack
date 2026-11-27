import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyTrustSettingsAction,
  compilePrDossier,
  recordReceipt,
  recordOutcomeWithTrustSync,
  recordVerifierReceipt,
  resolveWorkspaceScope,
  validateFindingsDocument,
  validatePrBodyContract,
  validateProofManifest,
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

    execFileSync("git", ["checkout", "-b", "feat/policy-tamper", "main"], { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agents", "risk-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        allowTier0AutoMerge: true,
        humanGates: { planApproval: "never", prReview: "tier0-auto" },
        tiers: {
          "0": { label: "low", globs: ["**/*"], requireHumanApproval: false },
          "3": { label: "critical", globs: [], requireHumanApproval: false },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(repo, "hooks.json"), "{}\n", "utf8");
    execFileSync("git", ["add", ".agents/risk-policy.json", "hooks.json"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "attempt policy bypass"], { cwd: repo, stdio: "ignore" });
    const tamperSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const tamperFindings = path.join(artifactDir, "tamper-findings.json");
    fs.writeFileSync(
      tamperFindings,
      JSON.stringify({
        schemaVersion: 1,
        headSha: tamperSha,
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Clean except policy edit",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );
    recordReceipt(
      { kind: "tool-command", conversationId: "exec", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha: tamperSha },
    );
    const tamperRes = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath: tamperFindings,
    });
    assert.equal(tamperRes.evidence.riskTier, 3);
    assert.equal(tamperRes.evidence.autoMergeEligible, false);
    assert.equal(tamperRes.evidence.baseReviewPolicy.riskPolicyModifiedInPr, true);

    const blankShaFindings = path.join(artifactDir, "blank-sha-findings.json");
    fs.writeFileSync(
      blankShaFindings,
      JSON.stringify({
        schemaVersion: 1,
        headSha: "",
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Missing headSha",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );
    const blankRes = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath: blankShaFindings,
    });
    assert.equal(blankRes.evidence.verifier.stale, true);
    assert.equal(blankRes.evidence.verifier.headSha, null);

    execFileSync("git", ["checkout", "-b", "feat/review-edit", "main"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "REVIEW.md"), "- Weakened\n", "utf8");
    execFileSync("git", ["add", "REVIEW.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "edit review"], { cwd: repo, stdio: "ignore" });
    const reviewEditSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const reviewFindings = path.join(artifactDir, "review-edit-findings.json");
    fs.writeFileSync(
      reviewFindings,
      JSON.stringify({
        schemaVersion: 1,
        headSha: reviewEditSha,
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Only review edit",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );
    recordReceipt(
      { kind: "tool-command", conversationId: "exec", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha: reviewEditSha },
    );

    execFileSync("git", ["checkout", "-b", "feat/clean-head-audit", "main"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "NOTES2.md"), "clean note\n", "utf8");
    execFileSync("git", ["add", "NOTES2.md"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "clean docs"], { cwd: repo, stdio: "ignore" });

    execFileSync("git", ["checkout", "main"], { cwd: repo, stdio: "ignore" });
    const crossBranchReview = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      headRef: "feat/review-edit",
      artifactDir,
      findingsPath: reviewFindings,
    });
    assert.equal(crossBranchReview.evidence.riskTier, 3);
    assert.equal(crossBranchReview.evidence.baseReviewPolicy.modifiedInPr, true);
    assert.equal(crossBranchReview.evidence.autoMergeEligible, false);

    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, "REVIEW.md"), "- Dirty uncommitted review edit\n", "utf8");
    fs.writeFileSync(path.join(repo, ".agents", "risk-policy.json"), "{}\n", "utf8");
    const nonHeadIsolated = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      headRef: "feat/clean-head-audit",
      artifactDir,
    });
    assert.equal(nonHeadIsolated.evidence.baseReviewPolicy.modifiedInPr, false);
    assert.equal(nonHeadIsolated.evidence.baseReviewPolicy.riskPolicyModifiedInPr, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("validateProofManifest enforces schema and compilePrDossier GitHub format covers all 4 statechart tiers, failed receipts, idempotent merge, and --check-pr-body", () => {
  assert.deepEqual(validateProofManifest({ schemaVersion: 2, checks: "no" }).length >= 2, true);
  assert.deepEqual(
    validateProofManifest({
      schemaVersion: 1,
      headSha: "a".repeat(40),
      statechart: { source: "feature-map-flow", transitions: [{ from: "Idle", to: "Done", action: "run", status: "PASS" }] },
      checks: [
        {
          id: "c1",
          featureId: "workflow-clis",
          name: "CLI check",
          surface: "cli",
          status: "UNREACHABLE",
          commandOrAction: "node cli.mjs",
          observed: "No server running",
        },
      ],
    }),
    [],
  );

  const repo = makeRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-gh-proof-"));
  const trustDir = path.join(artifactDir, "astack-trust");
  try {
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/demo-app.git"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feat/github-proof"], { cwd: repo, stdio: "ignore" });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "app.js"), "export const ready = true;\n", "utf8");
    execFileSync("git", ["add", "src/app.js"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add app"], { cwd: repo, stdio: "ignore" });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    recordReceipt(
      { kind: "tool-command", conversationId: "cli", command: "node --test tests/pass.test.js", error: "", workspaceDir: repo },
      { headSha },
    );
    recordReceipt(
      { kind: "tool-command", conversationId: "cli", command: "node --test tests/fail.test.js", error: "exit status 1", workspaceDir: repo },
      { headSha },
    );

    const tierC = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      format: "github",
    });
    assert.equal(tierC.evidence.statechartSource, "verification-lifecycle");
    assert.equal(tierC.evidence.recentChecks.length, 2);
    assert.equal(tierC.evidence.recentChecks[0].status, "PASS");
    assert.equal(tierC.evidence.recentChecks[1].status, "FAIL");
    assert.match(tierC.markdown, /<!-- astack:pr-proof:start -->/);
    assert.match(tierC.markdown, /<!-- astack:proof-meta \{/);
    assert.match(tierC.markdown, /```mermaid[\r\n]+stateDiagram-v2/);
    assert.match(tierC.markdown, /`PASS`/);
    assert.match(tierC.markdown, /`FAIL`/);
    assert.match(tierC.markdown, /https:\/\/github\.com\/acme\/demo-app\/blob\//);
    assert.doesNotMatch(tierC.markdown, /file:\/\/\//);
    assert.doesNotMatch(tierC.markdown, /````carousel/);
    assert.doesNotMatch(tierC.markdown, /[\u2013\u2014]/);
    assert.equal(validatePrBodyContract(tierC.markdown).ok, true);

    const eofFeatureDir = path.join(repo, ".agents", "skills", "verify-eof", "features");
    fs.mkdirSync(eofFeatureDir, { recursive: true });
    fs.writeFileSync(
      path.join(eofFeatureDir, "eof-only.md"),
      "# EOF Feature\n\n## Sub-features\n\n- Alpha bullet\n- Beta bullet\n",
      "utf8",
    );
    const tierB2Eof = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir: path.join(artifactDir, "empty-art"),
      format: "github",
      featureMapDir: eofFeatureDir,
    });
    assert.equal(tierB2Eof.evidence.statechartSource, "feature-map-coverage");
    assert.match(tierB2Eof.markdown, /Alpha bullet \[SKIP\]/);
    assert.match(tierB2Eof.markdown, /Beta bullet \[SKIP\]/);

    const featureDir = path.join(repo, ".agents", "skills", "verify-demo", "features");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(
      path.join(featureDir, "notes.md"),
      "# Notes Feature\n\n## Sub-features\n\n- Create note\n- Cancel draft\n- List notes\n",
      "utf8",
    );
    const manifestPath = path.join(trustDir, "proof-manifest.json");
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        featureMap: { skillDir: ".agents/skills/verify-demo", coveredFeatures: ["notes"] },
        checks: [
          {
            id: "create-note",
            featureId: "notes",
            name: "Create note persists",
            surface: "cli",
            status: "PASS",
            commandOrAction: "node cli.mjs create",
            observed: "Saved note 1",
          },
          {
            id: "cancel-note",
            featureId: "notes",
            name: "Cancel draft leaves store clean",
            surface: "ui",
            status: "UNREACHABLE",
            commandOrAction: "control-ui cancel",
            observed: "No headless browser in test",
          },
        ],
      }),
      "utf8",
    );

    const tierB2 = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      format: "github",
      featureMapDir: featureDir,
      proofManifestPath: manifestPath,
    });
    assert.equal(tierB2.evidence.statechartSource, "feature-map-coverage");
    assert.match(tierB2.markdown, /state "Notes Feature" as notes \{/);
    assert.doesNotMatch(tierB2.markdown, /create_note --> cancel_note/);
    assert.match(tierB2.markdown, /`UNREACHABLE`/);
    assert.match(tierB2.markdown, /"unreachable":1/);

    const flowManifestPath = path.join(trustDir, "flow-manifest.json");
    fs.writeFileSync(
      flowManifestPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha,
        statechart: {
          source: "feature-map-flow",
          transitions: [
            { from: "List", to: "Draft", action: "click New", status: "PASS" },
            { from: "Draft", to: "Saved", action: "click Save", status: "FAIL" },
          ],
        },
        checks: [
          {
            id: "save-flow",
            name: "Save flow",
            surface: "ui",
            status: "FAIL",
            commandOrAction: "click Save",
            observed: "500 returned",
          },
        ],
      }),
      "utf8",
    );
    const tierB1 = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      format: "github",
      proofManifestPath: flowManifestPath,
    });
    assert.equal(tierB1.evidence.statechartSource, "feature-map-flow");
    assert.match(tierB1.markdown, /List --> Draft: click New/);
    assert.match(tierB1.markdown, /class Saved fail/);

    const tlaPath = path.join(artifactDir, "tla.mmd");
    fs.writeFileSync(
      tlaPath,
      [
        "---",
        'title: "Demo Spec"',
        "---",
        "stateDiagram-v2",
        "  s0: Idle",
        "  s1: Broken",
        "  s0 --> s1: step",
        "  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834",
        "  class s0 teal",
        "  class s0 bugPath",
        "  class s1 breaks",
        "  class s1 repeats",
      ].join("\n"),
      "utf8",
    );
    const tierA1 = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      format: "github",
      statechartPath: tlaPath,
    });
    assert.equal(tierA1.evidence.statechartSource, "formal-tla");
    assert.match(tierA1.markdown, /classDef teal fill:#bfe3df/);
    assert.match(tierA1.markdown, /classDef bugPath stroke:#1680f3/);
    assert.match(tierA1.markdown, /classDef repeats stroke:#9b35d6/);

    const tsPath = path.join(artifactDir, "ts.mmd");
    fs.writeFileSync(tsPath, "%% provenance: formal-ts\nstateDiagram-v2\n  [*] --> Init\n  Init --> Ready: ok\n", "utf8");
    const tierA2 = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      format: "github",
      statechartPath: tsPath,
    });
    assert.equal(tierA2.evidence.statechartSource, "formal-ts");

    const prBodyFile = path.join(artifactDir, "body.md");
    fs.writeFileSync(prBodyFile, "## Why\n\nExplain the fix.\n\n## Scope\n\nCovers core parser.\n", "utf8");
    execFileSync(
      process.execPath,
      [cliPath, "--cwd", repo, "--base", "main", "--artifact-dir", artifactDir, "--format", "github", "--merge-body", prBodyFile, "--out", prBodyFile],
      { encoding: "utf8" },
    );
    const mergedFirst = fs.readFileSync(prBodyFile, "utf8");
    assert.match(mergedFirst, /^## Why[\s\S]*Explain the fix\./);
    assert.match(mergedFirst, /## Scope[\s\S]*Covers core parser\./);

    execFileSync(
      process.execPath,
      [cliPath, "--cwd", repo, "--base", "main", "--artifact-dir", artifactDir, "--format", "github", "--merge-body", prBodyFile, "--out", prBodyFile],
      { encoding: "utf8" },
    );
    const mergedSecond = fs.readFileSync(prBodyFile, "utf8");
    assert.equal(mergedSecond, mergedFirst);

    recordReceipt(
      {
        kind: "tool-command",
        conversationId: "cli",
        command: "node --test --grep '$& $$ $1'",
        error: "",
        workspaceDir: repo,
      },
      { headSha },
    );
    execFileSync(
      process.execPath,
      [cliPath, "--cwd", repo, "--base", "main", "--artifact-dir", artifactDir, "--format", "github", "--merge-body", prBodyFile, "--out", prBodyFile],
      { encoding: "utf8" },
    );
    const mergedDollar = fs.readFileSync(prBodyFile, "utf8");
    assert.ok(mergedDollar.includes("$& $$ $1"), "Expected literal $ replacement tokens to survive --merge-body");
    assert.equal(mergedDollar.match(/<!--\s*astack:pr-proof:start\s*-->/g)?.length, 1);

    const checkGood = spawnSync(
      process.execPath,
      [cliPath, "--check-pr-body", "-", "--json"],
      { input: mergedSecond, encoding: "utf8" },
    );
    assert.equal(checkGood.status, 0, checkGood.stderr);
    assert.equal(JSON.parse(checkGood.stdout).ok, true);

    const checkBad = spawnSync(
      process.execPath,
      [cliPath, "--check-pr-body", "-", "--json"],
      { input: "## Why\n\nPlain body with [local](file:///tmp/a.png)\n", encoding: "utf8" },
    );
    assert.equal(checkBad.status, 1);
    const badParsed = JSON.parse(checkBad.stdout);
    assert.equal(badParsed.ok, false);
    assert.ok(badParsed.violations.some((v) => /file:\/\/\//.test(v)));
    assert.ok(badParsed.violations.some((v) => /stateDiagram-v2/.test(v)));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("compilePrDossier reports Agent Trust level and unifies autoMergeEligible with Earned Trust L3 while keeping governance capped", () => {
  const repo = makeRepo();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dossier-trust-art-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dossier-trust-data-"));
  const trustDir = path.join(artifactDir, "astack-trust");
  try {
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".agents", "risk-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        autonomy: {
          defaultCeiling: 2,
          ceilings: { docs: 3, tests: 3, ui: 3, skills: 3, tooling: 3, core: 3, governance: 2 },
        },
      }, null, 2),
      "utf8",
    );
    fs.mkdirSync(path.join(repo, "sidecars", "demo"), { recursive: true });
    fs.writeFileSync(path.join(repo, "sidecars", "demo", "app.js"), "export const x = 1;\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "enroll repo"], { cwd: repo, stdio: "ignore" });
    const baseSha = execFileSync("git", ["rev-parse", "main"], { cwd: repo, encoding: "utf8" }).trim();
    const scope = resolveWorkspaceScope(repo);
    assert.equal(scope.kind, "enrolled_repo");

    applyTrustSettingsAction({
      repoId: scope.repoId,
      action: { beastOn: true, promotionMode: "auto" },
      dataDir,
    });

    execFileSync("git", ["checkout", "-b", "feat/ui-change"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "sidecars", "demo", "app.js"), "export const x = 2;\n", "utf8");
    execFileSync("git", ["add", "sidecars/demo/app.js"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "ui update"], { cwd: repo, stdio: "ignore" });
    const headUi = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

    recordReceipt(
      { kind: "tool-command", conversationId: "u1", command: "node --test sidecars/demo/app.test.js", error: "", workspaceDir: repo },
      { trustDir, headSha: headUi },
    );
    const findingsPath = path.join(trustDir, "findings.json");
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(
      findingsPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha: headUi,
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Verified UI change",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );
    recordVerifierReceipt({ trustDir, headSha: headUi, verdict: "PASS", findingsPath });

    const l0Dossier = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath,
      dataDir,
    });
    assert.equal(l0Dossier.evidence.autoMergeEligible, false);
    assert.equal(l0Dossier.evidence.trustContext?.category, "ui");
    assert.equal(l0Dossier.evidence.trustContext?.level, 0);
    assert.match(l0Dossier.markdown, /\| Agent Trust \| `ui` `L0\/L3` \(T `0\.00`, ceiling `L2`, 0\/12 merges, Beast Mode On, auto promo\) \|/);
    assert.match(l0Dossier.evidence.autoMerge?.reason ?? "", /earn L3 trust before delegating Merge/i);

    for (let i = 0; i < 12; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: repo,
        scope,
        category: "ui",
        outcome: "clean",
        headSha: headUi,
        predictedR: 0.05,
        dataDir,
      });
    }
    applyTrustSettingsAction({
      repoId: scope.repoId,
      action: { setCeiling: { category: "ui", ceiling: 3 } },
      dataDir,
    });

    const l3Dossier = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath,
      dataDir,
    });
    assert.equal(l3Dossier.evidence.trustContext?.level, 3);
    assert.equal(l3Dossier.evidence.autoMergeEligible, true);
    assert.equal(l3Dossier.evidence.autoMerge?.mode, "earned_trust_l3");
    assert.match(l3Dossier.markdown, /Yes \(Earned Trust L3 for ui, residual low\)/);
    assert.match(l3Dossier.markdown, /\| Agent Trust \| `ui` `L3\/L3`/);

    const l3Github = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath,
      dataDir,
      format: "github",
    });
    assert.match(l3Github.markdown, /Agent trust for `ui` is `L3\/L3`/);
    assert.match(l3Github.markdown, /Auto-merge is `Yes`/);
    assert.equal(validatePrBodyContract(l3Github.markdown).ok, true);

    for (let i = 0; i < 12; i++) {
      recordOutcomeWithTrustSync({
        workspaceDir: repo,
        scope,
        category: "governance",
        outcome: "clean",
        headSha: headUi,
        predictedR: 0.05,
        dataDir,
      });
    }
    fs.writeFileSync(path.join(repo, "hooks.json"), "{}\n", "utf8");
    execFileSync("git", ["add", "hooks.json"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "touch hooks"], { cwd: repo, stdio: "ignore" });
    const headGov = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    recordReceipt(
      { kind: "tool-command", conversationId: "u1", command: "node --test", error: "", workspaceDir: repo },
      { trustDir, headSha: headGov },
    );
    fs.writeFileSync(
      findingsPath,
      JSON.stringify({
        schemaVersion: 1,
        headSha: headGov,
        baseSha,
        round: 1,
        verdict: "PASS",
        summary: "Verified gov change",
        findings: [],
        dropped: [],
        reviewMdCompliance: { checked: true, violations: [] },
      }),
      "utf8",
    );
    recordVerifierReceipt({ trustDir, headSha: headGov, verdict: "PASS", findingsPath });

    const govDossier = compilePrDossier({
      cwd: repo,
      baseRef: "main",
      artifactDir,
      findingsPath,
      dataDir,
    });
    assert.equal(govDossier.evidence.autoMergeEligible, false);
    assert.equal(govDossier.evidence.trustContext?.category, "governance");
    assert.match(govDossier.markdown, /capped at `L2` forever/);
    assert.match(govDossier.evidence.autoMerge?.reason ?? "", /capped at L2 forever and never auto-merge/i);

    const legacyRepo = makeRepo();
    const legacyArt = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dossier-legacy-art-"));
    const legacyData = fs.mkdtempSync(path.join(os.tmpdir(), "astack-dossier-legacy-data-"));
    const legacyTrustDir = path.join(legacyArt, "astack-trust");
    try {
      fs.mkdirSync(path.join(legacyRepo, ".agents"), { recursive: true });
      fs.writeFileSync(
        path.join(legacyRepo, ".agents", "risk-policy.json"),
        JSON.stringify({
          schemaVersion: 1,
          allowTier0AutoMerge: true,
          humanGates: { planApproval: "nontrivial", prReview: "never" },
        }, null, 2),
        "utf8",
      );
      execFileSync("git", ["add", ".agents/risk-policy.json"], { cwd: legacyRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "enable legacy tier0"], { cwd: legacyRepo, stdio: "ignore" });
      const legacyBaseSha = execFileSync("git", ["rev-parse", "main"], { cwd: legacyRepo, encoding: "utf8" }).trim();
      const legacyScope = resolveWorkspaceScope(legacyRepo);
      assert.equal(legacyScope.kind, "enrolled_repo");
      applyTrustSettingsAction({ repoId: legacyScope.repoId, action: { beastOn: true }, dataDir: legacyData });

      execFileSync("git", ["checkout", "-b", "feat/tests-legacy"], { cwd: legacyRepo, stdio: "ignore" });
      fs.writeFileSync(
        path.join(legacyRepo, "tests", "app.test.js"),
        "import assert from 'node:assert/strict';\nassert.equal(1, 1);\nassert.equal(2, 2);\nassert.equal(3, 3);\n",
        "utf8",
      );
      execFileSync("git", ["add", "tests/app.test.js"], { cwd: legacyRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "add test assertion"], { cwd: legacyRepo, stdio: "ignore" });
      const legacyHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: legacyRepo, encoding: "utf8" }).trim();

      recordReceipt(
        { kind: "tool-command", conversationId: "u2", command: "node --test tests/app.test.js", error: "", workspaceDir: legacyRepo },
        { trustDir: legacyTrustDir, headSha: legacyHead },
      );
      const legacyFindings = path.join(legacyTrustDir, "findings.json");
      fs.mkdirSync(legacyTrustDir, { recursive: true });
      fs.writeFileSync(
        legacyFindings,
        JSON.stringify({
          schemaVersion: 1,
          headSha: legacyHead,
          baseSha: legacyBaseSha,
          round: 1,
          verdict: "PASS",
          summary: "Clean test addition",
          findings: [],
          dropped: [],
          reviewMdCompliance: { checked: true, violations: [] },
        }),
        "utf8",
      );
      recordVerifierReceipt({ trustDir: legacyTrustDir, headSha: legacyHead, verdict: "PASS", findingsPath: legacyFindings });

      const legacyDossier = compilePrDossier({
        cwd: legacyRepo,
        baseRef: "main",
        artifactDir: legacyArt,
        findingsPath: legacyFindings,
        dataDir: legacyData,
      });
      assert.equal(legacyDossier.evidence.trustContext?.level, 0);
      assert.equal(legacyDossier.evidence.autoMergeEligible, true);
      assert.equal(legacyDossier.evidence.autoMerge?.mode, "tier0_opt_in");
      assert.doesNotMatch(legacyDossier.evidence.autoMerge?.label ?? "", /Earned Trust L0/i);
      assert.match(legacyDossier.evidence.autoMerge?.label ?? "", /Tier 0 opt-in satisfied for tests/i);
    } finally {
      fs.rmSync(legacyRepo, { recursive: true, force: true });
      fs.rmSync(legacyArt, { recursive: true, force: true });
      fs.rmSync(legacyData, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
