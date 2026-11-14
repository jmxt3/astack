#!/usr/bin/env node
/**
 * Cross-platform zero-flag Node 22+ entrypoint for watch-pr.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "cli-main.ts");
const child = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", entry, ...process.argv.slice(2)],
  { stdio: "inherit" },
);
process.exit(child.status ?? 1);
