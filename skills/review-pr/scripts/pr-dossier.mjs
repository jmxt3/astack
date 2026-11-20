#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { compilePrDossier, validatePrBodyContract } from "../../../scripts/trust/index.mjs";

const USAGE = `Usage: node skills/review-pr/scripts/pr-dossier.mjs [options]

Options:
  --base <ref>             Base git ref (defaults to origin/main, main, or HEAD~1)
  --head <ref>             Head git ref (defaults to HEAD)
  --cwd <dir>              Repository working directory (defaults to cwd)
  --artifact-dir <dir>     Conversation artifact directory for receipts & evidence.json
  --findings <path>        Optional path to pr-verifier findings.json
  --screenshots <paths>    Comma-separated screenshot paths to embed in carousel (antigravity mode)
  --format <mode>          Output format: antigravity (default) or github
  --proof-manifest <path>  Optional path to proof-manifest.json
  --statechart <path>      Optional path to Mermaid stateDiagram-v2 (.mmd)
  --feature-map <dir>      Optional path to verify-<app>/features directory
  --repo-url <url>         Optional GitHub repository URL override
  --merge-body <path>      Optional existing PR body Markdown file for idempotent updates
  --check-pr-body <path>   Validate a PR body file (or '-' for stdin) and exit 0/1
  --out <path>             Output Markdown path for compiled dossier or PR body
  --json                   Emit machine-readable JSON output
  -h, --help               Show this help text and exit 0`;

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      cwd: { type: "string" },
      "artifact-dir": { type: "string" },
      findings: { type: "string" },
      screenshots: { type: "string" },
      format: { type: "string", default: "antigravity" },
      "proof-manifest": { type: "string" },
      statechart: { type: "string" },
      "feature-map": { type: "string" },
      "repo-url": { type: "string" },
      "merge-body": { type: "string" },
      "check-pr-body": { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  if (values["check-pr-body"] !== undefined) {
    const target = values["check-pr-body"];
    const baseDir = values.cwd ?? process.cwd();
    const rawBody =
      target === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(path.resolve(baseDir, target), "utf8");
    const check = validatePrBodyContract(rawBody);
    if (values.json) {
      process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    } else if (check.ok) {
      process.stdout.write("PR body contract valid.\n");
    } else {
      for (const v of check.violations) {
        process.stderr.write(`PR body violation: ${v}\n`);
      }
    }
    process.exit(check.ok ? 0 : 1);
  }

  const screenshots = values.screenshots
    ? values.screenshots.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const result = compilePrDossier({
    cwd: values.cwd ?? process.cwd(),
    baseRef: values.base,
    headRef: values.head,
    artifactDir: values["artifact-dir"] ?? null,
    findingsPath: values.findings ?? null,
    screenshots,
    outPath: values.out ?? null,
    format: values.format,
    proofManifestPath: values["proof-manifest"] ?? null,
    statechartPath: values.statechart ?? null,
    featureMapDir: values["feature-map"] ?? null,
    repoUrl: values["repo-url"] ?? null,
    mergeBodyPath: values["merge-body"] ?? null,
  });

  if (values.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          evidencePath: result.evidencePath,
          outPath: result.outPath,
          evidence: result.evidence,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(result.markdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
