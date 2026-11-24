import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHeadless, parseHookPayload } from "./envelope.mjs";
import { resolveWorkspaceScope as resolveWorkspaceScopeBase } from "./workspace-scope.mjs";

export const DEFAULT_ENGINEERING_MCP_SERVERS = [
  "github-mcp-server",
  "astack_trust",
  "chrome-devtools-mcp",
];

export const DEFAULT_RISK_POLICY = {
  schemaVersion: 1,
  defaultTier: 1,
  allowTier0AutoMerge: false,
  maxReviewRounds: 3,
  maxAssertionWeakeningRatio: 0.25,
  engineeringMcpServers: [...DEFAULT_ENGINEERING_MCP_SERVERS],
  autonomy: {
    defaultCeiling: 2,
    promotion: null,
    auditSampleRate: 5,
    maxBrierScore: 0.12,
    ceilings: {
      docs: 3,
      tests: 3,
      ui: 3,
      skills: 3,
      tooling: 3,
      core: 3,
      governance: 2,
    },
  },
  humanGates: {
    planApproval: "nontrivial",
    prReview: "always",
  },
  prDescriptionContract: {
    enabled: false,
    requireStatechart: true,
    requireProofTable: true,
    forbidLocalLinks: true,
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
        ".agents/**",
        "REVIEW.md",
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

function mergeRiskPolicy(custom) {
  const mergedTiers = { ...DEFAULT_RISK_POLICY.tiers };
  if (custom.tiers && typeof custom.tiers === "object") {
    for (const [k, v] of Object.entries(custom.tiers)) {
      if (v && typeof v === "object") {
        mergedTiers[k] = { ...(mergedTiers[k] ?? {}), ...v };
      }
    }
  }
  const engineeringMcpServers = Array.isArray(custom.engineeringMcpServers)
    ? [...new Set(custom.engineeringMcpServers.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))]
    : [...DEFAULT_RISK_POLICY.engineeringMcpServers];
  const mergedCeilings = {
    ...DEFAULT_RISK_POLICY.autonomy.ceilings,
    ...(custom.autonomy?.ceilings && typeof custom.autonomy.ceilings === "object"
      ? custom.autonomy.ceilings
      : {}),
  };
  const rawGov = Number(mergedCeilings.governance);
  mergedCeilings.governance = Number.isFinite(rawGov) ? Math.max(1, Math.min(2, Math.floor(rawGov))) : 2;
  const mergedAutonomy = {
    ...DEFAULT_RISK_POLICY.autonomy,
    ...(custom.autonomy && typeof custom.autonomy === "object" ? custom.autonomy : {}),
    ceilings: mergedCeilings,
  };
  return {
    ...DEFAULT_RISK_POLICY,
    ...custom,
    engineeringMcpServers,
    autonomy: mergedAutonomy,
    humanGates: {
      ...DEFAULT_RISK_POLICY.humanGates,
      ...(custom.humanGates ?? {}),
    },
    prDescriptionContract: {
      ...DEFAULT_RISK_POLICY.prDescriptionContract,
      ...(custom.prDescriptionContract && typeof custom.prDescriptionContract === "object"
        ? custom.prDescriptionContract
        : {}),
    },
    tiers: mergedTiers,
  };
}

/**
 * Loads `.agents/risk-policy.json` (from `baseRef` when supplied, otherwise workspace disk), merging onto `DEFAULT_RISK_POLICY`.
 */
export function loadRiskPolicy(workspaceDir, options = {}) {
  if (!workspaceDir) {
    return { present: false, path: null, policy: structuredClone(DEFAULT_RISK_POLICY) };
  }
  const hasBaseRefOption = options && Object.hasOwn(options, "baseRef");
  if (hasBaseRefOption) {
    if (!options.baseRef) {
      return { present: false, path: ".agents/risk-policy.json", policy: structuredClone(DEFAULT_RISK_POLICY), error: null };
    }
    const raw = tryGit(workspaceDir, ["show", `${options.baseRef}:.agents/risk-policy.json`]);
    if (raw === null) {
      return { present: false, path: ".agents/risk-policy.json", policy: structuredClone(DEFAULT_RISK_POLICY), error: null };
    }
    try {
      const custom = JSON.parse(raw);
      if (!custom || typeof custom !== "object") {
        return { present: true, path: ".agents/risk-policy.json", policy: structuredClone(DEFAULT_RISK_POLICY), error: null };
      }
      return {
        present: true,
        path: ".agents/risk-policy.json",
        error: null,
        policy: mergeRiskPolicy(custom),
      };
    } catch (err) {
      return { present: true, path: ".agents/risk-policy.json", policy: structuredClone(DEFAULT_RISK_POLICY), error: err.message };
    }
  }

  const filePath = path.join(workspaceDir, ".agents", "risk-policy.json");
  const res = readJsonIfExists(filePath);
  if (!res.present || !res.data || typeof res.data !== "object") {
    return { present: res.present, path: filePath, policy: structuredClone(DEFAULT_RISK_POLICY), error: res.error };
  }
  return {
    present: true,
    path: filePath,
    error: null,
    policy: mergeRiskPolicy(res.data),
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

function unquoteGitPath(rawPath) {
  const trimmed = String(rawPath ?? "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/**
 * Extracts normalized repo-relative paths from `git status --porcelain` lines without clipping status columns.
 */
export function parsePorcelainPaths(statusText) {
  const paths = [];
  for (const line of String(statusText ?? "").split(/\r?\n/)) {
    if (line.length < 4) continue;
    const raw = line.slice(3).trim();
    if (!raw) continue;
    const arrowIdx = raw.indexOf(" -> ");
    if (arrowIdx !== -1) {
      const oldPath = unquoteGitPath(raw.slice(0, arrowIdx)).replace(/\\/g, "/");
      const newPath = unquoteGitPath(raw.slice(arrowIdx + 4)).replace(/\\/g, "/");
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      const clean = unquoteGitPath(raw).replace(/\\/g, "/");
      if (clean) paths.push(clean);
    }
  }
  return paths;
}

/**
 * Reads `REVIEW.md` and `GLOSSARY.md` strictly from the base git ref so a PR cannot weaken its own review rules.
 */
export function readBaseReviewContext(workspaceDir, explicitBase, headRef = "HEAD") {
  const baseRef = resolveBaseRef(workspaceDir, explicitBase);
  if (!baseRef) {
    return {
      baseRef: null,
      reviewMd: { present: false, content: "", blobSha: null, modifiedInPr: false },
      glossaryMd: { present: false, content: "", blobSha: null, modifiedInPr: false },
      riskPolicy: { present: false, content: "", blobSha: null, modifiedInPr: false },
    };
  }

  const changed = new Set(
    (
      tryGit(workspaceDir, [
        "-c",
        "core.quotepath=false",
        "diff",
        "--name-only",
        "--no-renames",
        `${baseRef}...${headRef}`,
      ]) ?? ""
    )
      .split(/\r?\n/)
      .map((s) => unquoteGitPath(s).replace(/\\/g, "/"))
      .filter(Boolean),
  );
  if (headRef === "HEAD") {
    const statusText =
      tryGit(workspaceDir, ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"]) ?? "";
    for (const rel of parsePorcelainPaths(statusText)) {
      changed.add(rel);
    }
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
    riskPolicy: readBaseFile(".agents/risk-policy.json"),
  };
}

function detectEnabledTimelineSidecar({ artifactDir = "", configPath = null } = {}) {
  if (!artifactDir || !/(?:^|[\\/])antigravity[\\/]brain(?:[\\/]|$)/i.test(artifactDir)) {
    return false;
  }
  const cfgPath = configPath || path.join(os.homedir(), ".gemini", "config", "config.json");
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    const entry = cfg?.sidecars?.["astack/astack_timeline"];
    if (!entry || typeof entry !== "object") return false;
    if (entry.enabled === false) return false;
    return entry.enabled === true || (entry.resolvedPermissions !== null && entry.resolvedPermissions !== undefined);
  } catch {
    return false;
  }
}

/**
 * Resolves `WorkspaceScope` with tamper-resistant base-branch enrollment detection unless `checkEnrollment: false`.
 */
export function resolveEnrolledWorkspaceScope(workspaceDir, options = {}) {
  if (options.checkEnrollment === false) {
    return resolveWorkspaceScopeBase(workspaceDir, { checkEnrollment: false });
  }
  return resolveWorkspaceScopeBase(workspaceDir, {
    ...options,
    checkEnrollment: true,
    policyLoader:
      options.policyLoader ??
      ((repoRoot, explicitBase) => {
        const baseRef = resolveBaseRef(repoRoot, explicitBase);
        if (!baseRef) return { present: false, baseRef: null, error: null };
        const loaded = loadRiskPolicy(repoRoot, { baseRef });
        return { present: loaded.present, baseRef, error: loaded.error ?? null };
      }),
  });
}

/**
 * Formats Antigravity SessionStart `injectSteps` carrying base-branch governance context and optional AStack Timeline pill guidance.
 */
export function evaluateSessionContext(event, options = {}) {
  if (!event) return {};
  const scope = resolveWorkspaceScopeBase(event.workspaceDir, { checkEnrollment: false });
  if (scope.kind === "non_repo") return {};
  const timelineEnabled = detectEnabledTimelineSidecar({
    artifactDir: event.artifactDir,
    configPath: options.configPath,
  });
  const ctx = readBaseReviewContext(event.workspaceDir);
  const hasGovernance = ctx.reviewMd.present || ctx.glossaryMd.present || ctx.riskPolicy?.modifiedInPr;
  if (!hasGovernance && !timelineEnabled) {
    return {};
  }

  const parts = [];
  if (hasGovernance) {
    parts.push(`Loaded base-branch (${ctx.baseRef}) governance context:`);
    if (ctx.reviewMd.present) {
      parts.push(`\n## Base-branch REVIEW.md\n${ctx.reviewMd.content.slice(0, 3500)}`);
      if (ctx.reviewMd.modifiedInPr) {
        parts.push("\nWARNING: Working branch edits REVIEW.md. Evaluate strictly against base-branch REVIEW.md.");
      }
    }
    if (ctx.riskPolicy?.modifiedInPr) {
      parts.push("\nWARNING: Working branch edits .agents/risk-policy.json. Evaluate strictly against base-branch risk policy.");
    }
    if (ctx.glossaryMd.present) {
      parts.push(`\n## Base-branch GLOSSARY.md\n${ctx.glossaryMd.content.slice(0, 2500)}`);
    }
  }
  if (timelineEnabled) {
    parts.push(
      "AStack Timeline sidecar is enabled in this Antigravity App session. End your first AStack workflow reply (or a plan or PR review gate reply if not yet shown) with `[AStack Timeline](sidecar://astack/astack_timeline/)` on its own line. Do not repeat the pill on follow-up turns once shown.",
    );
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

export function collectLeafSegments(command, depth = 0) {
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

export function tokenizeSimpleWords(segment) {
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

function stripCommentsPreservingLines(sourceText) {
  const text = String(sourceText ?? "");
  const out = [];
  let mode = "normal";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (mode === "lineComment") {
      if (ch === "\n") {
        mode = "normal";
        out.push("\n");
      } else if (ch === "\r") {
        out.push("\r");
      } else {
        out.push(" ");
      }
      continue;
    }

    if (mode === "blockComment") {
      if (ch === "*" && next === "/") {
        mode = "normal";
        out.push("  ");
        i++;
      } else if (ch === "\n" || ch === "\r") {
        out.push(ch);
      } else {
        out.push(" ");
      }
      continue;
    }

    if (mode === "singleQuote" || mode === "doubleQuote" || mode === "template") {
      out.push(ch);
      if (ch === "\\" && next !== undefined) {
        out.push(next);
        i++;
        continue;
      }
      if (
        (mode === "singleQuote" && ch === "'") ||
        (mode === "doubleQuote" && ch === '"') ||
        (mode === "template" && ch === "`")
      ) {
        mode = "normal";
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      mode = "lineComment";
      out.push("  ");
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      mode = "blockComment";
      out.push("  ");
      i++;
      continue;
    }
    if (ch === "'") {
      mode = "singleQuote";
    } else if (ch === '"') {
      mode = "doubleQuote";
    } else if (ch === "`") {
      mode = "template";
    }
    out.push(ch);
  }

  return out.join("");
}

/**
 * Extracts static and dynamic ESM/CJS import/require specifiers with 1-based line numbers.
 */
export function extractImportSpecifiers(sourceText) {
  const stripped = stripCommentsPreservingLines(sourceText);
  const results = [];
  const importRegex =
    /\bimport\s+(?:type\s+)?(?:\*\s+as\s+\w+|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+))?)\s+from\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s*["']([^"']+)["']|(?<![.\w$])(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;

  let m;
  let lastIdx = 0;
  let line = 1;
  while ((m = importRegex.exec(stripped)) !== null) {
    for (let i = lastIdx; i < m.index; i++) {
      if (stripped.charCodeAt(i) === 10) line++;
    }
    lastIdx = m.index;
    const specifier = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (specifier) {
      results.push({ specifier, line });
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

function stripScriptExt(relPath) {
  return String(relPath ?? "").replace(/\.(?:[cm]?[jt]sx?)$/i, "");
}

function matchesPublicEntry(resolved, entry) {
  if (!resolved || !entry) return false;
  if (resolved === entry || matchesAnyGlob(resolved, [entry])) return true;
  const cleanResolved = stripScriptExt(resolved);
  const cleanEntry = stripScriptExt(entry);
  return cleanResolved === cleanEntry || `${cleanResolved}/index` === cleanEntry;
}

/**
 * Collects all `.agents/boundaries.json` importRules and bannedPatterns violations for a file.
 */
export function evaluateBoundaryViolations({ relPath, content, boundaries }) {
  const hits = [];
  if (!boundaries || !relPath) return hits;
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
          if (resolved && publicEntries.some((entry) => matchesPublicEntry(resolved, entry))) {
            continue;
          }
          hits.push({
            kind: "import",
            detail: `${rule.id ?? "boundary"}: ${normalizedPath}:${imp.line} imports forbidden target "${imp.specifier}" (${rule.reason ?? "boundary violation"})`,
          });
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
        const flags = String(pat.flags ?? "").replace(/[gy]/g, "");
        re = new RegExp(pat.regex, flags);
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({
            kind: "banned",
            detail: `${pat.id ?? "banned-pattern"}: ${normalizedPath}:${i + 1} matched banned pattern (${pat.reason ?? pat.regex})`,
          });
        }
      }
    }
  }

  return hits;
}

/**
 * Checks a pending file edit against `.agents/boundaries.json` importRules and bannedPatterns.
 */
export function evaluateBoundaryViolation({ relPath, content, boundaries }) {
  return evaluateBoundaryViolations({ relPath, content, boundaries })[0]?.detail ?? null;
}

/**
 * Evaluates a `PreToolUse` write payload against `.agents/boundaries.json`.
 */
export function evaluateBoundaryWrite(event, options = {}) {
  if (!event || event.kind !== "tool-write" || !event.filePath) {
    return { decision: "allow" };
  }
  if (!options.boundaries) {
    const scope = resolveWorkspaceScopeBase(event.workspaceDir, { checkEnrollment: false });
    if (scope.kind === "non_repo") return { decision: "allow" };
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
  let pendingGitFile = "";
  let inHeader = false;
  const perFile = new Map();

  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      pendingGitFile = m ? unquoteGitPath(m[1]).replace(/\\/g, "/") : "";
      currentFile = pendingGitFile;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("--- a/")) {
        pendingGitFile = unquoteGitPath(line.slice(6)).replace(/\\/g, "/");
        continue;
      }
      if (line === "--- /dev/null") {
        continue;
      }
      if (line === "+++ /dev/null") {
        currentFile = pendingGitFile;
        continue;
      }
      if (line.startsWith("+++ b/")) {
        currentFile = unquoteGitPath(line.slice(6)).replace(/\\/g, "/");
        continue;
      }
      if (line.startsWith("@@")) {
        inHeader = false;
        continue;
      }
    }
    if (!currentFile || line.startsWith("@@")) continue;
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
  const flagged = (removed > added && weakeningRatio > maxWeakeningRatio) || flaggedFiles.length > 0;
  return { added, removed, weakeningRatio, flagged, flaggedFiles };
}

const ACTION_LABELS = {
  read: "Read",
  local_write: "Local write",
  local_exec: "Local command",
  push_branch: "Push",
  open_pr: "Open PR",
  merge: "Merge",
  deploy: "Deploy",
  external_message: "External message",
  destructive: "Destructive action",
};

function formatDecisionReason({
  verb = "Paused",
  action,
  requiredLevel,
  category,
  trustLevel,
  trustScore,
  residual,
  riskScore,
  signals,
}) {
  const label = ACTION_LABELS[action] ?? action;
  const tStr = Number(trustScore ?? 0).toFixed(2);
  const rStr = Number(riskScore ?? 0).toFixed(2);
  const sigText = (Array.isArray(signals) ? signals : [])
    .slice(0, 3)
    .map((s) => (typeof s === "string" ? s : s?.id))
    .filter(Boolean)
    .join(", ");
  const sigClause = sigText ? ` from ${sigText}` : "";
  if (requiredLevel === null || requiredLevel === undefined) {
    return `${verb}. ${label} always requires human approval for ${category} (L${trustLevel}, T ${tStr}). Residual ${residual} (R ${rStr})${sigClause}.`;
  }
  return `${verb}. ${label} needs L${requiredLevel} for ${category}, current L${trustLevel} (T ${tStr}). Residual ${residual} (R ${rStr})${sigClause}.`;
}

/**
 * One-release read shim mapping legacy `allowTier0AutoMerge` and `humanGates.prReview` flags onto the decision table.
 */
export function mapLegacyPolicyFlags(policy = DEFAULT_RISK_POLICY) {
  const tier0AutoMerge = Boolean(
    policy?.allowTier0AutoMerge === true &&
      (policy?.humanGates?.prReview === "tier0-auto" || policy?.humanGates?.prReview === "never"),
  );
  const hasExplicitAutonomy = Boolean(policy?.autonomy && typeof policy.autonomy === "object");
  return {
    tier0AutoMerge,
    usedLegacyFlags: Boolean(
      policy?.allowTier0AutoMerge === true ||
        (typeof policy?.humanGates?.prReview === "string" &&
          policy.humanGates.prReview !== "always" &&
          !hasExplicitAutonomy),
    ),
  };
}

/**
 * Evaluates the deterministic `(action, residual, trustLevel)` decision table, returning `auto_approve`, `allow`, `force_ask`, or `deny`.
 */
export function evaluateDecisionTable({
  action = "read",
  residual = "medium",
  trustLevel = 0,
  category = "core",
  trustScore = 0,
  riskScore = 0,
  signals = [],
  beastOn = false,
  policy = DEFAULT_RISK_POLICY,
  headless = false,
  isOwnRevert = false,
} = {}) {
  if (action === "read") {
    return { decision: "allow", requiredLevel: 0, reason: null, viaLegacyShim: false };
  }

  const askDecision = headless ? "deny" : "force_ask";
  const askVerb = headless ? "Blocked" : "Paused";
  const lvl = Number.isFinite(Number(trustLevel)) ? Math.max(0, Math.min(3, Math.floor(Number(trustLevel)))) : 0;
  const legacy = mapLegacyPolicyFlags(policy);

  if (action === "deploy" || action === "external_message" || action === "destructive") {
    if (residual === "high" || residual === "blocked") {
      return {
        decision: "deny",
        requiredLevel: null,
        viaLegacyShim: false,
        reason: formatDecisionReason({
          verb: "Blocked",
          action,
          requiredLevel: null,
          category,
          trustLevel: lvl,
          trustScore,
          residual,
          riskScore,
          signals,
        }),
      };
    }
    return {
      decision: askDecision,
      requiredLevel: null,
      viaLegacyShim: false,
      reason: formatDecisionReason({
        verb: askVerb,
        action,
        requiredLevel: null,
        category,
        trustLevel: lvl,
        trustScore,
        residual,
        riskScore,
        signals,
      }),
    };
  }

  if (residual === "blocked") {
    const req = action === "merge" ? 3 : action === "push_branch" || action === "open_pr" ? 2 : 1;
    return {
      decision: "deny",
      requiredLevel: req,
      viaLegacyShim: false,
      reason: formatDecisionReason({
        verb: "Blocked",
        action,
        requiredLevel: req,
        category,
        trustLevel: lvl,
        trustScore,
        residual,
        riskScore,
        signals,
      }),
    };
  }

  if (action === "local_write" || action === "local_exec") {
    if (residual === "high") {
      return {
        decision: askDecision,
        requiredLevel: 1,
        viaLegacyShim: false,
        reason: formatDecisionReason({
          verb: askVerb,
          action,
          requiredLevel: 1,
          category,
          trustLevel: lvl,
          trustScore,
          residual,
          riskScore,
          signals,
        }),
      };
    }
    if (beastOn && lvl >= 1) {
      return { decision: "auto_approve", requiredLevel: 1, reason: null, viaLegacyShim: false };
    }
    if (!beastOn) {
      return { decision: "allow", requiredLevel: 1, reason: null, viaLegacyShim: false };
    }
    return {
      decision: askDecision,
      requiredLevel: 1,
      viaLegacyShim: false,
      reason: formatDecisionReason({
        verb: askVerb,
        action,
        requiredLevel: 1,
        category,
        trustLevel: lvl,
        trustScore,
        residual,
        riskScore,
        signals,
      }),
    };
  }

  if (action === "push_branch" || action === "open_pr") {
    if (residual === "high") {
      return {
        decision: askDecision,
        requiredLevel: 2,
        viaLegacyShim: false,
        reason: formatDecisionReason({
          verb: askVerb,
          action,
          requiredLevel: 2,
          category,
          trustLevel: lvl,
          trustScore,
          residual,
          riskScore,
          signals,
        }),
      };
    }
    if (beastOn && lvl >= 2) {
      return { decision: "auto_approve", requiredLevel: 2, reason: null, viaLegacyShim: false };
    }
    if (!beastOn) {
      return { decision: "allow", requiredLevel: 2, reason: null, viaLegacyShim: false };
    }
    return {
      decision: askDecision,
      requiredLevel: 2,
      viaLegacyShim: false,
      reason: formatDecisionReason({
        verb: askVerb,
        action,
        requiredLevel: 2,
        category,
        trustLevel: lvl,
        trustScore,
        residual,
        riskScore,
        signals,
      }),
    };
  }

  if (action === "merge") {
    if (residual === "low") {
      if (isOwnRevert && beastOn && lvl >= 2) {
        return { decision: "auto_approve", requiredLevel: 2, reason: null, viaLegacyShim: false };
      }
      if (beastOn && lvl >= 3 && category !== "governance") {
        return { decision: "auto_approve", requiredLevel: 3, reason: null, viaLegacyShim: false };
      }
      if (beastOn && legacy.tier0AutoMerge && (category === "docs" || category === "tests")) {
        return { decision: "auto_approve", requiredLevel: 3, reason: null, viaLegacyShim: true };
      }
    }
    return {
      decision: askDecision,
      requiredLevel: 3,
      viaLegacyShim: false,
      reason: formatDecisionReason({
        verb: askVerb,
        action,
        requiredLevel: 3,
        category,
        trustLevel: lvl,
        trustScore,
        residual,
        riskScore,
        signals,
      }),
    };
  }

  return { decision: "allow", requiredLevel: 0, reason: null, viaLegacyShim: false };
}
