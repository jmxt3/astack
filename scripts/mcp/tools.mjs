import fs from "node:fs";
import path from "node:path";
import {
  compilePrDossier,
  computeFreshness,
  evaluateIntentScope,
  evaluateRepoTrust,
  formatPipelineRail,
  loadRiskPolicy,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  recordIntentCard,
  recordRollbackReceipt,
  resolveBaseRef,
  resolveTrustDir,
  resolveWorkspaceScope,
  runArchitectureAudit,
  validateProofManifest,
} from "../trust/index.mjs";
import { scaffoldRepoPolicies } from "../../skills/setup-astack/scripts/init-repo-policy.mjs";
import { runWorkspaceDoctor } from "../../skills/setup-astack/scripts/setup-banner.mjs";

const MAX_TEXT_CHARS = 120_000;

function truncateText(text, limit = MAX_TEXT_CHARS) {
  if (typeof text !== "string" || text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n...(truncated at ${limit} characters)`;
}

function toFileUrl(absPath, line = 1) {
  const normalized = path.resolve(absPath).replace(/\\/g, "/");
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${normalized}#L${line}`;
}

function findFindingsDoc(workspaceDir, trustDir, findingsPath) {
  let candidate = findingsPath ? path.resolve(workspaceDir, findingsPath) : null;
  if (!candidate && trustDir) {
    const p = path.join(trustDir, "findings.json");
    if (fs.existsSync(p)) candidate = p;
  }
  if (!candidate || !fs.existsSync(candidate)) return null;
  try {
    return JSON.parse(fs.readFileSync(candidate, "utf8"));
  } catch {
    return null;
  }
}

export const UI_RESOURCES = [
  {
    uri: "ui://astack/pr-dossier.html",
    name: "AStack PR Dossier Card",
    description: "Interactive Blast-Radius Risk Tier, Guided Reading clusters, and PR verifier findings card.",
    mimeType: "text/html;profile=mcp-app",
    fileName: "pr-dossier.html",
    _meta: { ui: { prefersBorder: true } },
  },
  {
    uri: "ui://astack/arch-audit.html",
    name: "AStack Architecture Audit Card",
    description: "Interactive boundaries, banned patterns, shallow modules, and gardening audit card.",
    mimeType: "text/html;profile=mcp-app",
    fileName: "arch-audit.html",
    _meta: { ui: { prefersBorder: true } },
  },
  {
    uri: "ui://astack/tla-viewer.html",
    name: "AStack TLA+ Formal Spec Viewer",
    description: "Custom TLA+ state, invariant outline, and editor view for .tla specifications.",
    mimeType: "text/html;profile=mcp-app",
    fileName: "tla-viewer.html",
    _meta: { ui: { prefersBorder: false } },
  },
];

export const TOOL_DEFINITIONS = [
  {
    name: "compile_pr_dossier",
    title: "Compile PR Review Dossier",
    description:
      "Compile a Blast-Radius Risk Tier evidence snapshot, Guided Reading clusters, recent verification checks, and optional PR verifier findings for a git repository.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Target git repository directory (defaults to current working directory)." },
        baseRef: { type: "string", description: "Base git ref to compare against (auto-detected if omitted)." },
        headRef: { type: "string", description: "Head git ref (defaults to HEAD)." },
        artifactDir: { type: "string", description: "Optional conversation artifact directory containing receipts and findings.json." },
        findingsPath: { type: "string", description: "Optional path to pr-verifier findings.json." },
        format: { type: "string", enum: ["antigravity", "github"], description: "Rendered dossier format." },
        screenshots: { type: "array", items: { type: "string" }, description: "Optional screenshot paths to embed." },
      },
    },
    _meta: {
      ui: {
        resourceUri: "ui://astack/pr-dossier.html",
        visibility: ["model", "app"],
      },
    },
  },
  {
    name: "audit_architecture",
    title: "Audit Repository Architecture",
    description:
      "Scan the repository against .agents/boundaries.json import rules, banned patterns, Ousterhout shallow module thresholds, and workaround comments.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Target repository directory (defaults to current working directory)." },
      },
    },
    _meta: {
      ui: {
        resourceUri: "ui://astack/arch-audit.html",
        visibility: ["model", "app"],
      },
    },
  },
  {
    name: "doctor_workspace",
    title: "Doctor AStack Workspace",
    description:
      "Run read-only AStack environment and repository health diagnostics (Node version, verify-* skill freshness, hooks.json split defaults, policies, model routing, and git worktrees).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Target repository directory (defaults to current working directory)." },
      },
    },
  },
  {
    name: "get_trust_status",
    title: "Get Trust & Pipeline Status",
    description:
      "Read merged execution receipts, HEAD SHA, verification freshness, risk policy gates, and deterministic 6-stage AStack pipeline rail.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string", description: "Target repository directory (defaults to current working directory)." },
        artifactDir: { type: "string", description: "Optional artifact directory containing astack-trust/." },
        playbook: { type: "string", description: "Playbook label shown in the pipeline rail (defaults to feature)." },
      },
    },
  },
  {
    name: "record_proof_manifest",
    title: "Record Proof Manifest",
    description:
      "Validate and atomically write proof-manifest.json into the active session trust directory.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["manifest"],
      properties: {
        cwd: { type: "string", description: "Target repository directory (defaults to current working directory)." },
        artifactDir: { type: "string", description: "Optional artifact directory containing astack-trust/." },
        manifest: { type: "object", description: "Validated proof-manifest.json object matching proof-manifest-schema." },
      },
    },
  },
  {
    name: "declare_intent",
    title: "Declare Pre-Write Intent Card",
    description:
      "Record a structured pre-write Intent Card (goal, affected globs, assumptions, edge cases, rollback plan, and predicted risk) in the active trust directory before modifying code.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["goal", "affectedGlobs", "rollbackPlan"],
      properties: {
        cwd: { type: "string", description: "Target git repository directory (defaults to current working directory)." },
        artifactDir: { type: "string", description: "Optional artifact directory containing astack-trust/." },
        conversationId: { type: "string", description: "Conversation identifier (defaults to 'default')." },
        goal: { type: "string", description: "Concise statement of the intended change." },
        affectedGlobs: { type: "array", items: { type: "string" }, description: "Repo-relative globs bounding allowed edits." },
        assumptions: { type: "array", items: { type: "string" }, description: "Key assumptions checked before editing." },
        edgeCases: { type: "array", items: { type: "string" }, description: "Boundary conditions and failure paths to test." },
        rollbackPlan: { type: "string", description: "Concrete undo command or rollback procedure." },
        predictedRisk: { description: "Predicted risk score in [0, 1] or label (low, medium, high, critical)." },
        category: { type: "string", enum: ["docs", "tests", "ui", "skills", "tooling", "core", "governance"] },
      },
    },
  },
  {
    name: "open_tla_viewer",
    title: "AStack TLA+ Viewer",
    description: "Open a .tla formal specification in AStack's interactive TLA+ outline and editor view.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        file: {
          type: "object",
          properties: {
            name: { type: "string" },
            resourceUri: { type: "string" },
          },
        },
      },
    },
    _meta: {
      ui: {
        resourceUri: "ui://astack/tla-viewer.html",
      },
      "com.google.antigravity/ui": {
        entrypoints: [
          {
            type: "file",
            title: "AStack TLA+ Viewer",
            extensions: [".tla"],
          },
        ],
      },
    },
  },
  {
    name: "get_dossier_detail",
    title: "Get Full PR Dossier Detail",
    description: "App-only helper returning full dossier clusters and verifier findings for inline card expansion.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string" },
        baseRef: { type: "string" },
        artifactDir: { type: "string" },
        findingsPath: { type: "string" },
      },
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  {
    name: "scaffold_repo_policies",
    title: "Scaffold Repo Trust Policies",
    description: "App-only helper to idempotently scaffold .agents/risk-policy.json, boundaries.json, REVIEW.md, and GLOSSARY.md.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        cwd: { type: "string" },
        dryRun: { type: "boolean" },
        targets: { type: "array", items: { type: "string" } },
      },
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
];

