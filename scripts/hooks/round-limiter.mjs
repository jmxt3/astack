#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runHook } from "../trust/index.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHook("round-limiter");
}
