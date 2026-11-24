import {
  DEFAULT_RISK_POLICY,
  computeAssertionDelta,
  evaluateBoundaryViolations,
  matchesAnyGlob,
  parsePorcelainPaths,
} from "./policy.mjs";

export const TRUST_CATEGORIES = [
  "docs",
  "tests",
  "ui",
  "skills",
  "tooling",
  "core",
  "governance",
];

export const HARD_BLOCK_SIGNALS = new Set([
  "touches_governance",
  "bundled_sidecar_permissions",
  "scope_drift",
  "test_regression",
]);

export const DEFAULT_RISK_WEIGHTS = {
  touches_governance: 0.55,
  bundled_sidecar_permissions: 0.75,
  deletes_assertions: 0.6,
  test_regression: 0.65,
  scope_drift: 0.55,
  cross_zone_import: 0.45,
  public_surface_changed: 0.3,
  untested_change: 0.28,
  dependency_changed: 0.25,
  large_diff: 0.22,
  wide_declared_scope: 0.2,
  new_path: 0.12,
};

const GOVERNANCE_GLOBS = [
  ".agents/**",
  "REVIEW.md",
  "hooks.json",
  "scripts/hooks/**",
  ".github/workflows/**",
  "sidecars/*/sidecar.json",
];

const CORE_GLOBS = [
  "scripts/trust/**",
  "scripts/mcp/server.mjs",
  "scripts/mcp/tools.mjs",
  "plugin.json",
  "mcp_config.json",
  "**/*auth*",
  "**/*billing*",
  "**/*payment*",
  "**/*migration*",
  "**/security*/**",
];

const TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "scripts/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/fixtures/**",
];

const UI_GLOBS = [
  "sidecars/**",
  "scripts/mcp/src/**",
  "scripts/mcp/ui/**",
  "**/*.css",
  "**/*.html",
];

const SKILLS_GLOBS = ["skills/**"];

const DOCS_GLOBS = [
  "**/*.md",
  "**/*.txt",
  "docs/**",
  "LICENSE",
  "GLOSSARY.md",
  ".github/ISSUE_TEMPLATE/**",
];

const TOOLING_GLOBS = [
  "scripts/**",
  "agents/**",
  "rules/**",
  "package.json",
  "package-lock.json",
];

const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|cs)$/i;
const DEPENDENCY_FILE_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements\.txt|Cargo\.(?:toml|lock)|go\.(?:mod|sum))$/i;
const SIDECAR_MANIFEST_RE = /^sidecars\/[^/]+\/sidecar\.json$/i;
const SIDECAR_PERMISSION_KEY_RE = /"(?:arguments|workspace_uris|access_grants)"\s*:/;
const PUBLIC_SURFACE_FILE_RE =
  /^(?:scripts\/trust\/index\.mjs|scripts\/mcp\/tools\.mjs|plugin\.json|mcp_config\.json)$/i;
const FRONTMATTER_SKILL_OR_AGENT_RE = /^(?:skills\/[^/]+\/SKILL\.md|agents\/[^/]+\.md)$/i;

const CATEGORY_PRECEDENCE = [
  "governance",
  "core",
  "tooling",
  "ui",
  "skills",
  "tests",
  "docs",
];

function normalizePath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function unquoteDiffPath(raw) {
  const s = String(raw ?? "").trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

/**
 * Maps a single repo-relative path to one of the 7 canonical `TrustCategory` buckets.
 */
export function classifyFileCategory(relPath) {
  const clean = normalizePath(relPath);
  if (!clean) return "docs";
  if (matchesAnyGlob(clean, GOVERNANCE_GLOBS)) return "governance";
  if (matchesAnyGlob(clean, TEST_GLOBS)) return "tests";
  if (matchesAnyGlob(clean, CORE_GLOBS)) return "core";
  if (matchesAnyGlob(clean, UI_GLOBS)) return "ui";
  if (matchesAnyGlob(clean, SKILLS_GLOBS)) return "skills";
  if (matchesAnyGlob(clean, TOOLING_GLOBS)) return "tooling";
  if (matchesAnyGlob(clean, DOCS_GLOBS)) return "docs";
  return "tooling";
}

/**
 * Returns the dominant `TrustCategory` across a list of changed file paths.
 */
export function classifyDominantCategory(files = []) {
  if (!Array.isArray(files) || files.length === 0) return "docs";
  const seen = new Set(files.map((f) => classifyFileCategory(f)));
  for (const cat of CATEGORY_PRECEDENCE) {
    if (seen.has(cat)) return cat;
  }
  return "docs";
}

function parseDiffFiles(diffText) {
  const fileMap = new Map();
  let current = null;
  let inHeader = false;
  let srcPath = "";

  const ensureFile = (p) => {
    const clean = normalizePath(p);
    if (!clean) return null;
    if (!fileMap.has(clean)) {
      fileMap.set(clean, {
        file: clean,
        isNew: false,
        isDeleted: false,
        addedLines: [],
        removedLines: [],
      });
    }
    return fileMap.get(clean);
  };

  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      srcPath = m ? unquoteDiffPath(m[1]) : "";
      const dstPath = m ? unquoteDiffPath(m[2]) : srcPath;
      current = ensureFile(dstPath);
      continue;
    }
    if (inHeader) {
      if (line.startsWith("--- a/")) {
        srcPath = unquoteDiffPath(line.slice(6));
        continue;
      }
      if (line === "--- /dev/null") {
        if (current) current.isNew = true;
        continue;
      }
      if (line === "+++ /dev/null") {
        if (current) current.isDeleted = true;
        else if (srcPath) {
          current = ensureFile(srcPath);
          if (current) current.isDeleted = true;
        }
        continue;
      }
      if (line.startsWith("+++ b/")) {
        const dst = unquoteDiffPath(line.slice(6));
        const wasNew = current?.isNew ?? false;
        current = ensureFile(dst);
        if (current && wasNew) current.isNew = true;
        continue;
      }
      if (line.startsWith("@@")) {
        inHeader = false;
        continue;
      }
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++ ")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("--- ")) {
      current.removedLines.push(line.slice(1));
    }
  }
  return fileMap;
}

