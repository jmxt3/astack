#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { parseCliStdin, readCliPipelineState } from "./statusline.mjs";

const USAGE = `Usage: node scripts/cli/title.mjs [options]

Reads Antigravity CLI JSON from stdin and prints a plain-text terminal title (zero ANSI codes).

Options:
  -h, --help   Show this help text and exit 0`;

/**
 * Renders one plain-text terminal title line free of ANSI escape sequences.
 */
export function renderTerminalTitle(rawPayload) {
  const s = readCliPipelineState(rawPayload);
  const raw = `AStack [${s.activeStage} · ${s.freshness}] ${s.repoName}`;
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function main() {
  const { values } = parseArgs({
    options: { help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  process.stdout.write(`${renderTerminalTitle(parseCliStdin(raw))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stdout.write("AStack\n");
  }
}
