#!/usr/bin/env node
/**
 * Opt-in PreToolUse guard against irreversible/destructive commands.
 * Enable in astack/hooks.json by setting "enabled": true on "astack-irreversible-guard".
 */
import fs from "node:fs";

const RULES = [
  {
    label: "git push --force",
    pattern: /\bgit\s+push\b[^\n;|&]*(?:\s--force\b|\s-f\b)/i,
  },
  {
    label: "git reset --hard",
    pattern: /\bgit\s+reset\s+--hard\b/i,
  },
  {
    label: "recursive root/system delete",
    pattern:
      /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*)\s+(?:\/(?:\s|$|\*)|\/(?:bin|boot|dev|etc|home|lib|opt|proc|root|sbin|sys|usr|var)\b|~(?:\/|\s|$)|[A-Za-z]:\\(?:\s|$))/i,
  },
  {
    label: "SQL DROP/TRUNCATE",
    pattern: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
  },
  {
    label: "production destroy/deploy",
    pattern:
      /\b(?:kubectl\s+delete|terraform\s+destroy|pulumi\s+destroy|heroku\s+apps:destroy|vercel\s+--prod|flyctl?\s+deploy\b[^\n;|&]*--prod|wrangler\s+deploy\b[^\n;|&]*--env\s+prod)\b/i,
  },
];

export function evaluateCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return { decision: "allow" };
  }
  for (const rule of RULES) {
    if (rule.pattern.test(command)) {
      return {
        decision: "force_ask",
        reason: `AStack irreversible-guard: matched potentially destructive command (${rule.label}). Confirm before executing.`,
      };
    }
  }
  return { decision: "allow" };
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
    // Fail open on malformed stdin so hook transport issues never wedge the loop.
    process.stdout.write(JSON.stringify({ decision: "allow" }) + "\n");
    return;
  }

  const command =
    payload?.toolCall?.args?.CommandLine ??
    payload?.toolCall?.args?.command ??
    payload?.tool_input?.command ??
    "";

  process.stdout.write(JSON.stringify(evaluateCommand(command)) + "\n");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("irreversible-guard.mjs")) {
  main();
}
