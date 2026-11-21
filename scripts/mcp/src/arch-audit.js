import { bootMcpApp, domEl, openFileInSidePane, renderStatus } from "./theme.js";

let latestReport = null;
let hostCaps = {};

function addSection(shell, title, items, renderItem) {
  const card = domEl("div", "card");
  card.appendChild(domEl("h3", "card-title", `${title} (${items.length})`));
  if (items.length === 0) {
    card.appendChild(domEl("p", "empty", "None detected."));
  } else {
    items.slice(0, 25).forEach((item) => card.appendChild(renderItem(item)));
  }
  shell.appendChild(card);
}

function renderAudit(report, app) {
  latestReport = report;
  const root = document.getElementById("app");
  if (!root || !report?.summary) return;
  const s = report.summary;

  const shell = domEl("div", "shell");
  const hdr = domEl("div", "hdr");
  hdr.appendChild(domEl("h2", "title", "AStack Architecture Audit"));
  const badges = domEl("div", "badges");
  badges.appendChild(domEl("span", `pill ${report.ok ? "ok" : "err"}`, report.ok ? "PASS" : "VIOLATIONS"));
  badges.appendChild(domEl("span", "pill", `${s.filesScanned} files`));
  badges.appendChild(domEl("span", `pill ${s.shallowModules > 0 ? "warn" : ""}`, `${s.shallowModules} shallow`));
  badges.appendChild(domEl("span", `pill ${s.gardeningHits > 0 ? "warn" : ""}`, `${s.gardeningHits} gardening`));
  hdr.appendChild(badges);
  shell.appendChild(hdr);

  addSection(shell, "Boundary & Banned Pattern Hits", [
    ...(report.boundaryViolations || []),
    ...(report.bannedHits || []),
  ], (hit) => {
    const row = domEl("div", "row");
    const box = domEl("div");
    const btn = domEl("button", "link-btn", hit.file);
    btn.type = "button";
    btn.addEventListener("click", () => openFileInSidePane(app, hit.uri, renderStatus));
    box.append(btn, domEl("div", "muted", hit.detail));
    row.appendChild(box);
    return row;
  });

  addSection(shell, "Shallow Module Warnings", report.shallowModules || [], (mod) => {
    const row = domEl("div", "row");
    const box = domEl("div");
    const btn = domEl("button", "link-btn", mod.file);
    btn.type = "button";
    btn.addEventListener("click", () => openFileInSidePane(app, mod.uri, renderStatus));
    box.append(btn, domEl("div", "muted", mod.reason));
    row.appendChild(box);
    return row;
  });

  addSection(shell, "Gardening Hits", report.gardeningHits || [], (hit) => {
    const row = domEl("div", "row");
    const box = domEl("div");
    const btn = domEl("button", "link-btn", `${hit.file}:${hit.line}`);
    btn.type = "button";
    btn.addEventListener("click", () => openFileInSidePane(app, hit.uri, renderStatus));
    box.append(btn, domEl("div", "muted mono", `[${hit.id}] ${hit.snippet}`));
    row.appendChild(box);
    return row;
  });

  const actions = domEl("div", "actions");
  if (hostCaps?.message) {
    const correctBtn = domEl("button", "btn primary", "Run /correct");
    correctBtn.type = "button";
    correctBtn.addEventListener("click", async () => {
      try {
        await app.sendMessage({
          role: "user",
          content: [{ type: "text", text: "/correct Review architecture audit findings and encode structural guards in types, lints, or .agents/boundaries.json." }],
        });
        renderStatus("Sent /correct prompt.");
      } catch (err) {
        renderStatus(`Could not send message: ${err.message}`);
      }
    });
    actions.appendChild(correctBtn);
  }
  if (hostCaps?.updateModelContext) {
    const ctxBtn = domEl("button", "btn", "Attach audit context");
    ctxBtn.type = "button";
    ctxBtn.addEventListener("click", async () => {
      const txt = `Architecture Audit (${report.ok ? "PASS" : "FAIL"}): files=${s.filesScanned}, boundaries=${s.boundaryViolations}, banned=${s.bannedHits}, shallow=${s.shallowModules}, gardening=${s.gardeningHits}.`;
      try {
        await app.updateModelContext({ content: [{ type: "text", text: txt }] });
        renderStatus("Attached audit context.");
      } catch (err) {
        renderStatus(`Could not attach context: ${err.message}`);
      }
    });
    actions.appendChild(ctxBtn);
  }
  if (actions.children.length > 0) shell.appendChild(actions);

  const statusLine = domEl("div", "status-line");
  statusLine.id = "status-line";
  shell.appendChild(statusLine);
  root.replaceChildren(shell);
}

const { connect } = bootMcpApp("AStack Architecture Audit", {
  onInput: () => {
    const root = document.getElementById("app");
    if (root && !latestReport) {
      root.replaceChildren(domEl("div", "shell", "Scanning repository architecture..."));
    }
  },
  onResult: (result, app) => {
    if (result?.structuredContent) renderAudit(result.structuredContent, app);
  },
  onHostChange: (_ctx, app) => {
    hostCaps = app.getHostCapabilities() || {};
    if (latestReport) renderAudit(latestReport, app);
  },
});

connect().then(({ capabilities }) => {
  hostCaps = capabilities || {};
}).catch((err) => {
  renderStatus(`MCP host connection warning: ${err.message}`);
});
