import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isHeadless, parseHookPayload } from "./envelope.mjs";

export const DEFAULT_RISK_POLICY = {
  schemaVersion: 1,
  defaultTier: 1,
  allowTier0AutoMerge: false,
  maxReviewRounds: 3,
  maxAssertionWeakeningRatio: 0.25,
  humanGates: {
    planApproval: "nontrivial",
    prReview: "always",
  },
  tiers: {
    "0": {
      label: "low",
      description: "Documentation, markdown, and standalone test-only updates",
      globs: ["**/*.md", "**/*.txt", "docs/**", ".github/ISSUE_TEMPLATE/**"],
      requireHumanApproval: false,
    },
    "1": {
      label: "medium",
      description: "Standard feature, UI, or skill updates",
      globs: ["skills/**", "src/**", "app/**"],
      requireHumanApproval: true,
    },
    "2": {
      label: "high",
      description: "Core modules, schemas, public APIs, or configuration",
      globs: ["scripts/**", "agents/**", "rules/**", "package.json", "plugin.json"],
      requireHumanApproval: true,
    },
    "3": {
      label: "critical",
      description: "Auth, billing, migrations, hooks, CI workflows, and security policy",
      globs: [
        "hooks.json",
        "scripts/hooks/**",
        "scripts/trust/**",
        ".github/workflows/**",
        "**/*auth*",
        "**/*billing*",
        "**/*payment*",
        "**/*migration*",
        "**/security*/**",
      ],
      requireHumanApproval: true,
    },
  },
};

const TEST_PATH_ALLOWLIST =
  /(?:^|[\\/])(?:tests?|fixtures?|__tests__|mocks?)(?:[\\/]|$)|\.(?:test|spec)\.[jtcm]?[jt]sx?$/i;
const ENV_SHELL_ACTION =
  /\b(?:git\s+add|cp|copy|scp|curl\s+[^\n;|&]*-d|cat|type|Get-Content)\b[^\n;|&]*?(?:\.env(?:\.[a-z]+)?|id_rsa|id_ed25519|\.npmrc|\.pypirc)\b/i;

