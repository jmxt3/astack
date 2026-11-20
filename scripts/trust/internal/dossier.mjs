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
  loadRiskPolicy,
  matchesAnyGlob,
  readBaseReviewContext,
  resolveBaseRef,
} from "./policy.mjs";

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
    stats.set(file, { file, additions, deletions, firstLine: 1 });
  }

  let currentFile = "";
  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      currentFile = m ? m[1].replace(/\\/g, "/") : "";
      continue;
    }
    if (currentFile && line.startsWith("@@ ")) {
      const hunk = line.match(/\+(\d+)/);
      if (hunk && stats.has(currentFile) && stats.get(currentFile).firstLine === 1) {
        stats.get(currentFile).firstLine = Math.max(1, Number.parseInt(hunk[1], 10) || 1);
      }
    }
  }
  return [...stats.values()];
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
    `| Base REVIEW.md | ${evidence.baseReviewPolicy.present ? (evidence.baseReviewPolicy.modifiedInPr ? "Present (MODIFIED IN PR)" : "Present (unchanged)") : "Not present on base"} |`,
    `| Test Assertions | +${evidence.assertionDelta.added} / -${evidence.assertionDelta.removed} (ratio ${evidence.assertionDelta.weakeningRatio}${evidence.assertionDelta.flagged ? ", FLAGGED" : ""}) |`,
    `| Auto-Merge Eligible | ${evidence.autoMergeEligible ? "Yes (Tier 0 opt-in satisfied)" : "No (Human review required)"} |`,
    "",
  ];

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
      const absImg = path.isAbsolute(imgPath) ? imgPath : path.resolve(workspaceDir, imgPath);
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
  if (evidence.passedChecks.length === 0) {
    lines.push("No passing command or verifier receipts recorded for this session.", "");
  } else {
    lines.push("| Time | Category | Summary | HEAD |", "|---|---|---|---|");
    for (const chk of evidence.passedChecks.slice(-10)) {
      lines.push(`| ${chk.ts} | \`${chk.category}\` | ${chk.summary} | \`${(chk.headSha ?? "none").slice(0, 7)}\` |`);
    }
    lines.push("");
  }

  lines.push("## Independent PR Verifier Report", "");
  if (!findingsDoc) {
    lines.push("No `findings.json` attached yet. Run `pr-verifier` via `/review-pr`.", "");
  } else {
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
} = {}) {
  const workspaceDir = path.resolve(cwd);
  const resolvedBase = resolveBaseRef(workspaceDir, baseRef);
  const headSha = tryGitText(workspaceDir, ["rev-parse", headRef]).trim() || readHeadShaFast(workspaceDir);
  const baseSha = resolvedBase ? tryGitText(workspaceDir, ["rev-parse", resolvedBase]).trim() || null : null;

  const diffRange = resolvedBase ? `${resolvedBase}...${headRef}` : headRef;
  const numstatText = resolvedBase
    ? tryGitText(workspaceDir, ["diff", "--numstat", diffRange])
    : tryGitText(workspaceDir, ["diff", "--numstat", "HEAD"]);
  const diffText = resolvedBase
    ? tryGitText(workspaceDir, ["diff", diffRange])
    : tryGitText(workspaceDir, ["diff", "HEAD"]);

  const wtNumstat = tryGitText(workspaceDir, ["diff", "--numstat"]);
  const wtDiff = tryGitText(workspaceDir, ["diff"]);
  const combinedNumstat = [numstatText, wtNumstat].filter(Boolean).join("\n");
  const combinedDiff = [diffText, wtDiff].filter(Boolean).join("\n");
  const statusText = tryGitText(workspaceDir, ["status", "--porcelain"]);
  const treeDirty = statusText.trim().length > 0;
  const patchId = computePatchId(diffText, workspaceDir);

  const { policy } = loadRiskPolicy(workspaceDir);
  const baseCtx = readBaseReviewContext(workspaceDir, resolvedBase);
  const trustDir = resolveTrustDir({ workspaceDir, artifactDir });
  const trustRelPrefix = trustDir
    ? path.relative(workspaceDir, trustDir).split(path.sep).join("/")
    : null;

  const fileEntries = parseNumstatAndFirstLines(combinedNumstat, combinedDiff);
  const seenFiles = new Set(fileEntries.map((e) => e.file));
  for (const line of statusText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rel = trimmed.replace(/^[MADRCU?!]{1,2}\s+/, "").replace(/\\/g, "/");
    if (!rel || seenFiles.has(rel)) continue;
    if (trustRelPrefix && !trustRelPrefix.startsWith("..") && (rel === trustRelPrefix || rel.startsWith(`${trustRelPrefix}/`))) {
      continue;
    }
    seenFiles.add(rel);
    fileEntries.push({ file: rel, additions: 0, deletions: 0, firstLine: 1 });
  }
  const receipts = readMergedReceipts(trustDir);
  const priorEvidence = readEvidenceSnapshot(trustDir);
  const freshness = computeFreshness({
    receipts,
    headSha,
    patchId,
    priorEvidence,
    treeDirty: treeDirty && fileEntries.some((f) => !/\.md$/i.test(f.file)),
  });

  const assertionDelta = computeAssertionDelta(
    combinedDiff,
    policy.maxAssertionWeakeningRatio ?? 0.25,
  );
  const risk = classifyRiskTier(fileEntries.map((f) => f.file), policy);
  const clusters = clusterChangedFiles(fileEntries);

  let findingsDoc = null;
  let resolvedFindingsPath = findingsPath ? path.resolve(workspaceDir, findingsPath) : null;
  if (!resolvedFindingsPath && trustDir) {
    const candidate = path.join(trustDir, "findings.json");
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

  const maxReviewRounds = policy.maxReviewRounds ?? 3;
  const reviewRound = findingsDoc?.round ?? priorEvidence?.reviewRound ?? 0;
  const verifierVerdict = findingsDoc?.verdict ?? priorEvidence?.verifier?.verdict ?? null;
  const roundState = evaluateRoundState({
    reviewRound,
    verdict: verifierVerdict,
    maxReviewRounds,
    fresh: freshness === "fresh" || freshness === "fresh_rebase_patch_id",
  });

  const importantCount = findingsDoc
    ? findingsDoc.findings.filter((f) => f.severity === "important").length
    : 0;

  const autoMergeEligible = Boolean(
    policy.allowTier0AutoMerge === true &&
      policy.humanGates?.prReview === "tier0-auto" &&
      risk.tier === 0 &&
      (freshness === "fresh" || freshness === "fresh_rebase_patch_id") &&
      !assertionDelta.flagged &&
      !baseCtx.reviewMd.modifiedInPr &&
      findingsDoc &&
      (findingsDoc.verdict === "PASS" || findingsDoc.verdict === "PASS_WITH_NOTES") &&
      importantCount === 0,
  );

  const passedChecks = receipts
    .filter((r) => r.ok && (r.kind === "verifier" || ["test", "verify", "lint", "build"].includes(r.category)))
    .map((r) => ({ ts: r.ts, category: r.category, summary: r.summary, headSha: r.headSha }));

  const riskLabel = policy.tiers?.[String(risk.tier)]?.label ?? "medium";
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
    autoMergeEligible,
    reviewRound,
    maxReviewRounds,
    roundState,
    passedChecks,
    assertionDelta,
    baseReviewPolicy: {
      present: baseCtx.reviewMd.present,
      baseBlobSha: baseCtx.reviewMd.blobSha,
      modifiedInPr: baseCtx.reviewMd.modifiedInPr,
    },
    verifier: {
      verdict: verifierVerdict,
      headSha: findingsDoc?.headSha ?? priorEvidence?.verifier?.headSha ?? null,
      findingsPath: resolvedFindingsPath,
      importantCount,
    },
    clusters,
    screenshots: screenshots.filter(Boolean),
  };

  const evidencePath = trustDir ? writeEvidenceSnapshotAtomic(trustDir, evidence) : null;
  const markdown = renderDossierMarkdown({ workspaceDir, evidence, findingsDoc });
  let writtenOutPath = null;
  if (outPath) {
    writtenOutPath = path.resolve(workspaceDir, outPath);
    fs.mkdirSync(path.dirname(writtenOutPath), { recursive: true });
    fs.writeFileSync(writtenOutPath, markdown, "utf8");
  }

  return {
    evidence,
    markdown,
    evidencePath,
    outPath: writtenOutPath,
  };
}