function handleCompilePrDossier(args = {}, context = {}) {
  const workspaceDir = path.resolve(args.cwd || process.cwd());
  const artifactDir = args.artifactDir || null;
  const result = compilePrDossier({
    cwd: workspaceDir,
    baseRef: args.baseRef,
    headRef: args.headRef || "HEAD",
    artifactDir,
    findingsPath: args.findingsPath || null,
    format: args.format || "antigravity",
    screenshots: Array.isArray(args.screenshots) ? args.screenshots : [],
    dataDir: args.dataDir ?? context.dataDir ?? null,
  });
  const trustDir = resolveTrustDir({ workspaceDir, artifactDir });
  const findingsDoc = findFindingsDoc(workspaceDir, trustDir, args.findingsPath || null);
  const clustersWithUris = (result.evidence.clusters ?? []).slice(0, 40).map((c) => ({
    ...c,
    fileLinks: (c.files ?? []).slice(0, 50).map((rel) => ({
      path: rel,
      line: c.firstLines?.[rel] ?? 1,
      uri: toFileUrl(path.resolve(workspaceDir, rel), c.firstLines?.[rel] ?? 1),
    })),
  }));

  return {
    content: [{ type: "text", text: truncateText(result.markdown) }],
    structuredContent: {
      workspaceDir,
      evidencePath: result.evidencePath,
      evidence: {
        ...result.evidence,
        clusters: clustersWithUris,
      },
      findingsDoc: findingsDoc
        ? {
            ...findingsDoc,
            findings: Array.isArray(findingsDoc.findings)
              ? findingsDoc.findings.slice(0, 100).map((f) => ({
                  ...f,
                  uri: f.file ? toFileUrl(path.resolve(workspaceDir, f.file), f.line || 1) : null,
                }))
              : [],
          }
        : null,
    },
  };
}

