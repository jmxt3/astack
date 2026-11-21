import { PASS_THROUGH_SCHEMA, bootMcpApp, domEl, renderStatus } from "./theme.js";

let fileInfo = { name: "Specification.tla", resourceUri: null };
let specSource = "";
let hostCtx = {};

function decodeContentResult(res) {
  const item = Array.isArray(res?.contents) ? res.contents[0] : null;
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.blob === "string") {
    const bin = atob(item.blob);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  return "";
}

function parseTlaOutline(text) {
  const moduleMatch = text.match(/----\s*MODULE\s+([A-Za-z0-9_]+)\s*----/);
  const extMatch = text.match(/^\s*EXTENDS\s+(.+)$/m);
  const varsMatch = text.match(/^\s*VARIABLES?\s+(.+)$/m);
  const defs = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*==/);
    if (m) defs.push(m[1]);
  }
  return {
    moduleName: moduleMatch ? moduleMatch[1] : "Unknown",
    extendsList: extMatch ? extMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [],
    variables: varsMatch ? varsMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [],
    definitions: defs,
  };
}

function renderViewer(app) {
  const root = document.getElementById("app");
  if (!root) return;

  const outline = parseTlaOutline(specSource);
  const canWrite = Boolean(hostCtx?.["com.google.antigravity/resources"]?.write && fileInfo.resourceUri);

  const shell = domEl("div", "shell");
  const hdr = domEl("div", "hdr");
  hdr.appendChild(domEl("h2", "title", `${fileInfo.name} (${outline.moduleName})`));
  const badges = domEl("div", "badges");
  badges.appendChild(domEl("span", "pill", `${outline.variables.length} vars`));
  badges.appendChild(domEl("span", "pill", `${outline.definitions.length} defs`));
  if (canWrite) badges.appendChild(domEl("span", "pill ok", "Writable"));
  hdr.appendChild(badges);
  shell.appendChild(hdr);

  const metaCard = domEl("div", "card");
  metaCard.appendChild(domEl("h3", "card-title", "TLA+ Outline"));
  metaCard.appendChild(domEl("div", "row", `EXTENDS: ${outline.extendsList.join(", ") || "none"}`));
  metaCard.appendChild(domEl("div", "row", `VARIABLES: ${outline.variables.join(", ") || "none"}`));
  metaCard.appendChild(domEl("div", "row mono", `DEFINITIONS: ${outline.definitions.join(", ") || "none"}`));
  shell.appendChild(metaCard);

  const editor = document.createElement("textarea");
  editor.value = specSource;
  editor.readOnly = !canWrite;
  editor.spellcheck = false;
  editor.style.cssText =
    "width:100%;min-height:240px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg-2);color:var(--fg);font-family:var(--mono);font-size:12px;line-height:1.45;resize:vertical;";
  editor.addEventListener("input", () => {
    specSource = editor.value;
  });
  shell.appendChild(editor);

  if (canWrite) {
    const actions = domEl("div", "actions");
    const saveBtn = domEl("button", "btn primary", "Save .tla");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      renderStatus("Saving...");
      try {
        await app.request(
          {
            method: "com.google.antigravity/resources/write",
            params: { uri: fileInfo.resourceUri, text: specSource },
          },
          PASS_THROUGH_SCHEMA,
        );
        renderViewer(app);
        renderStatus("Saved to workspace.");
      } catch (err) {
        renderStatus(`Save failed: ${err.message}`);
      }
    });
    actions.appendChild(saveBtn);
    shell.appendChild(actions);
  }

  const statusLine = domEl("div", "status-line");
  statusLine.id = "status-line";
  shell.appendChild(statusLine);
  root.replaceChildren(shell);
}

async function loadSpec(info, app) {
  if (!info?.resourceUri) {
    specSource = "";
    renderViewer(app);
    return;
  }
  try {
    const res = await app.request(
      { method: "resources/read", params: { uri: info.resourceUri } },
      PASS_THROUGH_SCHEMA,
    );
    specSource = decodeContentResult(res);
    renderViewer(app);
  } catch (err) {
    renderStatus(`Could not load ${info.name}: ${err.message}`);
  }
}

const { connect } = bootMcpApp("AStack TLA+ Viewer", {
  onInput: (args, app) => {
    if (args?.file) {
      fileInfo = { name: args.file.name || "Specification.tla", resourceUri: args.file.resourceUri || null };
      renderViewer(app);
    }
  },
  onResult: async (result, app) => {
    const f = result?.structuredContent?.file;
    if (f) {
      fileInfo = { name: f.name || "Specification.tla", resourceUri: f.resourceUri || null };
      await loadSpec(fileInfo, app);
    }
  },
  onHostChange: (ctx, app) => {
    hostCtx = { ...hostCtx, ...ctx };
    renderViewer(app);
  },
});

connect().then(({ context }) => {
  hostCtx = context || {};
}).catch((err) => {
  renderStatus(`MCP host connection warning: ${err.message}`);
});
