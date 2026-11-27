import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  computeFreshness,
  evaluateRoundState,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  resolveTrustDir,
  writeEvidenceSnapshotAtomic,
} from "./ledger.mjs";
import {
  computeAssertionDelta,
  loadBoundaries,
  loadRiskPolicy,
  matchesAnyGlob,
  parsePorcelainPaths,
  readBaseReviewContext,
  resolveBaseRef,
} from "./policy.mjs";
import { assessChange } from "./risk.mjs";
import { resolveResidual } from "./mitigation.mjs";
import { evaluateIntentScope, readIntentCard } from "./intent.mjs";
import {
  renderGitHubPrProof,
  resolvePrStatechart,
  validateProofManifest,
} from "./pr-proof.mjs";

const VALID_VERDICTS = new Set(["PASS", "PASS_WITH_NOTES", "FAIL", "ESCALATE_HUMAN"]);
const VALID_SEVERITIES = new Set(["important", "nit", "pre_existing"]);
const VALID_CATEGORIES = new Set([
  "correctness",
  "security",
  "boundary",
  "test_weakening",
  "review_md",
  "regression",
  "architecture",
]);

function tryGitText(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function computePatchId(diffText, cwd) {
  if (!diffText || !diffText.trim()) return null;
  const res = spawnSync("git", ["patch-id", "--stable"], {
    cwd,
    input: diffText,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) return null;
  const sha = res.stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/**
 * Classifies changed files into Blast-Radius Risk Tiers 0..3 using `.agents/risk-policy.json`.
 */
export function classifyRiskTier(files, policy) {
  const tiers = policy?.tiers ?? {};
  const matchedMap = new Map();
  let highest = 0;

  for (const file of files) {
    const clean = String(file).replace(/\\/g, "/").replace(/^\.\//, "");
    let assigned = null;
    for (const tierNum of [3, 2, 1, 0]) {
      const cfg = tiers[String(tierNum)];
      if (!cfg || !Array.isArray(cfg.globs) || cfg.globs.length === 0) continue;
      for (const glob of cfg.globs) {
        if (matchesAnyGlob(clean, [glob])) {
          assigned = { tier: tierNum, glob };
          break;
        }
      }
      if (assigned) break;
    }
    if (!assigned) {
      assigned = { tier: Number(policy?.defaultTier ?? 1), glob: "<default>" };
    }
    if (assigned.tier > highest) highest = assigned.tier;
    const key = `${assigned.tier}:${assigned.glob}`;
    const existing = matchedMap.get(key) ?? { tier: assigned.tier, glob: assigned.glob, files: [] };
    existing.files.push(clean);
    matchedMap.set(key, existing);
  }

  return {
    tier: files.length === 0 ? 0 : highest,
    matchedRules: [...matchedMap.values()].sort((a, b) => b.tier - a.tier),
  };
}

function classifyClusterId(filePath) {
  const clean = filePath.replace(/\\/g, "/");
  if (
    /(?:^|\/)(?:tests?|fixtures?|__tests__|mocks?)(?:\/|$)|\.(?:test|spec)\.[jtcm]?[jt]sx?$/i.test(clean) ||
    /(?:schema|types|contract)\b|^REVIEW\.md$|^GLOSSARY\.md$/i.test(path.posix.basename(clean))
  ) {
    return "contracts-and-tests";
  }
  if (/\.md$|\.txt$|^docs\//i.test(clean)) {
    return "docs-and-generated";
  }
  if (
    /^(?:scripts\/trust|scripts\/hooks|src\/core|lib|domain)\//i.test(clean)
  ) {
    return "core-domain";
  }
  return "plumbing-and-wiring";
}

const CLUSTER_TITLES = {
  "contracts-and-tests": "1. Contracts and Tests",
  "core-domain": "2. Core State and Domain",
  "plumbing-and-wiring": "3. Plumbing and Wiring",
  "docs-and-generated": "4. Docs and Generated",
};

/**
 * Groups changed files into guided human review reading order.
 */
export function clusterChangedFiles(fileEntries) {
  const buckets = new Map([
    ["contracts-and-tests", []],
    ["core-domain", []],
    ["plumbing-and-wiring", []],
    ["docs-and-generated", []],
  ]);
  for (const entry of fileEntries) {
    const id = classifyClusterId(entry.file);
    buckets.get(id).push(entry);
  }
  const out = [];
  for (const [id, items] of buckets.entries()) {
    if (items.length === 0) continue;
    out.push({
      id,
      title: CLUSTER_TITLES[id],
      files: items.map((i) => i.file),
      additions: items.reduce((s, i) => s + i.additions, 0),
      deletions: items.reduce((s, i) => s + i.deletions, 0),
      firstLines: Object.fromEntries(items.map((i) => [i.file, i.firstLine ?? 1])),
      fileStats: Object.fromEntries(
        items.map((i) => [
          i.file,
          { additions: i.additions, deletions: i.deletions, firstLine: i.firstLine ?? 1 },
        ]),
      ),
    });
  }
  return out;
}

function parseNumstatAndFirstLines(numstatText, diffText) {
  const stats = new Map();
  for (const line of String(numstatText ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
    const deletions = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
    const file = parts.slice(2).join("\t").replace(/\\/g, "/");
    stats.set(file, { file, additions, deletions, firstLine: null });
  }

  let currentFile = "";
  let inHeader = false;
  let headerSrc = "";
  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      currentFile = m ? m[1].replace(/\\/g, "/") : "";
      headerSrc = currentFile;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("--- a/")) {
        headerSrc = line.slice(6).replace(/\\/g, "/");
        continue;
      }
      if (line === "+++ /dev/null") {
        currentFile = headerSrc;
        continue;
      }
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6).replace(/\\/g, "/");
        continue;
      }
      if (line.startsWith("@@ ")) {
        inHeader = false;
      }
    }
    if (currentFile && line.startsWith("@@ ")) {
      const hunk = line.match(/\+(\d+)/);
      if (hunk && stats.has(currentFile) && stats.get(currentFile).firstLine === null) {
        stats.get(currentFile).firstLine = Math.max(1, Number.parseInt(hunk[1], 10) || 1);
      }
    }
  }
  return [...stats.values()].map((entry) => ({ ...entry, firstLine: entry.firstLine ?? 1 }));
}