function handleAuditArchitecture(args = {}) {
  const workspaceDir = path.resolve(args.cwd || process.cwd());
  const report = runArchitectureAudit({ cwd: workspaceDir });
  const summary = report.summary;
  const lines = [
    `# Architecture Audit (${report.ok ? "PASS" : "VIOLATIONS FOUND"})`,
    "",
    `- Workspace: \`${workspaceDir}\``,
    `- Boundaries config: ${report.boundariesPresent ? "present" : "absent"}`,
    `- Files scanned: ${summary.filesScanned}`,
    `- Boundary violations: ${summary.boundaryViolations}`,
    `- Banned pattern hits: ${summary.bannedHits}`,
    `- Shallow module warnings: ${summary.shallowModules}`,
    `- Gardening hits: ${summary.gardeningHits}`,
  ];
  for (const v of report.boundaryViolations.slice(0, 25)) {
    lines.push(`- [BOUNDARY] ${v.file}: ${v.detail}`);
  }
  for (const b of report.bannedHits.slice(0, 25)) {
    lines.push(`- [BANNED] ${b.file}: ${b.detail}`);
  }
  for (const m of report.shallowModules.slice(0, 25)) {
    lines.push(`- [SHALLOW] ${m.file}: ${m.reason}`);
  }
  for (const g of report.gardeningHits.slice(0, 25)) {
    lines.push(`- [GARDEN:${g.id}] ${g.file}:${g.line} ${g.snippet}`);
  }

  return {
    content: [{ type: "text", text: truncateText(lines.join("\n")) }],
    structuredContent: {
      ...report,
      workspaceDir,
      boundaryViolations: report.boundaryViolations.slice(0, 100).map((v) => ({
        ...v,
        uri: toFileUrl(path.resolve(workspaceDir, v.file), 1),
      })),
      bannedHits: report.bannedHits.slice(0, 100).map((b) => ({
        ...b,
        uri: toFileUrl(path.resolve(workspaceDir, b.file), 1),
      })),
      shallowModules: report.shallowModules.slice(0, 100).map((m) => ({
        ...m,
        uri: toFileUrl(path.resolve(workspaceDir, m.file), 1),
      })),
      gardeningHits: report.gardeningHits.slice(0, 100).map((g) => ({
        ...g,
        uri: toFileUrl(path.resolve(workspaceDir, g.file), g.line || 1),
      })),
    },
  };
}

