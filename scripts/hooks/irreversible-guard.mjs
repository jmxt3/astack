#!/usr/bin/env node
/**
 * Opt-in PreToolUse guard against irreversible/destructive commands.
 * Enable in astack/hooks.json by setting "enabled": true on "astack-irreversible-guard".
 */
import fs from "node:fs";
import path from "node:path";

const SAFE_NON_DB_VERBS = new Set([
  "rg",
  "ripgrep",
  "grep",
  "egrep",
  "fgrep",
  "ag",
  "ack",
  "select-string",
  "sls",
  "findstr",
  "git",
  "echo",
  "write-output",
  "write-host",
  "printf",
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "less",
  "more",
  "sed",
  "awk",
  "node",
  "pytest",
  "vitest",
  "jest",
]);

const DB_CLI_VERBS = new Set([
  "psql",
  "mysql",
  "mariadb",
  "sqlite3",
  "sqlcmd",
  "mongosh",
  "cockroach",
  "duckdb",
  "clickhouse-client",
  "snowsql",
  "bq",
  "prisma",
  "drizzle-kit",
  "supabase",
  "turso",
  "pscale",
  "planetscale",
  "neonctl",
]);

const RUNNER_VERBS = new Set(["npx", "pnpm", "yarn", "pnpx", "bunx", "uvx", "sudo", "env"]);
const TRUNK_BRANCHES = new Set(["main", "master", "trunk", "prod", "production"]);
const SQL_DESTRUCTIVE_PATTERN = /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i;

const STATIC_SEGMENT_RULES = [
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
    label: "PowerShell recursive root/home delete or disk wipe",
    pattern:
      /\b(?:Remove-Item|ri|del|erase|rd|rmdir)\b(?=[^\n;|&]*(?:-Recurse\b|-r\b))(?=[^\n;|&]*(?:-Force\b|-fo\b))[^\n;|&]*(?:[A-Za-z]:\\(?:\s|$|\*|['"])|~(?:\/|\\|\s|$)|\$HOME\b|\$env:USERPROFILE\b|\/(?:\s|$|\*))|\b(?:Format-Volume|Clear-Disk)\b/i,
  },
  {
    label: "production destroy/deploy",
    pattern:
      /\b(?:kubectl\s+delete|terraform\s+destroy|pulumi\s+destroy|heroku\s+apps:destroy|vercel\s+--prod|flyctl?\s+deploy\b[^\n;|&]*--prod|wrangler\s+deploy\b[^\n;|&]*--env\s+prod)\b/i,
  },
];

function splitShellSegments(command) {
  const segments = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];

    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }

    if (!inSingle && !inDouble) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        if (buf.trim()) segments.push(buf.trim());
        buf = "";
        i++;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r") {
        if (buf.trim()) segments.push(buf.trim());
        buf = "";
        continue;
      }
    }

    buf += ch;
  }

  if (buf.trim()) segments.push(buf.trim());
  return segments;
}

