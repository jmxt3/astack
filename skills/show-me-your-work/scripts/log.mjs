#!/usr/bin/env node
/**
 * Append a well-formed row to a show-me-your-work decision log (TSV),
 * stripping tabs/newlines and neutralizing spreadsheet formula prefixes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEADER = "ts\tphase\tdecision\twhy\tevidence\tresult\n";

export function cleanCell(raw) {
  const flat = String(raw).replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

export function appendLogRow({ logfile, phase, decision, why, evidence, result, now = new Date() }) {
  const dir = path.dirname(logfile);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const needsHeader = !fs.existsSync(logfile) || fs.statSync(logfile).size === 0;
  if (needsHeader) {
    fs.appendFileSync(logfile, HEADER, "utf8");
  }
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const row = [ts, phase, decision, why, evidence, result].map((v, idx) => (idx === 0 ? v : cleanCell(v))).join("\t") + "\n";
  fs.appendFileSync(logfile, row, "utf8");
  return row;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6) {
    console.error("usage: log.mjs <logfile> <phase> <decision> <why> <evidence> <result>");
    process.exit(1);
  }
  const [logfile, phase, decision, why, evidence, result] = args;
  appendLogRow({ logfile, phase, decision, why, evidence, result });
}