const SECRET_PATTERNS = [
  { label: "PEM private key", regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { label: "GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "AWS access key", regex: /\bAKIA(?!IOSFODNN7EXAMPLE\b)[0-9A-Z]{16}\b/ },
  { label: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: "Slack token", regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { label: "LLM API key", regex: /\bsk-(?:proj|ant)-[A-Za-z0-9_-]{20,}\b/ },
];

const SAFE_NON_DB_VERBS = new Set([
  "rg", "ripgrep", "grep", "egrep", "fgrep", "ag", "ack", "select-string", "sls",
  "findstr", "git", "echo", "write-output", "write-host", "printf", "cat", "type",
  "get-content", "gc", "head", "tail", "less", "more", "sed", "awk", "node",
  "pytest", "vitest", "jest",
]);

const DB_CLI_VERBS = new Set([
  "psql", "mysql", "mariadb", "sqlite3", "sqlcmd", "mongosh", "cockroach",
  "duckdb", "clickhouse-client", "snowsql", "bq", "prisma", "drizzle-kit",
  "supabase", "turso", "pscale", "planetscale", "neonctl",
]);

const RUNNER_VERBS = new Set(["npx", "pnpm", "yarn", "pnpx", "bunx", "uvx", "sudo", "env"]);
const TRUNK_BRANCHES = new Set(["main", "master", "trunk", "prod", "production"]);
const SQL_DESTRUCTIVE_PATTERN = /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i;

const STATIC_SEGMENT_RULES = [
  { label: "git reset --hard", pattern: /\bgit\s+reset\s+--hard\b/i },
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

/**
 * Compiles a repo-relative glob pattern (`**`, `*`, `?`, `{a,b}`) into an anchored RegExp.
 */
export function globToRegex(glob) {
  const normalized = String(glob ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === "*" && next === "*") {
      if (normalized[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
      continue;
    }
    if (ch === "*") {
      re += "[^/]*";
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    if (ch === "{") {
      const end = normalized.indexOf("}", i + 1);
      if (end !== -1) {
        const parts = normalized
          .slice(i + 1, end)
          .split(",")
          .map((p) => p.replace(/[.+^$|()[\]\\]/g, "\\$&"));
        re += `(?:${parts.join("|")})`;
        i = end;
        continue;
      }
    }
    if (/[.+^$|()[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      continue;
    }
    re += ch;
  }
  re += "$";
  return new RegExp(re);
}

/**
 * Returns true if `relPath` matches any glob pattern in `globs`.
 */
export function matchesAnyGlob(relPath, globs = []) {
  const clean = String(relPath ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
  return globs.some((g) => globToRegex(g).test(clean));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return { present: false, data: null, error: null };
  try {
    return {
      present: true,
      data: JSON.parse(fs.readFileSync(filePath, "utf8")),
      error: null,
    };
  } catch (err) {
    return { present: true, data: null, error: err.message };
  }
}

/**
 * Loads `.agents/risk-policy.json` if present, merging cleanly onto `DEFAULT_RISK_POLICY`.
 */
export function loadRiskPolicy(workspaceDir) {
  if (!workspaceDir) {
    return { present: false, path: null, policy: structuredClone(DEFAULT_RISK_POLICY) };
  }
  const filePath = path.join(workspaceDir, ".agents", "risk-policy.json");
  const res = readJsonIfExists(filePath);
  if (!res.present || !res.data || typeof res.data !== "object") {
    return { present: res.present, path: filePath, policy: structuredClone(DEFAULT_RISK_POLICY), error: res.error };
  }
  const custom = res.data;
  const mergedTiers = { ...DEFAULT_RISK_POLICY.tiers };
  if (custom.tiers && typeof custom.tiers === "object") {
    for (const [k, v] of Object.entries(custom.tiers)) {
      if (v && typeof v === "object") {
        mergedTiers[k] = { ...(mergedTiers[k] ?? {}), ...v };
      }
    }
  }
  return {
    present: true,
    path: filePath,
    error: null,
    policy: {
      ...DEFAULT_RISK_POLICY,
      ...custom,
      humanGates: {
        ...DEFAULT_RISK_POLICY.humanGates,
        ...(custom.humanGates ?? {}),
      },
      tiers: mergedTiers,
    },
  };
}

/**
 * Loads `.agents/boundaries.json` if present in `workspaceDir`.
 */
export function loadBoundaries(workspaceDir) {
  if (!workspaceDir) return { present: false, path: null, boundaries: null };
  const filePath = path.join(workspaceDir, ".agents", "boundaries.json");
  const res = readJsonIfExists(filePath);
  return {
    present: res.present,
    path: filePath,
    boundaries: res.data && typeof res.data === "object" ? res.data : null,
    error: res.error,
  };
}

function tryGit(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/**
 * Resolves the authoritative base ref for PR/base-branch reads without failing on detached or single-branch repos.
 */
export function resolveBaseRef(workspaceDir, explicitBase) {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) return null;
  if (explicitBase) {
    const ok = tryGit(workspaceDir, ["rev-parse", "--verify", explicitBase]);
    if (ok !== null) return explicitBase;
  }
  for (const candidate of ["origin/main", "main", "origin/master", "master", "HEAD~1", "HEAD"]) {
    const ok = tryGit(workspaceDir, ["rev-parse", "--verify", candidate]);
    if (ok !== null) return candidate;
  }
  return null;
}

/**
 * Reads `REVIEW.md` and `GLOSSARY.md` strictly from the base git ref so a PR cannot weaken its own review rules.
 */
export function readBaseReviewContext(workspaceDir, explicitBase) {
  const baseRef = resolveBaseRef(workspaceDir, explicitBase);
  if (!baseRef) {
    return {
      baseRef: null,
      reviewMd: { present: false, content: "", blobSha: null, modifiedInPr: false },
      glossaryMd: { present: false, content: "", blobSha: null, modifiedInPr: false },
    };
  }

  const changed = new Set(
    (tryGit(workspaceDir, ["diff", "--name-only", `${baseRef}...HEAD`]) ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const line of (tryGit(workspaceDir, ["status", "--porcelain"]) ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rel = trimmed.replace(/^[MADRCU?!]{1,2}\s+/, "").trim();
    if (rel) changed.add(rel);
  }

  const readBaseFile = (relPath) => {
    const content = tryGit(workspaceDir, ["show", `${baseRef}:${relPath}`]);
    if (content === null) {
      return { present: false, content: "", blobSha: null, modifiedInPr: changed.has(relPath) };
    }
    const blobSha = tryGit(workspaceDir, ["rev-parse", `${baseRef}:${relPath}`])?.trim() ?? null;
    return { present: true, content, blobSha, modifiedInPr: changed.has(relPath) };
  };

  return {
    baseRef,
    reviewMd: readBaseFile("REVIEW.md"),
    glossaryMd: readBaseFile("GLOSSARY.md"),
  };
}

/**
 * Formats Antigravity SessionStart `injectSteps` carrying base-branch `REVIEW.md` and `GLOSSARY.md`.
 */
export function evaluateSessionContext(event) {
  if (!event || !event.workspaceDir) return {};
  const ctx = readBaseReviewContext(event.workspaceDir);
  if (!ctx.reviewMd.present && !ctx.glossaryMd.present) {
    return {};
  }

  const parts = [`Loaded base-branch (${ctx.baseRef}) governance context:`];
  if (ctx.reviewMd.present) {
    parts.push(`\n## Base-branch REVIEW.md\n${ctx.reviewMd.content.slice(0, 3500)}`);
    if (ctx.reviewMd.modifiedInPr) {
      parts.push("\nWARNING: Working branch edits REVIEW.md. Evaluate strictly against base-branch REVIEW.md.");
    }
  }
  if (ctx.glossaryMd.present) {
    parts.push(`\n## Base-branch GLOSSARY.md\n${ctx.glossaryMd.content.slice(0, 2500)}`);
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: parts.join("\n").trim(),
        },
      },
    ],
  };
}

/**
 * Evaluates secret leaks and direct `.env` writes across CLI and App/IDE tool payloads.
 */
export function evaluateSecrets(payloadOrEvent, { headless } = {}) {
  if (!payloadOrEvent || typeof payloadOrEvent !== "object") {
    return { decision: "allow" };
  }
  const event =
    payloadOrEvent.kind === "tool-write" || payloadOrEvent.kind === "tool-command"
      ? payloadOrEvent
      : parseHookPayload(payloadOrEvent, "pre");

  if (!event) return { decision: "allow" };

  const filePath = event.kind === "tool-write" ? event.filePath : "";
  const chunks = event.kind === "tool-write" ? event.chunks : [];
  const command = event.kind === "tool-command" ? event.command : "";
  const joinedChunks = chunks.join("\n");

  if (filePath && TEST_PATH_ALLOWLIST.test(filePath)) {
    return { decision: "allow" };
  }
  if (joinedChunks.includes("astack-secret-guard: allow-fixture")) {
    return { decision: "allow" };
  }

  let matched = null;
  if (event.kind === "tool-command") {
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
  } else if (event.kind === "tool-write") {
    const normalizedPath = filePath.replace(/\\/g, "/");
    if (/(?:^|\/)\.env(?:\.[^/]+)?$/i.test(normalizedPath) && !/\.example$/i.test(normalizedPath)) {
      matched = "direct .env secret file write";
    } else if (joinedChunks) {
      for (const rule of SECRET_PATTERNS) {
        if (rule.regex.test(joinedChunks)) {
          matched = rule.label;
          break;
        }
      }
    }
  }

  if (!matched) return { decision: "allow" };

  const nonInteractive = headless ?? isHeadless();
  return {
    decision: nonInteractive ? "deny" : "force_ask",
    reason: nonInteractive
      ? `AStack secret-guard: blocked potential credential leak in headless mode (${matched}).`
      : `AStack secret-guard: matched potential credential pattern (${matched}). Confirm before proceeding.`,
  };
}

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
    if (match[1] !== undefined) return match[1].replace(/\\(["\\])/g, "$1");
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

function getLeadingCommandVerbs(segment) {
  const tokens = tokenizeSimpleWords(segment);
  const verbs = [];
  let idx = 0;
  if (tokens[0] === "&") idx++;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.startsWith("-")) {
      idx++;
      continue;
    }
    const base = path.win32.basename(tok.replace(/\//g, "\\")).toLowerCase().replace(/\.exe$/, "");
    verbs.push(base);
    if (!RUNNER_VERBS.has(base)) break;
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
  if (!getLeadingCommandVerbs(segment).includes("git")) return false;
  const tokens = tokenizeSimpleWords(segment);
  const pushIdx = tokens.findIndex((t, i) => i > 0 && t.toLowerCase() === "push");
  if (pushIdx === -1) return false;

  let hasForce = false;
  let hasLease = false;
  let hasDelete = false;
  let hasForceRefspec = false;
  let hasTrunkDeleteRefspec = false;
  let targetsTrunk = false;

  for (const arg of tokens.slice(pushIdx + 1)) {
    const lower = arg.toLowerCase();
    if (lower === "--force" || lower === "-f") hasForce = true;
    else if (lower === "--force-with-lease" || lower.startsWith("--force-with-lease=") || lower === "--force-if-includes") hasLease = true;
    else if (lower === "--delete" || lower === "-d") hasDelete = true;
    else if (arg.startsWith("+") && arg.length > 1) hasForceRefspec = true;
    else if (arg.startsWith(":") && isTrunkTargetToken(arg)) hasTrunkDeleteRefspec = true;
    else if (!arg.startsWith("-") && isTrunkTargetToken(arg)) targetsTrunk = true;
  }

  return hasForce || hasForceRefspec || hasTrunkDeleteRefspec || (hasDelete && targetsTrunk) || (hasLease && targetsTrunk);
}

function findDestructiveMatch(command) {
  const leaves = collectLeafSegments(command);
  const hasDbClient = leaves.some((seg) =>
    getLeadingCommandVerbs(seg).some((verb) => DB_CLI_VERBS.has(verb)),
  );
  for (const segment of leaves) {
    if (matchGitPushRule(segment)) return "git push force or trunk deletion";
    for (const rule of STATIC_SEGMENT_RULES) {
      if (rule.pattern.test(segment)) return rule.label;
    }
    if (SQL_DESTRUCTIVE_PATTERN.test(segment)) {
      const verbs = getLeadingCommandVerbs(segment);
      const isSafeNonDb = verbs.length > 0 && verbs.every((verb) => SAFE_NON_DB_VERBS.has(verb));
      if (hasDbClient || !isSafeNonDb) return "SQL DROP/TRUNCATE";
    }
  }
  return null;
}

/**
 * Evaluates shell commands against destructive, trunk-clobbering, and SQL drop rules.
 */
export function evaluateIrreversible(commandOrEvent, { headless } = {}) {
  const command =
    typeof commandOrEvent === "string"
      ? commandOrEvent
      : commandOrEvent?.kind === "tool-command"
        ? commandOrEvent.command
        : "";
  if (typeof command !== "string" || command.trim() === "") {
    return { decision: "allow" };
  }
  const matchedLabel = findDestructiveMatch(command);
  if (!matchedLabel) return { decision: "allow" };

  const nonInteractive = headless ?? isHeadless();
  return {
    decision: nonInteractive ? "deny" : "force_ask",
    reason: nonInteractive
      ? `AStack irreversible-guard: blocked potentially destructive command in headless mode (${matchedLabel}).`
      : `AStack irreversible-guard: matched potentially destructive command (${matchedLabel}). Confirm before executing.`,
  };
}

/**
 * Extracts static ESM/CJS import/require specifiers with 1-based line numbers.
 */
export function extractImportSpecifiers(sourceText) {
  const results = [];
  const lines = String(sourceText ?? "").split(/\r?\n/);
  const importRegex = /(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\/\//.test(line)) continue;
    importRegex.lastIndex = 0;
    let m;
    while ((m = importRegex.exec(line)) !== null) {
      results.push({ specifier: m[1], line: i + 1 });
    }
  }
  return results;
}

/**
 * Resolves a relative import specifier from `fromRelPath` to a repo-relative POSIX path.
 */
export function resolveRelativeImportPath(fromRelPath, specifier) {
  if (!specifier || !specifier.startsWith(".")) return null;
  const fromDir = path.posix.dirname(String(fromRelPath).replace(/\\/g, "/"));
  return path.posix.normalize(path.posix.join(fromDir, specifier));
}

function fileMatchesZone(relPath, zoneSpec) {
  if (!zoneSpec || !Array.isArray(zoneSpec.include)) return false;
  if (!matchesAnyGlob(relPath, zoneSpec.include)) return false;
  if (Array.isArray(zoneSpec.exclude) && matchesAnyGlob(relPath, zoneSpec.exclude)) {
    return false;
  }
  return true;
}

/**
 * Checks a pending file edit against `.agents/boundaries.json` importRules and bannedPatterns.
 */
export function evaluateBoundaryViolation({ relPath, content, boundaries }) {
  if (!boundaries || !relPath) return null;
  const normalizedPath = String(relPath).replace(/\\/g, "/").replace(/^\.\//, "");
  const zones = boundaries.zones ?? {};

  if (Array.isArray(boundaries.importRules)) {
    const imports = extractImportSpecifiers(content);
    for (const rule of boundaries.importRules) {
      if (Array.isArray(rule.allowPaths) && matchesAnyGlob(normalizedPath, rule.allowPaths)) {
        continue;
      }
      const matchesSource = rule.from
        ? zones[rule.from]
          ? fileMatchesZone(normalizedPath, zones[rule.from])
          : matchesAnyGlob(normalizedPath, [rule.from])
        : true;
      if (!matchesSource) continue;

      const forbiddenZones = Array.isArray(rule.forbidImportFrom) ? rule.forbidImportFrom : [];
      for (const imp of imports) {
        const resolved = resolveRelativeImportPath(normalizedPath, imp.specifier);
        for (const targetName of forbiddenZones) {
          const targetZone = zones[targetName];
          const hitsZone = targetZone
            ? resolved && fileMatchesZone(resolved, targetZone)
            : matchesAnyGlob(resolved ?? imp.specifier, [targetName]);
          if (!hitsZone) continue;

          const publicEntries = targetZone?.publicEntry ?? [];
          if (resolved && publicEntries.some((entry) => resolved === entry || matchesAnyGlob(resolved, [entry]))) {
            continue;
          }
          return `${rule.id ?? "boundary"}: ${normalizedPath}:${imp.line} imports forbidden target "${imp.specifier}" (${rule.reason ?? "boundary violation"})`;
        }
      }
    }
  }

  if (Array.isArray(boundaries.bannedPatterns)) {
    const lines = String(content ?? "").split(/\r?\n/);
    for (const pat of boundaries.bannedPatterns) {
      if (Array.isArray(pat.fileGlobs) && !matchesAnyGlob(normalizedPath, pat.fileGlobs)) {
        continue;
      }
      if (Array.isArray(pat.allowGlobs) && matchesAnyGlob(normalizedPath, pat.allowGlobs)) {
        continue;
      }
      if (!pat.regex) continue;
      let re;
      try {
        re = new RegExp(pat.regex, pat.flags ?? "");
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          return `${pat.id ?? "banned-pattern"}: ${normalizedPath}:${i + 1} matched banned pattern (${pat.reason ?? pat.regex})`;
        }
      }
    }
  }

  return null;
}

/**
 * Evaluates a `PreToolUse` write payload against `.agents/boundaries.json`.
 */
export function evaluateBoundaryWrite(event, options = {}) {
  if (!event || event.kind !== "tool-write" || !event.filePath) {
    return { decision: "allow" };
  }
  const boundaries = options.boundaries ?? loadBoundaries(event.workspaceDir).boundaries;
  if (!boundaries) return { decision: "allow" };

  const relPath = event.workspaceDir
    ? path.relative(path.resolve(event.workspaceDir), path.resolve(event.workspaceDir, event.filePath)).split(path.sep).join("/")
    : event.filePath.replace(/\\/g, "/");
  if (relPath.startsWith("..")) return { decision: "allow" };

  const violation = evaluateBoundaryViolation({
    relPath,
    content: event.chunks.join("\n"),
    boundaries,
  });
  if (!violation) return { decision: "allow" };

  const nonInteractive = options.headless ?? isHeadless();
  return {
    decision: nonInteractive ? "deny" : "force_ask",
    reason: nonInteractive
      ? `AStack boundary-guard: blocked boundary violation in headless mode (${violation}).`
      : `AStack boundary-guard: ${violation}.`,
  };
}

const ASSERTION_LINE_REGEX =
  /\b(?:assert(?:\.[A-Za-z0-9_]+)?\s*\(|expect\s*\(|should\.|t\.(?:equal|deepEqual|ok|truthy|throws|rejects)\s*\(|assert\s+)/;

/**
 * Computes added vs removed test assertions from unified git diff text and flags silent weakening.
 */
export function computeAssertionDelta(diffText, maxWeakeningRatio = 0.25) {
  let added = 0;
  let removed = 0;
  let currentFile = "";
  const perFile = new Map();

  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      currentFile = m ? m[1] : "";
      continue;
    }
    if (!currentFile || line.startsWith("+++") || line.startsWith("---")) continue;
    if (!TEST_PATH_ALLOWLIST.test(currentFile) && !/\.(?:test|spec)\./i.test(currentFile)) {
      continue;
    }
    if (!ASSERTION_LINE_REGEX.test(line.slice(1))) continue;

    const stats = perFile.get(currentFile) ?? { added: 0, removed: 0 };
    if (line.startsWith("+")) {
      added++;
      stats.added++;
    } else if (line.startsWith("-")) {
      removed++;
      stats.removed++;
    }
    perFile.set(currentFile, stats);
  }

  const total = added + removed;
  const weakeningRatio = removed > 0 && total > 0 ? Number((removed / total).toFixed(3)) : 0;
  const flaggedFiles = [];
  for (const [file, stats] of perFile.entries()) {
    const fileTotal = stats.added + stats.removed;
    const ratio = fileTotal > 0 ? stats.removed / fileTotal : 0;
    if (stats.removed > stats.added && ratio > maxWeakeningRatio) {
      flaggedFiles.push(file);
    }
  }
  const flagged = removed > added && weakeningRatio > maxWeakeningRatio;
  return { added, removed, weakeningRatio, flagged, flaggedFiles };
}
