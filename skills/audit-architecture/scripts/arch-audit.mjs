#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runArchitectureAudit } from "../../../scripts/trust/index.mjs";

const USAGE = `Usage: node skills/audit-architecture/scripts/arch-audit.mjs [options]

Options:
  --cwd <dir>   Repository root to audit (defaults to current working directory)
  --strict      Exit 1 when boundary or banned-pattern violations are found
  --json        Emit machine-readable JSON output
  -h, --help    Show this help text and exit 0`;

function main() {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const report = runArchitectureAudit({ cwd: values.cwd ?? process.cwd() });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const s = report.summary;
    process.stdout.write(
      `[arch-audit] files=${s.filesScanned} boundaries=${s.boundaryViolations} banned=${s.bannedHits} shallow=${s.shallowModules} gardening=${s.gardeningHits}\n`,
    );
    for (const v of report.boundaryViolations) process.stdout.write(`BOUNDARY ${v.detail}\n`);
    for (const b of report.bannedHits) process.stdout.write(`BANNED ${b.detail}\n`);
    for (const m of report.shallowModules) process.stdout.write(`SHALLOW ${m.file}: ${m.reason}\n`);
    for (const g of report.gardeningHits) process.stdout.write(`GARDEN [${g.id}] ${g.file}:${g.line} ${g.snippet}\n`);
  }

  if (values.strict && !report.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