function handleDoctorWorkspace(args = {}) {
  const workspaceDir = path.resolve(args.cwd || process.cwd());
  const report = runWorkspaceDoctor({ cwd: workspaceDir });
  const lines = [
    `# AStack Workspace Doctor (${report.ok ? "OK" : "WARNINGS"})`,
    "",
    `- Workspace: ${report.workspace} (${report.cwd})`,
    "",
    "| Check | Status | Detail |",
    "|---|---|---|",
    ...report.checks.map((c) => `| \`${c.id}\` | \`${c.status}\` | ${c.detail} |`),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: report,
  };
}

function handleGetTrustStatus(args = {}, context = {}) {
  const workspaceDir = path.resolve(args.cwd || process.cwd());
  const artifactDir = args.artifactDir || null;
  const scope = resolveWorkspaceScope(workspaceDir);
  const trustDir = resolveTrustDir({ workspaceDir, artifactDir });
  const receipts = trustDir ? readMergedReceipts(trustDir) : [];
  const evidence = trustDir ? readEvidenceSnapshot(trustDir) : null;
  const headSha = readHeadShaFast(workspaceDir);
  const freshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
  const baseRef = scope.kind === "enrolled_repo" ? scope.baseRef : resolveBaseRef(workspaceDir);
  const { present: policyPresent, policy } = loadRiskPolicy(workspaceDir, { baseRef });
  const rail = formatPipelineRail({ playbook: args.playbook || "feature", policy });
  const trust =
    scope.kind !== "non_repo"
      ? evaluateRepoTrust({
          repoId: scope.repoId,
          policy,
          dataDir: args.dataDir ?? context.dataDir ?? null,
        })
      : null;

  const calibration = trust
    ? {
        chainValid: trust.chainValid,
        frozen: trust.frozen,
        totalOutcomes: trust.totalOutcomes,
        maxBrierScore: trust.maxBrierScore,
        byCategory: Object.fromEntries(
          trust.categoryList.map((c) => [
            c.id,
            {
              level: c.level,
              ceiling: c.ceiling,
              score: c.score,
              brier: c.brier,
              clean: c.clean,
              edited: c.edited,
              reverted: c.reverted,
              promoReady: c.promoReady,
            },
          ]),
        ),
      }
    : null;

  const trustLine =
    scope.kind === "non_repo"
      ? "Scope: non_repo (AStack trust inactive)"
      : scope.kind === "git_unregistered"
        ? `Scope: git_unregistered (repoId=${scope.repoId}, Trust OFF)`
        : `Scope: enrolled_repo (repoId=${scope.repoId}, beast=${trust.beastOn ? "on" : "off"}, promotion=${trust.promotionMode}, chain=${trust.chainValid ? "valid" : "BROKEN"})`;

  const text = [
    `HEAD: ${headSha ?? "none"} | Freshness: ${freshness} | Receipts: ${receipts.length} | TrustDir: ${trustDir ?? "none"}`,
    trustLine,
    "",
    rail,
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    structuredContent: {
      workspaceDir,
      scope,
      trustDir,
      headSha,
      freshness,
      receiptCount: receipts.length,
      policyPresent,
      evidence,
      trust,
      calibration,
      recentReceipts: receipts.slice(-20),
    },
  };
}

