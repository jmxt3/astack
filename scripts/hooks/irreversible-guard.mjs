#!/usr/bin/env node
/**
 * Opt-in PreToolUse guard against irreversible/destructive commands.
 * Enable in astack/hooks.json by setting "enabled": true on "astack-irreversible-guard".
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateIrreversible, runHook } from "../trust/index.mjs";

export function evaluateCommand(command, options = {}) {
  return evaluateIrreversible(command, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHook("irreversible-guard");
}
