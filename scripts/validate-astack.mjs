#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_NATIVE_COMMANDS,
  MAX_ANTIGRAVITY_BYTES,
  RESERVED_SKILL_NAMES,
  applyFrontmatterPolicy,
  loadCatalog,
  parseFrontmatter,
} from "./catalog.mjs";
import { TOOL_MATCHERS } from "./trust/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");

const ALLOWED_SKILL_KEYS = new Set([
  "name",
  "description",
  "disable-model-invocation",
  "license",
  "compatibility",
]);
const ALLOWED_AGENT_KEYS = new Set([
  "name",
  "description",
  "mainAgent",
  "subagent",
  "model",
  "tools",
  "commandExecutionPolicy",
  "skills",
  "inheritMcp",
  "inheritCustomizations",
]);
const BOOLEAN_AGENT_KEYS = ["mainAgent", "subagent", "inheritMcp", "inheritCustomizations"];
const ALLOWED_RULE_TRIGGERS = new Set(["always_on", "model_decision", "glob", "manual"]);

const VALID_COMMAND_MODES = new Set(["run", "load", "contract", "recommend"]);
const VALID_TIMELINE_KINDS = new Set(["skill", "native", "playbook", "script", "agent", "concept"]);
const DOC_COUNT_TARGETS = [
  "README.md",
  "docs/agent-timeline.md",
  "docs/user-guide.md",
  "docs/architecture-and-swarm.md",
  "docs/guide/README.md",
  "docs/guide/01-setup.md",
  "docs/guide/09-make-it-yours.md",
  "skills/astack-help/SKILL.md",
  "rules/astack-orchestration.md",
];

