#!/usr/bin/env node
/**
 * Shared Antigravity catalog invariants, frontmatter helpers, and manual-only
 * invocation policy loader for AStack.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = path.resolve(__dirname, "..");
export const MAX_ANTIGRAVITY_BYTES = 24000;

export const EXPECTED_NATIVE_COMMANDS = [
  "/boost",
  "/teamwork",
  "/run-workflow",
  "/swarm",
  "/goal",
  "/plan",
  "/grill-me",
  "/learn",
  "/agy-customizations",
  "/plugin",
  "/automation",
  "/schedule",
  "/browser",
  "/btw",
  "/generative_ui",
  "/antigravity-guide",
];

export const BUILTIN_RESERVED_SKILL_NAMES = [
  "agy-customizations",
  "antigravity_guide",
  "antigravity-guide",
  "automation",
  "generative_ui",
  "mcp-app-development",
  "migrate-agent-settings",
  "migrate-workflows",
  "native_swarm",
  "permissioned-github",
  "plugin",
  "run-workflow",
  "swarm_monitor",
  "swarm_narrator",
  "swarm_pane",
  "ui-plugin-navigation",
];

export const RESERVED_SKILL_NAMES = new Set([
  ...EXPECTED_NATIVE_COMMANDS.map((c) => c.slice(1)),
  ...BUILTIN_RESERVED_SKILL_NAMES,
]);

/**
 * Splits a UTF-8 markdown document with optional YAML frontmatter into
 * `{ hasFrontmatter, entries, body }`.
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { hasFrontmatter: false, entries: [], body: content };
  }
  const [, rawFm, body] = match;
  const lines = rawFm.split(/\r?\n/);
  const entries = [];
  let current = null;

  for (const line of lines) {
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyMatch) {
      if (current) entries.push(current);
      current = { key: keyMatch[1], valueLines: [keyMatch[2]] };
    } else if (current) {
      current.valueLines.push(line);
    }
  }
  if (current) entries.push(current);

  return { hasFrontmatter: true, entries, body };
}

/**
 * Serializes YAML frontmatter entries back into a markdown frontmatter block.
 */
export function serializeFrontmatter(entries) {
  const rendered = entries.map(({ key, valueLines }) => {
    const [first, ...rest] = valueLines;
    if (rest.length === 0) return `${key}: ${first}`;
    return `${key}: ${first}\n${rest.join("\n")}`;
  });
  return `---\n${rendered.join("\n")}\n---\n`;
}

function upsertManualInvocationEntries(entries, manualOnly) {
  const withoutFlag = entries.filter((e) => e.key !== "disable-model-invocation");
  if (!manualOnly) {
    return withoutFlag;
  }
  const next = [];
  let inserted = false;
  for (const entry of withoutFlag) {
    next.push(entry);
    if (entry.key === "description" && !inserted) {
      next.push({ key: "disable-model-invocation", valueLines: ["true"] });
      inserted = true;
    }
  }
  if (!inserted) {
    next.push({ key: "disable-model-invocation", valueLines: ["true"] });
  }
  return next;
}

/**
 * Loads `scripts/catalog.json` from `rootDir`.
 */
export function loadCatalog(rootDir = DEFAULT_ROOT_DIR) {
  const catalogPath = path.join(rootDir, "scripts", "catalog.json");
  return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
}

/**
 * Applies `scripts/catalog.json` `manualOnlySkills` frontmatter policy across
 * every `skills/<name>/SKILL.md` under `rootDir`.
 */
export function applyFrontmatterPolicy(rootDir = DEFAULT_ROOT_DIR) {
  const catalog = loadCatalog(rootDir);
  const manualOnly = new Set(catalog.manualOnlySkills ?? []);
  const skillsRoot = path.join(rootDir, "skills");
  const report = { updated: [], unchanged: [] };
  if (!fs.existsSync(skillsRoot)) {
    return report;
  }

  const skillDirs = fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const skillName of skillDirs) {
    const skillPath = path.join(skillsRoot, skillName, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const raw = fs.readFileSync(skillPath, "utf8");
    const { hasFrontmatter, entries, body } = parseFrontmatter(raw);
    if (!hasFrontmatter) continue;

    const wantManual = manualOnly.has(skillName);
    const existingFlag = entries.find((e) => e.key === "disable-model-invocation");
    const currentVal = existingFlag?.valueLines.join("\n").trim();
    const rel = `skills/${skillName}/SKILL.md`;
    if ((wantManual && currentVal === "true") || (!wantManual && !existingFlag)) {
      report.unchanged.push(rel);
      continue;
    }

    const nextEntries = upsertManualInvocationEntries(entries, wantManual);
    const nextContent = `${serializeFrontmatter(nextEntries)}${body.replace(/\r\n/g, "\n")}`;
    fs.writeFileSync(skillPath, nextContent, "utf8");
    report.updated.push(rel);
  }

  return report;
}
