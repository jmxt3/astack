#!/usr/bin/env node
/**
 * Opt-in Stop hook checking AStack receipt freshness and git status (override off with ASTACK_REQUIRE_VERIFY=0).
 * Enable in astack/hooks.json by setting "enabled": true on "astack-verify-reminder".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateVerifyReminder, parseHookPayload, runHook } from "../trust/index.mjs";

export function evaluateStop(payload, options = {}) {
  const event = parseHookPayload(payload, "stop");
  return evaluateVerifyReminder(event, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHook("verify-reminder");
}
