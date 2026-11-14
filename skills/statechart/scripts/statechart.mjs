#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
const needsStripFlag = major === 22 && minor >= 6 && minor < 18;
const nodeFlags = [
  ...(needsStripFlag ? ["--experimental-strip-types"] : []),
  "--disable-warning=ExperimentalWarning",
];

const entry = path.join(import.meta.dirname, "statechart.ts");
const result = spawnSync(process.execPath, [...nodeFlags, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}
if (result.signal) {
  process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 2);
