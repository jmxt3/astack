#!/usr/bin/env node
/**
 * Append a well-formed row to a show-me-your-work decision log (TSV),
 * stripping tabs/newlines and neutralizing spreadsheet formula prefixes.
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";
const USAGE = `Usage: node log.mjs [--dry-run] [-h|--help] <logfile> <phase> <decision> <why> <evidence> <result>

Options:
  --dry-run   Format the sanitized TSV row to stdout without writing <logfile>
  -h, --help  Show this help text and exit 0`;

export function cleanCell(raw) {
  const flat = String(raw).replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

export function formatLogRow({ phase, decision, why, evidence, result, now = new Date() }) {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    [ts, phase, decision, why, evidence, result]
      .map((v, idx) => (idx === 0 ? v : cleanCell(v)))
      .join("\t") + "\n"
  );
}

export function appendLogRow({ logfile, phase, decision, why, evidence, result, now = new Date(), dryRun = false }) {
  const row = formatLogRow({ phase, decision, why, evidence, result, now });
  if (dryRun) {
    return row;
  }
  const dir = path.dirname(logfile);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const needsHeader = !fs.existsSync(logfile) || fs.statSync(logfile).size === 0;
  if (needsHeader) {
    fs.appendFileSync(logfile, HEADER, "utf8");
  }
  fs.appendFileSync(logfile, row, "utf8");
  return row;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(1);
  }
  if (parsed.values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (parsed.positionals.length !== 6) {
    console.error(USAGE);
    process.exit(1);
  }
  const [logfile, phase, decision, why, evidence, result] = parsed.positionals;
  const row = appendLogRow({
    logfile,
    phase,
    decision,
    why,
    evidence,
    result,
    dryRun: parsed.values["dry-run"],
  });
  if (parsed.values["dry-run"]) {
    process.stdout.write(row);
  }
}
