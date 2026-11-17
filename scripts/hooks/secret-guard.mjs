#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_PATH_ALLOWLIST = /(?:^|[\\/])(?:tests?|fixtures?|__tests__|mocks?)(?:[\\/]|$)|\.(?:test|spec)\.[jtcm]?[jt]sx?$/i;
const ENV_SHELL_ACTION = /\b(?:git\s+add|cp|copy|scp|curl\s+[^\n;|&]*-d|cat|type|Get-Content)\b[^\n;|&]*?(?:\.env(?:\.[a-z]+)?|id_rsa|id_ed25519|\.npmrc|\.pypirc)\b/i;

const SECRET_PATTERNS = [
  { label: "PEM private key", regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { label: "GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "AWS access key", regex: /\bAKIA(?!IOSFODNN7EXAMPLE\b)[0-9A-Z]{16}\b/ },
  { label: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Slack token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: "LLM API key", regex: /\bsk-(?:proj|ant)-[A-Za-z0-9_-]{20,}\b/ },
];

function extractTargetFields(payload) {
  const toolName = String(payload?.toolCall?.name ?? payload?.tool_name ?? "").toLowerCase();
  const args = payload?.toolCall?.args ?? payload?.tool_input ?? payload?.args ?? {};
  const filePath = String(args.Path ?? args.path ?? "");
  const textContent = String(args.Content ?? args.content ?? args.Replacement ?? args.replacement ?? "");
  const command = String(args.CommandLine ?? args.command ?? "");
  return { toolName, filePath, textContent, command };
}

export function evaluateSecretPayload(payload, { headless } = {}) {
  if (!payload || typeof payload !== "object") {
    return { decision: "allow" };
  }
  const { toolName, filePath, textContent, command } = extractTargetFields(payload);

  if (filePath && TEST_PATH_ALLOWLIST.test(filePath)) {
    return { decision: "allow" };
  }
  if (textContent.includes("astack-secret-guard: allow-fixture")) {
    return { decision: "allow" };
  }

  let matched = null;
  if (toolName === "run_command" || command) {
    if (ENV_SHELL_ACTION.test(command)) {
      matched = "sensitive dotfile or private key shell access";
    }
    if (!matched) {
      for (const rule of SECRET_PATTERNS) {
        if (rule.regex.test(command)) {
          matched = rule.label;
          break;
        }
      }
    }
  } else if (textContent) {
    const normalizedPath = filePath.replace(/\\/g, "/");
    if (/(?:^|\/)\.env(?:\.[^/]+)?$/i.test(normalizedPath) && !/\.example$/i.test(normalizedPath)) {
      matched = "direct .env secret file write";
    } else {
      for (const rule of SECRET_PATTERNS) {
        if (rule.regex.test(textContent)) {
          matched = rule.label;
          break;
        }
      }
    }
  }

  if (!matched) {
    return { decision: "allow" };
  }

  const isHeadless =
    headless ??
    (process.env.NON_INTERACTIVE === "1" ||
      process.env.CI === "true" ||
      process.env.CI === "1");

  return {
    decision: isHeadless ? "deny" : "force_ask",
    reason: isHeadless
      ? `AStack secret-guard: blocked potential credential leak in headless mode (${matched}).`
      : `AStack secret-guard: matched potential credential pattern (${matched}). Confirm before proceeding.`,
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

  process.stdout.write(JSON.stringify(evaluateSecretPayload(payload)) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
