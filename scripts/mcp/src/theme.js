import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

export const PASS_THROUGH_SCHEMA = {
  "~standard": {
    version: 1,
    vendor: "astack",
    validate: (value) => ({ value }),
  },
};

export const BASE_THEME_CSS = `
  :root {
    color-scheme: light dark;
    --bg: var(--color-background-primary, #ffffff);
    --bg-2: var(--color-background-secondary, #f5f6f8);
    --bg-3: var(--color-background-tertiary, #eceef2);
    --fg: var(--color-text-primary, #1b1d21);
    --fg-muted: var(--color-text-secondary, #5a6069);
    --fg-faint: var(--color-text-tertiary, #828993);
    --border: var(--color-border-primary, rgba(27, 29, 33, 0.14));
    --accent: var(--color-ring-primary, #2563eb);
    --ok: var(--color-text-success, #16a34a);
    --ok-bg: var(--color-background-success, rgba(22, 163, 74, 0.12));
    --warn: var(--color-text-warning, #b45309);
    --warn-bg: var(--color-background-warning, rgba(180, 83, 9, 0.12));
    --err: var(--color-text-danger, #dc2626);
    --err-bg: var(--color-background-danger, rgba(220, 38, 38, 0.12));
    --font: var(--font-sans, system-ui, -apple-system, sans-serif);
    --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  }
  :root[data-theme="dark"] {
    --bg: var(--color-background-primary, #131519);
    --bg-2: var(--color-background-secondary, #1a1d23);
    --bg-3: var(--color-background-tertiary, #232730);
    --fg: var(--color-text-primary, #eef0f4);
    --fg-muted: var(--color-text-secondary, #a2a8b4);
    --fg-faint: var(--color-text-tertiary, #747b87);
    --border: var(--color-border-primary, rgba(238, 240, 244, 0.14));
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font-family: var(--font); font-size: 13px; line-height: 1.45; }
  .shell { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .hdr { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
  .title { font-size: 14px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
  .badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--bg-2); border: 1px solid var(--border); color: var(--fg-muted); }
  .pill.ok { color: var(--ok); background: var(--ok-bg); border-color: color-mix(in srgb, var(--ok) 32%, transparent); }
  .pill.warn { color: var(--warn); background: var(--warn-bg); border-color: color-mix(in srgb, var(--warn) 32%, transparent); }
  .pill.err { color: var(--err); background: var(--err-bg); border-color: color-mix(in srgb, var(--err) 32%, transparent); }
  .card { background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .card-title { margin: 0 0 6px; font-size: 12px; font-weight: 600; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.03em; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; border-top: 1px solid var(--border); }
  .row:first-child { border-top: 0; }
  .btn { appearance: none; border: 1px solid var(--border); background: var(--bg); color: var(--fg); font: inherit; font-size: 12px; font-weight: 500; padding: 5px 10px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
  .btn:hover:not(:disabled) { background: var(--bg-3); border-color: var(--accent); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.primary { background: color-mix(in srgb, var(--accent) 16%, var(--bg)); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
  .link-btn { appearance: none; border: 0; background: transparent; color: var(--accent); font-family: var(--mono); font-size: 12px; padding: 0; cursor: pointer; text-align: left; word-break: break-all; }
  .link-btn:hover { text-decoration: underline; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .status-line { font-size: 11.5px; color: var(--fg-muted); min-height: 16px; }
  .muted { color: var(--fg-muted); }
  .mono { font-family: var(--mono); }
  details { border: 1px solid var(--border); border-radius: 7px; background: var(--bg-2); padding: 6px 10px; }
  summary { cursor: pointer; font-weight: 600; font-size: 12.5px; list-style: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .tabs { display: flex; flex-wrap: wrap; gap: 6px; }
  .tab { padding: 3px 9px; border-radius: 999px; font-size: 11.5px; border: 1px solid var(--border); background: var(--bg); color: var(--fg-muted); cursor: pointer; }
  .tab.active { background: var(--bg-3); color: var(--fg); border-color: var(--accent); font-weight: 600; }
  .empty { color: var(--fg-faint); font-size: 12px; margin: 0; }
  .meter { height: 6px; border-radius: 999px; background: var(--bg-3); overflow: hidden; margin-top: 6px; }
  .meter-fill { height: 100%; background: var(--ok); }
  .meter-fill.warn { background: var(--warn); }
  .meter-fill.err { background: var(--err); }
`;

export function domEl(tag, cls = "", text = null) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

export function applyContextTheme(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

export async function openFileInSidePane(app, fileUri, setStatus) {
  if (!fileUri) return;
  try {
    const res = await app.request(
      { method: "com.google.antigravity/toggle-aux-pane", params: { tabType: "fileView", uri: fileUri } },
      PASS_THROUGH_SCHEMA,
    );
    if (res?.isError && setStatus) {
      setStatus(`File path copied: ${fileUri}`);
    }
  } catch (err) {
    if (setStatus) {
      setStatus(err?.code === -32601 ? `Side pane open unsupported by host (${fileUri})` : `Could not open ${fileUri}`);
    }
  }
}

export function bootMcpApp(appName, { onInput, onResult, onCancel, onHostChange } = {}) {
  const app = new App({ name: appName, version: "0.4.0" }, {}, { autoResize: true });

  app.ontoolinput = (params) => onInput?.(params?.arguments ?? {}, app);
  app.ontoolresult = (result) => onResult?.(result, app);
  app.ontoolcancelled = (params) => onCancel?.(params?.reason ?? "Cancelled", app);
  app.onhostcontextchanged = (ctx) => {
    applyContextTheme(ctx);
    onHostChange?.(ctx, app);
  };

  return {
    app,
    connect: async () => {
      await app.connect();
      const ctx = app.getHostContext();
      applyContextTheme(ctx);
      onHostChange?.(ctx, app);
      return {
        capabilities: app.getHostCapabilities(),
        context: ctx,
      };
    },
  };
}
