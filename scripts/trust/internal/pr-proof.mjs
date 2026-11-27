import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROOF_START_MARKER = "<!-- astack:pr-proof:start -->";
const PROOF_END_MARKER = "<!-- astack:pr-proof:end -->";
const VALID_CHECK_STATUSES = new Set(["PASS", "FAIL", "SKIP", "UNREACHABLE"]);
const VALID_STATECHART_SOURCES = new Set([
  "formal-tla",
  "formal-ts",
  "feature-map-flow",
  "feature-map-coverage",
  "verification-lifecycle",
]);

const PELE_GITHUB_CLASS_DEFS = {
  blue: "fill:#c3e0ff,stroke:#1b6ec2,color:#1c1c1c",
  orange: "fill:#f0d3bf,stroke:#b85a06,color:#1c1c1c",
  purple: "fill:#e3d5ff,stroke:#6f42c1,color:#1c1c1c",
  yellow: "fill:#f0dcbf,stroke:#9a6700,color:#1c1c1c",
  teal: "fill:#bfe3df,stroke:#177c72,color:#1c1c1c",
  tan: "fill:#e5d9ce,stroke:#7c6350,color:#1c1c1c",
  pink: "fill:#ffcbe6,stroke:#bf3989,color:#1c1c1c",
  bugPath: "stroke:#1680f3,stroke-width:2.5px",
  repeats: "stroke:#9b35d6,stroke-width:2.5px,stroke-dasharray:6 3",
};

const STATUS_CLASS_DEFS = [
  "  classDef pass fill:#e6f6ec,stroke:#1a7f37,color:#116329",
  "  classDef fail fill:#ffecee,stroke:#cf222e,color:#82071e",
  "  classDef skip fill:#f6f8fa,stroke:#57606a,color:#24292f",
  "  classDef unreachable fill:#fff8c5,stroke:#9a6700,color:#4d2d00",
];