function unescapeDoubleQuoted(text) {
  return text.replace(/\\(["\\])/g, "$1");
}

function unwrapShellInvocation(segment) {
  const envPrefix = String.raw`(?:(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*)(?:&\s+)?`;
  const patterns = [
    new RegExp(String.raw`^${envPrefix}(?:sh|bash|zsh|dash)\b[^|;\n]*?\s-[a-zA-Z]*c\s+(?:"((?:\\.|[^"\\])*)"|'([^']*)')(?:\s+.*)?$`, "i"),
    new RegExp(String.raw`^${envPrefix}(?:pwsh|powershell)(?:\.exe)?\b[^|;\n]*?\s-(?:c|Command)\s+(?:"((?:\\.|[^"\\])*)"|'([^']*)')(?:\s+.*)?$`, "i"),
    new RegExp(String.raw`^${envPrefix}cmd(?:\.exe)?\b[^|;\n]*?\s\/c\s+(?:"([^"]*)"|'([^']*)'|([^\r\n|&;]+))$`, "i"),
    new RegExp(String.raw`^${envPrefix}eval\s+(?:"((?:\\.|[^"\\])*)"|'([^']*)')(?:\s+.*)?$`, "i"),
  ];

  for (const regex of patterns) {
    const match = segment.match(regex);
    if (!match) continue;
    if (match[1] !== undefined) return unescapeDoubleQuoted(match[1]);
    if (match[2] !== undefined) return match[2];
    if (match[3] !== undefined) return match[3].trim();
  }
  return null;
}

function collectLeafSegments(command, depth = 0) {
  const segments = splitShellSegments(command);
  if (depth >= 4) return segments;

  const leaves = [];
  for (const segment of segments) {
    const unwrapped = unwrapShellInvocation(segment);
    if (unwrapped) {
      leaves.push(...collectLeafSegments(unwrapped, depth + 1));
    } else {
      leaves.push(segment);
    }
  }
  return leaves;
}

function tokenizeSimpleWords(segment) {
  const tokens = [];
  const tokenRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = tokenRegex.exec(segment)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function normalizeCommandToken(rawToken) {
  const base = path.win32.basename(rawToken.replace(/\//g, "\\")).toLowerCase();
  return base.replace(/\.exe$/, "");
}

function getLeadingCommandVerbs(segment) {
  const tokens = tokenizeSimpleWords(segment);
  const verbs = [];
  let idx = 0;
  if (tokens[0] === "&") idx++;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) {
    idx++;
  }
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.startsWith("-")) {
      idx++;
      continue;
    }
    const norm = normalizeCommandToken(tok);
    verbs.push(norm);
    if (!RUNNER_VERBS.has(norm)) break;
    idx++;
  }
  return verbs;
}

function isTrunkTargetToken(token) {
  const rhs = token.includes(":") ? token.split(":").slice(1).join(":") : token;
  const cleaned = rhs.replace(/^\+/, "").replace(/^refs\/heads\//i, "").toLowerCase();
  return TRUNK_BRANCHES.has(cleaned);
}

function matchGitPushRule(segment) {
  const verbs = getLeadingCommandVerbs(segment);
  if (!verbs.includes("git")) return false;
  const tokens = tokenizeSimpleWords(segment);
  const pushIdx = tokens.findIndex((t, i) => i > 0 && t.toLowerCase() === "push");
  if (pushIdx === -1) return false;

  const pushArgs = tokens.slice(pushIdx + 1);
  let hasForce = false;
  let hasLease = false;
  let hasDelete = false;
  let hasForceRefspec = false;
  let hasTrunkDeleteRefspec = false;
  let targetsTrunk = false;

  for (const arg of pushArgs) {
    const lower = arg.toLowerCase();
    if (lower === "--force" || lower === "-f") hasForce = true;
    else if (lower === "--force-with-lease" || lower.startsWith("--force-with-lease=") || lower === "--force-if-includes") {
      hasLease = true;
    } else if (lower === "--delete" || lower === "-d") hasDelete = true;
    else if (arg.startsWith("+") && arg.length > 1) hasForceRefspec = true;
    else if (arg.startsWith(":") && isTrunkTargetToken(arg)) hasTrunkDeleteRefspec = true;
    else if (!arg.startsWith("-") && isTrunkTargetToken(arg)) targetsTrunk = true;
  }

  return (
    hasForce ||
    hasForceRefspec ||
    hasTrunkDeleteRefspec ||
    (hasDelete && targetsTrunk) ||
    (hasLease && targetsTrunk)
  );
}

function findDestructiveMatch(command) {
  const leaves = collectLeafSegments(command);
  const hasDbClient = leaves.some((seg) =>
    getLeadingCommandVerbs(seg).some((verb) => DB_CLI_VERBS.has(verb)),
  );

  for (const segment of leaves) {
    if (matchGitPushRule(segment)) {
      return "git push force or trunk deletion";
    }
    for (const rule of STATIC_SEGMENT_RULES) {
      if (rule.pattern.test(segment)) {
        return rule.label;
      }
    }
    if (SQL_DESTRUCTIVE_PATTERN.test(segment)) {
      const verbs = getLeadingCommandVerbs(segment);
      const isSafeNonDb = verbs.length > 0 && verbs.every((verb) => SAFE_NON_DB_VERBS.has(verb));
      if (hasDbClient || !isSafeNonDb) {
        return "SQL DROP/TRUNCATE";
      }
    }
  }
  return null;
}

export function evaluateCommand(command, { headless } = {}) {
  if (typeof command !== "string" || command.trim() === "") {
    return { decision: "allow" };
  }
  const matchedLabel = findDestructiveMatch(command);
  if (!matchedLabel) {
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
      ? `AStack irreversible-guard: blocked potentially destructive command in headless mode (${matchedLabel}).`
      : `AStack irreversible-guard: matched potentially destructive command (${matchedLabel}). Confirm before executing.`,
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