/**
 * Validates a `findings.json` document emitted by `pr-verifier` or incident-replay evals.
 */
export function validateFindingsDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return ["Document must be a JSON object"];
  }
  if (doc.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (!VALID_VERDICTS.has(doc.verdict)) {
    errors.push(`verdict must be one of ${[...VALID_VERDICTS].join(", ")}`);
  }
  if (typeof doc.summary !== "string" || !doc.summary.trim()) {
    errors.push("summary must be a non-empty string");
  }
  if (!Array.isArray(doc.findings)) {
    errors.push("findings must be an array");
  } else {
    doc.findings.forEach((f, idx) => {
      if (!f || typeof f !== "object") {
        errors.push(`findings[${idx}] must be an object`);
        return;
      }
      if (!VALID_SEVERITIES.has(f.severity)) {
        errors.push(`findings[${idx}].severity invalid: ${f.severity}`);
      }
      if (!VALID_CATEGORIES.has(f.category)) {
        errors.push(`findings[${idx}].category invalid: ${f.category}`);
      }
      for (const req of ["id", "file", "claim", "evidence", "suggestedFix"]) {
        if (typeof f[req] !== "string" || !f[req].trim()) {
          errors.push(`findings[${idx}].${req} must be a non-empty string`);
        }
      }
      if (!Number.isInteger(f.line) || f.line < 1) {
        errors.push(`findings[${idx}].line must be integer >= 1`);
      }
    });
  }
  if (!Array.isArray(doc.dropped)) {
    errors.push("dropped must be an array");
  }
  if (!doc.reviewMdCompliance || typeof doc.reviewMdCompliance.checked !== "boolean" || !Array.isArray(doc.reviewMdCompliance.violations)) {
    errors.push("reviewMdCompliance must include boolean checked and array violations");
  }
  return errors;
}

function escapeMarkdownCell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

function toFileUrl(absPath, line = 1) {
  const normalized = path.resolve(absPath).replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${normalized}#L${line}`;
}

/**
 * Renders the visual Markdown + Mermaid + carousel PR review dossier for Antigravity App, CLI, IDE, and GitHub.
 */