const MERMAID_RESERVED = new Set([
  "end",
  "state",
  "class",
  "classdef",
  "note",
  "direction",
  "style",
  "linkstyle",
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function escapeMarkdownCell(text) {
  return String(text ?? "")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function sanitizeMermaidText(text, maxLen = 72) {
  return String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/-->/g, " to ")
    .replace(/\[\[/g, "[")
    .replace(/["`{}<>#;|]/g, " ")
    .replace(/:/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen) || "step";
}

function toMermaidId(raw, usedIds = null, prefix = "n") {
  let clean = String(raw ?? "")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!clean || /^[0-9]/.test(clean) || MERMAID_RESERVED.has(clean.toLowerCase())) {
    clean = `${prefix}_${clean || "node"}`;
  }
  if (!usedIds) return clean;
  let candidate = clean;
  let n = 2;
  while (usedIds.has(candidate)) {
    candidate = `${clean}_${n++}`;
  }
  usedIds.add(candidate);
  return candidate;
}

function injectGitHubClassDefs(mmdText) {
  const lines = String(mmdText ?? "").split(/\r?\n/);
  const defined = new Set();
  const referenced = new Set();

  for (const line of lines) {
    const defMatch = line.match(/^\s*classDef\s+([A-Za-z0-9_-]+)\b/);
    if (defMatch) defined.add(defMatch[1]);
    const clsMatch = line.match(/^\s*class\s+\S+\s+([A-Za-z0-9_,-]+)\s*$/);
    if (clsMatch) {
      for (const name of clsMatch[1].split(",")) {
        const trimmed = name.trim();
        if (trimmed) referenced.add(trimmed);
      }
    }
  }

  const missingLines = [];
  for (const cls of Object.keys(PELE_GITHUB_CLASS_DEFS)) {
    if (referenced.has(cls) && !defined.has(cls)) {
      missingLines.push(`  classDef ${cls} ${PELE_GITHUB_CLASS_DEFS[cls]}`);
    }
  }
  if (missingLines.length === 0) return lines.join("\n");

  const firstClassIdx = lines.findIndex((line) => /^\s*class\s+/.test(line));
  if (firstClassIdx !== -1) {
    lines.splice(firstClassIdx, 0, ...missingLines);
  } else {
    lines.push(...missingLines);
  }
  return lines.join("\n");
}

function normalizeGitHubRepoUrl(rawUrl) {
  const text = String(rawUrl ?? "").trim();
  if (!text) return null;
  const httpsMatch = text.match(/^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) return `https://github.com/${httpsMatch[1]}`;
  const scpMatch = text.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (scpMatch) return `https://github.com/${scpMatch[1]}`;
  const sshMatch = text.match(/^ssh:\/\/(?:[^@\s]+@)?github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (sshMatch) return `https://github.com/${sshMatch[1]}`;
  return null;
}

function resolveGitHubRepoUrl(workspaceDir, explicitRepoUrl) {
  if (explicitRepoUrl) {
    return normalizeGitHubRepoUrl(explicitRepoUrl);
  }
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return null;
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: workspaceDir,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return normalizeGitHubRepoUrl(remote);
  } catch {
    return null;
  }
}

function resolveFeaturesDir(workspaceDir, explicitFeatureMapDir, proofManifest) {
  const candidate = explicitFeatureMapDir || proofManifest?.featureMap?.skillDir || null;
  if (candidate) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceDir, candidate);
    const nested = path.join(abs, "features");
    if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) return nested;
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
    return null;
  }
  const hasMappedChecks = Boolean(
    proofManifest?.featureMap?.coveredFeatures?.length ||
      proofManifest?.checks?.some((c) => Boolean(c.featureId)),
  );
  if (!hasMappedChecks) {
    return null;
  }
  const skillsDir = path.join(workspaceDir, ".agents", "skills");
  if (!fs.existsSync(skillsDir)) return null;
  const dirs = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("verify-"))
    .map((d) => d.name)
    .sort();
  for (const name of dirs) {
    const featDir = path.join(skillsDir, name, "features");
    if (!fs.existsSync(featDir) || !fs.statSync(featDir).isDirectory()) continue;
    const hasMd = fs.readdirSync(featDir).some((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
    if (hasMd) return featDir;
  }
  return null;
}

function readFeatureMapEntries(featuresDir) {
  if (!featuresDir || !fs.existsSync(featuresDir)) return [];
  const files = fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md") && d.name.toLowerCase() !== "readme.md")
    .map((d) => d.name)
    .sort();

  const entries = [];
  for (const file of files) {
    const featureId = path.basename(file, ".md");
    const raw = fs.readFileSync(path.join(featuresDir, file), "utf8");
    const h1 = raw.match(/^#\s+(.+)$/m);
    const title = h1 ? h1[1].trim() : featureId;
    const subHeader = raw.match(/^##\s+Sub-features\b[^\r\n]*[\r\n]+/m);
    const subFeatures = [];
    if (subHeader && subHeader.index !== undefined) {
      const after = raw.slice(subHeader.index + subHeader[0].length);
      const nextHeading = after.search(/^##\s/m);
      const subSection = nextHeading === -1 ? after : after.slice(0, nextHeading);
      for (const line of subSection.split(/\r?\n/)) {
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) {
          const clean = bullet[1]
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/`([^`]+)`/g, "$1")
            .replace(/\*\*([^*]+)\*\*/g, "$1")
            .replace(/__([^_]+)__/g, "$1")
            .trim();
          if (clean) subFeatures.push(clean);
        }
      }
    }
    const companionMmd = path.join(featuresDir, `${featureId}.statechart.mmd`);
    entries.push({
      featureId,
      title,
      subFeatures,
      companionStatechartPath: fs.existsSync(companionMmd) ? companionMmd : null,
    });
  }
  return entries;
}

function extractTitleFromMmd(mmdText) {
  const m = String(mmdText ?? "").match(/^---\s*[\r\n]+title:\s*(.+?)[\r\n]+---/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return m[1].trim().replace(/^["']|["']$/g, "");
  }
}

function normalizeCheckKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function collectUnifiedProofRows({ evidence, proofManifest }) {
  const rows = [];
  const seenCommands = new Set();
  const manifestHeadMismatch = Boolean(
    proofManifest?.headSha &&
      evidence?.headSha &&
      proofManifest.headSha.toLowerCase() !== evidence.headSha.toLowerCase(),
  );

  if (proofManifest && Array.isArray(proofManifest.checks)) {
    for (const chk of proofManifest.checks) {
      const featureSuffix = chk.featureId ? ` (${chk.featureId})` : "";
      const observed = manifestHeadMismatch
        ? `${chk.observed} [manifest HEAD ${proofManifest.headSha.slice(0, 7)} differs from ${(evidence.headSha ?? "none").slice(0, 7)}]`
        : chk.observed;
      rows.push({
        id: chk.id,
        featureId: chk.featureId ?? null,
        label: `${chk.name}${featureSuffix}`,
        surface: chk.surface,
        status: chk.status,
        commandOrAction: chk.commandOrAction,
        observed,
      });
      seenCommands.add(normalizeCheckKey(chk.commandOrAction));
    }
  }

  const latestReceipts = new Map();
  for (const r of evidence?.recentChecks ?? []) {
    const key = `${r.category}:${normalizeCheckKey(r.summary)}`;
    latestReceipts.set(key, r);
  }
  for (const r of latestReceipts.values()) {
    const cmdKey = normalizeCheckKey(r.summary);
    if (seenCommands.has(cmdKey)) continue;
    const status = r.status ?? (r.ok ? "PASS" : "FAIL");
    rows.push({
      id: cmdKey,
      featureId: null,
      label: `${r.category} check`,
      surface: r.category,
      status,
      commandOrAction: r.summary,
      observed: `Receipt at ${r.ts} on HEAD ${(r.headSha ?? "none").slice(0, 7)}`,
    });
  }

  if (rows.length === 0) {
    rows.push({
      id: "unverified",
      featureId: null,
      label: "No verification receipts recorded on HEAD",
      surface: "cli",
      status: "SKIP",
      commandOrAction: "node skills/pre-pr/scripts/pr-dossier.mjs --format github",
      observed: `Freshness is ${evidence?.freshness ?? "missing_receipts"}`,
    });
  }

  const counts = { pass: 0, fail: 0, skip: 0, unreachable: 0 };
  for (const row of rows) {
    if (row.status === "PASS") counts.pass++;
    else if (row.status === "FAIL") counts.fail++;
    else if (row.status === "UNREACHABLE") counts.unreachable++;
    else counts.skip++;
  }

  return { rows, counts, manifestHeadMismatch };
}

function buildLifecycleStatechart(evidence) {
  const checks = evidence?.recentChecks ?? [];
  const hasFailReceipt = checks.some((c) => !c.ok || c.status === "FAIL");
  const assertionsOk = !evidence?.assertionDelta?.flagged;

  let receiptsStatus = "skip";
  if (hasFailReceipt) receiptsStatus = "fail";
  else if (evidence?.freshness === "fresh" || evidence?.freshness === "fresh_rebase_patch_id") receiptsStatus = "pass";
  else if (evidence?.freshness && evidence.freshness !== "missing_receipts") receiptsStatus = "fail";

  let verifierStatus = "skip";
  const verdict = evidence?.verifier?.verdict;
  if (verdict === "FAIL" || verdict === "ESCALATE_HUMAN") verifierStatus = "fail";
  else if ((verdict === "PASS" || verdict === "PASS_WITH_NOTES") && !evidence?.verifier?.stale) verifierStatus = "pass";
  else if (evidence?.verifier?.stale) verifierStatus = "unreachable";

  let gateStatus = "skip";
  if (evidence?.roundState === "escalated" || !assertionsOk || receiptsStatus === "fail" || verifierStatus === "fail") {
    gateStatus = "fail";
  } else if (evidence?.roundState === "verified" || (receiptsStatus === "pass" && verifierStatus === "pass")) {
    gateStatus = "pass";
  }

  const totalFiles = (evidence?.clusters ?? []).reduce((sum, c) => sum + c.files.length, 0);
  const lines = [
    "stateDiagram-v2",
    ...STATUS_CLASS_DEFS,
    "  [*] --> Diff",
    `  Diff: Diff (${totalFiles} files, Tier ${evidence?.riskTier ?? 1})`,
    `  Assertions: Assertions (+${evidence?.assertionDelta?.added ?? 0}/-${evidence?.assertionDelta?.removed ?? 0})`,
    `  Receipts: Receipts (${sanitizeMermaidText(evidence?.freshness ?? "missing_receipts", 36)})`,
    `  Verifier: Verifier (${sanitizeMermaidText(verdict ? `${verdict}${evidence?.verifier?.stale ? " stale" : ""}` : "pending", 36)})`,
    `  Gate: Risk Gate (${sanitizeMermaidText(evidence?.roundState ?? "open", 24)})`,
    "  Diff --> Assertions",
    "  Assertions --> Receipts",
    "  Receipts --> Verifier",
    "  Verifier --> Gate",
    "  Gate --> [*]",
    "  class Diff pass",
    `  class Assertions ${assertionsOk ? "pass" : "fail"}`,
    `  class Receipts ${receiptsStatus}`,
    `  class Verifier ${verifierStatus}`,
    `  class Gate ${gateStatus}`,
  ];
  return {
    source: "verification-lifecycle",
    title: "PR Verification Lifecycle",
    mermaid: lines.join("\n"),
  };
}

/**
 * Validates a `proof-manifest.json` document written by verification harnesses.
 */
export function validateProofManifest(doc) {
  const errors = [];
  if (!isPlainObject(doc)) {
    return ["Document must be a JSON object"];
  }
  if (doc.schemaVersion !== 1) {
    errors.push("schemaVersion must equal 1");
  }
  if (doc.headSha !== undefined && doc.headSha !== null) {
    if (typeof doc.headSha !== "string" || (doc.headSha && !/^[0-9a-f]{40}$/i.test(doc.headSha))) {
      errors.push("headSha must be empty or a 40-character hexadecimal git SHA");
    }
  }
  if (doc.generatedAt !== undefined && typeof doc.generatedAt !== "string") {
    errors.push("generatedAt must be a string when present");
  }
  if (doc.statechart !== undefined) {
    if (!isPlainObject(doc.statechart)) {
      errors.push("statechart must be an object");
    } else {
      if (doc.statechart.source !== undefined && !VALID_STATECHART_SOURCES.has(doc.statechart.source)) {
        errors.push(`statechart.source invalid: ${doc.statechart.source}`);
      }
      if (doc.statechart.title !== undefined && typeof doc.statechart.title !== "string") {
        errors.push("statechart.title must be a string");
      }
      if (doc.statechart.mmdPath !== undefined && typeof doc.statechart.mmdPath !== "string") {
        errors.push("statechart.mmdPath must be a string");
      }
      if (doc.statechart.transitions !== undefined) {
        if (!Array.isArray(doc.statechart.transitions)) {
          errors.push("statechart.transitions must be an array");
        } else {
          doc.statechart.transitions.forEach((t, idx) => {
            if (!isPlainObject(t)) {
              errors.push(`statechart.transitions[${idx}] must be an object`);
              return;
            }
            for (const field of ["from", "to", "action"]) {
              if (typeof t[field] !== "string" || !t[field].trim()) {
                errors.push(`statechart.transitions[${idx}].${field} must be a non-empty string`);
              }
            }
            if (t.status !== undefined && !VALID_CHECK_STATUSES.has(t.status)) {
              errors.push(`statechart.transitions[${idx}].status invalid: ${t.status}`);
            }
          });
        }
      }
    }
  }
  if (doc.featureMap !== undefined) {
    if (!isPlainObject(doc.featureMap)) {
      errors.push("featureMap must be an object");
    } else {
      if (doc.featureMap.skillDir !== undefined && typeof doc.featureMap.skillDir !== "string") {
        errors.push("featureMap.skillDir must be a string");
      }
      if (
        doc.featureMap.coveredFeatures !== undefined &&
        (!Array.isArray(doc.featureMap.coveredFeatures) ||
          doc.featureMap.coveredFeatures.some((f) => typeof f !== "string" || !f.trim()))
      ) {
        errors.push("featureMap.coveredFeatures must be an array of non-empty strings");
      }
    }
  }
  if (!Array.isArray(doc.checks)) {
    errors.push("checks must be an array");
  } else {
    doc.checks.forEach((chk, idx) => {
      if (!isPlainObject(chk)) {
        errors.push(`checks[${idx}] must be an object`);
        return;
      }
      for (const field of ["id", "name", "surface", "commandOrAction", "observed"]) {
        if (typeof chk[field] !== "string" || !chk[field].trim()) {
          errors.push(`checks[${idx}].${field} must be a non-empty string`);
        }
      }
      if (!VALID_CHECK_STATUSES.has(chk.status)) {
        errors.push(`checks[${idx}].status invalid: ${chk.status}`);
      }
      if (chk.featureId !== undefined && typeof chk.featureId !== "string") {
        errors.push(`checks[${idx}].featureId must be a string`);
      }
    });
  }
  return errors;
}

/**
 * Resolves the highest truthful Mermaid `stateDiagram-v2` tier for a PR without fabricating transitions.
 */
export function resolvePrStatechart({
  workspaceDir = process.cwd(),
  evidence = {},
  proofManifest = null,
  statechartPath = null,
  featureMapDir = null,
  requireFallback = false,
} = {}) {
  const rootDir = path.resolve(workspaceDir);
  if (statechartPath) {
    const resolvedExplicit = path.isAbsolute(statechartPath)
      ? statechartPath
      : path.resolve(rootDir, statechartPath);
    if (!fs.existsSync(resolvedExplicit)) {
      throw new Error(`Statechart file not found (${resolvedExplicit})`);
    }
    const raw = fs.readFileSync(resolvedExplicit, "utf8").trim();
    if (!/^\s*stateDiagram-v2\b/m.test(raw)) {
      throw new Error(`Statechart file must contain stateDiagram-v2 (${resolvedExplicit})`);
    }
    const isTsFormal =
      proofManifest?.statechart?.source === "formal-ts" ||
      /%%\s*provenance:\s*formal-ts\b|bounded-bfs/i.test(raw);
    return {
      source: isTsFormal ? "formal-ts" : "formal-tla",
      title: proofManifest?.statechart?.title || extractTitleFromMmd(raw) || "Formal Statechart",
      mermaid: injectGitHubClassDefs(raw),
    };
  }

  const manifestMmdRel = proofManifest?.statechart?.mmdPath;
  if (manifestMmdRel) {
    const absMmd = path.isAbsolute(manifestMmdRel)
      ? manifestMmdRel
      : path.resolve(rootDir, manifestMmdRel);
    if (fs.existsSync(absMmd)) {
      const raw = fs.readFileSync(absMmd, "utf8").trim();
      if (/^\s*stateDiagram-v2\b/m.test(raw)) {
        const isTsFormal =
          proofManifest?.statechart?.source === "formal-ts" ||
          /%%\s*provenance:\s*formal-ts\b|bounded-bfs/i.test(raw);
        return {
          source: isTsFormal ? "formal-ts" : "formal-tla",
          title: proofManifest?.statechart?.title || extractTitleFromMmd(raw) || "Formal Statechart",
          mermaid: injectGitHubClassDefs(raw),
        };
      }
    }
  }

  const transitions = proofManifest?.statechart?.transitions ?? [];
  if (transitions.length > 0) {
    const usedIds = new Set();
    const idMap = new Map();
    const getNodeId = (rawName) => {
      if (!idMap.has(rawName)) {
        idMap.set(rawName, toMermaidId(rawName, usedIds, "s"));
      }
      return idMap.get(rawName);
    };
    const nodeStatuses = new Map();
    const lines = ["stateDiagram-v2", ...STATUS_CLASS_DEFS];
    const firstFrom = transitions[0].from;
    if (firstFrom !== "[*]") {
      lines.push(`  [*] --> ${getNodeId(firstFrom)}`);
    }
    for (const t of transitions) {
      const fromId = t.from === "[*]" ? "[*]" : getNodeId(t.from);
      const toId = t.to === "[*]" ? "[*]" : getNodeId(t.to);
      if (t.from !== "[*]") {
        const label = sanitizeMermaidText(t.from, 48);
        if (label !== fromId && !nodeStatuses.has(`${fromId}:decl`)) {
          lines.push(`  ${fromId}: ${label}`);
          nodeStatuses.set(`${fromId}:decl`, true);
        }
      }
      if (t.to !== "[*]") {
        const label = sanitizeMermaidText(t.to, 48);
        if (label !== toId && !nodeStatuses.has(`${toId}:decl`)) {
          lines.push(`  ${toId}: ${label}`);
          nodeStatuses.set(`${toId}:decl`, true);
        }
        if (t.status && VALID_CHECK_STATUSES.has(t.status)) {
          const prev = nodeStatuses.get(toId);
          if (prev !== "fail") {
            nodeStatuses.set(toId, t.status.toLowerCase());
          }
        }
      }
      lines.push(`  ${fromId} --> ${toId}: ${sanitizeMermaidText(t.action, 56)}`);
    }
    for (const [nodeId, statusCls] of nodeStatuses.entries()) {
      if (nodeId.endsWith(":decl")) continue;
      lines.push(`  class ${nodeId} ${statusCls}`);
    }
    return {
      source: "feature-map-flow",
      title: proofManifest?.statechart?.title || "Observed Feature Flow",
      mermaid: lines.join("\n"),
    };
  }

  const featuresDir = resolveFeaturesDir(rootDir, featureMapDir, proofManifest, evidence);
  const featureEntries = readFeatureMapEntries(featuresDir);
  const coveredSet = new Set(proofManifest?.featureMap?.coveredFeatures ?? []);

  for (const entry of featureEntries) {
    if (!entry.companionStatechartPath) continue;
    if (coveredSet.size > 0 && !coveredSet.has(entry.featureId)) continue;
    const raw = fs.readFileSync(entry.companionStatechartPath, "utf8").trim();
    if (/^\s*stateDiagram-v2\b/m.test(raw)) {
      return {
        source: "feature-map-flow",
        title: entry.title,
        mermaid: injectGitHubClassDefs(raw),
      };
    }
  }

  const manifestChecks = proofManifest?.checks ?? [];
  if (featureEntries.length > 0 || manifestChecks.length > 0) {
    const usedIds = new Set(["Preconditions", "Verified", "Blocked", "Pending"]);
    const selectedFeatures =
      coveredSet.size > 0
        ? featureEntries.filter((f) => coveredSet.has(f.featureId))
        : featureEntries;
    const activeFeatures = selectedFeatures.length > 0 ? selectedFeatures : featureEntries;

    const groups = [];
    const assignedCheckIdx = new Set();

    for (const feat of activeFeatures) {
      const matched = [];
      manifestChecks.forEach((chk, idx) => {
        if (chk.featureId === feat.featureId) {
          matched.push(chk);
          assignedCheckIdx.add(idx);
        }
      });
      const items =
        matched.length > 0
          ? matched.map((c) => ({
              id: c.id,
              name: c.name,
              status: c.status,
            }))
          : feat.subFeatures.slice(0, 4).map((sub, i) => ({
              id: `${feat.featureId}_sub_${i + 1}`,
              name: sub,
              status: "SKIP",
            }));
      if (items.length === 0) {
        items.push({
          id: `${feat.featureId}_check`,
          name: feat.title,
          status: "SKIP",
        });
      }
      groups.push({ featureId: feat.featureId, title: feat.title, items });
    }

    const unassigned = manifestChecks.filter((_, idx) => !assignedCheckIdx.has(idx));
    if (unassigned.length > 0) {
      const extraByFeature = new Map();
      for (const chk of unassigned) {
        const key = chk.featureId || "verified-checks";
        if (!extraByFeature.has(key)) extraByFeature.set(key, []);
        extraByFeature.get(key).push(chk);
      }
      for (const [key, list] of extraByFeature.entries()) {
        groups.push({
          featureId: key,
          title: key === "verified-checks" ? "Recorded Checks" : key,
          items: list.map((c) => ({ id: c.id, name: c.name, status: c.status })),
        });
      }
    }

    const lines = ["stateDiagram-v2", ...STATUS_CLASS_DEFS, "  [*] --> Preconditions"];
    const classLines = [];
    const usedTerminals = new Set();

    for (const grp of groups) {
      const grpId = toMermaidId(grp.featureId, usedIds, "feat");
      lines.push(`  Preconditions --> ${grpId}`);
      lines.push(`  state "${sanitizeMermaidText(grp.title, 48)}" as ${grpId} {`);
      let hasFail = false;
      let hasPass = false;
      for (const item of grp.items) {
        const chkNodeId = toMermaidId(item.id, usedIds, "chk");
        const safeLabel = sanitizeMermaidText(item.name, 52);
        lines.push(`    ${chkNodeId}: ${safeLabel} [${item.status}]`);
        classLines.push(`  class ${chkNodeId} ${item.status.toLowerCase()}`);
        if (item.status === "FAIL") hasFail = true;
        if (item.status === "PASS") hasPass = true;
      }
      lines.push("  }");
      const terminal = hasFail ? "Blocked" : hasPass ? "Verified" : "Pending";
      usedTerminals.add(terminal);
      lines.push(`  ${grpId} --> ${terminal}`);
    }

    if (usedTerminals.has("Verified")) lines.push("  class Verified pass");
    if (usedTerminals.has("Blocked")) lines.push("  class Blocked fail");
    if (usedTerminals.has("Pending")) lines.push("  class Pending skip");
    lines.push(...classLines);

    return {
      source: "feature-map-coverage",
      title: proofManifest?.statechart?.title || "Feature Map Verification Coverage",
      mermaid: lines.join("\n"),
    };
  }

  return requireFallback ? buildLifecycleStatechart(evidence) : null;
}

/**
 * Renders an idempotent GitHub PR proof block (optional Statechart, PASS/FAIL/SKIP/UNREACHABLE table, and bot metadata).
 */
export function renderGitHubPrProof({
  workspaceDir = process.cwd(),
  evidence = {},
  findingsDoc = null,
  proofManifest = null,
  statechart = undefined,
  requireFallback = false,
  repoUrl = null,
  existingBody = null,
} = {}) {
  const rootDir = path.resolve(workspaceDir);
  const resolvedStatechart =
    statechart === undefined
      ? resolvePrStatechart({ workspaceDir: rootDir, evidence, proofManifest, requireFallback })
      : statechart;
  const { rows, counts, manifestHeadMismatch } = collectUnifiedProofRows({
    evidence,
    proofManifest,
  });
  const shortHead = (evidence?.headSha ?? "none").slice(0, 7);
  const githubBase = resolveGitHubRepoUrl(rootDir, repoUrl);

  const meta = {
    schemaVersion: 1,
    headSha: shortHead,
    freshness: evidence?.freshness ?? "missing_receipts",
    riskTier: evidence?.riskTier ?? 1,
    statechartSource: resolvedStatechart?.source ?? null,
    counts,
  };

  const lines = [
    PROOF_START_MARKER,
    `<!-- astack:proof-meta ${JSON.stringify(meta)} -->`,
    "",
  ];
  if (resolvedStatechart) {
    lines.push(
      "## Statechart",
      "",
      `Provenance is \`${resolvedStatechart.source}\` on \`HEAD ${shortHead}\`.`,
      "",
      "```mermaid",
      resolvedStatechart.mermaid,
      "```",
      "",
    );
  }
  lines.push(
    "## Verification Proof",
    "",
    `Summary on \`HEAD ${shortHead}\` (\`${evidence?.freshness ?? "missing_receipts"}\`, Risk Tier ${evidence?.riskTier ?? 1} ${evidence?.riskLabel ?? "medium"}). PASS ${counts.pass}, FAIL ${counts.fail}, SKIP ${counts.skip}, UNREACHABLE ${counts.unreachable}.`,
    "",
  );

  if (evidence?.trustContext) {
    const tc = evidence.trustContext;
    const autoLabel = evidence.autoMergeEligible ? "Yes" : "No";
    const autoReason = escapeMarkdownCell(
      evidence.autoMerge?.reason ?? (evidence.autoMergeEligible ? "eligible" : "Human review required"),
    );
    const trustText =
      tc.category === "governance"
        ? `Agent trust for \`governance\` is \`L${tc.level}\` (\`T ${Number(tc.score ?? 0).toFixed(2)}\`, capped at \`L2\` forever). Auto-merge is \`${autoLabel}\` (${autoReason}).`
        : `Agent trust for \`${tc.category}\` is \`L${tc.level}/L3\` (\`T ${Number(tc.score ?? 0).toFixed(2)}\`, ceiling \`L${tc.ceiling}\`, \`${tc.merges}/${tc.minMergesForL3}\` merges). Auto-merge is \`${autoLabel}\` (${autoReason}).`;
    lines.push(trustText, "");
  }

  if (manifestHeadMismatch) {
    lines.push(
      `> **Warning.** Attached \`proof-manifest.json\` records \`HEAD ${proofManifest.headSha.slice(0, 7)}\` instead of current \`HEAD ${shortHead}\`. Re-run verification before merging.`,
      "",
    );
  }

  lines.push(
    "| Check or Feature | Surface | Status | Command or Action | Observed Result |",
    "|---|---|---|---|---|",
  );
  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownCell(row.label)} | \`${escapeMarkdownCell(row.surface)}\` | \`${row.status}\` | \`${escapeMarkdownCell(row.commandOrAction)}\` | ${escapeMarkdownCell(row.observed)} |`,
    );
  }
  lines.push("");

  lines.push(
    "<details>",
    "<summary>Receipts, Guided Reading Order, and Independent Verifier</summary>",
    "",
    "### Verification Receipts",
    "",
  );
  const recentChecks = evidence?.recentChecks ?? [];
  if (recentChecks.length === 0) {
    lines.push("No command or verifier receipts recorded for this session.", "");
  } else {
    lines.push("| Time | Category | Status | Summary | HEAD |", "|---|---|---|---|---|");
    for (const chk of recentChecks.slice(-15)) {
      const status = chk.status ?? (chk.ok ? "PASS" : "FAIL");
      lines.push(
        `| ${chk.ts} | \`${chk.category}\` | \`${status}\` | ${escapeMarkdownCell(chk.summary)} | \`${(chk.headSha ?? "none").slice(0, 7)}\` |`,
      );
    }
    lines.push("");
  }

  lines.push("### Guided Reading Order", "");
  const clusters = evidence?.clusters ?? [];
  if (clusters.length === 0) {
    lines.push("No changed files against base.", "");
  } else {
    for (const cluster of clusters) {
      lines.push(`#### ${cluster.title} (+${cluster.additions} / -${cluster.deletions})`, "");
      for (const relFile of cluster.files) {
        const lineNo = cluster.firstLines?.[relFile] ?? 1;
        if (githubBase && evidence?.headSha) {
          const encodedPath = relFile.split("/").map(encodeURIComponent).join("/");
          lines.push(`- [${relFile}#L${lineNo}](${githubBase}/blob/${evidence.headSha}/${encodedPath}#L${lineNo})`);
        } else {
          lines.push(`- \`${relFile}#L${lineNo}\``);
        }
      }
      lines.push("");
    }
  }

  lines.push("### Independent PR Verifier", "");
  if (!findingsDoc) {
    lines.push("No `findings.json` attached yet.", "");
  } else {
    const important = findingsDoc.findings.filter((f) => f.severity === "important");
    const nits = findingsDoc.findings.filter((f) => f.severity === "nit");
    const preExisting = findingsDoc.findings.filter((f) => f.severity === "pre_existing");
    lines.push(
      `**Verdict.** \`${findingsDoc.verdict}\` (${escapeMarkdownCell(findingsDoc.summary)}). Important ${important.length}, Nit ${nits.length}, Pre-existing ${preExisting.length}.`,
      "",
    );
    if (evidence?.verifier?.stale) {
      lines.push(
        `> **Warning.** Attached \`findings.json\` verified \`${findingsDoc.headSha}\` instead of \`${evidence.headSha}\`.`,
        "",
      );
    }
  }
  lines.push("</details>", PROOF_END_MARKER);

  const block = lines.join("\n");
  if (typeof existingBody === "string" && existingBody.length > 0) {
    const markerPair = /<!--\s*astack:pr-proof:start\s*-->[\s\S]*?<!--\s*astack:pr-proof:end\s*-->/;
    if (markerPair.test(existingBody)) {
      return `${existingBody.replace(markerPair, () => block).trimEnd()}\n`;
    }
    const openOnly = /<!--\s*astack:pr-proof:start\s*-->[\s\S]*$/;
    if (openOnly.test(existingBody)) {
      return `${existingBody.replace(openOnly, () => block).trimEnd()}\n`;
    }
    return `${existingBody.trimEnd()}\n\n${block}\n`;
  }
  return `${block}\n`;
}

/**
 * Validates that a GitHub PR body satisfies AStack's statechart and verification proof contract.
 */
export function validatePrBodyContract(
  bodyText,
  { requireStatechart = false, requireProofTable = true, forbidLocalLinks = true } = {},
) {
  const violations = [];
  if (typeof bodyText !== "string" || !bodyText.trim()) {
    return { ok: false, violations: ["PR body is empty"], meta: null };
  }

  if (!bodyText.includes(PROOF_START_MARKER) || !bodyText.includes(PROOF_END_MARKER)) {
    violations.push("Missing <!-- astack:pr-proof:start --> or <!-- astack:pr-proof:end --> markers");
  }

  let meta = null;
  const metaMatch = bodyText.match(/<!--\s*astack:proof-meta\s+(\{[^\r\n]*?\})\s*-->/);
  if (!metaMatch) {
    violations.push("Missing <!-- astack:proof-meta {...} --> metadata comment");
  } else {
    try {
      const parsed = JSON.parse(metaMatch[1]);
      if (
        !isPlainObject(parsed) ||
        parsed.schemaVersion !== 1 ||
        !isPlainObject(parsed.counts) ||
        !["pass", "fail", "skip", "unreachable"].every((k) => Number.isInteger(parsed.counts[k]))
      ) {
        violations.push("Invalid astack:proof-meta JSON schema");
      } else {
        meta = parsed;
      }
    } catch {
      violations.push("Malformed astack:proof-meta JSON");
    }
  }

  if (requireStatechart) {
    const mermaidBlocks = [...bodyText.matchAll(/```mermaid\b[^\r\n]*[\r\n]+([\s\S]*?)```/gi)];
    const hasStateDiagram = mermaidBlocks.some((m) => /^\s*stateDiagram-v2\b/m.test(m[1]));
    if (!hasStateDiagram) {
      violations.push("Missing Mermaid stateDiagram-v2 statechart block");
    }
  }

  if (requireProofTable) {
    const hasHeading = /^##\s+Verification Proof\b/m.test(bodyText);
    const hasStatusRow = /^\|\s*.+\|\s*`?(?:PASS|FAIL|SKIP|UNREACHABLE)`?\s*\|/m.test(bodyText);
    if (!hasHeading || !hasStatusRow) {
      violations.push("Missing ## Verification Proof table with PASS/FAIL/SKIP/UNREACHABLE row");
    }
  }

  if (forbidLocalLinks) {
    if (/file:\/\//i.test(bodyText)) {
      violations.push("PR body contains forbidden local file:/// link");
    }
    if (/\]\((?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var)\/)/i.test(bodyText)) {
      violations.push("PR body contains forbidden local filesystem path link");
    }
    if (/^````carousel\b/m.test(bodyText)) {
      violations.push("PR body contains Antigravity-only carousel fence");
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    meta,
  };
}
