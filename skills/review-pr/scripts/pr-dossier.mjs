#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { compilePrDossier } from "../../../scripts/trust/index.mjs";

const USAGE = `Usage: node skills/review-pr/scripts/pr-dossier.mjs [options]

Options:
  --base <ref>            Base git ref (defaults to origin/main, main, or HEAD~1)
  --head <ref>            Head git ref (defaults to HEAD)
  --cwd <dir>             Repository working directory (defaults to cwd)
  --artifact-dir <dir>    Conversation artifact directory for receipts & evidence.json
  --findings <path>       Optional path to pr-verifier findings.json
  --screenshots <paths>   Comma-separated screenshot paths to embed in carousel
  --out <path>            Output Markdown path for visual PR dossier
  --json                  Emit machine-readable JSON output
  -h, --help              Show this help text and exit 0`;

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: "string" },
      head: { type: "string", default: "HEAD" },
      cwd: { type: "string" },
      "artifact-dir": { type: "string" },
      findings: { type: "string" },
      screenshots: { type: "string" },
      out: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
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