export function renderDossierMarkdown({
  workspaceDir,
  evidence,
  findingsDoc = null,
}) {
  const lines = [
    `# Visual PR Review Dossier`,
    "",
    `| Signal | Value |`,
    `|---|---|`,
    `| Risk Tier | Tier ${evidence.riskTier} (${evidence.riskLabel}) |`,
    `| Freshness | \`${evidence.freshness}\` (HEAD \`${(evidence.headSha ?? "none").slice(0, 7)}\`) |`,
    `| Review Round | ${evidence.reviewRound}/${evidence.maxReviewRounds} (\`${evidence.roundState}\`) |`,
    `| Base REVIEW.md | ${evidence.baseReviewPolicy.present ? (evidence.baseReviewPolicy.modifiedInPr ? "Present (MODIFIED IN PR)" : "Present (unchanged)") : "Not present on base"}${evidence.baseReviewPolicy.riskPolicyModifiedInPr ? " (risk-policy.json MODIFIED IN PR)" : ""} |`,
    `| Test Assertions | +${evidence.assertionDelta.added} / -${evidence.assertionDelta.removed} (ratio ${evidence.assertionDelta.weakeningRatio}${evidence.assertionDelta.flagged ? ", FLAGGED" : ""}) |`,
    `| Auto-Merge Eligible | ${evidence.autoMergeEligible ? "Yes (Tier 0 opt-in satisfied)" : "No (Human review required)"} |`,
    "",
  ];

  if (evidence.riskAssessment) {
    const ra = evidence.riskAssessment;
    lines.push("## Risk Card", "");
    lines.push(ra.summary, "");
    lines.push(
      `| Field | Value |`,
      `|---|---|`,
      `| Category | \`${ra.category}\` |`,
      `| Risk Score (R) | \`${ra.score.toFixed(2)}\` (inherent \`${ra.inherent}\`, residual \`${ra.residual}\`) |`,
      `| Rollback | \`${ra.rollback.kind}\`: ${escapeMarkdownCell(ra.rollback.plan)} |`,
      `| Signals | ${ra.signals.length > 0 ? ra.signals.map((s) => `\`${s.id}\``).join(", ") : "none"} |`,
      "",
    );
  }

  lines.push("## Blast Radius Map", "", "```mermaid", "flowchart LR");
  const baseLabel = `Base ${(evidence.baseRef ?? "trunk").replace(/"/g, "'")}`;
  lines.push(`  Base["${baseLabel}"]`);
  if (evidence.clusters.length === 0) {
    lines.push(`  NoDiff["No changed files"]`);
    lines.push("  Base --> NoDiff");
  } else {
    for (const cluster of evidence.clusters) {
      const nodeId = cluster.id.replace(/[^a-zA-Z0-9]/g, "_");
      const label = `${cluster.title} (${cluster.files.length} files, +${cluster.additions}/-${cluster.deletions})`;
      lines.push(`  ${nodeId}["${label.replace(/"/g, "'")}"]`);
      lines.push(`  Base --> ${nodeId}`);
    }
  }
  lines.push(`  Gate["Risk Tier ${evidence.riskTier} Gate"]`);
  for (const cluster of evidence.clusters) {
    const nodeId = cluster.id.replace(/[^a-zA-Z0-9]/g, "_");
    lines.push(`  ${nodeId} --> Gate`);
  }
  lines.push("```", "");

  if (evidence.screenshots.length > 0) {
    lines.push("## Visual UI Proof", "", "````carousel");
    evidence.screenshots.forEach((imgPath, idx) => {
      if (idx > 0) lines.push("<!-- slide -->");
      const absImg = (path.isAbsolute(imgPath) ? imgPath : path.resolve(workspaceDir, imgPath)).replace(/\\/g, "/");
      const caption = path.basename(imgPath);
      lines.push(`![${caption}](${absImg})`);
    });
    lines.push("````", "");
  }

  lines.push("## Guided Reading Order", "");
  if (evidence.clusters.length === 0) {
    lines.push("No changed files against base.", "");
  } else {
    for (const cluster of evidence.clusters) {
      lines.push(`### ${cluster.title} (+${cluster.additions} / -${cluster.deletions})`, "");
      for (const relFile of cluster.files) {
        const lineNo = cluster.firstLines?.[relFile] ?? 1;
        const absFile = path.resolve(workspaceDir, relFile);
        lines.push(`- [${relFile}](${toFileUrl(absFile, lineNo)})`);
      }
      lines.push("");
    }
  }

  lines.push("## Verification Receipts", "");
  const antigravityChecks = evidence.recentChecks ?? evidence.passedChecks ?? [];
  if (antigravityChecks.length === 0) {
    lines.push("No passing command or verifier receipts recorded for this session.", "");
  } else {
    lines.push("| Time | Category | Status | Model | Summary | HEAD |", "|---|---|---|---|---|---|");
    for (const chk of antigravityChecks.slice(-10)) {
      const status = chk.status ?? (chk.ok === false ? "FAIL" : "PASS");
      const model = chk.modelName ? `\`${escapeMarkdownCell(chk.modelName)}\`` : "session";
      lines.push(
        `| ${chk.ts} | \`${chk.category}\` | \`${status}\` | ${model} | ${escapeMarkdownCell(chk.summary)} | \`${(chk.headSha ?? "none").slice(0, 7)}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("## Independent PR Verifier Report", "");
  if (!findingsDoc) {
    lines.push("No `findings.json` attached yet. Run `pr-verifier` via `/pre-pr`.", "");
  } else {
    if (evidence.verifier?.stale) {
      lines.push(
        `> **Warning.** Attached \`findings.json\` is stale: it verified an older commit (\`${findingsDoc.headSha}\`) instead of HEAD (\`${evidence.headSha}\`). Re-run \`pr-verifier\`.`,
        "",
      );
    }
    lines.push(`**Verdict.** \`${findingsDoc.verdict}\` (${findingsDoc.summary})`, "");
    const important = findingsDoc.findings.filter((f) => f.severity === "important");
    const nits = findingsDoc.findings.filter((f) => f.severity === "nit");
    const preExisting = findingsDoc.findings.filter((f) => f.severity === "pre_existing");

    const renderGroup = (heading, items) => {
      lines.push(`### ${heading} (${items.length})`, "");
      if (items.length === 0) {
        lines.push("None.", "");
        return;
      }
      for (const item of items) {
        const abs = path.resolve(workspaceDir, item.file);
        lines.push(
          `- **${item.id} [${item.category}]** [${item.file}#L${item.line}](${toFileUrl(abs, item.line)}): ${item.claim}`,
          `  Evidence: ${item.evidence}`,
          `  Suggested fix: ${item.suggestedFix}`,
        );
      }
      lines.push("");
    };

    renderGroup("Important", important);
    renderGroup("Nit", nits);
    renderGroup("Pre-existing", preExisting);

    if (findingsDoc.dropped.length > 0) {
      lines.push(`<details>`, `<summary>Dropped unverified claims (${findingsDoc.dropped.length})</summary>`, "");
      for (const d of findingsDoc.dropped) {
        lines.push(`- ${d.claim} (reason: ${d.reason})`);
      }
      lines.push("", `</details>`, "");
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Compiles `evidence.json` and the visual Markdown PR review dossier for a branch diff.
 */
export function compilePrDossier({
  cwd = process.cwd(),
  baseRef,
  headRef = "HEAD",
  artifactDir = null,
  findingsPath = null,
  screenshots = [],
  outPath = null,
  format = "antigravity",
  proofManifestPath = null,
  statechartPath = null,
  featureMapDir = null,
  repoUrl = null,
  mergeBodyPath = null,
  writeEvidence = true,
} = {}) {
  if (format !== "antigravity" && format !== "github") {
    throw new Error(`Invalid format "${format}": expected "antigravity" or "github"`);
  }
  const workspaceDir = path.resolve(cwd);
  const resolvedBase = resolveBaseRef(workspaceDir, baseRef);
  const headSha = tryGitText(workspaceDir, ["rev-parse", headRef]).trim() || readHeadShaFast(workspaceDir);
  const baseSha = resolvedBase ? tryGitText(workspaceDir, ["rev-parse", resolvedBase]).trim() || null : null;

  const comparingHead = headRef === "HEAD";
  let diffSpec = headRef;
  if (comparingHead) {
    if (resolvedBase) {
      const mergeBase = tryGitText(workspaceDir, ["merge-base", resolvedBase, "HEAD"]).trim();
      diffSpec = mergeBase || resolvedBase;
    } else {
      diffSpec = "HEAD";
    }
  } else if (resolvedBase) {
    diffSpec = `${resolvedBase}...${headRef}`;
  }
  const numstatText = tryGitText(workspaceDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-renames",
    "--numstat",
    diffSpec,
  ]);
  const diffText = tryGitText(workspaceDir, [
    "-c",
    "core.quotepath=false",
    "diff",
    "--no-renames",
    diffSpec,
  ]);

  const statusText = comparingHead
    ? tryGitText(workspaceDir, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"])
    : "";
  const patchId = computePatchId(diffText, workspaceDir);

  const { policy } = loadRiskPolicy(workspaceDir, { baseRef: resolvedBase });
  const baseCtx = readBaseReviewContext(workspaceDir, resolvedBase, headRef);
  const trustDir = resolveTrustDir({ workspaceDir, artifactDir });
  const fallbackTrustDir = artifactDir ? resolveTrustDir({ workspaceDir, artifactDir: null }) : null;
  const trustRelPrefix = trustDir
    ? path.relative(workspaceDir, trustDir).split(path.sep).join("/")
    : null;
  const isUnderTrustDir = (rel) =>
    Boolean(
      trustRelPrefix &&
        !trustRelPrefix.startsWith("..") &&
        (rel === trustRelPrefix || rel.startsWith(`${trustRelPrefix}/`)),
    );

  const fileEntries = parseNumstatAndFirstLines(numstatText, diffText).filter(
    (e) => !isUnderTrustDir(e.file),
  );
  const seenFiles = new Set(fileEntries.map((e) => e.file));
  const dirtyNonTrustFiles = [];
  for (const rel of parsePorcelainPaths(statusText)) {
    if (!rel || isUnderTrustDir(rel)) continue;
    dirtyNonTrustFiles.push(rel);
    if (!seenFiles.has(rel)) {
      seenFiles.add(rel);
      fileEntries.push({ file: rel, additions: 0, deletions: 0, firstLine: 1 });
    }
  }
  let receipts = readMergedReceipts(trustDir);
  if (receipts.length === 0 && fallbackTrustDir && fallbackTrustDir !== trustDir) {
    receipts = readMergedReceipts(fallbackTrustDir);
  }
  let priorEvidence = readEvidenceSnapshot(trustDir);
  if (!priorEvidence && fallbackTrustDir && fallbackTrustDir !== trustDir) {
    priorEvidence = readEvidenceSnapshot(fallbackTrustDir);
  }
  const freshness = computeFreshness({
    receipts,
    headSha,
    patchId,
    priorEvidence,
    treeDirty: dirtyNonTrustFiles.some((rel) => !/\.md$/i.test(rel)),
  });

  const maxAllowedRatio = policy.maxAssertionWeakeningRatio ?? 0.25;
  const assertionDelta = {
    ...computeAssertionDelta(diffText, maxAllowedRatio),
    maxAllowedRatio,
  };
  const risk = classifyRiskTier(fileEntries.map((f) => f.file), policy);
  const { boundaries } = loadBoundaries(workspaceDir);
  const clusters = clusterChangedFiles(fileEntries);

  let findingsDoc = null;
  let resolvedFindingsPath = findingsPath ? path.resolve(workspaceDir, findingsPath) : null;
  if (!resolvedFindingsPath && trustDir) {
    const candidate = path.join(trustDir, "findings.json");
    if (fs.existsSync(candidate)) resolvedFindingsPath = candidate;
  }
  if (!resolvedFindingsPath && fallbackTrustDir && fallbackTrustDir !== trustDir) {
    const candidate = path.join(fallbackTrustDir, "findings.json");
    if (fs.existsSync(candidate)) resolvedFindingsPath = candidate;
  }
  if (resolvedFindingsPath && fs.existsSync(resolvedFindingsPath)) {
    const rawFindings = JSON.parse(fs.readFileSync(resolvedFindingsPath, "utf8"));
    const errors = validateFindingsDocument(rawFindings);
    if (errors.length > 0) {
      throw new Error(`Invalid findings.json (${resolvedFindingsPath}): ${errors.join("; ")}`);
    }
    findingsDoc = rawFindings;
  }

  let proofManifest = null;
  let resolvedManifestPath = proofManifestPath ? path.resolve(workspaceDir, proofManifestPath) : null;
  if (resolvedManifestPath && !fs.existsSync(resolvedManifestPath)) {
    throw new Error(`Proof manifest not found (${resolvedManifestPath})`);
  }
  if (!resolvedManifestPath && trustDir) {
    const candidate = path.join(trustDir, "proof-manifest.json");
    if (fs.existsSync(candidate)) resolvedManifestPath = candidate;
  }
  if (!resolvedManifestPath && fallbackTrustDir && fallbackTrustDir !== trustDir) {
    const candidate = path.join(fallbackTrustDir, "proof-manifest.json");
    if (fs.existsSync(candidate)) resolvedManifestPath = candidate;
  }
  if (resolvedManifestPath && fs.existsSync(resolvedManifestPath)) {
    const rawManifest = JSON.parse(fs.readFileSync(resolvedManifestPath, "utf8"));
    const manifestErrors = validateProofManifest(rawManifest);
    if (manifestErrors.length > 0) {
      throw new Error(`Invalid proof-manifest.json (${resolvedManifestPath}): ${manifestErrors.join("; ")}`);
    }
    proofManifest = rawManifest;
  }

  const maxReviewRounds = policy.maxReviewRounds ?? 3;
  const reviewRound = findingsDoc?.round ?? priorEvidence?.reviewRound ?? 0;
  const findingsHead = findingsDoc?.headSha?.trim() || null;
  const effectiveVerifierHead = findingsDoc
    ? findingsHead
    : (priorEvidence?.verifier?.headSha?.trim() ?? null);
  const rawVerifierVerdict = findingsDoc?.verdict ?? priorEvidence?.verifier?.verdict ?? null;
  const hasVerifierData = Boolean(findingsDoc || rawVerifierVerdict || effectiveVerifierHead);
  const priorRebaseValid = Boolean(
    priorEvidence?.freshness === "fresh_rebase_patch_id" &&
      priorEvidence?.verifier?.headSha === effectiveVerifierHead &&
      !priorEvidence?.verifier?.stale,
  );
  const verifierMatchesHead = Boolean(
    hasVerifierData &&
      effectiveVerifierHead &&
      (!headSha ||
        effectiveVerifierHead === headSha ||
        (freshness === "fresh_rebase_patch_id" &&
          (priorEvidence?.headSha === effectiveVerifierHead || priorRebaseValid))),
  );
  const findingsStale = Boolean(hasVerifierData && !verifierMatchesHead);
  const reviewViolations = findingsDoc?.reviewMdCompliance?.violations ?? [];
  const reviewViolationCount = findingsDoc
    ? reviewViolations.length
    : (priorEvidence?.verifier?.reviewViolationCount ?? 0);
  const carryEscalation =
    rawVerifierVerdict === "ESCALATE_HUMAN" ||
    (reviewRound >= maxReviewRounds && rawVerifierVerdict === "FAIL");
  const verifierVerdict = findingsStale && !carryEscalation ? null : rawVerifierVerdict;
  const roundState = evaluateRoundState({
    reviewRound,
    verdict: verifierVerdict,
    maxReviewRounds,
    fresh: freshness === "fresh" || freshness === "fresh_rebase_patch_id",
  });

  const importantCount = findingsDoc
    ? findingsDoc.findings.filter((f) => f.severity === "important").length
    : (priorEvidence?.verifier?.importantCount ?? 0);

  const autoMergeEligible = Boolean(
    policy.allowTier0AutoMerge === true &&
      policy.humanGates?.prReview === "tier0-auto" &&
      risk.tier === 0 &&
      (freshness === "fresh" || freshness === "fresh_rebase_patch_id") &&
      !assertionDelta.flagged &&
      !baseCtx.reviewMd.modifiedInPr &&
      !baseCtx.riskPolicy.modifiedInPr &&
      findingsDoc &&
      verifierMatchesHead &&
      reviewViolationCount === 0 &&
      (findingsDoc.verdict === "PASS" || findingsDoc.verdict === "PASS_WITH_NOTES") &&
      importantCount === 0,
  );

  const checkReceipts = receipts.filter(
    (r) => r.kind === "verifier" || ["test", "verify", "lint", "build"].includes(r.category),
  );
  const recentCandidates = checkReceipts.filter((r) => {
    if (!headSha || !r.headSha) return true;
    if (r.headSha === headSha) return true;
    return freshness === "fresh_rebase_patch_id" && priorEvidence?.headSha && r.headSha === priorEvidence.headSha;
  });
  const recentChecks = recentCandidates.map((r) => ({
    ts: r.ts,
    category: r.category,
    ok: Boolean(r.ok),
    status: r.ok ? "PASS" : "FAIL",
    modelName: r.modelName ?? null,
    summary: r.summary,
    headSha: r.headSha,
  }));
  const passedChecks = checkReceipts
    .filter((r) => r.ok)
    .map((r) => ({
      ts: r.ts,
      category: r.category,
      modelName: r.modelName ?? null,
      summary: r.summary,
      headSha: r.headSha,
    }));

  const riskLabel = policy.tiers?.[String(risk.tier)]?.label ?? "medium";
  let intentCard = null;
  if (trustDir && fs.existsSync(trustDir)) {
    const intentFiles = fs
      .readdirSync(trustDir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^intent\..+\.json$/i.test(d.name))
      .map((d) => {
        const full = path.join(trustDir, d.name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { name: d.name, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    if (intentFiles.length > 0) {
      const latest = intentFiles[intentFiles.length - 1].name;
      const convId = latest.slice("intent.".length, -".json".length);
      intentCard = readIntentCard(trustDir, convId);
    }
  }
  const rawAssessment = assessChange({
    diffText,
    numstat: numstatText,
    statusText,
    policy,
    receipts,
    boundaries,
    intent: intentCard,
    action: "open_pr",
    headSha,
  });
  const riskAssessment = resolveResidual(rawAssessment, receipts, {
    headSha,
    priorEvidence: {
      ...(priorEvidence ?? {}),
      verifier: {
        verdict: rawVerifierVerdict,
        headSha: effectiveVerifierHead,
        stale: findingsStale,
        importantCount,
        reviewViolationCount,
      },
    },
    proofManifest,
    intent: intentCard,
  });
  const intentScope = intentCard
    ? evaluateIntentScope(intentCard, fileEntries.map((f) => f.file))
    : null;
  const intentSummary = intentCard
    ? {
        goal: intentCard.goal,
        affectedGlobs: intentCard.affectedGlobs,
        rollbackPlan: intentCard.rollbackPlan,
        predictedRisk: intentCard.predictedRisk ?? null,
        inScope: Boolean(intentScope?.inScope),
        driftedFiles: intentScope?.driftedFiles ?? [],
      }
    : null;
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseRef: resolvedBase,
    baseSha,
    headSha,
    patchId,
    freshness,
    riskTier: risk.tier,
    riskLabel,
    matchedRiskRules: risk.matchedRules,
    riskAssessment,
    intent: intentSummary,
    autoMergeEligible,
    reviewRound,
    maxReviewRounds,
    roundState,
    passedChecks,
    recentChecks,
    assertionDelta,
    baseReviewPolicy: {
      present: baseCtx.reviewMd.present,
      baseBlobSha: baseCtx.reviewMd.blobSha,
      modifiedInPr: baseCtx.reviewMd.modifiedInPr,
      riskPolicyModifiedInPr: baseCtx.riskPolicy.modifiedInPr,
    },
    verifier: {
      verdict: rawVerifierVerdict,
      headSha: effectiveVerifierHead,
      stale: findingsStale,
      findingsPath: resolvedFindingsPath,
      importantCount,
      reviewViolationCount,
    },
    clusters,
    screenshots: screenshots.filter(Boolean),
  };

  let statechart = null;
  let markdown;
  if (format === "github") {
    statechart = resolvePrStatechart({
      workspaceDir,
      evidence,
      proofManifest,
      statechartPath,
      featureMapDir,
    });
    evidence.statechartSource = statechart.source;
    const resolvedMergeBody = mergeBodyPath ? path.resolve(workspaceDir, mergeBodyPath) : null;
    const existingBody =
      resolvedMergeBody && fs.existsSync(resolvedMergeBody)
        ? fs.readFileSync(resolvedMergeBody, "utf8")
        : null;
    markdown = renderGitHubPrProof({
      workspaceDir,
      evidence,
      findingsDoc,
      proofManifest,
      statechart,
      repoUrl,
      existingBody,
    });
  } else {
    markdown = renderDossierMarkdown({ workspaceDir, evidence, findingsDoc });
  }

  const evidencePath = writeEvidence && trustDir ? writeEvidenceSnapshotAtomic(trustDir, evidence) : null;
  if (writeEvidence && format === "github" && trustDir) {
    fs.mkdirSync(trustDir, { recursive: true });
    fs.writeFileSync(path.join(trustDir, "pr-body.md"), markdown, "utf8");
  }
  let writtenOutPath = null;
  if (outPath) {
    writtenOutPath = path.resolve(workspaceDir, outPath);
    fs.mkdirSync(path.dirname(writtenOutPath), { recursive: true });
    fs.writeFileSync(writtenOutPath, markdown, "utf8");
  }

  return {
    evidence,
    findingsDoc,
    markdown,
    evidencePath,
    outPath: writtenOutPath,
    statechart,
  };
}

const DEFECT_SIGNAL_IDS = new Set([
  "test_regression",
  "deletes_assertions",
  "bundled_sidecar_permissions",
  "scope_drift",
  "cross_zone_import",
]);
const GATE_SIGNAL_IDS = new Set(["touches_governance"]);

function pluralFilesLabel(count) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function freshnessToneFor(freshness) {
  if (freshness === "fresh" || freshness === "fresh_rebase_patch_id") return "ok";
  if (freshness === "missing_receipts") return "warn";
  return "err";
}

function buildFileMetaLookup(evidence, findingsDoc) {
  const tierByFile = new Map();
  for (const rule of evidence?.matchedRiskRules ?? []) {
    const t = Number(rule?.tier ?? 0);
    for (const rel of rule?.files ?? []) {
      const prev = tierByFile.get(rel) ?? -1;
      if (t > prev) tierByFile.set(rel, t);
    }
  }

  const linkByFile = new Map();
  for (const cl of evidence?.clusters ?? []) {
    for (const link of cl?.fileLinks ?? []) {
      if (link?.path) linkByFile.set(link.path, link);
    }
  }

  const signalsByFile = new Map();
  const addFileSignal = (rel, sigId) => {
    if (!rel || !sigId) return;
    const list = signalsByFile.get(rel) ?? [];
    if (!list.includes(sigId)) list.push(sigId);
    signalsByFile.set(rel, list);
  };

  for (const rel of evidence?.assertionDelta?.flaggedFiles ?? []) {
    addFileSignal(rel, "deletes_assertions");
  }
  for (const rel of evidence?.intent?.driftedFiles ?? []) {
    addFileSignal(rel, "scope_drift");
  }
  for (const f of findingsDoc?.findings ?? []) {
    if (f?.severity === "important" && f?.file) {
      addFileSignal(f.file, "verifier_important");
    }
  }

  const allPaths = new Set([
    ...tierByFile.keys(),
    ...linkByFile.keys(),
    ...(evidence?.clusters ?? []).flatMap((c) => c?.files ?? []),
  ]);
  for (const sig of evidence?.riskAssessment?.signals ?? []) {
    const evText = String(sig?.evidence ?? "");
    for (const rel of allPaths) {
      if (evText.includes(rel)) {
        addFileSignal(rel, sig.id);
      }
    }
  }

  return { tierByFile, linkByFile, signalsByFile, allPaths };
}

function resolveDecisionMode({
  hasDefect,
  verifierStale,
  isFresh,
  readyToShip,
}) {
  if (hasDefect) {
    return { mode: "defect_blocked", tone: "err", badge: "DEFECT BLOCKED" };
  }
  if (verifierStale || !isFresh) {
    return { mode: "stale_evidence", tone: "warn", badge: "STALE PROOF" };
  }
  if (readyToShip) {
    return { mode: "ready_to_ship", tone: "ok", badge: "READY TO SHIP" };
  }
  return { mode: "policy_gate", tone: "warn", badge: "POLICY GATE" };
}

function buildGuardrailRows({
  evidence,
  findingsDoc,
  isFresh,
  verifierStale,
  importantCount,
  reviewViolationCount,
  signals,
  assertionSummary,
}) {
  const basePolicy = evidence?.baseReviewPolicy ?? {};
  const reviewModified = Boolean(basePolicy.modifiedInPr);
  const policyModified = Boolean(basePolicy.riskPolicyModifiedInPr);
  const boundarySig = signals.find((s) => s.id === "cross_zone_import");
  const sidecarSig = signals.find((s) => s.id === "bundled_sidecar_permissions");
  const intent = evidence?.intent ?? null;

  const reviewMdRow = reviewModified
    ? { id: "review_md", label: "Base REVIEW.md", tone: "err", status: "FAIL", detail: "REVIEW.md modified in PR" }
    : reviewViolationCount > 0
      ? {
          id: "review_md",
          label: "Base REVIEW.md",
          tone: "err",
          status: "FAIL",
          detail: `${reviewViolationCount} invariant violation(s)`,
        }
      : {
          id: "review_md",
          label: "Base REVIEW.md",
          tone: "ok",
          status: "OK",
          detail: findingsDoc?.reviewMdCompliance?.checked
            ? "Unchanged and checked (0 violations)"
            : basePolicy.present
              ? "Unchanged on base"
              : "Not configured on base",
        };

  const riskPolicyRow = policyModified
    ? {
        id: "risk_policy",
        label: "Risk policy",
        tone: "err",
        status: "FAIL",
        detail: ".agents/risk-policy.json modified in PR",
      }
    : {
        id: "risk_policy",
        label: "Risk policy",
        tone: "ok",
        status: "OK",
        detail: ".agents/risk-policy.json unchanged",
      };

  const capPct = Math.round((assertionSummary.maxAllowedRatio ?? 0.25) * 100);
  const ratioPct = Math.round((assertionSummary.weakeningRatio ?? 0) * 100);
  const testIntegrityRow = assertionSummary.flagged
    ? {
        id: "test_integrity",
        label: "Test integrity",
        tone: "err",
        status: "FAIL",
        detail: `+${assertionSummary.added}/-${assertionSummary.removed} (ratio ${ratioPct}% > ${capPct}% cap)`,
      }
    : {
        id: "test_integrity",
        label: "Test integrity",
        tone: "ok",
        status: "OK",
        detail: `+${assertionSummary.added}/-${assertionSummary.removed} (net ${assertionSummary.net >= 0 ? "+" : ""}${assertionSummary.net})`,
      };

  const intentScopeRow = !intent
    ? {
        id: "intent_scope",
        label: "Intent scope",
        tone: "neutral",
        status: "INFO",
        detail: "No Intent Card declared",
      }
    : intent.inScope
      ? {
          id: "intent_scope",
          label: "Intent scope",
          tone: "ok",
          status: "OK",
          detail: "All changed files inside declared globs",
        }
      : {
          id: "intent_scope",
          label: "Intent scope",
          tone: "err",
          status: "FAIL",
          detail: `${pluralFilesLabel(intent.driftedFiles?.length ?? 0)} outside declared globs`,
        };

  const boundariesRow =
    boundarySig || sidecarSig
      ? {
          id: "trust_boundaries",
          label: "Trust boundaries",
          tone: "err",
          status: "FAIL",
          detail: boundarySig?.evidence || sidecarSig?.evidence || "Boundary violation detected",
        }
      : {
          id: "trust_boundaries",
          label: "Trust boundaries",
          tone: "ok",
          status: "OK",
          detail: "0 cross-zone imports, 0 sidecar permission keys",
        };

  const freshnessRow = verifierStale
    ? {
        id: "freshness",
        label: "Proof freshness",
        tone: "warn",
        status: "WARN",
        detail: "pr-verifier report is behind current HEAD",
      }
    : isFresh
      ? {
          id: "freshness",
          label: "Proof freshness",
          tone: "ok",
          status: "OK",
          detail: importantCount > 0 ? "Receipts match HEAD (findings open)" : "Receipts match HEAD",
        }
      : {
          id: "freshness",
          label: "Proof freshness",
          tone: "warn",
          status: "WARN",
          detail: `Freshness ${evidence?.freshness ?? "stale"}`,
        };

  return [
    reviewMdRow,
    riskPolicyRow,
    testIntegrityRow,
    intentScopeRow,
    boundariesRow,
    freshnessRow,
  ];
}

/**
 * Builds the Option A view model consumed by both the MCP inline PR Dossier card and the Timeline sidecar view.
 */
export function buildDossierViewModel({
  evidence,
  findingsDoc = null,
  prReviewUri = null,
} = {}) {
  if (!evidence) return null;

  const freshness = evidence.freshness ?? "missing_receipts";
  const isFresh = freshness === "fresh" || freshness === "fresh_rebase_patch_id";
  const shortHead = evidence.headSha ? String(evidence.headSha).slice(0, 7) : "none";
  const riskTier = Number(evidence.riskTier ?? 1);
  const riskLabel = evidence.riskLabel ?? "medium";
  const ra = evidence.riskAssessment ?? null;
  const rawSignals = Array.isArray(ra?.signals) ? ra.signals : [];
  const verifierStale = Boolean(evidence.verifier?.stale);
  const allFindings = Array.isArray(findingsDoc?.findings) ? findingsDoc.findings : [];
  const importantCount = findingsDoc
    ? allFindings.filter((f) => f.severity === "important").length
    : Number(evidence.verifier?.importantCount ?? 0);
  const nitCount = findingsDoc ? allFindings.filter((f) => f.severity === "nit").length : 0;
  const preExistingCount = findingsDoc
    ? allFindings.filter((f) => f.severity === "pre_existing").length
    : 0;
  const reviewViolations = findingsDoc?.reviewMdCompliance?.violations ?? [];
  const reviewViolationCount = findingsDoc
    ? reviewViolations.length
    : Number(evidence.verifier?.reviewViolationCount ?? 0);
  const delta = evidence.assertionDelta ?? {};
  const added = Number(delta.added ?? 0);
  const removed = Number(delta.removed ?? 0);
  const basePolicy = evidence.baseReviewPolicy ?? {};

  const hasDefect = Boolean(
    importantCount > 0 ||
      findingsDoc?.verdict === "FAIL" ||
      reviewViolationCount > 0 ||
      basePolicy.modifiedInPr ||
      basePolicy.riskPolicyModifiedInPr ||
      delta.flagged ||
      rawSignals.some((s) => DEFECT_SIGNAL_IDS.has(s.id)),
  );
  const readyToShip = Boolean(
    !hasDefect &&
      !verifierStale &&
      isFresh &&
      (evidence.autoMergeEligible === true ||
        (riskTier === 0 &&
          findingsDoc &&
          (findingsDoc.verdict === "PASS" || findingsDoc.verdict === "PASS_WITH_NOTES") &&
          (!ra || ra.residual === "low"))),
  );

  const decBase = resolveDecisionMode({
    hasDefect,
    verifierStale,
    isFresh,
    readyToShip,
  });

  const { tierByFile, linkByFile, signalsByFile } = buildFileMetaLookup(evidence, findingsDoc);

  const signals = rawSignals.map((sig) => {
    const tone = DEFECT_SIGNAL_IDS.has(sig.id)
      ? "err"
      : GATE_SIGNAL_IDS.has(sig.id)
        ? "warn"
        : "neutral";
    const badge = tone === "err" ? "FAIL" : tone === "warn" ? "GATE" : "INFO";
    const evText = String(sig.evidence ?? "");
    let matchedLink = null;
    for (const [rel, link] of linkByFile.entries()) {
      if (evText.includes(rel)) {
        matchedLink = link;
        break;
      }
    }
    return {
      id: sig.id,
      tone,
      badge,
      weight: Number(sig.weight ?? 0),
      evidence: evText,
      file: matchedLink?.path ?? null,
      line: matchedLink?.line ?? null,
      uri: matchedLink?.uri ?? null,
    };
  });

  const assertionSummary = {
    added,
    removed,
    net: added - removed,
    weakeningRatio: Number(delta.weakeningRatio ?? 0),
    maxAllowedRatio: Number(delta.maxAllowedRatio ?? 0.25),
    flagged: Boolean(delta.flagged),
    flaggedFiles: (delta.flaggedFiles ?? []).map((rel) => {
      const link = linkByFile.get(rel);
      return {
        path: rel,
        line: link?.line ?? 1,
        uri: link?.uri ?? null,
      };
    }),
  };

  const guardrails = buildGuardrailRows({
    evidence,
    findingsDoc,
    isFresh,
    verifierStale,
    importantCount,
    reviewViolationCount,
    signals,
    assertionSummary,
  });

  const clusters = Array.isArray(evidence.clusters) ? evidence.clusters : [];
  let totalFiles = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;
  const reviewFirst = [];
  const remainingClusters = [];

  for (const cl of clusters) {
    const files = Array.isArray(cl.files) ? cl.files : [];
    totalFiles += files.length;
    totalAdditions += Number(cl.additions ?? 0);
    totalDeletions += Number(cl.deletions ?? 0);

    const restFiles = [];
    for (const rel of files) {
      const link = linkByFile.get(rel);
      const stat = cl.fileStats?.[rel] ?? {};
      const item = {
        path: rel,
        line: link?.line ?? cl.firstLines?.[rel] ?? stat.firstLine ?? 1,
        uri: link?.uri ?? null,
        additions: Number(link?.additions ?? stat.additions ?? 0),
        deletions: Number(link?.deletions ?? stat.deletions ?? 0),
        tier: tierByFile.has(rel) ? tierByFile.get(rel) : Math.min(riskTier, 1),
        signals: signalsByFile.get(rel) ?? [],
      };
      if (item.tier >= 2 || item.signals.length > 0) {
        reviewFirst.push(item);
      } else {
        restFiles.push(item);
      }
    }
    if (restFiles.length > 0) {
      remainingClusters.push({
        id: cl.id,
        title: cl.title || cl.id,
        additions: restFiles.reduce((s, f) => s + f.additions, 0),
        deletions: restFiles.reduce((s, f) => s + f.deletions, 0),
        files: restFiles,
      });
    }
  }

  reviewFirst.sort(
    (a, b) =>
      b.tier - a.tier ||
      b.signals.length - a.signals.length ||
      a.path.localeCompare(b.path),
  );

  const govSignal = signals.find((s) => s.id === "touches_governance");
  const defectSignal = signals.find((s) => s.tone === "err");
  let headline;
  let why;
  let next;
  let primaryAction;

  if (decBase.mode === "defect_blocked") {
    headline =
      importantCount > 0
        ? `Action needed: ${importantCount} important finding${importantCount === 1 ? "" : "s"}`
        : "Action needed: red-flag guardrail tripped";
    why =
      findingsDoc?.summary && importantCount > 0
        ? findingsDoc.summary
        : defectSignal?.evidence ||
          (basePolicy.modifiedInPr
            ? "Base REVIEW.md was modified inside this PR."
            : basePolicy.riskPolicyModifiedInPr
              ? ".agents/risk-policy.json was modified inside this PR."
              : "A blocking risk signal fired on this diff.");
    next =
      importantCount > 0
        ? "Fix the verified important findings and re-run /pre-pr on HEAD."
        : "Resolve the failing guardrail above and re-run verification on HEAD.";
    primaryAction =
      importantCount > 0
        ? { id: "fix_important", label: `Fix ${importantCount} important` }
        : prReviewUri
          ? { id: "open_pr_review", label: "Open pr-review.md" }
          : { id: "rerun_pre_pr", label: "Re-run /pre-pr" };
  } else if (decBase.mode === "stale_evidence") {
    headline = verifierStale
      ? "Proof behind HEAD: re-run pr-verifier"
      : "Verification needed on current HEAD";
    why = verifierStale
      ? `Attached findings.json verified ${String(evidence.verifier?.headSha ?? "an older commit").slice(0, 7)}, not HEAD ${shortHead}.`
      : `Freshness is ${freshness}; no passing HEAD verification receipt is recorded yet.`;
    next = "Run /pre-pr to refresh receipts and pr-verifier on HEAD.";
    primaryAction = { id: "rerun_pre_pr", label: "Re-run /pre-pr" };
  } else if (decBase.mode === "ready_to_ship") {
    headline = evidence.autoMergeEligible
      ? "Ready to ship: Tier 0 auto-eligible (0 findings)"
      : "Ready to ship: verified clean (0 findings)";
    why =
      findingsDoc?.summary ||
      `All ${pluralFilesLabel(totalFiles)} verified clean on HEAD ${shortHead}.`;
    next = "Open pr-review.md or proceed to merge.";
    primaryAction = prReviewUri
      ? { id: "open_pr_review", label: "Open pr-review.md" }
      : { id: "attach_context", label: "Attach summary to chat" };
  } else {
    const defectNote = findingsDoc
      ? "0 defects found"
      : "verifier pending";
    headline = `Human review required: Policy Gate (${defectNote})`;
    why = govSignal
      ? govSignal.evidence
      : findingsDoc?.verdict === "ESCALATE_HUMAN"
        ? findingsDoc.summary
        : `Tier ${riskTier} (${riskLabel}) changes require human review before merge.`;
    next =
      reviewFirst.length > 0
        ? `Inspect the ${pluralFilesLabel(reviewFirst.length)} pinned under Review First, then approve or merge.`
        : "Inspect the changed clusters below, then approve or merge.";
    primaryAction = prReviewUri
      ? { id: "open_pr_review", label: "Open pr-review.md" }
      : { id: "attach_context", label: "Attach summary to chat" };
  }

  const inherentScore = Number(ra?.inherentScore ?? ra?.score ?? 0);
  const residualScore = Number(ra?.score ?? 0);
  const residualLabel = ra?.residual ?? (decBase.mode === "ready_to_ship" ? "low" : "medium");
  const fallbackRollback =
    shortHead !== "none" ? `git revert ${shortHead}` : "git revert HEAD";
  const rollbackPlan =
    evidence.intent?.rollbackPlan || ra?.rollback?.plan || fallbackRollback;

  const verdict = findingsDoc?.verdict ?? null;
  const verdictTone =
    verdict === "FAIL"
      ? "err"
      : verdict === "PASS" || verdict === "PASS_WITH_NOTES"
        ? "ok"
        : verdict === "ESCALATE_HUMAN"
          ? "warn"
          : "neutral";

  return {
    header: {
      riskTier,
      riskLabel,
      freshness,
      freshnessTone: freshnessToneFor(freshness),
      shortHead,
      reviewRound: Number(evidence.reviewRound ?? 0),
      maxReviewRounds: Number(evidence.maxReviewRounds ?? 3),
      roundState: evidence.roundState ?? "pending",
    },
    decision: {
      ...decBase,
      headline,
      why,
      next,
      inherentScore,
      residualScore,
      residual: residualLabel,
      primaryAction,
    },
    intentStrip: {
      declared: Boolean(evidence.intent),
      goal: evidence.intent?.goal ?? null,
      inScope: evidence.intent ? Boolean(evidence.intent.inScope) : null,
      driftedCount: evidence.intent?.driftedFiles?.length ?? 0,
      rollbackPlan,
    },
    assertionSummary,
    signals,
    guardrails,
    reading: {
      totalFiles,
      totalAdditions,
      totalDeletions,
      reviewFirst,
      remainingClusters,
      remainingFileCount: Math.max(0, totalFiles - reviewFirst.length),
    },
    verifier: {
      attached: Boolean(findingsDoc),
      verdict,
      verdictTone,
      summary: findingsDoc?.summary ?? null,
      stale: verifierStale,
      verifiedHead: evidence.verifier?.headSha
        ? String(evidence.verifier.headSha).slice(0, 7)
        : null,
      reviewMdChecked: Boolean(findingsDoc?.reviewMdCompliance?.checked),
      reviewMdViolations: reviewViolations,
      counts: {
        all: allFindings.length,
        important: importantCount,
        nit: nitCount,
        pre_existing: preExistingCount,
      },
      findings: allFindings,
      dropped: Array.isArray(findingsDoc?.dropped) ? findingsDoc.dropped : [],
    },
    actions: {
      canOpenPrReview: Boolean(prReviewUri),
      prReviewUri: prReviewUri ?? null,
      canFixImportant: importantCount > 0,
      needsRerun: verifierStale || !isFresh,
      rollbackCommand: rollbackPlan,
    },
  };
}
