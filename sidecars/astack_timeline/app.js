(() => {
  const POLL_MS = 1800;
  const ATTENTION_STATUSES = new Set(["waiting_gate", "stale", "error", "next", "active"]);
  const AUTO_EXPAND_STATUSES = new Set(["waiting_gate", "stale", "error"]);
  const DOCS_URL_PREFIX = "https://github.com/jmxt3/astack/";
  const PASTE_SHORTCUT = /mac/i.test(navigator.platform || navigator.userAgent || "") ? "Cmd+V" : "Ctrl+V";
  const params = new URLSearchParams(location.search);
  const state = {
    etag: "",
    snap: null,
    workspaceUri: params.get("workspaceUri") || "",
    setupDrawerOpen: false,
    expanded: new Set(),
    moreExpanded: new Set(),
    userToggled: false,
    toastTimer: null,
    popoverHideTimer: null,
    popoverAnchor: null,
  };

  function syncScheme() {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;color:var(--background, #f7f7f8)";
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith("color(") ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? "dark" : "light";
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }

  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svgIcon(kind) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    const strokeWidth = kind === "check" ? "2.5" : kind === "check-sm" ? "2.3" : kind === "external" ? "1.8" : "1.7";
    svg.setAttribute("stroke-width", strokeWidth);
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const size = kind === "check-sm" || kind === "external" ? "11px" : "12px";
    svg.style.width = size;
    svg.style.height = size;
    svg.style.flex = "none";

    const add = (tag, attrs) => {
      const p = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      svg.appendChild(p);
    };

    if (kind === "check" || kind === "check-sm") {
      add("path", { d: "M3.5 8.5 6.5 11.5 12.5 4.8" });
    } else if (kind === "warn") {
      add("path", { d: "M8 4.4v4.3" });
      add("circle", { cx: "8", cy: "11.6", r: "0.6", fill: "currentColor" });
    } else if (kind === "gate") {
      add("circle", { cx: "8", cy: "8", r: "2.8", fill: "currentColor", stroke: "none" });
    } else if (kind === "doc") {
      add("path", { d: "M4.5 2.5h5l2.5 2.5v8.5h-7.5z" });
      add("path", { d: "M9.5 2.5V5H12" });
    } else if (kind === "external") {
      add("path", { d: "M5 11 11 5" });
      add("path", { d: "M6.5 5H11v4.5" });
    } else if (kind === "copy") {
      add("rect", { x: "5.5", y: "5.5", width: "7.5", height: "7.5", rx: "1.4" });
      add("path", { d: "M10 5.5V4a1.2 1.2 0 0 0-1.2-1.2H4A1.2 1.2 0 0 0 2.8 4v4.8A1.2 1.2 0 0 0 4 10h1.5" });
    } else if (kind === "chevron") {
      add("path", { d: "M6 4.5 9.5 8 6 11.5" });
    }
    return svg;
  }

  function showToast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  async function writeClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  function focusActiveChat() {
    const convId = window.sidecar?.conversationId || params.get("conversationId") || "";
    if (convId && typeof window.sidecar?.ui?.toggleConversation === "function") {
      window.sidecar.ui.toggleConversation(convId);
    }
  }

  async function copyCommand(itemOrText, buttonEl) {
    const displayCmd = String(typeof itemOrText === "string" ? itemOrText : (itemOrText?.command ?? "")).trim();
    const payload = String(typeof itemOrText === "string" ? itemOrText : (itemOrText?.copyText ?? displayCmd)).trim();
    if (!payload) return;
    const ok = await writeClipboard(payload);
    if (ok) {
      if (buttonEl) {
        if (buttonEl._copiedTimer) clearTimeout(buttonEl._copiedTimer);
        buttonEl.classList.add("copied");
        buttonEl._copiedTimer = setTimeout(() => {
          buttonEl.classList.remove("copied");
          buttonEl._copiedTimer = null;
        }, 900);
      }
      focusActiveChat();
      showToast(`Copied "${payload}" · Paste in chat (${PASTE_SHORTCUT})`);
      return;
    }
    showToast(`Copy blocked · Type "${displayCmd}" in chat`);
  }

  async function openArtifact(artifact) {
    if (window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri: artifact.uri });
      return;
    }
    const ok = await writeClipboard(artifact.uri);
    showToast(ok ? `Copied ${artifact.name} path` : `Could not copy ${artifact.name} path`);
  }

  function cancelHidePopover() {
    if (state.popoverHideTimer) {
      clearTimeout(state.popoverHideTimer);
      state.popoverHideTimer = null;
    }
  }

  function hideCommandPopover() {
    cancelHidePopover();
    const pop = document.getElementById("cmd-popover");
    if (!pop) return;
    pop.classList.add("hidden");
    pop.replaceChildren();
    if (state.popoverAnchor) {
      state.popoverAnchor.removeAttribute("aria-describedby");
      state.popoverAnchor = null;
    }
  }

  function scheduleHidePopover() {
    cancelHidePopover();
    state.popoverHideTimer = setTimeout(hideCommandPopover, 180);
  }

  function findCommandMeta(snap, command) {
    const sections = [snap?.setup, ...(snap?.stages || [])];
    for (const sec of sections) {
      if (!sec) continue;
      for (const list of [sec.commands, sec.autoSubCommands, sec.moreCommands]) {
        const found = list?.find((c) => c.command === command);
        if (found) return found;
      }
    }
    return null;
  }

  function positionCommandPopover(pop, anchorEl) {
    const pad = 12;
    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const maxLeft = Math.max(pad, window.innerWidth - popRect.width - pad);
    const left = Math.min(Math.max(pad, anchorRect.left), maxLeft);
    const fitsBelow = anchorRect.bottom + 6 + popRect.height <= window.innerHeight - pad;
    const top = fitsBelow
      ? anchorRect.bottom + 6
      : Math.max(pad, anchorRect.top - popRect.height - 6);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function showCommandPopover(anchorEl, item) {
    if (!item?.description) return;
    const pop = document.getElementById("cmd-popover");
    if (!pop) return;
    cancelHidePopover();
    if (state.popoverAnchor && state.popoverAnchor !== anchorEl) {
      state.popoverAnchor.removeAttribute("aria-describedby");
    }
    state.popoverAnchor = anchorEl;
    anchorEl.setAttribute("aria-describedby", "cmd-popover");

    const head = el("div", "cmd-popover-head");
    head.appendChild(el("span", "cmd-popover-name", item.command));
    if (typeof item.docsUrl === "string" && item.docsUrl.startsWith(DOCS_URL_PREFIX)) {
      const link = el("a", "cmd-popover-doc");
      link.href = item.docsUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.appendChild(el("span", "", "Docs"));
      link.appendChild(svgIcon("external"));
      head.appendChild(link);
    }

    pop.replaceChildren(
      head,
      el("p", "cmd-popover-desc", item.description),
      el("div", "cmd-popover-foot", `Click to copy and focus chat (${PASTE_SHORTCUT})`),
    );
    pop.classList.remove("hidden");
    positionCommandPopover(pop, anchorEl);
  }

  function attachCommandPopover(elNode, item) {
    if (!item?.description) return;
    elNode.addEventListener("mouseenter", () => showCommandPopover(elNode, item));
    elNode.addEventListener("mouseleave", scheduleHidePopover);
    elNode.addEventListener("focus", () => showCommandPopover(elNode, item));
    elNode.addEventListener("blur", scheduleHidePopover);
  }

  function statusPill(status) {
    if (status === "waiting_gate") return el("span", "pill gate", "Gate");
    if (status === "stale") return el("span", "pill stale", "Stale");
    if (status === "error") return el("span", "pill error", "Escalated");
    if (status === "next") return el("span", "pill next", "Next");
    if (status === "active") return el("span", "pill active", "Active");
    if (status === "skipped") return el("span", "pill muted", "Skipped");
    return null;
  }

  function wireCommandAction(node, itemOrText, stopPropagation = true) {
    const displayCmd = typeof itemOrText === "string" ? itemOrText : (itemOrText?.command ?? "");
    const item = typeof itemOrText === "object" && itemOrText !== null ? itemOrText : null;
    if (item?.description) {
      node.setAttribute("aria-label", `Copy ${displayCmd}`);
      attachCommandPopover(node, item);
    } else if (displayCmd) {
      node.title = `Copy ${displayCmd}`;
    }
    node.addEventListener("click", (ev) => {
      if (stopPropagation) ev.stopPropagation();
      copyCommand(item || displayCmd, node);
    });
  }

  function buildCommandChip(item, classNameOverride) {
    const cls = classNameOverride || (item.optional ? `chip optional ${item.state}` : `chip ${item.state}`);
    const chip = el("button", cls);
    chip.type = "button";
    wireCommandAction(chip, item);
    if (item.state === "done") {
      const ic = svgIcon("check-sm");
      ic.classList.add("chip-icon");
      chip.appendChild(ic);
    } else if (item.state === "stale") {
      const ic = svgIcon("warn");
      ic.classList.add("chip-icon");
      chip.appendChild(ic);
    }
    chip.appendChild(el("span", "", item.command));
    return chip;
  }

  function appendSubCommands(container, sectionId, autoSubCommands, moreCommands) {
    if (Array.isArray(autoSubCommands) && autoSubCommands.length > 0) {
      const subWrap = el("div", "subcmd-section");
      subWrap.appendChild(el("div", "subcmd-label", "Triggered automatically"));
      const subList = el("div", "subcmd-list");
      for (const sub of autoSubCommands) {
        const pill = el("button", sub.ran ? "subcmd-pill ran" : "subcmd-pill");
        pill.type = "button";
        wireCommandAction(pill, sub);
        if (sub.ran) {
          const ic = svgIcon("check-sm");
          ic.classList.add("chip-icon");
          pill.appendChild(ic);
        } else {
          pill.appendChild(el("span", "subcmd-dot", "·"));
        }
        pill.appendChild(el("span", "", sub.command));
        subList.appendChild(pill);
      }
      subWrap.appendChild(subList);
      container.appendChild(subWrap);
    }

    if (Array.isArray(moreCommands) && moreCommands.length > 0) {
      const isMoreOpen = state.moreExpanded.has(sectionId);
      const ranCount = moreCommands.filter((c) => c.state === "done").length;
      const moreWrap = el("div", "more-section");
      const toggle = el("button", "more-toggle");
      toggle.type = "button";
      toggle.dataset.testid = `more-toggle-${sectionId}`;
      toggle.setAttribute("aria-expanded", String(isMoreOpen));
      const chev = svgIcon("chevron");
      chev.classList.add("chev");
      toggle.appendChild(chev);
      toggle.appendChild(el("span", "", `More commands (${moreCommands.length})`));
      if (ranCount > 0) {
        toggle.appendChild(el("span", "more-ran", `· ${ranCount} ran`));
      }
      toggle.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (state.moreExpanded.has(sectionId)) state.moreExpanded.delete(sectionId);
        else state.moreExpanded.add(sectionId);
        render(state.snap);
      });
      moreWrap.appendChild(toggle);

      if (isMoreOpen) {
        const moreChips = el("div", "more-chips");
        moreChips.dataset.testid = `more-chips-${sectionId}`;
        for (const item of moreCommands) {
          moreChips.appendChild(buildCommandChip(item));
        }
        moreWrap.appendChild(moreChips);
      }
      container.appendChild(moreWrap);
    }
  }

  function render(snap) {
    document.getElementById("progress").textContent = `${snap.doneCount} / ${snap.totalCount}`;
    const live = document.getElementById("live");
    const liveMode = !snap.hasConversation ? "idle" : snap.liveState;
    live.className = `live ${liveMode}`;
    document.getElementById("live-label").textContent = snap.liveLabel;

    const metaParts = [];
    if (snap.workspaceName) {
      metaParts.push(snap.branch ? `${snap.workspaceName} (${snap.branch})` : snap.workspaceName);
    }
    if (snap.riskTier !== null && snap.riskTier !== undefined) {
      metaParts.push(`Tier ${snap.riskTier}`);
    }
    if (snap.freshness) {
      metaParts.push(snap.freshness);
    }
    const setupReady = snap.setup?.status === "ready";
    const metaRow = document.getElementById("meta-row");
    metaRow.replaceChildren();
    if (metaParts.length > 0 || setupReady) {
      metaRow.classList.remove("hidden");
      metaParts.forEach((part, idx) => {
        if (idx > 0) metaRow.appendChild(el("span", "meta-sep", "·"));
        metaRow.appendChild(el("span", "", part));
      });
      if (setupReady) {
        if (metaParts.length > 0) metaRow.appendChild(el("span", "meta-sep", "·"));
        const setupToggle = el("button", "meta-btn");
        setupToggle.type = "button";
        setupToggle.dataset.testid = "timeline-setup-toggle";
        setupToggle.setAttribute("aria-expanded", String(state.setupDrawerOpen));
        setupToggle.appendChild(svgIcon("check-sm"));
        setupToggle.appendChild(el("span", "", "Setup ready"));
        setupToggle.addEventListener("click", () => {
          state.setupDrawerOpen = !state.setupDrawerOpen;
          render(state.snap);
        });
        metaRow.appendChild(setupToggle);
      }
    } else {
      metaRow.classList.add("hidden");
    }

    const setupDrawer = document.getElementById("setup-drawer");
    setupDrawer.replaceChildren();
    if (setupReady && state.setupDrawerOpen) {
      setupDrawer.classList.remove("hidden");
      setupDrawer.appendChild(el("p", "setup-drawer-detail", snap.setup.detail));
      const chips = el("div", "chips");
      for (const item of snap.setup.commands || []) {
        chips.appendChild(buildCommandChip(item));
      }
      setupDrawer.appendChild(chips);
      appendSubCommands(setupDrawer, "setup", snap.setup.autoSubCommands, snap.setup.moreCommands);
    } else {
      setupDrawer.classList.add("hidden");
    }

    const setupCard = document.getElementById("setup-card");
    setupCard.replaceChildren();
    if (snap.setup?.status === "needs_setup") {
      setupCard.classList.remove("hidden");
      const copyWrap = el("div", "setup-card-copy");
      copyWrap.appendChild(el("div", "setup-card-kicker", "First-time setup · Once per repo"));
      copyWrap.appendChild(el("p", "setup-card-hint", snap.setup.summary));
      setupCard.appendChild(copyWrap);
      const setupItem = snap.setup.commands?.[0];
      if (setupItem) {
        setupCard.appendChild(buildCommandChip(setupItem, "chip next"));
      }
    } else {
      setupCard.classList.add("hidden");
    }

    const nextBar = document.getElementById("next-bar");
    nextBar.replaceChildren();
    const suppressSetupNext = snap.setup?.status === "needs_setup" && snap.nextAction?.stageId === "setup";
    if (snap.nextAction && !suppressSetupNext) {
      nextBar.classList.remove("hidden");
      const copyWrap = el("div", "next-copy");
      copyWrap.appendChild(el("div", "next-kicker", `Next · ${snap.nextAction.stageLabel}`));
      copyWrap.appendChild(el("p", "next-hint", snap.nextAction.hint));
      nextBar.appendChild(copyWrap);

      const cmdBtn = el("button", "chip next");
      cmdBtn.type = "button";
      const nextMeta = findCommandMeta(snap, snap.nextAction.command);
      wireCommandAction(cmdBtn, nextMeta || snap.nextAction.command, false);
      cmdBtn.appendChild(el("span", "", snap.nextAction.command));
      cmdBtn.appendChild(svgIcon("copy"));
      nextBar.appendChild(cmdBtn);
    } else {
      nextBar.classList.add("hidden");
    }

    if (!state.userToggled) {
      state.expanded.clear();
      const focus = snap.stages.find((s) => AUTO_EXPAND_STATUSES.has(s.status));
      if (focus) state.expanded.add(focus.id);
    }

    const list = document.getElementById("timeline");
    list.replaceChildren();

    snap.stages.forEach((stage, idx) => {
      const isLast = idx === snap.stages.length - 1;
      const isExpanded = state.expanded.has(stage.id);
      const li = el("li", `step ${stage.status}`);
      if (ATTENTION_STATUSES.has(stage.status)) {
        li.setAttribute("aria-current", "step");
      }

      const rail = el("div", "rail");
      const node = el("span", `node ${stage.status}`);
      node.setAttribute("aria-hidden", "true");
      if (stage.status === "done") node.appendChild(svgIcon("check"));
      else if (stage.status === "stale" || stage.status === "error") node.appendChild(svgIcon("warn"));
      else if (stage.status === "waiting_gate") node.appendChild(svgIcon("gate"));
      rail.appendChild(node);
      if (!isLast) {
        const stem = el("span", `stem ${stage.status === "done" || stage.status === "skipped" ? "done" : ""}`);
        stem.setAttribute("aria-hidden", "true");
        rail.appendChild(stem);
      }
      li.appendChild(rail);

      const body = el("div", "step-body");
      const stepBtn = el("button", "step-btn");
      stepBtn.type = "button";
      stepBtn.setAttribute("aria-expanded", String(isExpanded));
      stepBtn.addEventListener("click", () => {
        state.userToggled = true;
        if (state.expanded.has(stage.id)) state.expanded.delete(stage.id);
        else state.expanded.add(stage.id);
        render(state.snap);
      });

      stepBtn.appendChild(el("span", "step-title", `${stage.number}. ${stage.label}`));
      const badge = statusPill(stage.status);
      if (badge) stepBtn.appendChild(badge);
      else if (stage.gate === "GATE" && stage.status === "pending") {
        stepBtn.appendChild(el("span", "pill muted", "Gate"));
      }
      const chev = svgIcon("chevron");
      chev.classList.add("chev");
      stepBtn.appendChild(chev);
      body.appendChild(stepBtn);

      if (stage.summary) {
        body.appendChild(el("p", "stage-summary", stage.summary));
      }

      const chips = el("div", "chips");
      for (const item of stage.commands) {
        chips.appendChild(buildCommandChip(item));
      }
      body.appendChild(chips);

      if (isExpanded) {
        const detail = el("div", "detail");
        detail.appendChild(el("p", "detail-text", stage.detail));
        if (Array.isArray(stage.subChecks) && stage.subChecks.length > 0) {
          const subRow = el("div", "subchecks");
          for (const sub of stage.subChecks) {
            const mark = sub.status === "done" ? "✓" : sub.status === "stale" ? "!" : "·";
            subRow.appendChild(el("span", `subcheck ${sub.status}`, `${sub.label} ${mark}`));
          }
          detail.appendChild(subRow);
        }
        if (stage.artifact) {
          const artBtn = el("button", "artifact-btn");
          artBtn.type = "button";
          artBtn.appendChild(svgIcon("doc"));
          artBtn.appendChild(el("span", "", `Open ${stage.artifact.name}`));
          artBtn.addEventListener("click", () => openArtifact(stage.artifact));
          detail.appendChild(artBtn);
        }
        appendSubCommands(detail, stage.id, stage.autoSubCommands, stage.moreCommands);
        body.appendChild(detail);
      }

      li.appendChild(body);
      list.appendChild(li);
    });

    const footer = document.getElementById("panel-footer");
    if (footer) {
      const helpMeta = findCommandMeta(snap, "/astack-help") || {
        command: "/astack-help",
        copyText: "/astack-help",
        state: "pending",
        optional: true,
      };
      const helpChip = buildCommandChip(helpMeta);
      const refLink = el("a", "footer-link");
      refLink.href = `${DOCS_URL_PREFIX}blob/main/docs/agent-timeline.md`;
      refLink.target = "_blank";
      refLink.rel = "noopener noreferrer";
      refLink.appendChild(el("span", "", "Full timeline reference"));
      refLink.appendChild(svgIcon("external"));
      footer.replaceChildren(helpChip, refLink);
    }

    if (state.popoverAnchor && !document.contains(state.popoverAnchor)) {
      hideCommandPopover();
    }
  }

  async function poll() {
    if (document.hidden) return;
    const convId = window.sidecar?.conversationId || params.get("conversationId") || "";
    const qs = new URLSearchParams();
    if (convId) qs.set("conversationId", convId);
    if (state.workspaceUri) qs.set("workspaceUri", state.workspaceUri);
    if (state.etag) qs.set("etag", state.etag);
    const token = params.get("token");
    if (token) qs.set("token", token);
    const url = `/api/timeline?${qs.toString()}`;
    try {
      const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
      const res = await f(url, { method: "GET" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.unchanged) return;
      state.etag = data.etag || "";
      state.snap = data;
      render(data);
    } catch {
      document.getElementById("live").className = "live idle";
      document.getElementById("live-label").textContent = "Offline";
    }
  }

  async function syncWorkspaceUri() {
    if (typeof window.sidecar?.getWorkspaceUris !== "function") return;
    try {
      const uris = await window.sidecar.getWorkspaceUris();
      const first = Array.isArray(uris) && typeof uris[0] === "string" ? uris[0].trim() : "";
      if (first && first !== state.workspaceUri) {
        state.workspaceUri = first;
        state.etag = "";
        poll();
      }
    } catch {
    }
  }

  if (typeof window.sidecar?.onWorkspaceChange === "function") {
    try {
      window.sidecar.onWorkspaceChange((uris) => {
        const first = Array.isArray(uris) && typeof uris[0] === "string" ? uris[0].trim() : "";
        if (first !== state.workspaceUri) {
          state.workspaceUri = first;
          state.etag = "";
          poll();
        }
      });
    } catch {
    }
  }

  const popEl = document.getElementById("cmd-popover");
  if (popEl) {
    popEl.addEventListener("mouseenter", cancelHidePopover);
    popEl.addEventListener("mouseleave", scheduleHidePopover);
    popEl.addEventListener("focusin", cancelHidePopover);
    popEl.addEventListener("focusout", scheduleHidePopover);
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideCommandPopover();
  });
  document.addEventListener("scroll", hideCommandPopover, { capture: true, passive: true });
  document.addEventListener("click", (ev) => {
    if (!popEl || popEl.classList.contains("hidden")) return;
    if (popEl.contains(ev.target)) return;
    if (state.popoverAnchor && state.popoverAnchor.contains(ev.target)) return;
    hideCommandPopover();
  });

  syncWorkspaceUri();
  poll();
  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) poll();
  });
})();
