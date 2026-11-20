#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateSecrets, runHook } from "../trust/index.mjs";

export function evaluateSecretPayload(payload, options = {}) {
  return evaluateSecrets(payload, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHook("secret-guard");
}
