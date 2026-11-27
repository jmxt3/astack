#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_RISK_POLICY } from "../../../scripts/trust/index.mjs";

const USAGE = `Usage: node skills/setup-astack/scripts/init-repo-policy.mjs [options]

Options:
  --cwd <dir>         Target repository root (defaults to current working directory)
  --targets <list>    Comma-separated targets: risk-policy,boundaries,review-md,glossary,pr-template (default: risk-policy,boundaries,review-md,glossary)
  --force             Overwrite existing files
  --dry-run           Report planned changes without writing files
  --json              Emit machine-readable JSON output
  -h, --help          Show this help text and exit 0`;

const DEFAULT_BOUNDARIES_TEMPLATE = {
  schemaVersion: 1,
  zones: {
    core: { include: ["src/core/**"], publicEntry: ["src/core/index.js"] },
    app: { include: ["src/app/**"] },
  },
  importRules: [
    {
      id: "no-core-internals",
      from: "app",
      forbidImportFrom: ["core"],
      reason: "Import from src/core/index.js instead of internal modules",
    },
  ],
  bannedPatterns: [],
  shallowModuleThresholds: {
    maxExportsPerShallowFile: 8,
    minImplLinesPerExport: 6,
  },
};

const DEFAULT_REVIEW_MD = `# Repository Review Rules

> Loaded strictly from the base branch (\`git show <base>:REVIEW.md\`). PR diffs cannot relax these checks.

## Must-Check Invariants

1. **Prove runtime behavior.** Every behavioral change must include a real test or Control Glass execution receipt on \`HEAD\`.
2. **No silent test weakening.** Never delete or loosen existing assertions to force a failing test suite green.
3. **Preserve module boundaries.** Respect \`.agents/boundaries.json\` import zones and public entrypoints.
4. **Tiered human sign-off.** Tier 1 through Tier 3 changes always require human review before merge.
5. **PR verification proof.** Every GitHub PR description must include a compiled \`PASS\`/\`FAIL\`/\`SKIP\`/\`UNREACHABLE\` proof table from \`pr-dossier.mjs --format github\` (plus a \`stateDiagram-v2\` statechart when changing state machines, protocols, or formal verifiers).
`;

const DEFAULT_GLOSSARY_MD = `# Domain Glossary

> Keep shared domain nouns and entity boundaries canonical across specs, types, and UI copy.

| Term | Canonical Meaning | Avoid / Do Not Confuse With |
|---|---|---|
| Workspace | Active repository root directory under verification | Plugin install directory |
| Evidence Bundle | Deterministic \`evidence.json\` bound to \`HEAD\` SHA | Unverified prose test claims |
`;

const DEFAULT_PR_TEMPLATE_MD = `## Why

<!-- 1-3 short sentences on the problem and approach. -->

## What changed

- <!-- Key behavioral or structural change. -->

## Scope

- <!-- What this PR covers and what it deliberately leaves out. -->

## Blast Radius

<!-- Risk Tier (Tier 0..3), affected surfaces, and safety check. -->

<!-- astack:pr-proof:start -->
<!-- Replace with: node skills/pre-pr/scripts/pr-dossier.mjs --format github --merge-body <body-file> --out <body-file> -->
<!-- astack:pr-proof:end -->
`;

const ALL_TARGETS = ["risk-policy", "boundaries", "review-md", "glossary"];

/**
 * Idempotently scaffolds repo governance files (\`.agents/risk-policy.json\`, \`.agents/boundaries.json\`, \`REVIEW.md\`, \`GLOSSARY.md\`, optional \`.github/PULL_REQUEST_TEMPLATE.md\`).
 */
export function scaffoldRepoPolicies({
  cwd = process.cwd(),
  targets = ALL_TARGETS,
  force = false,
  dryRun = false,
} = {}) {
  const rootDir = path.resolve(cwd);
  const selected = new Set(targets.length > 0 ? targets : ALL_TARGETS);
  const templates = [
    {
      id: "risk-policy",
      rel: ".agents/risk-policy.json",
      content: `${JSON.stringify(DEFAULT_RISK_POLICY, null, 2)}\n`,
    },
    {
      id: "boundaries",
      rel: ".agents/boundaries.json",
      content: `${JSON.stringify(DEFAULT_BOUNDARIES_TEMPLATE, null, 2)}\n`,
    },
    {
      id: "review-md",
      rel: "REVIEW.md",
      content: DEFAULT_REVIEW_MD,
    },
    {
      id: "glossary",
      rel: "GLOSSARY.md",
      content: DEFAULT_GLOSSARY_MD,
    },
    {
      id: "pr-template",
      rel: ".github/PULL_REQUEST_TEMPLATE.md",
      content: DEFAULT_PR_TEMPLATE_MD,
    },
  ].filter((item) => selected.has(item.id));

  const created = [];
  const overwritten = [];
  const skipped = [];

  for (const item of templates) {
    const abs = path.join(rootDir, ...item.rel.split("/"));
    const exists = fs.existsSync(abs);
    if (exists && !force) {
      skipped.push(item.rel);
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, item.content, "utf8");
    }
    if (exists) {
      overwritten.push(item.rel);
    } else {
      created.push(item.rel);
    }
  }

  return {
    cwd: rootDir,
    dryRun,
    created,
    overwritten,
    skipped,
  };
}

function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      targets: { type: "string" },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const targets = values.targets
    ? values.targets.split(",").map((s) => s.trim()).filter(Boolean)
    : ALL_TARGETS;

  const result = scaffoldRepoPolicies({
    cwd: values.cwd ?? process.cwd(),
    targets,
    force: values.force,
    dryRun: values["dry-run"],
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const mode = result.dryRun ? " (dry-run)" : "";
  process.stdout.write(
    `[init-repo-policy${mode}] created=${result.created.join(",") || "none"} overwritten=${result.overwritten.join(",") || "none"} skipped=${result.skipped.join(",") || "none"}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
