#!/usr/bin/env node
/**
 * Stop hook checking AStack receipt freshness and git status (override off with ASTACK_REQUIRE_VERIFY=0).
 * Pass --dirty-only to continue automatically only when post-edit verification became dirty_after_verify.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateStageHandoff,
  evaluateVerifyReminder,
  parseHookPayload,
  runHook,
} from "../trust/index.mjs";

export function evaluateStop(payload, options = {}) {
  const event = parseHookPayload(payload, "stop");
  const dirtyOnly = options.dirtyOnly ?? process.argv.includes("--dirty-only");
  const verify = evaluateVerifyReminder(event, { ...options, dirtyOnly });
  if (verify.decision !== "allow") return verify;
  return evaluateStageHandoff(event, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHook("verify-reminder");
}
