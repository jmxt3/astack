import { bootMcpApp, domEl, openFileInSidePane, renderErrorCard, renderStatus } from "./theme.js";

let latestData = null;
let activeSeverity = "all";
let hostCaps = {};

function tierClass(tier) {
  if (tier >= 3) return "err";
  if (tier === 2) return "warn";
  if (tier === 0) return "ok";
  return "";
}

function toneClass(tone) {
  if (tone === "err") return "err";
  if (tone === "warn") return "warn";
  if (tone === "ok") return "ok";
  return "";
}

function pluralFiles(count) {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function copyToClipboard(text, label) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => renderStatus(`Copied ${label}: ${text}`),
      () => renderStatus(`Copy ready (${label}): ${text}`),
    );
    return;
  }
  renderStatus(`Copy ready (${label}): ${text}`);
}

function makeFileLink(app, pathText, line, uri, suffix = "") {
  const btn = domEl("button", "link-btn", `${pathText}:${line || 1}${suffix}`);
  btn.type = "button";
  btn.addEventListener("click", () => {
    if (uri) openFileInSidePane(app, uri, renderStatus);
    else renderStatus(`File path: ${pathText}:${line || 1}`);
  });
  return btn;
}

function renderDossier(data, app) {
  latestData = data;
  const root = document.getElementById("app");
  if (!root || !data?.evidence) return;
  const vm = data.viewModel;
  if (!vm) {
    renderErrorCard("AStack PR Dossier", "Dossier view model unavailable. Re-run /pre-pr.");
    return;
  }
  const hdrInfo = vm.header;
  const dec = vm.decision;

  const shell = domEl("div", "shell");
  const hdr = domEl("div", "hdr");
  hdr.appendChild(domEl("h2", "title", "AStack PR Dossier"));
  const badges = domEl("div", "badges");
  badges.appendChild(domEl("span", `pill ${tierClass(hdrInfo.riskTier)}`, `Tier ${hdrInfo.riskTier} (${hdrInfo.riskLabel})`));
  badges.appendChild(domEl("span", `pill ${toneClass(hdrInfo.freshnessTone)}`, `${hdrInfo.freshness} · ${hdrInfo.shortHead}`));
  badges.appendChild(domEl("span", "pill", `Round ${hdrInfo.reviewRound}/${hdrInfo.maxReviewRounds} (${hdrInfo.roundState})`));
  hdr.appendChild(badges);
  shell.appendChild(hdr);

  const banner = domEl("section", `banner ${toneClass(dec.tone)}`);
  const bannerHead = domEl("div", "banner-head");
  const bannerLeft = domEl("div", "banner-left");
  bannerLeft.appendChild(domEl("span", "banner-tag", dec.badge));
  bannerLeft.appendChild(domEl("h3", "banner-title", dec.headline));
  bannerHead.appendChild(bannerLeft);
  bannerHead.appendChild(
    domEl(
      "span",
      `pill ${toneClass(dec.tone)}`,
      `Inherent ${dec.inherentScore.toFixed(2)} -> Residual ${dec.residualScore.toFixed(2)} (${dec.residual})`,
    ),
  );
  banner.appendChild(bannerHead);

  const whyP = domEl("p", "banner-line");
  whyP.append(domEl("strong", "", "Why: "), document.createTextNode(dec.why));
  const nextP = domEl("p", "banner-line");
  nextP.append(domEl("strong", "", "Next: "), document.createTextNode(dec.next));
  banner.append(whyP, nextP);
  shell.appendChild(banner);

  const intentStrip = domEl("div", "intent-strip");
  const intentLeft = domEl("div", "intent-left");
  const intentBadgeText = !vm.intentStrip.declared
    ? "No Intent Card"
    : vm.intentStrip.inScope
      ? "In Scope"
      : `Scope Drift (${vm.intentStrip.driftedCount})`;
  const intentBadgeTone = !vm.intentStrip.declared ? "" : vm.intentStrip.inScope ? "ok" : "err";
  intentLeft.appendChild(domEl("span", `pill ${intentBadgeTone}`, intentBadgeText));
  if (vm.intentStrip.goal) {
    intentLeft.appendChild(domEl("span", "intent-goal", vm.intentStrip.goal));
  }
  const rbWrap = domEl("div", "rollback-wrap");
  rbWrap.appendChild(domEl("code", "rollback-code", vm.intentStrip.rollbackPlan));
  const copyRb = domEl("button", "btn btn-sm", "Copy");
  copyRb.type = "button";
  copyRb.addEventListener("click", () => copyToClipboard(vm.intentStrip.rollbackPlan, "rollback command"));
  rbWrap.appendChild(copyRb);
  intentStrip.append(intentLeft, rbWrap);
  shell.appendChild(intentStrip);

  const sigCard = domEl("div", "card");
  const sigHead = domEl("div", "card-head");
  sigHead.appendChild(domEl("h3", "card-title", "Signals & Guardrails"));
  const delta = vm.assertionSummary;
  const netSign = delta.net >= 0 ? "+" : "";
  const netText = `Assertions +${delta.added} / -${delta.removed} (net ${netSign}${delta.net}) · ${delta.flagged ? "FLAGGED" : "Safe"}`;
  sigHead.appendChild(domEl("span", `pill ${delta.flagged ? "err" : "ok"}`, netText));
  sigCard.appendChild(sigHead);

  if (delta.flagged && delta.flaggedFiles.length > 0) {
    const ratioPct = Math.round((delta.weakeningRatio || 0) * 100);
    const capPct = Math.round((delta.maxAllowedRatio || 0.25) * 100);
    const flagBox = domEl("div", "stale-alert");
    flagBox.appendChild(document.createTextNode(`Weakening ratio ${ratioPct}% exceeds ${capPct}% cap in `));
    delta.flaggedFiles.forEach((f, idx) => {
      if (idx > 0) flagBox.appendChild(document.createTextNode(", "));
      flagBox.appendChild(makeFileLink(app, f.path, f.line, f.uri));
    });
    sigCard.appendChild(flagBox);
  }

  for (const sig of vm.signals) {
    const row = domEl("div", "signal-row");
    const info = domEl("div", "signal-info");
    const head = domEl("div", "signal-head");
    head.appendChild(domEl("span", `pill ${toneClass(sig.tone)}`, sig.badge));
    head.appendChild(domEl("span", "mono", sig.id));
    info.appendChild(head);
    if (sig.evidence) info.appendChild(domEl("div", "muted", sig.evidence));
    row.appendChild(info);
    if (sig.file) {
      row.appendChild(makeFileLink(app, sig.file, sig.line || 1, sig.uri));
    }
    sigCard.appendChild(row);
  }

  if (vm.guardrails.length > 0) {
    const strip = domEl("div", "pill-strip");
    for (const g of vm.guardrails) {
      const pillTone = toneClass(g.tone);
      const pill = domEl("span", `pill ${pillTone}`, `${g.label}: ${g.status}`);
      pill.title = g.detail || "";
      strip.appendChild(pill);
    }
    sigCard.appendChild(strip);
  }
  if (vm.trustSummary?.line) {
    const trustRow = domEl("div", "row");
    trustRow.appendChild(domEl("span", "muted", vm.trustSummary.line));
    sigCard.appendChild(trustRow);
    if (vm.trustSummary.autoMergeReason) {
      sigCard.appendChild(domEl("p", "empty", vm.trustSummary.autoMergeReason));
    }
  }
  shell.appendChild(sigCard);

  const read = vm.reading;
  const readCard = domEl("div", "card");
  const readHead = domEl("div", "card-head");
  readHead.appendChild(
    domEl("h3", "card-title", `Guided Reading (${pluralFiles(read.totalFiles)} · +${read.totalAdditions}/-${read.totalDeletions})`),
  );
  readHead.appendChild(
    domEl("span", "muted", read.reviewFirst.length > 0 ? "Review First pinned" : "All low-risk"),
  );
  readCard.appendChild(readHead);

  if (read.totalFiles === 0) {
    readCard.appendChild(domEl("p", "empty", "No changed files against base ref."));
  } else {
    if (read.reviewFirst.length > 0) {
      const pinBox = domEl("div", "pin-box");
      pinBox.appendChild(domEl("div", "pin-title", `Review First (${pluralFiles(read.reviewFirst.length)} flagged Tier 2/3)`));
      for (const f of read.reviewFirst) {
        const row = domEl("div", "file-row");
        const left = domEl("div", "file-left");
        left.appendChild(domEl("span", `pill ${tierClass(f.tier)}`, `Tier ${f.tier}`));
        for (const s of f.signals || []) {
          left.appendChild(domEl("span", `pill ${toneClass(dec.tone === "err" ? "err" : "warn")}`, s));
        }
        left.appendChild(makeFileLink(app, f.path, f.line, f.uri));
        row.appendChild(left);
        row.appendChild(domEl("span", "muted mono", `+${f.additions}/-${f.deletions}`));
        pinBox.appendChild(row);
      }
      readCard.appendChild(pinBox);
    }

    if (read.remainingClusters.length > 0) {
      const det = domEl("details");
      if (read.reviewFirst.length === 0) det.open = true;
      const sum = domEl("summary");
      sum.appendChild(
        domEl("span", "", `Other ${pluralFiles(read.remainingFileCount)} across ${read.remainingClusters.length} clusters`),
      );
      sum.appendChild(domEl("span", "muted", "Expand"));
      det.appendChild(sum);
      for (const cl of read.remainingClusters) {
        const sub = domEl("div", "cluster-sub");
        sub.appendChild(
          domEl("div", "cluster-sub-title", `${cl.title} (${pluralFiles(cl.files.length)} · +${cl.additions}/-${cl.deletions})`),
        );
        for (const f of cl.files) {
          const row = domEl("div", "file-row");
          row.appendChild(makeFileLink(app, f.path, f.line, f.uri));
          row.appendChild(domEl("span", "muted mono", `+${f.additions}/-${f.deletions}`));
          sub.appendChild(row);
        }
        det.appendChild(sub);
      }
      readCard.appendChild(det);
    }
  }
  shell.appendChild(readCard);

  const ver = vm.verifier;
  const verCard = domEl("div", "card");
  const verHead = domEl("div", "card-head");
  verHead.appendChild(domEl("h3", "card-title", "Independent PR Verifier"));
  if (ver.verdict) {
    verHead.appendChild(domEl("span", `pill ${toneClass(ver.verdictTone)}`, ver.verdict));
  }
  verCard.appendChild(verHead);

  if (!ver.attached) {
    verCard.appendChild(domEl("p", "empty", "No findings.json attached yet. Run /pre-pr to audit HEAD."));
  } else {
    if (ver.stale) {
      verCard.appendChild(
        domEl(
          "div",
          "stale-alert",
          `Stale report: verified ${ver.verifiedHead || "an older commit"}, current HEAD is ${hdrInfo.shortHead}. Re-run /pre-pr.`,
        ),
      );
    }
    if (ver.summary) {
      verCard.appendChild(domEl("p", "banner-line", ver.summary));
    }
    const compStrip = domEl("div", "pill-strip");
    const vCount = ver.reviewMdViolations.length;
    compStrip.appendChild(
      domEl(
        "span",
        `pill ${vCount > 0 ? "err" : "ok"}`,
        vCount > 0 ? `Base REVIEW.md: ${vCount} violation(s)` : "Base REVIEW.md: checked, 0 violations",
      ),
    );
    if (ver.counts.all === 0) {
      compStrip.appendChild(domEl("span", "pill", "0 important · 0 nit · 0 pre-existing"));
    }
    verCard.appendChild(compStrip);

    if (ver.counts.all > 0) {
      const tabs = domEl("div", "tabs");
      tabs.style.marginTop = "8px";
      for (const sev of ["all", "important", "nit", "pre_existing"]) {
        const cnt = ver.counts[sev] ?? 0;
        const tab = domEl("button", `tab ${activeSeverity === sev ? "active" : ""}`, `${sev} (${cnt})`);
        tab.type = "button";
        tab.addEventListener("click", () => {
          activeSeverity = sev;
          renderDossier(latestData, app);
        });
        tabs.appendChild(tab);
      }
      verCard.appendChild(tabs);

      const visible = activeSeverity === "all"
        ? ver.findings
        : ver.findings.filter((f) => f.severity === activeSeverity);
      if (visible.length === 0) {
        verCard.appendChild(domEl("p", "empty", "No matching findings in this category."));
      } else {
        for (const item of visible) {
          const card = domEl("div", "finding-card");
          const fHead = domEl("div", "finding-head");
          const meta = domEl("div", "finding-meta");
          meta.appendChild(domEl("span", `pill ${item.severity === "important" ? "err" : "warn"}`, item.severity));
          meta.appendChild(domEl("span", "", `${item.id} · ${item.category}`));
          fHead.appendChild(meta);
          if (item.ruleRef) fHead.appendChild(domEl("span", "muted mono", item.ruleRef));
          card.appendChild(fHead);
          card.appendChild(domEl("div", "", item.claim));
          if (item.evidence) card.appendChild(domEl("div", "muted", `Evidence: ${item.evidence}`));
          if (item.suggestedFix) card.appendChild(domEl("div", "", `Suggested fix: ${item.suggestedFix}`));
          if (item.file) card.appendChild(makeFileLink(app, item.file, item.line || 1, item.uri));
          verCard.appendChild(card);
        }
      }
    }

    if (ver.dropped.length > 0) {
      const det = domEl("details", "dropped-details");
      const sum = domEl("summary");
      sum.appendChild(
        domEl("span", "", `Checked & ruled out (${ver.dropped.length} dropped ${ver.dropped.length === 1 ? "claim" : "claims"})`),
      );
      sum.appendChild(domEl("span", "muted", "Expand"));
      det.appendChild(sum);
      const list = domEl("ul", "dropped-list");
      for (const d of ver.dropped) {
        const li = domEl("li");
        li.append(domEl("strong", "", d.claim), document.createTextNode(`: ${d.reason}`));
        list.appendChild(li);
      }
      det.appendChild(list);
      verCard.appendChild(det);
    }
  }
  shell.appendChild(verCard);

  const actions = domEl("div", "actions");
  if (vm.actions.canOpenPrReview && vm.actions.prReviewUri) {
    const openBtn = domEl("button", `btn ${vm.actions.canFixImportant ? "" : "primary"}`, "Open pr-review.md");
    openBtn.type = "button";
    openBtn.addEventListener("click", () => openFileInSidePane(app, vm.actions.prReviewUri, renderStatus));
    actions.appendChild(openBtn);
  }
  if (hostCaps?.message && vm.actions.canFixImportant) {
    const fixBtn = domEl("button", "btn primary", `Fix ${ver.counts.important} important`);
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
  if (hostCaps?.message && vm.actions.needsRerun) {
    const rerunBtn = domEl("button", `btn ${!vm.actions.canFixImportant && !vm.actions.canOpenPrReview ? "primary" : ""}`, "Re-run /pre-pr");
    rerunBtn.type = "button";
    rerunBtn.addEventListener("click", async () => {
      renderStatus("Sending /pre-pr request to conversation...");
      try {
        await app.sendMessage({
          role: "user",
          content: [{ type: "text", text: "/pre-pr Re-compile PR dossier and verify HEAD." }],
        });
        renderStatus("Sent /pre-pr request.");
      } catch (err) {
        renderStatus(`Could not send message: ${err.message}`);
      }
    });
    actions.appendChild(rerunBtn);
  }
  if (hostCaps?.updateModelContext) {
    const ctxBtn = domEl("button", "btn", "Attach summary to chat");
    ctxBtn.type = "button";
    ctxBtn.addEventListener("click", async () => {
      const summary = `PR Dossier: ${dec.badge} (${dec.headline}), Tier ${hdrInfo.riskTier} (${hdrInfo.riskLabel}), freshness=${hdrInfo.freshness}, inherent=${dec.inherentScore.toFixed(2)}, residual=${dec.residualScore.toFixed(2)}, important=${ver.counts.important}, round=${hdrInfo.reviewRound}/${hdrInfo.maxReviewRounds}.`;
      try {
        await app.updateModelContext({ content: [{ type: "text", text: summary }] });
        renderStatus("Attached dossier summary to your next message.");
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
    if (result?.isError || !result?.structuredContent) {
      const msg = result?.content?.find((c) => c?.type === "text")?.text || "Could not compile PR dossier.";
      renderErrorCard("AStack PR Dossier", msg);
      return;
    }
    renderDossier(result.structuredContent, app);
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
