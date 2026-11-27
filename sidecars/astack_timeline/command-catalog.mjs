import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CATALOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "command-catalog.json");

function normalizeCommandEntry(docsBase, entry) {
  const kind = typeof entry?.kind === "string" ? entry.kind : "skill";
  const docsPath = typeof entry?.docsPath === "string" ? entry.docsPath : "";
  const docsUrl = docsPath ? `${docsBase}/${docsPath.replace(/^\/+/, "")}` : null;
  const invocable = entry?.invocable !== false;
  return {
    kind,
    invocable,
    backingPath: typeof entry?.backingPath === "string" ? entry.backingPath : null,
    invokedBy: typeof entry?.invokedBy === "string" ? entry.invokedBy : null,
    description: typeof entry?.description === "string" ? entry.description : "",
    docsPath,
    docsUrl,
  };
}

/**
 * Loads and normalizes the declarative timeline command catalog JSON for server, engine, and validator consumers.
 */
export function loadCommandCatalog(catalogPath = DEFAULT_CATALOG_PATH) {
  const raw = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const githubDocsBase = String(raw.githubDocsBase || "").replace(/\/+$/, "");
  const commandDocs = {};
  for (const [cmd, entry] of Object.entries(raw.commands ?? {})) {
    commandDocs[cmd] = normalizeCommandEntry(githubDocsBase, entry);
  }
  const stageCatalog = {};
  for (const [stageId, stageEntry] of Object.entries(raw.stageCatalog ?? {})) {
    stageCatalog[stageId] = {
      autoSubCommands: Array.isArray(stageEntry?.autoSubCommands) ? [...stageEntry.autoSubCommands] : [],
      moreCommands: Array.isArray(stageEntry?.moreCommands) ? [...stageEntry.moreCommands] : [],
    };
  }
  return {
    githubDocsBase,
    commandDocs,
    stageCatalog,
    delegateGuide: raw.delegateGuide ?? { stages: [], delegateMenu: [] },
    colleagueReviewGuide: raw.colleagueReviewGuide ?? { intents: [] },
  };
}

const loaded = loadCommandCatalog();

export const GITHUB_DOCS_BASE = loaded.githubDocsBase;
export const COMMAND_DOCS = loaded.commandDocs;
export const STAGE_COMMAND_CATALOG = loaded.stageCatalog;
export const DELEGATE_GUIDE_DATA = loaded.delegateGuide;
export const COLLEAGUE_REVIEW_GUIDE = loaded.colleagueReviewGuide;