function parseNumstatTotals(numstatText) {
  const files = [];
  let totalLines = 0;
  let nonLockLines = 0;
  for (const line of String(numstatText ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
    const deleted = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
    const file = normalizePath(parts.slice(2).join("\t"));
    files.push({ file, added, deleted });
    totalLines += added + deleted;
    if (!/package-lock\.json|pnpm-lock\.yaml|yarn\.lock$/i.test(file)) {
      nonLockLines += added + deleted;
    }
  }
  return { files, totalLines, nonLockLines };
}

function deriveTierFromPolicy(files, policy) {
  const tiers = (policy ?? DEFAULT_RISK_POLICY).tiers ?? DEFAULT_RISK_POLICY.tiers;
  let highest = 0;
  for (const file of files) {
    const clean = normalizePath(file);
    let assigned = null;
    for (const tierNum of [3, 2, 1, 0]) {
      const cfg = tiers[String(tierNum)];
      if (!cfg || !Array.isArray(cfg.globs) || cfg.globs.length === 0) continue;
      if (matchesAnyGlob(clean, cfg.globs)) {
        assigned = tierNum;
        break;
      }
    }
    const t = assigned ?? Number(policy?.defaultTier ?? 1);
    if (t > highest) highest = t;
  }
  return files.length === 0 ? 0 : highest;
}

/**
 * Computes the noisy-OR probability score `R = 1 - prod(1 - m_i * w_i)` clamped to `[0, 1]`.
 */
export function computeNoisyOrScore(signals = [], mitigationFactors = null) {
  let complement = 1;
  for (const sig of signals) {
    const w = Math.max(0, Math.min(1, Number(sig.weight ?? DEFAULT_RISK_WEIGHTS[sig.id] ?? 0)));
    const m = mitigationFactors && Object.hasOwn(mitigationFactors, sig.id)
      ? Math.max(0, Math.min(1, Number(mitigationFactors[sig.id])))
      : 1;
    complement *= 1 - m * w;
  }
  const score = 1 - complement;
  return Number(Math.max(0, Math.min(1, score)).toFixed(4));
}

export function bucketFromScore(score, { hardBlocked = false, isInherent = false } = {}) {
  if (hardBlocked) return isInherent ? "critical" : "blocked";
  if (isInherent && score >= 0.7) return "critical";
  if (score < 0.15) return "low";
  if (score < 0.4) return "medium";
  return "high";
}

function detectTestRegression(receipts = []) {
  const latestByCommand = new Map();
  const everPassed = new Set();
  for (const r of receipts) {
    if (r?.kind !== "command" || r.category !== "test") continue;
    const key = String(r.summary ?? "").trim();
    if (!key) continue;
    if (r.ok) everPassed.add(key);
    latestByCommand.set(key, Boolean(r.ok));
  }
  const regressed = [];
  for (const cmd of everPassed) {
    if (latestByCommand.get(cmd) === false) {
      regressed.push(cmd);
    }
  }
  return regressed;
}

function buildPlainSummary({ inherent, residual, score, category, signals, rollback }) {
  const label = residual === "blocked" ? "Blocked risk" : `${residual.charAt(0).toUpperCase()}${residual.slice(1)} risk`;
  const rText = `R ${score.toFixed(2)}`;
  if (signals.length === 0) {
    return `${label} (${rText}) across ${category} only. Undo: ${rollback.plan}.`;
  }
  const topIds = signals.slice(0, 3).map((s) => s.id).join(", ");
  return `${label} (${rText}) in ${category} (${inherent} inherent) from ${topIds}. Undo: ${rollback.plan}.`;
}

/**
 * Pure zero-I/O shadow risk classifier that scores a git diff and session receipts into a `RiskAssessment`.
 */
export function assessChange({
  diffText = "",
  numstat = "",
  statusText = "",
  policy = DEFAULT_RISK_POLICY,
  receipts = [],
  boundaries = null,
  intent = null,
  action = "open_pr",
  headSha = null,
  now = new Date().toISOString(),
} = {}) {
  const effectivePolicy = policy ?? DEFAULT_RISK_POLICY;
  const weights = {
    ...DEFAULT_RISK_WEIGHTS,
    ...(effectivePolicy?.risk?.weights ?? {}),
  };

  const diffFiles = parseDiffFiles(diffText);
  const numstatInfo = parseNumstatTotals(numstat);
  const statusFiles = parsePorcelainPaths(statusText);

  const fileSet = new Set();
  for (const f of diffFiles.keys()) fileSet.add(f);
  for (const entry of numstatInfo.files) fileSet.add(entry.file);
  for (const rel of statusFiles) fileSet.add(normalizePath(rel));
  const files = [...fileSet].sort();

  const signals = [];
  const pushSignal = (id, severity, evidence) => {
    signals.push({
      id,
      severity,
      weight: weights[id] ?? DEFAULT_RISK_WEIGHTS[id] ?? 0.2,
      evidence,
    });
  };

  const govFiles = files.filter((f) => matchesAnyGlob(f, GOVERNANCE_GLOBS));
  if (govFiles.length > 0) {
    pushSignal("touches_governance", 3, govFiles.slice(0, 4).join(", "));
  }

  const sidecarPermHits = [];
  for (const [file, info] of diffFiles.entries()) {
    if (!SIDECAR_MANIFEST_RE.test(file) || info.isDeleted) continue;
    const hitLines = info.addedLines.filter((l) => SIDECAR_PERMISSION_KEY_RE.test(l));
    if (hitLines.length > 0) {
      sidecarPermHits.push(file);
    }
  }
  if (sidecarPermHits.length > 0) {
    pushSignal(
      "bundled_sidecar_permissions",
      3,
      `permission keys added in ${sidecarPermHits.join(", ")}`,
    );
  }

  const assertionDelta = computeAssertionDelta(
    diffText,
    effectivePolicy?.maxAssertionWeakeningRatio ?? 0.25,
  );
  if (assertionDelta.flagged) {
    pushSignal(
      "deletes_assertions",
      3,
      `+${assertionDelta.added}/-${assertionDelta.removed} (ratio ${assertionDelta.weakeningRatio}) in ${assertionDelta.flaggedFiles.join(", ") || "tests"}`,
    );
  }

  const prodCodeFiles = files.filter(
    (f) => CODE_FILE_RE.test(f) && !matchesAnyGlob(f, TEST_GLOBS),
  );
  const touchedTestFiles = files.filter((f) => matchesAnyGlob(f, TEST_GLOBS));
  const hasPassingTestReceipt = receipts.some(
    (r) =>
      r?.ok &&
      (r.kind === "verifier" || (r.kind === "command" && (r.category === "test" || r.category === "verify"))) &&
      (!headSha || !r.headSha || r.headSha === headSha) &&
      (!r.ts || !receipts.some((w) => w?.kind === "file_write" && String(w.ts ?? "") > String(r.ts))),
  );
  if (prodCodeFiles.length > 0 && touchedTestFiles.length === 0 && !hasPassingTestReceipt) {
    pushSignal(
      "untested_change",
      2,
      `${prodCodeFiles.length} code file(s) changed without test updates or passing HEAD test receipt`,
    );
  }

  const publicSurfaceHits = [];
  for (const f of files) {
    if (PUBLIC_SURFACE_FILE_RE.test(f)) {
      publicSurfaceHits.push(f);
      continue;
    }
    if (FRONTMATTER_SKILL_OR_AGENT_RE.test(f)) {
      const info = diffFiles.get(f);
      const changedLines = [...(info?.addedLines ?? []), ...(info?.removedLines ?? [])];
      if (changedLines.some((l) => /^(?:name|description|disable-model-invocation|tools|model):/.test(l.trim()))) {
        publicSurfaceHits.push(f);
      }
    }
  }
  if (publicSurfaceHits.length > 0) {
    pushSignal("public_surface_changed", 2, publicSurfaceHits.slice(0, 4).join(", "));
  }

  const depFiles = files.filter((f) => DEPENDENCY_FILE_RE.test(f));
  if (depFiles.length > 0) {
    pushSignal("dependency_changed", 2, depFiles.join(", "));
  }

  const boundaryHits = [];
  for (const [file, info] of diffFiles.entries()) {
    if (!CODE_FILE_RE.test(file) || info.addedLines.length === 0) continue;
    const addedBody = info.addedLines.join("\n");
    if (boundaries) {
      const hits = evaluateBoundaryViolations({ relPath: file, content: addedBody, boundaries });
      for (const h of hits) boundaryHits.push(h.detail);
    } else if (
      !file.startsWith("scripts/trust/") &&
      !file.startsWith("scripts/test/") &&
      /(?:import|from|require\s*\()\s*["'][^"']*trust\/internal\//.test(addedBody)
    ) {
      boundaryHits.push(`${file} imports scripts/trust/internal/* directly`);
    }
  }
  if (boundaryHits.length > 0) {
    pushSignal("cross_zone_import", 2, boundaryHits[0]);
  }

  const largeDiffThreshold = Number(effectivePolicy?.risk?.largeDiffThreshold ?? 400);
  const diffChangedLines =
    numstatInfo.nonLockLines > 0
      ? numstatInfo.nonLockLines
      : [...diffFiles.values()].reduce(
          (sum, info) =>
            /package-lock\.json|pnpm-lock\.yaml|yarn\.lock$/i.test(info.file)
              ? sum
              : sum + info.addedLines.length + info.removedLines.length,
          0,
        );
  if (diffChangedLines > largeDiffThreshold) {
    pushSignal("large_diff", 2, `${diffChangedLines} changed lines exceeds threshold ${largeDiffThreshold}`);
  }

  const newFiles = [...diffFiles.values()].filter((info) => info.isNew).map((info) => info.file);
  for (const line of String(statusText ?? "").split(/\r?\n/)) {
    if (line.startsWith("?? ")) {
      const p = normalizePath(line.slice(3).trim());
      if (p && !newFiles.includes(p)) newFiles.push(p);
    }
  }
  if (newFiles.length > 0) {
    pushSignal("new_path", 1, newFiles.slice(0, 4).join(", "));
  }

  if (intent && Array.isArray(intent.affectedGlobs) && intent.affectedGlobs.length > 0) {
    const globs = intent.affectedGlobs.map((g) => normalizePath(g)).filter(Boolean);
    const hasWildcardAll = globs.some((g) => g === "**" || g === "**/*" || g === "*");
    const coveredCats = new Set(globs.map((g) => classifyFileCategory(g.replace(/\*+/g, "file"))));
    if (hasWildcardAll || globs.length > 10 || coveredCats.size >= 3) {
      pushSignal(
        "wide_declared_scope",
        1,
        `intent globs span ${hasWildcardAll ? "entire repo" : `${globs.length} globs across ${coveredCats.size} categories`}`,
      );
    }
    const drifted = files.filter((f) => !matchesAnyGlob(f, globs));
    if (drifted.length > 0) {
      pushSignal("scope_drift", 3, `outside intent scope: ${drifted.slice(0, 4).join(", ")}`);
    }
  }

  const regressedTests = detectTestRegression(receipts);
  if (regressedTests.length > 0) {
    pushSignal("test_regression", 3, `previously passing test now fails: ${regressedTests[0]}`);
  }

  const category = classifyDominantCategory(files);
  const pathTier = deriveTierFromPolicy(files, effectivePolicy);
  const hasHardSignal = signals.some((s) => HARD_BLOCK_SIGNALS.has(s.id));
  const inherentScore = computeNoisyOrScore(signals);
  const inherent = bucketFromScore(inherentScore, { hardBlocked: hasHardSignal, isInherent: true });
  const residual = bucketFromScore(inherentScore, { hardBlocked: hasHardSignal, isInherent: false });
  const tier = hasHardSignal
    ? 3
    : Math.max(pathTier, inherentScore >= 0.4 ? 2 : inherentScore >= 0.15 ? 1 : 0);

  const shortSha = headSha ? String(headSha).slice(0, 7) : "HEAD";
  const rollback =
    action === "read"
      ? { kind: "none", plan: "Read-only action; no rollback required" }
      : action === "local_write" || action === "local_exec"
        ? { kind: "checkout", plan: `git checkout -- ${files[0] ?? "."}` }
        : action === "deploy" || action === "external_message" || action === "destructive"
          ? { kind: "manual", plan: "Manual rollback required before proceeding" }
          : { kind: "revert", plan: `git revert ${shortSha}` };

  const summary = buildPlainSummary({
    inherent,
    residual,
    score: inherentScore,
    category,
    signals,
    rollback,
  });

  return {
    action,
    category,
    tier,
    signals,
    inherentScore,
    score: inherentScore,
    inherent,
    requiredMitigations: [],
    satisfied: [],
    residual,
    rollback,
    summary,
    predictedAt: now,
    headSha: headSha ?? null,
  };
}
