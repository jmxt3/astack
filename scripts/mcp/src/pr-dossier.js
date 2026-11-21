import { bootMcpApp, domEl, openFileInSidePane, renderStatus } from "./theme.js";

let latestData = null;
let activeSeverity = "all";
let hostCaps = {};

function tierClass(tier) {
  if (tier >= 3) return "err";
  if (tier === 2) return "warn";
  if (tier === 0) return "ok";
  return "";
}

function freshnessClass(freshness) {
  if (freshness === "fresh" || freshness === "fresh_rebase_patch_id") return "ok";
  if (freshness === "missing_receipts") return "warn";
  return "err";
}

function renderDossier(data, app) {
  latestData = data;
  const root = document.getElementById("app");
  if (!root || !data?.evidence) return;
  const ev = data.evidence;
  const findingsDoc = data.findingsDoc || null;

  const shell = domEl("div", "shell");
  const hdr = domEl("div", "hdr");
  const titleWrap = domEl("h2", "title", "AStack PR Dossier");
  const badges = domEl("div", "badges");
  badges.appendChild(domEl("span", `pill ${tierClass(ev.riskTier)}`, `Tier ${ev.riskTier} (${ev.riskLabel})`));
  badges.appendChild(domEl("span", `pill ${freshnessClass(ev.freshness)}`, `${ev.freshness} · ${(ev.headSha || "none").slice(0, 7)}`));
  badges.appendChild(domEl("span", "pill", `Round ${ev.reviewRound}/${ev.maxReviewRounds} (${ev.roundState})`));
  hdr.append(titleWrap, badges);
  shell.appendChild(hdr);

  const delta = ev.assertionDelta || { added: 0, removed: 0, weakeningRatio: 0, flagged: false };
  const meterCard = domEl("div", "card");
  meterCard.appendChild(domEl("h3", "card-title", "Diff Signals & Test Integrity"));
  const deltaRow = domEl("div", "row");
  deltaRow.appendChild(domEl("span", "", `Test assertions: +${delta.added} / -${delta.removed} (ratio ${delta.weakeningRatio})`));
  deltaRow.appendChild(
    domEl("span", `pill ${delta.flagged ? "err" : "ok"}`, delta.flagged ? "FLAGGED" : ev.autoMergeEligible ? "Tier 0 Auto" : "Human Review"),
  );
  meterCard.appendChild(deltaRow);
  const meter = domEl("div", "meter");
  const pct = Math.min(100, Math.round((Number(delta.weakeningRatio) || 0) * 100));
  const fill = domEl("div", `meter-fill ${delta.flagged ? "err" : pct > 10 ? "warn" : ""}`);
  fill.style.width = `${Math.max(4, pct || 4)}%`;
  meter.appendChild(fill);
  meterCard.appendChild(meter);
  shell.appendChild(meterCard);

  const clusters = Array.isArray(ev.clusters) ? ev.clusters : [];
  const clusterWrap = domEl("div", "card");
  clusterWrap.appendChild(domEl("h3", "card-title", `Guided Reading Clusters (${clusters.length})`));
  if (clusters.length === 0) {
    clusterWrap.appendChild(domEl("p", "empty", "No changed files against base ref."));
  } else {
    clusters.forEach((cl, idx) => {
      const det = domEl("details");
      if (idx === 0) det.open = true;
      const sum = domEl("summary");
      sum.appendChild(domEl("span", "", cl.title || cl.id));
      sum.appendChild(domEl("span", "muted mono", `${(cl.files || []).length} files · +${cl.additions}/-${cl.deletions}`));
      det.appendChild(sum);
      const links = Array.isArray(cl.fileLinks) ? cl.fileLinks : [];
      links.forEach((f) => {
        const row = domEl("div", "row");
        const btn = domEl("button", "link-btn", `${f.path}:${f.line}`);
        btn.type = "button";
        btn.addEventListener("click", () => openFileInSidePane(app, f.uri, renderStatus));
        row.appendChild(btn);
        det.appendChild(row);
      });
      clusterWrap.appendChild(det);
    });
  }
  shell.appendChild(clusterWrap);

  const findingsCard = domEl("div", "card");
  const allFindings = Array.isArray(findingsDoc?.findings) ? findingsDoc.findings : [];
  findingsCard.appendChild(
    domEl(
      "h3",
      "card-title",
      findingsDoc ? `PR Verifier (${findingsDoc.verdict})` : "PR Verifier",
    ),
  );
  if (!findingsDoc) {
    findingsCard.appendChild(domEl("p", "empty", "No findings.json attached yet."));
  } else {
    const tabs = domEl("div", "tabs");
    for (const sev of ["all", "important", "nit", "pre_existing"]) {
      const cnt = sev === "all" ? allFindings.length : allFindings.filter((f) => f.severity === sev).length;
      const tab = domEl("button", `tab ${activeSeverity === sev ? "active" : ""}`, `${sev} (${cnt})`);
      tab.type = "button";
      tab.addEventListener("click", () => {
        activeSeverity = sev;
        renderDossier(latestData, app);
      });
      tabs.appendChild(tab);
    }
    findingsCard.appendChild(tabs);

    const visible = activeSeverity === "all" ? allFindings : allFindings.filter((f) => f.severity === activeSeverity);
    if (visible.length === 0) {
      findingsCard.appendChild(domEl("p", "empty", "No matching findings in this category."));
    } else {
      visible.forEach((item) => {
        const row = domEl("div", "row");
        const info = domEl("div");
        info.appendChild(domEl("div", "", `[${item.severity}] ${item.claim}`));
        if (item.uri) {
          const fileBtn = domEl("button", "link-btn", `${item.file}:${item.line} (${item.category})`);
          fileBtn.type = "button";
          fileBtn.addEventListener("click", () => openFileInSidePane(app, item.uri, renderStatus));
          info.appendChild(fileBtn);
        }
        row.appendChild(info);
        findingsCard.appendChild(row);
      });
    }
  }
  shell.appendChild(findingsCard);

  const actions = domEl("div", "actions");
  if (hostCaps?.message && allFindings.some((f) => f.severity === "important")) {
    const fixBtn = domEl("button", "btn primary", "Fix important findings");
    fixBtn.type = "button";
    fixBtn.addEventListener("click", async () => {
      renderStatus("Sending fix request to conversation...");
      try {
        await app.sendMessage({
          role: "user",
          content: [{ type: "text", text: "/astack-mode Fix the verified important findings from findings.json and re-verify on HEAD." }],
        });
        renderStatus("Sent fix request.");
      } catch (err) {
        renderStatus(`Could not send message: ${err.message}`);
      }
    });
    actions.appendChild(fixBtn);
  }
  if (hostCaps?.updateModelContext) {
    const ctxBtn = domEl("button", "btn", "Attach review context");
    ctxBtn.type = "button";
    ctxBtn.addEventListener("click", async () => {
      const importantCnt = allFindings.filter((f) => f.severity === "important").length;
      const summary = `PR Dossier: Tier ${ev.riskTier} (${ev.riskLabel}), freshness=${ev.freshness}, importantFindings=${importantCnt}, round=${ev.reviewRound}/${ev.maxReviewRounds}.`;
      try {
        await app.updateModelContext({ content: [{ type: "text", text: summary }] });
        renderStatus("Attached dossier context to your next message.");
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

const { connect } = bootMcpApp("AStack PR Dossier", {
  onInput: () => {
    const root = document.getElementById("app");
    if (root && !latestData) {
      root.replaceChildren(domEl("div", "shell", "Compiling PR review dossier..."));
    }
  },
  onResult: (result, app) => {
    if (result?.structuredContent) renderDossier(result.structuredContent, app);
  },
  onHostChange: (_ctx, app) => {
    hostCaps = app.getHostCapabilities() || {};
    if (latestData) renderDossier(latestData, app);
  },
});

connect().then(({ capabilities }) => {
  hostCaps = capabilities || {};
}).catch((err) => {
  renderStatus(`MCP host connection warning: ${err.message}`);
});