function handleRecordProofManifest(args = {}) {
  const workspaceDir = path.resolve(args.cwd || process.cwd());
  const manifest = args.manifest;
  const errors = validateProofManifest(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid proof-manifest.json: ${errors.join("; ")}`);
  }
  const trustDir = resolveTrustDir({ workspaceDir, artifactDir: args.artifactDir || null });
  if (!trustDir) {
    throw new Error("Could not resolve active trust directory");
  }
  fs.mkdirSync(trustDir, { recursive: true });
  const targetPath = path.join(trustDir, "proof-manifest.json");
  const tmpPath = path.join(
    trustDir,
    `proof-manifest.json.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`,
  );
  fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, targetPath);

  return {
    content: [{ type: "text", text: `Recorded valid proof-manifest.json at ${targetPath}` }],
    structuredContent: {
      ok: true,
      targetPath,
      schemaVersion: manifest.schemaVersion,
    },
  };
}

function handleDeclareIntent(args = {}) {
  const workspaceDir = path.resolve(args.cwd || process.cwd());
  const scope = resolveWorkspaceScope(workspaceDir, { checkEnrollment: false });
  if (scope.kind === "non_repo") {
    throw new Error("declare_intent requires an active git repository");
  }
  const trustDir = resolveTrustDir({ workspaceDir, artifactDir: args.artifactDir || null });
  if (!trustDir) {
    throw new Error("Could not resolve active trust directory");
  }
  const rawConv = args.conversationId === undefined || args.conversationId === null ? "" : String(args.conversationId).trim();
  if (rawConv && (/[\\/\0]/.test(rawConv) || rawConv.includes("..") || rawConv === ".")) {
    throw new Error("Invalid conversationId: path separators and traversal segments are forbidden");
  }
  const conversationId = rawConv || "default";
  const headSha = readHeadShaFast(workspaceDir);
  const { intent, targetPath } = recordIntentCard({
    trustDir,
    conversationId,
    headSha,
    card: {
      goal: args.goal,
      affectedGlobs: args.affectedGlobs,
      assumptions: args.assumptions,
      edgeCases: args.edgeCases,
      rollbackPlan: args.rollbackPlan,
      predictedRisk: args.predictedRisk,
      category: args.category,
    },
  });
  recordRollbackReceipt({
    trustDir,
    conversationId,
    headSha,
    plan: intent.rollbackPlan,
  });
  const scopeCheck = evaluateIntentScope(intent, []);
  return {
    content: [
      {
        type: "text",
        text: `Recorded Intent Card (${intent.category}, ${intent.affectedGlobs.length} glob(s), wideScope=${scopeCheck.wideScope}) at ${targetPath}. Rollback: ${intent.rollbackPlan}`,
      },
    ],
    structuredContent: {
      ok: true,
      targetPath,
      intent,
      wideScope: scopeCheck.wideScope,
      wideScopeReason: scopeCheck.wideScopeReason,
    },
  };
}

function handleOpenTlaViewer(args = {}) {
  const fileInfo = args?.file && typeof args.file === "object" ? args.file : {};
  const name = typeof fileInfo.name === "string" && fileInfo.name ? fileInfo.name : "Specification.tla";
  const resourceUri = typeof fileInfo.resourceUri === "string" ? fileInfo.resourceUri : null;
  const text = resourceUri
    ? `Opened TLA+ specification ${name} (${resourceUri})`
    : "Opened AStack TLA+ Viewer with empty selection.";
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      file: { name, resourceUri },
    },
  };
}

/**
 * Dispatches an MCP `tools/call` invocation to AStack's pure-ESM domain facade.
 */
export function dispatchToolCall(name, args = {}, context = {}) {
  try {
    switch (name) {
      case "compile_pr_dossier":
      case "get_dossier_detail":
        return handleCompilePrDossier(args, context);
      case "audit_architecture":
        return handleAuditArchitecture(args);
      case "doctor_workspace":
        return handleDoctorWorkspace(args);
      case "get_trust_status":
        return handleGetTrustStatus(args, context);
      case "record_proof_manifest":
        return handleRecordProofManifest({ ...args, dataDir: context.dataDir });
      case "declare_intent":
        return handleDeclareIntent(args);
      case "open_tla_viewer":
        return handleOpenTlaViewer(args);
      case "scaffold_repo_policies": {
        const res = scaffoldRepoPolicies({
          cwd: args.cwd || process.cwd(),
          dryRun: Boolean(args.dryRun),
          targets: Array.isArray(args.targets) ? args.targets : undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
          structuredContent: res,
        };
      }
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error in ${name}: ${err.message}` }],
    };
  }
}
