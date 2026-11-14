#!/usr/bin/env node
/**
 * Opt-in Stop hook reminding agents to verify dirty code changes when ASTACK_REQUIRE_VERIFY=1.
 * Enable in astack/hooks.json by setting "enabled": true on "astack-verify-reminder".
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function evaluateStop(payload, options = {}) {
  if (!payload || typeof payload !== "object") {
    return { decision: "allow" };
  }
  if (payload.continuationActive === true) {
    return { decision: "allow" };
  }
  if (payload.terminationReason && payload.terminationReason !== "NO_TOOL_CALL") {
    return { decision: "allow" };
  }

  const requireVerify = options.requireVerify ?? process.env.ASTACK_REQUIRE_VERIFY === "1";
  if (!requireVerify) {
    return { decision: "allow" };
  }

  const cwd = payload.cwd;
  if (typeof cwd !== "string" || !cwd || !fs.existsSync(cwd)) {
    return { decision: "allow" };
  }

  let status = "";
  try {
    status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { decision: "allow" };
  }

  const dirtyCode = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/\.md$/i.test(line));

  if (dirtyCode.length === 0) {
    return { decision: "allow" };
  }

  return {
    decision: "continue",
    reason:
      "AStack verify-reminder (ASTACK_REQUIRE_VERIFY=1): uncommitted code changes detected. Confirm empirical verification ran against the real target (`control-ui`, `control-cli`, test suite) and run `/deslop` if finished.",
  };
}

function main() {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  process.stdout.write(JSON.stringify(evaluateStop(payload)) + "\n");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("verify-reminder.mjs")) {
  main();
}