const CURSOR_LEAK_PATTERNS = [
  { id: "cursor-dir", regex: /~?\.cursor\//g },
  { id: "pstack-models-mdc", regex: /\bpstack-models\.mdc\b/g },
  { id: "agent-transcripts", regex: /\bagent-transcripts\//g },
  { id: "poteto-slash", regex: /\/poteto-(?:mode|help)\b/g },
  { id: "setup-pstack-slash", regex: /\/setup-pstack\b/g },
  { id: "cursor-tool-todowrite", regex: /\bTodoWrite\b/g },
  { id: "cursor-tool-strreplace", regex: /\bStrReplace\b/g },
  { id: "cursor-webhook-api", regex: /api2\.cursor\.sh/g },
  { id: "cursor-subagent-type", regex: /\bsubagent_type\b/g },
  { id: "author-typo", regex: /\bMaschi[t]\b/g },
  { id: "invalid-global-skills-dir", regex: /~\/\.agents\/skills\b/g },
  { id: "cursor-ask-allow-multiple", regex: /\ballow_multiple\b/g },
  { id: "cursor-slash-visualize", regex: /(?:^|[\s`])\/visualize\b/gm },
  { id: "cursor-package-scope", regex: /@cursor-skill\//g },
  { id: "bun-types-leak", regex: /\bbun-types\b/g },
  { id: "legacy-automation-name", regex: /\bbenn[y]\b/gi },
];

const INSPIRATION_LEAK_PATTERNS = [
  { id: "inspiration-lauren-tan", regex: /\b(?:lauren|laura)\s+tan\b/gi },
  { id: "inspiration-garry-tan", regex: /\b(?:garry|gary)\s+tan\b/gi },
  { id: "inspiration-poteto", regex: /(?<![a-zA-Z0-9_])@?poteto\b/gi },
  { id: "inspiration-garrytan", regex: /(?<![a-zA-Z0-9_])@?garrytan\b/gi },
  { id: "inspiration-pstack", regex: /\bpstack\b/gi },
  { id: "inspiration-gstack", regex: /\bgstack\b/gi },
  { id: "inspiration-security-audit-skill", regex: /\b(?:cloudflare\/)?security-audit-skill\b/gi },
];

function checkInspirationLeaks(rel, content, errors) {
  for (const { id, regex } of INSPIRATION_LEAK_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(content)) {
      errors.push({
        file: rel,
        message: `Inspiration reference leak matched (${id}); keep upstream attribution in README.md or CREDITS.md`,
      });
    }
  }
}

const PRINCIPLE_REF_REGEX = /\b(principle-[a-z0-9][a-z0-9-]*)\b/g;

function stripUrls(text) {
  return text.replace(/https?:\/\/[^\s)\]>'"]+/g, "");
}

function addRelativeTarget(rawTarget, links) {
  const trimmed = rawTarget?.trim();
  if (
    !trimmed ||
    trimmed === "url" ||
    trimmed.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ||
    trimmed.includes("<") ||
    trimmed.includes(">") ||
    trimmed.includes("${") ||
    trimmed.startsWith("$")
  ) {
    return;
  }
  const cleanTarget = trimmed.split("#")[0].split("?")[0];
  if (cleanTarget) {
    links.push(cleanTarget);
  }
}

function extractRelativeLinks(markdown) {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const links = [];
  const mdRegex = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = mdRegex.exec(withoutCode)) !== null) {
    addRelativeTarget(match[1], links);
  }
  const htmlRegex = /\b(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((match = htmlRegex.exec(withoutCode)) !== null) {
    const attr = match[1].toLowerCase();
    const rawValue = match[2] ?? match[3] ?? "";
    if (attr === "srcset") {
      for (const candidate of rawValue.split(",")) {
        const urlPart = candidate.trim().split(/\s+/)[0];
        addRelativeTarget(urlPart, links);
      }
    } else {
      addRelativeTarget(rawValue, links);
    }
  }
  return links;
}

function collectFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (!exts || exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function toRel(rootDir, fullPath) {
  return path.relative(rootDir, fullPath).split(path.sep).join("/");
}

function formatCompanionLinks(companions) {
  return companions
    .map((relPath) => {
      const clean = relPath.replace(/\\/g, "/");
      const label = clean.endsWith("/SKILL.md")
        ? clean.split("/").slice(-2, -1)[0]
        : path.posix.basename(clean);
      return `[${label}](../../../${clean})`;
    })
    .join(", ");
}

function formatBackingCell(entry) {
  const b = entry.backing ?? {};
  if (entry.mode === "run") {
    const parts = [`tool \`${b.tool}\``];
    if (b.subagentType) parts.push(`TypeName \`${b.subagentType}\``);
    if (b.skill) parts.push(`skill \`${b.skill}\``);
    return parts.join(", ");
  }
  if (entry.mode === "load") {
    return `built-in skill \`${b.skill}\``;
  }
  if (entry.mode === "contract") {
    const base = `[${path.posix.basename(b.contract)}](../../../${b.contract})`;
    return b.pairsWith?.length ? `${base} + \`${b.pairsWith.join("`, `")}\`` : base;
  }
  return `recommend \`${b.exampleLine}\``;
}

export function renderNativeCommandsMarkdown(registry) {
  const lines = [
    "# Native Antigravity Slash Commands",
    "",
    `Generated from [native-commands.json](./native-commands.json) (source catalog \`${registry.source}\`). Do not edit manually; run \`node scripts/validate-astack.mjs --write-native-commands\` after updating the registry.`,
    "",
    "## Engagement Modes",
    "",
    "- **run**: Call the native tool directly (after loading its built-in skill when present).",
    "- **load**: Read the built-in Antigravity `SKILL.md` and follow its workflow.",
    "- **contract**: Reproduce the command's documented protocol in the active turn (stop at reviewable artifacts when required).",
    "- **recommend**: Harness-owned mode. Print a copy-ready command line for the user, explain what it adds, and use in-turn fallback only if they decline.",
    "",
    "When a command is `app`-only (such as `/automation` or `/generative_ui`), CLI sessions route to `/schedule` or plain Markdown/Mermaid fallbacks cleanly.",
    "",
    `## All ${registry.commands.length} Native Commands`,
    "",
    "| Command | Category | Mode | Backing | Triggers | Surfaces | Tier | AStack Companion |",
    "|---|---|---|---|---|---|---|---|",
  ];

  for (const entry of registry.commands) {
    const triggers = entry.triggers?.length
      ? entry.triggers.map((t) => `\`${t}\``).join(", ")
      : "User-initiated only";
    const surfaces = (entry.surfaces ?? []).join(", ");
    const companions = formatCompanionLinks(entry.astackCompanion ?? []);
    lines.push(
      `| \`${entry.command}\` | ${entry.category} | \`${entry.mode}\` | ${formatBackingCell(entry)} | ${triggers} | ${surfaces} | ${entry.tier} | ${companions} |`,
    );
  }

  lines.push("");
  return `${lines.join("\n")}`;
}

function validateNativeCommandsRegistry(rootDir, errors) {
  const registryRel = "skills/astack-mode/references/native-commands.json";
  const markdownRel = "skills/astack-mode/references/native-commands.md";
  const registryPath = path.join(rootDir, registryRel);
  const markdownPath = path.join(rootDir, markdownRel);
  const hasAstackMode = fs.existsSync(path.join(rootDir, "skills", "astack-mode"));

  if (!fs.existsSync(registryPath)) {
    if (hasAstackMode) {
      errors.push({ file: registryRel, message: `Missing native command registry: ${registryRel}` });
    }
    return new Set();
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  } catch (err) {
    errors.push({ file: registryRel, message: `Invalid JSON: ${err.message}` });
    return new Set();
  }

  if (!Array.isArray(registry?.commands)) {
    errors.push({ file: registryRel, message: "Registry must contain a commands array" });
    return new Set();
  }

  const seen = new Set();
  for (const entry of registry.commands) {
    if (!entry || typeof entry.command !== "string") {
      errors.push({ file: registryRel, message: "Registry command entry missing string command field" });
      continue;
    }
    if (seen.has(entry.command)) {
      errors.push({ file: registryRel, message: `Duplicate native command entry: ${entry.command}` });
      continue;
    }
    seen.add(entry.command);

    if (!VALID_COMMAND_MODES.has(entry.mode)) {
      errors.push({ file: registryRel, message: `Invalid mode "${entry.mode}" for ${entry.command}` });
    }

    const backing = entry.backing ?? {};
    if (entry.mode === "run" && !backing.tool) {
      errors.push({ file: registryRel, message: `Run-mode command ${entry.command} missing backing.tool` });
    }
    if (entry.mode === "load" && !backing.skill) {
      errors.push({ file: registryRel, message: `Load-mode command ${entry.command} missing backing.skill` });
    }
    if (entry.mode === "contract") {
      if (!backing.contract) {
        errors.push({ file: registryRel, message: `Contract-mode command ${entry.command} missing backing.contract` });
      } else if (!fs.existsSync(path.join(rootDir, ...backing.contract.split("/")))) {
        errors.push({
          file: registryRel,
          message: `Contract-mode command ${entry.command} points to missing path: ${backing.contract}`,
        });
      }
    }
    if (entry.mode === "recommend" && !backing.exampleLine) {
      errors.push({ file: registryRel, message: `Recommend-mode command ${entry.command} missing backing.exampleLine` });
    }

    if (!Array.isArray(entry.astackCompanion) || entry.astackCompanion.length === 0) {
      errors.push({ file: registryRel, message: `${entry.command} must list at least one astackCompanion` });
    } else {
      for (const comp of entry.astackCompanion) {
        if (!fs.existsSync(path.join(rootDir, ...comp.split("/")))) {
          errors.push({
            file: registryRel,
            message: `${entry.command} lists missing astackCompanion: ${comp}`,
          });
        }
      }
    }
  }

  for (const expected of EXPECTED_NATIVE_COMMANDS) {
    if (!seen.has(expected)) {
      errors.push({ file: registryRel, message: `Missing catalog command from registry: ${expected}` });
    }
  }
  const expectedSet = new Set(EXPECTED_NATIVE_COMMANDS);
  for (const actual of seen) {
    if (!expectedSet.has(actual)) {
      errors.push({ file: registryRel, message: `Unknown catalog command in registry: ${actual}` });
    }
  }

  const expectedMarkdown = renderNativeCommandsMarkdown(registry);
  if (!fs.existsSync(markdownPath)) {
    errors.push({
      file: markdownRel,
      message: `Missing generated ${markdownRel}. Run: node scripts/validate-astack.mjs --write-native-commands`,
    });
  } else {
    const actualMarkdown = fs.readFileSync(markdownPath, "utf8").replace(/\r\n/g, "\n");
    if (actualMarkdown !== expectedMarkdown) {
      errors.push({
        file: markdownRel,
        message: `${markdownRel} drifted from native-commands.json. Run: node scripts/validate-astack.mjs --write-native-commands`,
      });
    }
  }
  return seen;
}

function checkTimelineCatalog(rootDir, { validSkillNames, nativeCommandSet }, errors) {
  const catalogRel = "sidecars/astack_timeline/command-catalog.json";
  const catalogPath = path.join(rootDir, ...catalogRel.split("/"));
  if (!fs.existsSync(catalogPath)) return;

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  } catch (err) {
    errors.push({ file: catalogRel, message: `Invalid JSON: ${err.message}` });
    return;
  }

  const commands = catalog?.commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    errors.push({ file: catalogRel, message: "command-catalog.json must declare a commands object" });
    return;
  }

  for (const [cmd, entry] of Object.entries(commands)) {
    if (!entry || typeof entry !== "object") {
      errors.push({ file: catalogRel, message: `Catalog entry ${cmd} must be an object` });
      continue;
    }
    if (!VALID_TIMELINE_KINDS.has(entry.kind)) {
      errors.push({ file: catalogRel, message: `Invalid kind "${entry.kind}" for ${cmd}` });
    }
    if (typeof entry.description !== "string" || !entry.description.trim()) {
      errors.push({ file: catalogRel, message: `Catalog entry ${cmd} missing description` });
    }
    if (typeof entry.docsPath !== "string" || !entry.docsPath.trim()) {
      errors.push({ file: catalogRel, message: `Catalog entry ${cmd} missing docsPath` });
    } else {
      const relDoc = entry.docsPath.split("#")[0];
      if (!fs.existsSync(path.join(rootDir, ...relDoc.split("/")))) {
        errors.push({ file: catalogRel, message: `Catalog entry ${cmd} docsPath missing on disk: ${relDoc}` });
      }
    }

    if (entry.kind === "skill") {
      const slug = cmd.startsWith("/") ? cmd.slice(1) : "";
      if (!slug || !validSkillNames.has(slug)) {
        errors.push({ file: catalogRel, message: `Skill entry ${cmd} does not exist under skills/` });
      }
      if (entry.invocable === false) {
        errors.push({ file: catalogRel, message: `Skill entry ${cmd} must stay invocable` });
      }
    } else if (entry.kind === "native") {
      if (nativeCommandSet.size > 0 && !nativeCommandSet.has(cmd)) {
        errors.push({ file: catalogRel, message: `Native entry ${cmd} missing from native-commands.json` });
      }
      if (entry.invocable === false) {
        errors.push({ file: catalogRel, message: `Native entry ${cmd} must stay invocable` });
      }
    } else if (entry.kind === "playbook") {
      if (!cmd.startsWith("/astack-mode ")) {
        errors.push({ file: catalogRel, message: `Playbook entry ${cmd} must use /astack-mode <trigger> syntax` });
      }
      if (entry.invocable === false) {
        errors.push({ file: catalogRel, message: `Playbook entry ${cmd} must stay invocable` });
      }
      if (typeof entry.backingPath !== "string" || !fs.existsSync(path.join(rootDir, ...entry.backingPath.split("/")))) {
        errors.push({ file: catalogRel, message: `Playbook entry ${cmd} missing backingPath: ${entry.backingPath}` });
      }
    } else if (entry.kind === "script" || entry.kind === "agent") {
      if (entry.invocable !== false) {
        errors.push({ file: catalogRel, message: `Internal ${entry.kind} ${cmd} must set invocable: false` });
      }
      if (typeof entry.backingPath !== "string" || !fs.existsSync(path.join(rootDir, ...entry.backingPath.split("/")))) {
        errors.push({ file: catalogRel, message: `Internal ${entry.kind} ${cmd} missing backingPath: ${entry.backingPath}` });
      }
      const invoker = entry.invokedBy;
      if (!invoker || !commands[invoker] || commands[invoker].invocable === false) {
        errors.push({ file: catalogRel, message: `Internal ${entry.kind} ${cmd} must declare invocable invokedBy` });
      }
    } else if (entry.kind === "concept" && entry.invocable !== false) {
      errors.push({ file: catalogRel, message: `Concept entry ${cmd} must set invocable: false` });
    }
  }

  for (const [stageId, stageEntry] of Object.entries(catalog.stageCatalog ?? {})) {
    for (const cmd of stageEntry?.autoSubCommands ?? []) {
      if (!commands[cmd]) {
        errors.push({ file: catalogRel, message: `stageCatalog.${stageId}.autoSubCommands references unknown ${cmd}` });
      }
    }
    for (const cmd of stageEntry?.moreCommands ?? []) {
      if (!commands[cmd]) {
        errors.push({ file: catalogRel, message: `stageCatalog.${stageId}.moreCommands references unknown ${cmd}` });
      } else if (commands[cmd].invocable === false) {
        errors.push({
          file: catalogRel,
          message: `stageCatalog.${stageId}.moreCommands cannot include non-invocable ${cmd}`,
        });
      }
    }
  }

  if (validSkillNames.size > 0 && nativeCommandSet.size > 0) {
    for (const skill of validSkillNames) {
      if (!skill.startsWith("principle-") && !commands[`/${skill}`]) {
        errors.push({ file: catalogRel, message: `Non-principle skill /${skill} missing from command-catalog.json` });
      }
    }
    for (const nativeCmd of nativeCommandSet) {
      if (!commands[nativeCmd]) {
        errors.push({ file: catalogRel, message: `Native command ${nativeCmd} missing from command-catalog.json` });
      }
    }
  }

  const slashTokenRe = /(?:^|[\s(])(\/[a-z][a-z0-9_-]*)/gi;
  const checkSlashText = (label, text) => {
    if (typeof text !== "string") return;
    slashTokenRe.lastIndex = 0;
    let m;
    while ((m = slashTokenRe.exec(text)) !== null) {
      const cmd = m[1];
      if (
        !validSkillNames.has(cmd.slice(1)) &&
        !(nativeCommandSet.size > 0 ? nativeCommandSet.has(cmd) : EXPECTED_NATIVE_COMMANDS.includes(cmd))
      ) {
        errors.push({ file: catalogRel, message: `delegateGuide ${label} references unknown command ${cmd}` });
      }
    }
  };
  for (const pick of catalog.delegateGuide?.picks ?? []) {
    checkSlashText(`picks.${pick.id}`, pick.prompt);
  }
  for (const sec of catalog.delegateGuide?.sections ?? []) {
    for (const item of sec.items ?? []) {
      checkSlashText(`sections.${sec.id}.${item.command}`, item.command);
      checkSlashText(`sections.${sec.id}.${item.command}.copyText`, item.copyText);
      const itemCmd = item.copyText || item.command;
      const isRegisteredNative = nativeCommandSet.size > 0
        ? nativeCommandSet.has(itemCmd)
        : EXPECTED_NATIVE_COMMANDS.includes(itemCmd);
      if (isRegisteredNative && (/not wired/i.test(item.ownership || "") || /not wired/i.test(item.statusPill || ""))) {
        errors.push({
          file: catalogRel,
          message: `Registered native command ${itemCmd} cannot be marked "${item.statusPill || item.ownership}"`,
        });
      }
    }
  }
  for (const stage of catalog.delegateGuide?.stages ?? []) {
    for (const ex of stage.examples ?? []) {
      checkSlashText(`stages.${stage.id}.${ex.id}`, ex.prompt);
      for (const cmd of ex.commands ?? []) {
        if (!commands[cmd]) {
          errors.push({ file: catalogRel, message: `delegateGuide stages.${stage.id}.${ex.id} references unknown ${cmd}` });
        }
        const isRegisteredNative = nativeCommandSet.size > 0
          ? nativeCommandSet.has(cmd)
          : EXPECTED_NATIVE_COMMANDS.includes(cmd);
        if (isRegisteredNative && /not wired/i.test(ex.ownership || "")) {
          errors.push({
            file: catalogRel,
            message: `Registered native command ${cmd} cannot be marked "${ex.ownership}"`,
          });
        }
      }
    }
    for (const cmd of stage.commands ?? []) {
      if (!commands[cmd]) {
        errors.push({ file: catalogRel, message: `delegateGuide stages.${stage.id}.commands references unknown ${cmd}` });
      }
    }
  }
  for (const item of catalog.delegateGuide?.delegateMenu ?? []) {
    checkSlashText(`delegateMenu.${item.id}`, item.command);
    checkSlashText(`delegateMenu.${item.id}.prompt`, item.prompt);
  }
  for (const intent of catalog.colleagueReviewGuide?.intents ?? []) {
    for (const step of [...(intent.steps ?? []), ...(intent.moreChecks ?? [])]) {
      if (!commands[step.command]) {
        errors.push({
          file: catalogRel,
          message: `colleagueReviewGuide.${intent.id} references unknown command ${step.command}`,
        });
      }
      checkSlashText(`colleagueReviewGuide.${intent.id}.${step.command}`, step.command);
      checkSlashText(`colleagueReviewGuide.${intent.id}.${step.command}.prompt`, step.prompt);
    }
  }
}

function checkDocCountClaims(rootDir, counts, errors) {
  const countSpecs = [
    {
      label: "native command count",
      regex: /`?(\d+)`?\s+(?:native(?:\s+Antigravity)?\s+(?:slash\s+)?commands|public(?:\s+Antigravity)?\s+slash\s+commands|Native\s+Antigravity\s+Commands|Native\s+Slash\s+Commands)\b/gi,
      expected: counts.nativeCount,
    },
    {
      label: "manual-only skill count",
      regex: /`?(\d+)`?\s+manual-only/gi,
      expected: counts.manualOnlyCount,
    },
    {
      label: "total skill count",
      regex: /(?:\bships|\bhas)\s+(?:\*\*|`)?(\d+)(?:\*\*|`)?\s+skills\b/gi,
      expected: counts.skillCount,
    },
    {
      label: "custom agent count",
      regex: /`?(\d+)`?\s+custom\s+agents?\b/gi,
      expected: counts.agentCount,
    },
    {
      label: "passive hook count",
      regex: /`?(\d+)`?\s+passive\s+observe-only(?:\s+hooks?)?\b/gi,
      expected: counts.enabledPassiveHooks,
    },
  ];

  for (const rel of DOC_COUNT_TARGETS) {
    const abs = path.join(rootDir, ...rel.split("/"));
    if (!fs.existsSync(abs)) continue;
    const content = fs.readFileSync(abs, "utf8");
    for (const spec of countSpecs) {
      if (spec.expected <= 0) continue;
      spec.regex.lastIndex = 0;
      let m;
      while ((m = spec.regex.exec(content)) !== null) {
        const actual = Number.parseInt(m[1], 10);
        if (actual !== spec.expected) {
          errors.push({
            file: rel,
            message: `Stale ${spec.label} (${actual}); expected ${spec.expected}`,
          });
        }
      }
    }
  }
}

function validateCommandSurfaces(
  rootDir,
  { validSkillNames, nativeCommandSet, manualOnlySkillCount, agentCount, enabledPassiveHooks },
  errors,
) {
  checkTimelineCatalog(rootDir, { validSkillNames, nativeCommandSet }, errors);

  if (nativeCommandSet.size === 0 || validSkillNames.size === 0) return;

  const nonPrincipleSkills = [...validSkillNames].filter((s) => !s.startsWith("principle-")).sort();
  const checkCoverageFile = (rel, { requireNative = true } = {}) => {
    const abs = path.join(rootDir, ...rel.split("/"));
    if (!fs.existsSync(abs)) return;
    const text = fs.readFileSync(abs, "utf8");
    for (const skill of nonPrincipleSkills) {
      if (!text.includes(`/${skill}`) && !text.includes(`skills/${skill}/`)) {
        errors.push({ file: rel, message: `Documentation missing skill /${skill}` });
      }
    }
    if (requireNative) {
      for (const cmd of nativeCommandSet) {
        if (!text.includes(cmd)) {
          errors.push({ file: rel, message: `Documentation missing native command ${cmd}` });
        }
      }
    }
  };

  checkCoverageFile("skills/astack-help/SKILL.md", { requireNative: true });
  checkCoverageFile("docs/agent-timeline.md", { requireNative: true });
  const readmePath = path.join(rootDir, "README.md");
  if (fs.existsSync(readmePath) && fs.readFileSync(readmePath, "utf8").includes("## Skill catalog")) {
    checkCoverageFile("README.md", { requireNative: false });
  }

  checkDocCountClaims(
    rootDir,
    {
      nativeCount: nativeCommandSet.size,
      manualOnlyCount: manualOnlySkillCount.length,
      skillCount: validSkillNames.size,
      agentCount,
      enabledPassiveHooks,
    },
    errors,
  );
}

/**
 * Validates an AStack plugin tree at `rootDir`. Returns `{ ok, errors, warnings, stats }`.
 */
export function validateAStack(rootDir = DEFAULT_ROOT_DIR, { withAgy = false } = {}) {
  const errors = [];
  const warnings = [];

  const manifestPath = path.join(rootDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push({ file: "plugin.json", message: "Missing plugin.json at plugin root" });
  } else {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name !== "astack") {
        errors.push({ file: "plugin.json", message: `Expected manifest.name === "astack", got ${manifest.name}` });
      }
      if (!manifest.author?.name?.includes("João Machete")) {
        errors.push({ file: "plugin.json", message: 'manifest.author.name must credit "João Machete"' });
      }
      if (manifest.logo && !fs.existsSync(path.join(rootDir, manifest.logo))) {
        errors.push({ file: "plugin.json", message: `Missing logo file: ${manifest.logo}` });
      }
    } catch (err) {
      errors.push({ file: "plugin.json", message: `Invalid JSON: ${err.message}` });
    }
  }

  const licensePath = path.join(rootDir, "LICENSE");
  if (!fs.existsSync(licensePath)) {
    errors.push({ file: "LICENSE", message: "Missing LICENSE at plugin root" });
  } else {
    const licenseText = fs.readFileSync(licensePath, "utf8");
    if (!licenseText.includes("Lauren Tan") || !licenseText.includes("João Machete")) {
      errors.push({ file: "LICENSE", message: 'LICENSE must credit both "Lauren Tan" and "João Machete"' });
    }
  }

  const skillsRoot = path.join(rootDir, "skills");
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!RESERVED_SKILL_NAMES.has(entry.name)) continue;
      errors.push({
        file: `skills/${entry.name}`,
        message: `skills/${entry.name} must not exist because it shadows the native /${entry.name} command or built-in skill. Rename it (use skills/fanout for swarm) and route through skills/astack-mode/references/native-commands.json.`,
      });
    }
  }

  const nativeCommandSet = validateNativeCommandsRegistry(rootDir, errors);

  const validSkillNames = new Set();
  const autoInvokeSkills = [];
  const manualOnlySkillCount = [];
  const autoDescriptions = new Map();
  let autoInvokeDescriptionBytes = 0;
  let skillCount = 0;
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
      const rel = `skills/${entry.name}/SKILL.md`;
      if (!fs.existsSync(skillFile)) {
        errors.push({ file: `skills/${entry.name}`, message: "Skill directory missing SKILL.md" });
        continue;
      }
      validSkillNames.add(entry.name);
      skillCount++;
      const content = fs.readFileSync(skillFile, "utf8");
      const { hasFrontmatter, entries, body } = parseFrontmatter(content);
      if (!hasFrontmatter) {
        errors.push({ file: rel, message: "Missing YAML frontmatter" });
        continue;
      }
      const keyMap = Object.fromEntries(entries.map((e) => [e.key, e.valueLines.join("\n").trim()]));
      for (const key of Object.keys(keyMap)) {
        if (!ALLOWED_SKILL_KEYS.has(key)) {
          errors.push({ file: rel, message: `Unsupported frontmatter key "${key}" in Antigravity SKILL.md` });
        }
      }
      if (!keyMap.name) {
        errors.push({ file: rel, message: "Missing required frontmatter field: name" });
      } else if (keyMap.name !== entry.name) {
        errors.push({ file: rel, message: `Frontmatter name "${keyMap.name}" does not match folder "${entry.name}"` });
      }
      if (!keyMap.description) {
        errors.push({ file: rel, message: "Missing required frontmatter field: description" });
      }
      if (keyMap["disable-model-invocation"] !== undefined) {
        const val = keyMap["disable-model-invocation"];
        if (val !== "true" && val !== "false") {
          errors.push({
            file: rel,
            message: `Invalid disable-model-invocation value "${val}": must be boolean true or false`,
          });
        }
      }
      const isManualOnly = keyMap["disable-model-invocation"] === "true";
      if (isManualOnly) {
        manualOnlySkillCount.push(entry.name);
      } else {
        const descBytes = Buffer.byteLength(`${keyMap.name ?? entry.name}\n${keyMap.description ?? ""}`, "utf8");
        autoInvokeSkills.push({ name: entry.name, bytes: descBytes });
        autoInvokeDescriptionBytes += descBytes;
        const normalizedDesc = (keyMap.description ?? "").trim().toLowerCase().replace(/\s+/g, " ");
        if (normalizedDesc) {
          const priorSkill = autoDescriptions.get(normalizedDesc);
          if (priorSkill) {
            errors.push({
              file: rel,
              message: `Duplicate auto-invocable skill description matches ${priorSkill}`,
            });
          } else {
            autoDescriptions.set(normalizedDesc, entry.name);
          }
        }
      }
      const bodyBytes = Buffer.byteLength(body, "utf8");
      if (bodyBytes > MAX_ANTIGRAVITY_BYTES) {
        errors.push({
          file: rel,
          message: `Skill body is ${bodyBytes} bytes, exceeding Antigravity's ${MAX_ANTIGRAVITY_BYTES}-byte truncation limit`,
        });
      }
    }
  }

  const catalogFile = path.join(rootDir, "scripts", "catalog.json");
  if (fs.existsSync(catalogFile)) {
    try {
      const catalog = loadCatalog(rootDir);
      if (typeof catalog.maxAutoInvokeSkills === "number" && autoInvokeSkills.length > catalog.maxAutoInvokeSkills) {
        const top = [...autoInvokeSkills]
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 5)
          .map((s) => `${s.name}(${s.bytes}B)`)
          .join(", ");
        errors.push({
          file: "scripts/catalog.json",
          message: `Auto-invocable skill count ${autoInvokeSkills.length} exceeds maxAutoInvokeSkills (${catalog.maxAutoInvokeSkills}); largest: ${top}`,
        });
      }
      if (
        typeof catalog.maxAutoInvokeDescriptionBytes === "number" &&
        autoInvokeDescriptionBytes > catalog.maxAutoInvokeDescriptionBytes
      ) {
        const top = [...autoInvokeSkills]
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 5)
          .map((s) => `${s.name}(${s.bytes}B)`)
          .join(", ");
        errors.push({
          file: "scripts/catalog.json",
          message: `Auto-invocable startup description bytes ${autoInvokeDescriptionBytes} exceeds maxAutoInvokeDescriptionBytes (${catalog.maxAutoInvokeDescriptionBytes}); largest: ${top}`,
        });
      }
    } catch (err) {
      errors.push({ file: "scripts/catalog.json", message: `Invalid JSON: ${err.message}` });
    }
  }

  const agentsRoot = path.join(rootDir, "agents");
  let agentCount = 0;
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      agentCount++;
      const rel = `agents/${entry.name}`;
      const content = fs.readFileSync(path.join(agentsRoot, entry.name), "utf8");
      const { hasFrontmatter, entries } = parseFrontmatter(content);
      if (!hasFrontmatter) {
        errors.push({ file: rel, message: "Agent file missing YAML frontmatter" });
        continue;
      }
      const keyMap = Object.fromEntries(entries.map((e) => [e.key, e.valueLines.join("\n").trim()]));
      for (const key of Object.keys(keyMap)) {
        if (!ALLOWED_AGENT_KEYS.has(key)) {
          errors.push({ file: rel, message: `Unsupported frontmatter key "${key}" in Antigravity agent` });
        }
      }
      const expectedName = path.basename(entry.name, ".md");
      if (keyMap.name !== expectedName) {
        errors.push({ file: rel, message: `Agent name "${keyMap.name}" does not match filename "${expectedName}"` });
      }
      if (!keyMap.description) {
        errors.push({ file: rel, message: "Agent missing description" });
      }
      for (const boolKey of BOOLEAN_AGENT_KEYS) {
        if (keyMap[boolKey] !== undefined && keyMap[boolKey] !== "true" && keyMap[boolKey] !== "false") {
          errors.push({
            file: rel,
            message: `Invalid ${boolKey} value "${keyMap[boolKey]}": must be boolean true or false`,
          });
        }
      }
      if (expectedName === "pr-verifier" && keyMap.tools !== undefined) {
        errors.push({
          file: rel,
          message: "agents/pr-verifier.md must omit tools: to avoid Antigravity App/CLI tool-validation hangs",
        });
      }
    }
  }

  const hooksFile = path.join(rootDir, "hooks.json");
  let enabledPassiveHooks = 0;
  if (fs.existsSync(hooksFile)) {
    try {
      const hooksCfg = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
      const expectedMatchers = {
        "astack-receipt-ledger": { event: "PostToolUse", matcher: TOOL_MATCHERS.receiptLedger },
        "astack-secret-guard": { event: "PreToolUse", matcher: TOOL_MATCHERS.secretGuard },
        "astack-evidence-gate": { event: "PreToolUse", matcher: TOOL_MATCHERS.evidenceGate },
        "astack-trust-gate": { event: "PreToolUse", matcher: TOOL_MATCHERS.trustGate },
        "astack-boundary-guard": { event: "PreToolUse", matcher: TOOL_MATCHERS.fileWrite },
        "astack-round-limiter": { event: "PreToolUse", matcher: TOOL_MATCHERS.fileWrite },
      };
      for (const [hookName, def] of Object.entries(hooksCfg)) {
        if (!def || typeof def !== "object") continue;
        if (def.enabled === true) enabledPassiveHooks++;
        const spec = expectedMatchers[hookName];
        if (spec) {
          const entry = Array.isArray(def[spec.event]) ? def[spec.event][0] : null;
          if (!entry || entry.matcher !== spec.matcher) {
            errors.push({
              file: "hooks.json",
              message: `${hookName} ${spec.event} matcher drifted from TOOL_MATCHERS (${spec.matcher})`,
            });
          }
        }
        for (const evKey of ["PreToolUse", "PostToolUse", "SessionStart", "Stop", "PreInvocation", "PostInvocation"]) {
          const items = def[evKey];
          if (!Array.isArray(items)) continue;
          const handlers = evKey === "PreToolUse" || evKey === "PostToolUse"
            ? items.flatMap((block) => (Array.isArray(block?.hooks) ? block.hooks : []))
            : items;
          for (const h of handlers) {
            const m = typeof h?.command === "string" ? h.command.match(/^node\s+\.\/(\S+)/) : null;
            if (m && !fs.existsSync(path.join(rootDir, ...m[1].split("/")))) {
              errors.push({
                file: "hooks.json",
                message: `${hookName} references missing hook script: ${m[1]}`,
              });
            }
          }
        }
      }
    } catch (err) {
      errors.push({ file: "hooks.json", message: `Invalid JSON: ${err.message}` });
    }
  }

  const trustScanDirs = [
    ...collectFiles(path.join(rootDir, "scripts"), [".mjs", ".js", ".ts", ".cjs"]),
    ...collectFiles(path.join(rootDir, "skills"), [".mjs", ".js", ".ts", ".cjs"]),
    ...collectFiles(path.join(rootDir, "sidecars"), [".mjs", ".js", ".ts", ".cjs"]),
  ];
  for (const codeFile of trustScanDirs) {
    const rel = toRel(rootDir, codeFile);
    if (rel.startsWith("scripts/trust/") || rel.startsWith("scripts/test/")) continue;
    const rawCode = fs.readFileSync(codeFile, "utf8");
    if (/(?:import|from|require\s*\()\s*["'][^"']*trust\/internal\//.test(rawCode)) {
      errors.push({
        file: rel,
        message: "Direct import of scripts/trust/internal/* is forbidden; import scripts/trust/index.mjs instead",
      });
    }
  }

  const sidecarsRoot = path.join(rootDir, "sidecars");
  let sidecarCount = 0;
  if (fs.existsSync(sidecarsRoot)) {
    for (const entry of fs.readdirSync(sidecarsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestFile = path.join(sidecarsRoot, entry.name, "sidecar.json");
      const rel = `sidecars/${entry.name}/sidecar.json`;
      if (!fs.existsSync(manifestFile)) {
        errors.push({ file: `sidecars/${entry.name}`, message: "Sidecar directory missing sidecar.json" });
        continue;
      }
      sidecarCount++;
      let cfg;
      try {
        cfg = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      } catch (err) {
        errors.push({ file: rel, message: `Invalid JSON: ${err.message}` });
        continue;
      }
      const hasCmd = typeof cfg?.command === "string" && cfg.command.trim().length > 0;
      const hasBuiltin = typeof cfg?.builtin === "string" && cfg.builtin.trim().length > 0;
      if (hasCmd === hasBuiltin) {
        errors.push({ file: rel, message: "sidecar.json must define exactly one of command or builtin" });
      }
      if (hasCmd && cfg.command === "node" && Array.isArray(cfg.args) && typeof cfg.args[0] === "string") {
        const scriptArg = cfg.args[0];
        if (!scriptArg.startsWith("-") && !path.isAbsolute(scriptArg)) {
          const targetScript = path.join(sidecarsRoot, entry.name, ...scriptArg.split("/"));
          if (!fs.existsSync(targetScript)) {
            errors.push({ file: rel, message: `Sidecar references missing script: ${scriptArg}` });
          }
        }
      }
      if (cfg?.has_web_ui === true) {
        const views = cfg?.ui_config?.views;
        if (!Array.isArray(views) || views.length === 0) {
          errors.push({ file: rel, message: "has_web_ui sidecar must declare non-empty ui_config.views" });
        } else {
          for (const view of views) {
            if (typeof view?.path !== "string" || typeof view?.entrypoint !== "string" || !view.entrypoint.startsWith("SIDECAR_UI_ENTRYPOINT_")) {
              errors.push({ file: rel, message: "Each sidecar ui_config.views entry must declare path and SIDECAR_UI_ENTRYPOINT_*" });
            }
          }
        }
      }
      const permissionTriggers = [];
      if (Array.isArray(cfg?.arguments) && cfg.arguments.length > 0) {
        permissionTriggers.push("arguments");
      }
      if (Array.isArray(cfg?.agent_permissions?.workspace_uris) && cfg.agent_permissions.workspace_uris.length > 0) {
        permissionTriggers.push("agent_permissions.workspace_uris");
      }
      if (Array.isArray(cfg?.agent_permissions?.access_grants) && cfg.agent_permissions.access_grants.length > 0) {
        permissionTriggers.push("agent_permissions.access_grants");
      }
      if (permissionTriggers.length > 0) {
        errors.push({
          file: rel,
          message: `Bundled sidecar must not request ${permissionTriggers.join(", ")} (Antigravity disables the entire plugin under sidecar permission review; keep scheduled automation templates under docs/automations/)`,
        });
      }
    }
  }

  const rulesRoot = path.join(rootDir, "rules");
  let ruleCount = 0;
  if (fs.existsSync(rulesRoot)) {
    for (const entry of fs.readdirSync(rulesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      ruleCount++;
      const rel = `rules/${entry.name}`;
      const content = fs.readFileSync(path.join(rulesRoot, entry.name), "utf8");
      const { hasFrontmatter, entries } = parseFrontmatter(content);
      if (hasFrontmatter) {
        const keyMap = Object.fromEntries(entries.map((e) => [e.key, e.valueLines.join("\n").trim()]));
        if (keyMap.trigger && !ALLOWED_RULE_TRIGGERS.has(keyMap.trigger)) {
          errors.push({ file: rel, message: `Invalid rule trigger "${keyMap.trigger}"` });
        }
      }
      const totalBytes = Buffer.byteLength(content, "utf8");
      if (totalBytes > MAX_ANTIGRAVITY_BYTES) {
        errors.push({ file: rel, message: `Rule exceeds ${MAX_ANTIGRAVITY_BYTES} bytes (${totalBytes})` });
      }
    }
  }

  const mdScanTargets = [
    ...["README.md", "CREDITS.md", "CODE_OF_CONDUCT.md", "CONTRIBUTING.md", "SECURITY.md"]
      .map((f) => path.join(rootDir, f))
      .filter((p) => fs.existsSync(p)),
    ...collectFiles(path.join(rootDir, "rules"), [".md"]),
    ...collectFiles(path.join(rootDir, "agents"), [".md"]),
    ...collectFiles(path.join(rootDir, "skills"), [".md"]),
    ...collectFiles(path.join(rootDir, "docs"), [".md"]),
  ];

  for (const mdFile of mdScanTargets) {
    const rel = toRel(rootDir, mdFile);
    const content = fs.readFileSync(mdFile, "utf8");

    for (const target of extractRelativeLinks(content)) {
      let decodedTarget = target;
      try {
        decodedTarget = decodeURIComponent(target);
      } catch {
        errors.push({ file: rel, message: `Malformed percent-encoding in relative link target: ${target}` });
        continue;
      }
      const resolved = path.resolve(path.dirname(mdFile), ...decodedTarget.split("/"));
      if (!fs.existsSync(resolved)) {
        errors.push({ file: rel, message: `Broken relative link target: ${target}` });
      }
    }

    const sanitizedForLeakCheck = stripUrls(content);
    for (const { id, regex } of CURSOR_LEAK_PATTERNS) {
      regex.lastIndex = 0;
      if (regex.test(sanitizedForLeakCheck)) {
        errors.push({ file: rel, message: `Cursor runtime leak matched (${id})` });
      }
    }
    if (rel !== "README.md" && rel !== "CREDITS.md") {
      checkInspirationLeaks(rel, content, errors);
    }

    const seenUnknownPrinciples = new Set();
    PRINCIPLE_REF_REGEX.lastIndex = 0;
    let principleMatch;
    while ((principleMatch = PRINCIPLE_REF_REGEX.exec(sanitizedForLeakCheck)) !== null) {
      const slug = principleMatch[1];
      if (!validSkillNames.has(slug) && !seenUnknownPrinciples.has(slug)) {
        seenUnknownPrinciples.add(slug);
        errors.push({ file: rel, message: `Unknown principle skill reference: ${slug}` });
      }
    }
  }

  validateCommandSurfaces(
    rootDir,
    { validSkillNames, nativeCommandSet, manualOnlySkillCount, agentCount, enabledPassiveHooks },
    errors,
  );

  let agyReport = null;
  if (withAgy) {
    try {
      const stdout = execFileSync("agy", ["plugin", "validate", "--strict", "--json", rootDir], {
        encoding: "utf8",
      });
      agyReport = JSON.parse(stdout);
      for (const finding of agyReport.findings ?? []) {
        if (finding.severity === "note" && /plugin is off until the user reviews/i.test(finding.message ?? "")) {
          errors.push({ file: finding.file ?? "plugin", message: `[agy] ${finding.message}` });
        }
      }
    } catch (err) {
      const stdout = err.stdout?.toString?.() ?? "";
      if (stdout) {
        try {
          agyReport = JSON.parse(stdout);
          for (const finding of agyReport.findings ?? []) {
            const bucket = finding.severity === "error" ? errors : warnings;
            bucket.push({ file: finding.file ?? "plugin", message: `[agy] ${finding.message}` });
          }
        } catch {
          errors.push({ file: "agy", message: `agy plugin validate failed: ${err.message}` });
        }
      } else {
        errors.push({ file: "agy", message: `agy plugin validate failed: ${err.message}` });
      }
    }
  }

  const mcpConfigFile = path.join(rootDir, "mcp_config.json");
  let mcpServerCount = 0;
  if (fs.existsSync(mcpConfigFile)) {
    try {
      const mcpCfg = JSON.parse(fs.readFileSync(mcpConfigFile, "utf8"));
      const servers = mcpCfg?.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length === 0) {
        errors.push({ file: "mcp_config.json", message: "mcp_config.json must declare a non-empty mcpServers object" });
      } else {
        for (const [serverName, def] of Object.entries(servers)) {
          mcpServerCount++;
          if (!def || typeof def !== "object" || Array.isArray(def)) {
            errors.push({ file: "mcp_config.json", message: `mcpServers.${serverName} must be an object` });
            continue;
          }
          if (def.serverUrl !== undefined || def.url !== undefined) {
            errors.push({
              file: "mcp_config.json",
              message: `mcpServers.${serverName} must use local stdio command, never remote serverUrl/url`,
            });
          }
          if (typeof def.command !== "string" || !def.command.trim()) {
            errors.push({ file: "mcp_config.json", message: `mcpServers.${serverName} missing local command` });
          }
          if (Array.isArray(def.args)) {
            for (const arg of def.args) {
              if (typeof arg !== "string") continue;
              const m = arg.match(/^\$\{PLUGIN_ROOT\}\/(.+)$/);
              if (m && !fs.existsSync(path.join(rootDir, ...m[1].split("/")))) {
                errors.push({
                  file: "mcp_config.json",
                  message: `mcpServers.${serverName} references missing plugin script: ${m[1]}`,
                });
              }
            }
          }
        }
      }
    } catch (err) {
      errors.push({ file: "mcp_config.json", message: `Invalid JSON: ${err.message}` });
    }
  }

  const runtimeLeakTargets = [
    "plugin.json",
    "mcp_config.json",
    "hooks.json",
    "scripts/mcp/server.mjs",
    "scripts/mcp/tools.mjs",
  ];
  if (fs.existsSync(sidecarsRoot)) {
    for (const entry of fs.readdirSync(sidecarsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        runtimeLeakTargets.push(`sidecars/${entry.name}/sidecar.json`);
      }
    }
  }
  for (const rel of runtimeLeakTargets) {
    const abs = path.join(rootDir, ...rel.split("/"));
    if (fs.existsSync(abs)) {
      checkInspirationLeaks(rel, fs.readFileSync(abs, "utf8"), errors);
    }
  }

  return {
    ok: errors.length === 0 && warnings.length === 0,
    errors,
    warnings,
    stats: {
      skills: skillCount,
      manualOnlySkills: manualOnlySkillCount.length,
      autoInvokeSkills: autoInvokeSkills.length,
      autoInvokeDescriptionBytes,
      agents: agentCount,
      rules: ruleCount,
      sidecars: sidecarCount,
      mcpServers: mcpServerCount,
      markdownFilesChecked: mdScanTargets.length,
    },
    agyReport,
  };
}

const USAGE = `Usage: node scripts/validate-astack.mjs [options] [rootDir]

Options:
  --no-agy                   Skip agy plugin validate --strict
  --json                     Emit machine-readable JSON output
  --write-native-commands    Regenerate skills/astack-mode/references/native-commands.md from native-commands.json
  --apply-frontmatter-policy Synchronize disable-model-invocation from scripts/catalog.json before validating
  -h, --help                 Show this help text and exit 0`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "no-agy": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "write-native-commands": { type: "boolean", default: false },
      "apply-frontmatter-policy": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const rootDir = positionals[0] ? path.resolve(positionals[0]) : DEFAULT_ROOT_DIR;
  if (values["apply-frontmatter-policy"]) {
    applyFrontmatterPolicy(rootDir);
  }
  if (values["write-native-commands"]) {
    const registryPath = path.join(rootDir, "skills", "astack-mode", "references", "native-commands.json");
    const markdownPath = path.join(rootDir, "skills", "astack-mode", "references", "native-commands.md");
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    fs.writeFileSync(markdownPath, renderNativeCommandsMarkdown(registry), "utf8");
  }
  const result = validateAStack(rootDir, { withAgy: !values["no-agy"] });

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[validate-astack] skills=${result.stats.skills} auto=${result.stats.autoInvokeSkills} autoBytes=${result.stats.autoInvokeDescriptionBytes} agents=${result.stats.agents} rules=${result.stats.rules} sidecars=${result.stats.sidecars} mcpServers=${result.stats.mcpServers} md=${result.stats.markdownFilesChecked} errors=${result.errors.length} warnings=${result.warnings.length}`,
    );
    for (const err of result.errors) {
      console.error(`ERROR ${err.file}: ${err.message}`);
    }
    for (const warn of result.warnings) {
      console.warn(`WARN ${warn.file}: ${warn.message}`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}
