(() => {
  const POLL_MS = 1800;
  const POLL_TIMEOUT_MS = 8000;
  const LOADING_GRACE_MS = 180;
  const INITIAL_WS_WAIT_MS = 80;
  const DOCS_URL_PREFIX = "https://github.com/jmxt3/astack/";
  const PASTE_SHORTCUT = /mac/i.test(navigator.platform || navigator.userAgent || "") ? "Cmd+V" : "Ctrl+V";
  const params = new URLSearchParams(location.search);

  const state = {
    etag: "",
    pollSeq: 0,
    pollTimer: null,
    pollInFlight: false,
    pollAbort: null,
    loadingTimer: null,
    trustActionSeq: 0,
    lastPollError: null,
    snap: null,
    workspaceUri: params.get("workspaceUri") || "",
    view:
      params.get("view") === "delegate" || location.hash === "#delegate"
        ? "delegate"
        : params.get("view") === "trust" || location.hash === "#trust"
          ? "trust"
          : params.get("view") === "dossier" || location.hash === "#dossier"
            ? "dossier"
            : params.get("view") === "audit" || location.hash === "#audit"
              ? "audit"
              : "timeline",
    dossier: { loading: false, data: null, error: null, severity: "all", reqSeq: 0 },
    audit: { loading: false, data: null, error: null, reqSeq: 0 },
    guideExpandedStage: null,
    guideUserToggled: false,
    guideCmdDrawerOpen: false,
    guideSelectedExampleByStage: {},
    setupDrawerOpen: false,
    beastDrawerOpen: false,
    panelMode: "build",
    panelModeUserToggled: false,
    lastConversationId: "",
    reviewPrExpandedIntent: null,
    reviewPrMoreOpen: false,
    expanded: new Set(),
    moreExpanded: new Set(),
    subExpanded: { swarm: false, goal: false, more: false },
    highlightTarget: null,
    solo: null,
    artifact: null,
    artifactReturnEl: null,
    userToggled: false,
    toastTimer: null,
    popoverHideTimer: null,
    popoverAnchor: null,
    suppressedPopoverEl: null,
    progressPopover: null,
    pulsedTimers: new Set(),
  };

  let rail = null;
  let railStages = [];
  let railWrap = null;
  let railList = null;
  let prevLiveIds = new Set();
  let railAnnounceReady = false;
  let railAnnounceTimer = null;
  let pendingAnnouncements = [];
  const PAD_TOP = 32;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svgIcon(kind, sizePx = 12) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    const box = kind === "chevron" ? "0 0 16 16" : kind === "diamond" ? "0 0 10 10" : kind === "active-arc" ? "0 0 18 18" : "0 0 14 14";
    svg.setAttribute("viewBox", box);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.style.width = `${sizePx}px`;
    svg.style.height = `${sizePx}px`;
    svg.style.flex = "none";

    const add = (tag, attrs) => {
      const p = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      svg.appendChild(p);
    };

    if (kind === "check" || kind === "check-sm") {
      svg.setAttribute("stroke-width", kind === "check" ? "2.1" : "1.8");
      add("path", { d: "M3 7.4 5.9 10.2 11.2 4.2" });
    } else if (kind === "warn") {
      svg.setAttribute("stroke-width", "1.7");
      add("path", { d: "M7 3.5v4.3" });
      add("circle", { cx: "7", cy: "10.6", r: "0.75", fill: "currentColor", stroke: "none" });
    } else if (kind === "gate") {
      add("circle", { cx: "7", cy: "7", r: "2.6", fill: "currentColor", stroke: "none" });
    } else if (kind === "active-arc") {
      svg.setAttribute("stroke-width", "1.6");
      add("path", { d: "M9 1.75 A7.25 7.25 0 0 1 16.25 9" });
    } else if (kind === "chevron") {
      svg.setAttribute("stroke-width", "1.5");
      add("path", { d: "M6 4 10 8 6 12" });
    } else if (kind === "back") {
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("stroke-width", "1.6");
      add("path", { d: "M10 4 6 8 10 12" });
    } else if (kind === "external") {
      svg.setAttribute("stroke-width", "1.4");
      add("path", { d: "M4 10 10 4" });
      add("path", { d: "M5.5 4H10v4.5" });
    } else if (kind === "copy") {
      svg.setAttribute("stroke-width", "1.2");
      add("rect", { x: "4.5", y: "4.5", width: "7", height: "7", rx: "1.3" });
      add("path", { d: "M9 4.5V3.1A1.1 1.1 0 0 0 7.9 2H3.1A1.1 1.1 0 0 0 2 3.1v4.8A1.1 1.1 0 0 0 3.1 9H4.5" });
    } else if (kind === "diamond") {
      svg.setAttribute("stroke-width", "1.3");
      add("path", { d: "M5 0.8 9.2 5 5 9.2 0.8 5 Z" });
    } else if (kind === "plus") {
      svg.setAttribute("stroke-width", "1.5");
      add("path", { d: "M7 2.5v9M2.5 7h9" });
    } else if (kind === "arrow-return") {
      svg.setAttribute("stroke-width", "1.3");
      add("path", { d: "M11 3v4.5H3M5.5 5 3 7.5 5.5 10" });
    } else if (kind === "swarm") {
      svg.setAttribute("stroke-width", "1.1");
      add("path", { d: "M7 7 2.5 3.5M7 7 11.8 4M7 7 8.6 12", "stroke-opacity": "0.7" });
      add("circle", { cx: "7", cy: "7", r: "1.6", fill: "currentColor", stroke: "none" });
      add("circle", { cx: "2.5", cy: "3.5", r: "1.3", fill: "currentColor", stroke: "none" });
      add("circle", { cx: "11.8", cy: "4", r: "1.3", fill: "currentColor", stroke: "none" });
      add("circle", { cx: "8.6", cy: "12", r: "1.3" });
    } else if (kind === "orbit") {
      svg.setAttribute("stroke-width", "1.2");
      add("ellipse", { cx: "7", cy: "7", rx: "6", ry: "2.6" });
      add("circle", { cx: "7", cy: "7", r: "1.3", fill: "currentColor", stroke: "none" });
      add("circle", { cx: "12.3", cy: "8.1", r: "1.4", fill: "currentColor", stroke: "none" });
    } else if (kind === "loop") {
      svg.setAttribute("stroke-width", "1.3");
      add("path", { d: "M11.6 7.6A4.7 4.7 0 1 1 9.9 3.2" });
      add("path", { d: "M9.6 1.4 10.1 3.4 8.1 3.9" });
      add("circle", { cx: "7", cy: "7", r: "1.3", fill: "currentColor", stroke: "none" });
    } else if (kind === "spiral") {
      svg.setAttribute("stroke-width", "1.3");
      add("path", { d: "M3 2 7 4.5 11 2M3 5.8 7 8.3 11 5.8" });
      add("circle", { cx: "7", cy: "11.6", r: "1.4", fill: "currentColor", stroke: "none" });
    } else if (kind === "lanes") {
      svg.setAttribute("stroke-width", "1.2");
      add("path", { d: "M1.5 3.5H7L12 7M1.5 7H12M1.5 10.5H7L12 7" });
      add("circle", { cx: "12.3", cy: "7", r: "1.3", fill: "currentColor", stroke: "none" });
    } else if (kind === "milestone") {
      svg.setAttribute("stroke-width", "1.2");
      add("path", { d: "M1.5 9.5H11" });
      add("circle", { cx: "3", cy: "9.5", r: "1.3", fill: "currentColor", stroke: "none" });
      add("circle", { cx: "6.8", cy: "9.5", r: "1.3", fill: "currentColor", stroke: "none" });
      add("path", { d: "M10.5 9.5V2.8L13 4.2 10.5 5.6" });
    } else if (kind === "clock") {
      svg.setAttribute("stroke-width", "1.2");
      add("circle", { cx: "7", cy: "7", r: "5.4" });
      add("path", { d: "M7 3.9V7l2.2 1.4" });
    } else if (kind === "cycle") {
      svg.setAttribute("stroke-width", "1.2");
      add("path", { d: "M2.6 6A4.6 4.6 0 0 1 11 4.2M11.4 8A4.6 4.6 0 0 1 3 9.8" });
      add("path", { d: "M11.2 1.9 11.1 4.4 8.7 4.1M2.8 12.1 2.9 9.6 5.3 9.9" });
    } else if (kind === "browser") {
      svg.setAttribute("stroke-width", "1.1");
      add("rect", { x: "1.5", y: "2.5", width: "11", height: "9", rx: "1.6" });
      add("path", { d: "M1.5 5.2h11" });
      add("circle", { cx: "3.4", cy: "3.9", r: "0.6", fill: "currentColor", stroke: "none" });
      add("circle", { cx: "5.2", cy: "3.9", r: "0.6", fill: "currentColor", stroke: "none" });
    } else if (kind === "fork") {
      svg.setAttribute("stroke-width", "1.3");
      add("path", { d: "M4 12.5V1.5M4 8.5C4 5.6 7.4 5.2 9.6 3.6" });
      add("circle", { cx: "10.6", cy: "2.9", r: "1.5" });
    } else if (kind === "doc") {
      svg.setAttribute("stroke-width", "1.1");
      add("rect", { x: "2.5", y: "1.5", width: "9", height: "11", rx: "1.5" });
      add("path", { d: "M4.8 5h4.4M4.8 7.4h4.4M4.8 9.8h2.8" });
    } else if (kind === "book") {
      svg.setAttribute("stroke-width", "1.1");
      add("path", { d: "M7 3.6C5.4 2.5 3.4 2.4 1.6 2.9v8.3c1.8-.5 3.8-.4 5.4.7 1.6-1.1 3.6-1.2 5.4-.7V2.9C10.6 2.4 8.6 2.5 7 3.6ZM7 3.6v8.3" });
    } else if (kind === "compact") {
      svg.setAttribute("stroke-width", "1.1");
      add("path", { d: "M2 4.5h3v-3M12 4.5H9v-3M2 9.5h3v3M12 9.5H9v3" });
    } else if (kind === "pr") {
      svg.setAttribute("stroke-width", "1.3");
      add("circle", { cx: "4", cy: "3.2", r: "1.5" });
      add("circle", { cx: "4", cy: "10.8", r: "1.5" });
      add("circle", { cx: "10.2", cy: "10.8", r: "1.5" });
      add("path", { d: "M4 4.7v4.6M10.2 9.3V5.4A1.8 1.8 0 0 0 8.4 3.6H7.2" });
      add("path", { d: "M8.3 2.4 7 3.6l1.3 1.2" });
    } else if (kind === "pr-merged") {
      svg.setAttribute("stroke-width", "1.3");
      add("circle", { cx: "4", cy: "3.2", r: "1.5" });
      add("circle", { cx: "4", cy: "10.8", r: "1.5" });
      add("circle", { cx: "10.2", cy: "10.8", r: "1.5" });
      add("path", { d: "M4 4.7v4.6M4 4.7c0 3 2.4 6.1 4.7 6.1" });
    } else if (kind === "stop") {
      svg.setAttribute("stroke-width", "1.3");
      add("circle", { cx: "7", cy: "7", r: "5.2" });
      add("path", { d: "M5.1 5.1l3.8 3.8M8.9 5.1l-3.8 3.8" });
    }
    return svg;
  }

  function syncScheme() {
    const bg = getComputedStyle(document.documentElement).backgroundColor;
    const nums = (bg.match(/[\d.]+/g) || []).map(Number);
    if (nums.length >= 3 && (nums.length < 4 || nums[3] > 0)) {
      const scale = bg.startsWith("color(") ? 1 : 255;
      const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const theme = lum < 0.5 ? "dark" : "light";
      if (document.documentElement.dataset.theme !== theme) {
        document.documentElement.dataset.theme = theme;
      }
      rail?.refreshTheme();
    }
  }

  function getConversationId(includeSnap = false) {
    return window.sidecar?.conversationId || params.get("conversationId") || (includeSnap ? state.snap?.conversationId : "") || "";
  }

  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });

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

  async function openWorkspaceFile(uri, label) {
    if (uri && typeof window.sidecar?.ui?.toggleAuxPane === "function") {
      try {
        await window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri });
        return;
      } catch {
      }
    }
    const target = label || uri || "";
    if (!target) return;
    const ok = await writeClipboard(target);
    showToast(ok ? `Path copied: ${target}` : target);
  }

  function focusActiveChat() {
    const convId = getConversationId(false);
    if (convId && typeof window.sidecar?.ui?.toggleConversation === "function") {
      window.sidecar.ui.toggleConversation(convId);
    }
  }

  async function copyCommand(itemOrText, buttonEl, promptToastMode = false) {
    const displayCmd = String(typeof itemOrText === "string" ? itemOrText : itemOrText?.command ?? "").trim();
    const payload = String(typeof itemOrText === "string" ? itemOrText : itemOrText?.copyText ?? displayCmd).trim();
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
      if (promptToastMode && payload.length > 28) {
        showToast(`Copied ${payload.split(" ")[0]} prompt · paste it in the chat (${PASTE_SHORTCUT})`);
      } else {
        showToast(`Copied "${payload}" · Paste in chat (${PASTE_SHORTCUT})`);
      }
      return;
    }
    showToast(`Copy blocked · Type "${displayCmd || payload}" in chat`);
  }

  function isSdkHost() {
    return typeof window.sidecar?.fetch === "function" && !window.sidecar?.standalone;
  }

  function apiFetch(endpoint, payload, fetchOpts = {}) {
    if (isSdkHost()) {
      const opts = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      };
      if (fetchOpts.signal) opts.signal = fetchOpts.signal;
      return window.sidecar.fetch(endpoint, opts);
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(payload || {})) {
      if (v === undefined || v === null || v === "" || v === false) continue;
      qs.set(k, v === true ? "1" : String(v));
    }
    const query = qs.toString();
    const urlToken = params.get("token");
    const headers = urlToken ? { "X-Sidecar-Token": urlToken } : undefined;
    const opts = { method: "GET", headers };
    if (fetchOpts.signal) opts.signal = fetchOpts.signal;
    return fetch(query ? `${endpoint}?${query}` : endpoint, opts);
  }

  function apiPost(endpoint, payload) {
    if (isSdkHost()) {
      return window.sidecar.fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
    }
    const headers = { "Content-Type": "application/json" };
    const urlToken = params.get("token");
    if (urlToken) headers["X-Sidecar-Token"] = urlToken;
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload || {}),
    });
  }

  function applyTrustPatchToSnapshot(nextTrust) {
    if (!state.snap?.trust || !nextTrust) return;
    const prev = state.snap.trust;
    const categories = Array.isArray(nextTrust.categoryList) ? nextTrust.categoryList : prev.categories;
    const activeCatState =
      nextTrust.categories?.[prev.activeCategory] ??
      categories.find((c) => c.id === prev.activeCategory) ??
      prev.activeCatState;
    let promoBanner = null;
    if (!nextTrust.frozen) {
      if (nextTrust.lastAutoPromo) {
        promoBanner = { kind: "auto", ...nextTrust.lastAutoPromo };
      } else {
        const readyCat =
          (activeCatState?.promoReady ? activeCatState : null) ??
          categories.find((c) => c.promoReady);
        if (readyCat) {
          promoBanner = {
            kind: "manual",
            catId: readyCat.id,
            toLvl: readyCat.eligibleNextLevel,
            count: readyCat.clean + readyCat.edited,
            score: readyCat.score,
            brier: readyCat.brier,
          };
        }
      }
    }
    state.snap = {
      ...state.snap,
      trust: {
        ...prev,
        beastOn: Boolean(nextTrust.beastOn),
        promotionMode: nextTrust.promotionMode || prev.promotionMode,
        promotionLockedByPolicy: Boolean(nextTrust.promotionLockedByPolicy),
        chainValid: nextTrust.chainValid !== false,
        frozen: Boolean(nextTrust.frozen),
        totalOutcomes: Number(nextTrust.totalOutcomes ?? prev.totalOutcomes ?? 0),
        activeCatState,
        categories,
        promoBanner,
      },
    };
    render(state.snap);
  }

  async function updateTrustSettings(actionPayload, successMsg) {
    const actionSeq = ++state.trustActionSeq;
    state.pollSeq += 1;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.pollInFlight) {
      state.pollAbort?.abort();
      state.pollInFlight = false;
      state.pollAbort = null;
    }
    try {
      const res = await apiPost("/api/trust/settings", {
        ...actionPayload,
        conversationId: getConversationId(true),
        workspaceUri: state.workspaceUri,
      });
      const data = await res.json().catch(() => ({}));
      if (actionSeq !== state.trustActionSeq) {
        return;
      }
      if (!res.ok) {
        showToast(data?.error || `Settings update failed (${res.status})`);
        if (!state.pollInFlight) scheduleNextPoll();
        return;
      }
      if (data?.trust) {
        applyTrustPatchToSnapshot(data.trust);
      }
      if (successMsg) showToast(successMsg);
      state.etag = "";
      await poll({ force: true });
    } catch {
      if (actionSeq !== state.trustActionSeq) return;
      showToast("Could not update trust settings");
      if (!state.pollInFlight) scheduleNextPoll();
    }
  }

  function releaseArtifactObjectUrl() {
    if (state.artifact?.objectUrl) {
      URL.revokeObjectURL(state.artifact.objectUrl);
      state.artifact.objectUrl = null;
    }
  }

  function buildArtifactQuery(name, raw = false) {
    const convId = getConversationId(true);
    const qs = new URLSearchParams();
    if (convId) qs.set("conversationId", convId);
    qs.set("name", name);
    if (raw) qs.set("raw", "1");
    const token = params.get("token");
    if (token) qs.set("token", token);
    return `/api/artifact?${qs.toString()}`;
  }

  function appendInlineMarkdown(parent, text) {
    const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
    let lastIndex = 0;
    for (const match of text.matchAll(tokenRe)) {
      const idx = match.index ?? 0;
      if (idx > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, idx)));
      }
      const token = match[0];
      if (token.startsWith("`")) {
        parent.appendChild(el("code", "md-inline-code", token.slice(1, -1)));
      } else if (token.startsWith("**")) {
        parent.appendChild(el("strong", "", token.slice(2, -2)));
      } else {
        const label = token.slice(1, token.indexOf("]("));
        const a = el("a", "md-link", label);
        a.href = match[2];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.appendChild(a);
      }
      lastIndex = idx + token.length;
    }
    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function renderMarkdownArticle(markdown) {
    const doc = el("article", "md-doc");
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      if (/^```/.test(line)) {
        const codeLines = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const pre = el("pre", "md-pre");
        pre.appendChild(el("code", "", codeLines.join("\n")));
        doc.appendChild(pre);
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        const tag = `h${Math.min(heading[1].length, 4)}`;
        const h = el(tag, "md-heading");
        appendInlineMarkdown(h, heading[2].trim());
        doc.appendChild(h);
        i += 1;
        continue;
      }
      if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
        doc.appendChild(el("hr", "md-hr"));
        i += 1;
        continue;
      }
      if (/^>\s?/.test(line)) {
        const quote = el("blockquote", "md-quote");
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\s?/, ""));
          i += 1;
        }
        const qp = el("p", "");
        appendInlineMarkdown(qp, quoteLines.join(" "));
        quote.appendChild(qp);
        doc.appendChild(quote);
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const ul = el("ul", "md-list");
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          const li = el("li", "");
          appendInlineMarkdown(li, lines[i].replace(/^\s*[-*]\s+/, ""));
          ul.appendChild(li);
          i += 1;
        }
        doc.appendChild(ul);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const ol = el("ol", "md-list");
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          const li = el("li", "");
          appendInlineMarkdown(li, lines[i].replace(/^\s*\d+\.\s+/, ""));
          ol.appendChild(li);
          i += 1;
        }
        doc.appendChild(ol);
        continue;
      }
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(?:```|#{1,4}\s|>\s?|\s*[-*]\s+|\s*\d+\.\s+|(?:---|\*\*\*|___)\s*$)/.test(lines[i])
      ) {
        paraLines.push(lines[i].trim());
        i += 1;
      }
      const p = el("p", "md-p");
      appendInlineMarkdown(p, paraLines.join(" "));
      doc.appendChild(p);
    }
    return doc;
  }

  function renderArtifactView() {
    const container = document.getElementById("artifact-view");
    if (!container || !state.artifact) return;
    const art = state.artifact;

    const header = el("header", "artifact-header");
    const navRow = el("div", "artifact-nav-row");
    const backBtn = el("button", "back-btn");
    backBtn.type = "button";
    backBtn.id = "back-from-artifact";
    backBtn.dataset.testid = "back-from-artifact";
    backBtn.appendChild(svgIcon("back", 14));
    backBtn.appendChild(el("span", "", "Timeline"));
    backBtn.addEventListener("click", () => switchView("timeline", true));
    navRow.appendChild(backBtn);

    if (art.rawUrl) {
      const rawLink = el("a", "artifact-raw-link");
      rawLink.href = art.rawUrl;
      rawLink.target = "_blank";
      rawLink.rel = "noopener noreferrer";
      rawLink.appendChild(el("span", "", "Open raw"));
      rawLink.appendChild(svgIcon("external", 10));
      navRow.appendChild(rawLink);
    }
    header.appendChild(navRow);

    const titleRow = el("div", "artifact-title-row");
    titleRow.appendChild(el("h1", "title", art.label || art.name));
    if (art.name) {
      titleRow.appendChild(el("span", "artifact-filename", art.name));
    }
    header.appendChild(titleRow);

    const body = el("main", "artifact-body");
    if (art.loading) {
      body.appendChild(el("p", "artifact-status", `Opening ${art.name || art.label}...`));
    } else if (art.error) {
      body.appendChild(el("p", "artifact-status error", art.error));
    } else if (art.data?.kind === "markdown") {
      body.appendChild(renderMarkdownArticle(art.data.content));
    } else if (art.data?.kind === "image") {
      const imgSrc = art.objectUrl || art.rawUrl;
      if (imgSrc) {
        const frame = el("div", "artifact-img-frame");
        const img = el("img", "artifact-viewer-img");
        img.src = imgSrc;
        img.alt = art.label || art.name;
        frame.appendChild(img);
        body.appendChild(frame);
      } else {
        body.appendChild(el("p", "artifact-status error", `Could not load image preview for ${art.name}.`));
      }
    } else if (art.data?.kind === "pdf") {
      if (art.rawUrl) {
        const note = el("p", "artifact-status", `PDF preview ready for ${art.name}. `);
        const pdfLink = el("a", "md-link", "Open PDF in browser tab");
        pdfLink.href = art.rawUrl;
        pdfLink.target = "_blank";
        pdfLink.rel = "noopener noreferrer";
        note.appendChild(pdfLink);
        body.appendChild(note);
      } else {
        body.appendChild(el("p", "artifact-status", `Open ${art.name} inside Antigravity to view the PDF.`));
      }
    } else if (art.data) {
      body.appendChild(el("pre", "artifact-viewer-pre", art.data.content || ""));
    }

    container.replaceChildren(header, body);
  }

  async function openArtifact(artifact, triggerEl = null) {
    if (!artifact) return;
    if (artifact.kind !== "pr" && artifact.uri && typeof window.sidecar?.ui?.toggleAuxPane === "function") {
      try {
        await window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri: artifact.uri });
        return;
      } catch {
      }
    }
    if (artifact.kind === "pr") {
      if (artifact.uri && /^https?:\/\//i.test(artifact.uri)) {
        window.open(artifact.uri, "_blank", "noopener,noreferrer");
        return;
      }
      showToast(`${artifact.label || artifact.name} has no PR URL yet`);
      return;
    }
    if (!artifact.name) return;
    releaseArtifactObjectUrl();
    state.artifactReturnEl = triggerEl || document.activeElement;
    const convId = getConversationId(true);
    const rawUrl = isSdkHost() ? null : buildArtifactQuery(artifact.name, true);
    state.artifact = {
      label: artifact.label || artifact.name,
      name: artifact.name,
      uri: artifact.uri || null,
      loading: true,
      error: null,
      data: null,
      rawUrl,
      objectUrl: null,
    };
    switchView("artifact");
    try {
      const res = await apiFetch("/api/artifact", { conversationId: convId, name: artifact.name, raw: false });
      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!state.artifact || state.artifact.name !== artifact.name) return;
      if (data?.kind === "image") {
        const rawRes = await apiFetch("/api/artifact", { conversationId: convId, name: artifact.name, raw: true });
        if (!rawRes.ok) {
          throw new Error(`HTTP ${rawRes.status}`);
        }
        const blob = await rawRes.blob();
        if (!state.artifact || state.artifact.name !== artifact.name) return;
        state.artifact.objectUrl = URL.createObjectURL(blob);
      }
      state.artifact.loading = false;
      state.artifact.data = data;
      renderArtifactView();
    } catch (err) {
      if (!state.artifact || state.artifact.name !== artifact.name) return;
      state.artifact.loading = false;
      state.artifact.error = `Could not open ${artifact.name} (${err?.message || "request failed"}).`;
      renderArtifactView();
    }
  }

  async function openTaskLog(job, triggerEl = null) {
    if (!job) return;
    releaseArtifactObjectUrl();
    state.artifactReturnEl = triggerEl || document.activeElement;
    const convId = getConversationId(true);
    const title = job.title || job.summary || job.taskSlug || "Background Task";
    const logName = job.logFile || job.taskSlug || "task";
    let rawUrl = null;
    if (!isSdkHost() && job.logFile) {
      const qs = new URLSearchParams();
      if (convId) qs.set("conversationId", convId);
      qs.set("taskLog", job.logFile);
      qs.set("raw", "1");
      const token = params.get("token");
      if (token) qs.set("token", token);
      rawUrl = `/api/artifact?${qs.toString()}`;
    }
    state.artifact = {
      label: title,
      name: `${logName} · ${job.status || "done"}`,
      uri: null,
      loading: Boolean(job.logFile),
      error: null,
      data: job.logFile
        ? null
        : {
            kind: "text",
            content: job.command ? `$ ${job.command}\n\n(No task log file on disk for ${logName})` : `(No task log file on disk for ${logName})`,
          },
      rawUrl,
      objectUrl: null,
    };
    switchView("artifact");
    if (!job.logFile) return;
    try {
      const res = await apiFetch("/api/artifact", { conversationId: convId, taskLog: job.logFile, raw: false });
      if (!res.ok) {
        const errPayload = await res.json().catch(() => ({}));
        throw new Error(errPayload.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (!state.artifact || state.artifact.label !== title) return;
      const prefix = job.command ? `$ ${job.command}\n${"─".repeat(48)}\n` : "";
      state.artifact.loading = false;
      state.artifact.data = { kind: "text", content: `${prefix}${data?.content || "(empty log)"}` };
      renderArtifactView();
    } catch (err) {
      if (!state.artifact || state.artifact.label !== title) return;
      state.artifact.loading = false;
      state.artifact.error = `Could not open ${logName} (${err?.message || "request failed"}).`;
      renderArtifactView();
    }
  }

  function formatSec(sec) {
    const v = Math.max(0, Math.floor(sec));
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const ss = String(v % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  function formatElapsedText(isoStart, isoEnd, prefix = "") {
    const startMs = Date.parse(isoStart || "");
    if (!Number.isFinite(startMs)) return prefix ? prefix.trim() : "0:00";
    const endMs = isoEnd ? Date.parse(isoEnd) : Date.now();
    const sec = Number.isFinite(endMs) ? (endMs - startMs) / 1000 : 0;
    return `${prefix}${formatSec(sec)}`;
  }

  function formatCountdownText(isoNext, prefix = "") {
    const nextMs = Date.parse(isoNext || "");
    if (!Number.isFinite(nextMs)) return "";
    const diff = (nextMs - Date.now()) / 1000;
    if (diff <= 0) return `${prefix}due`;
    return `${prefix}${formatSec(diff)}`;
  }

  function tickTimers() {
    if (document.hidden || state.view !== "timeline") return;
    const nodes = document.querySelectorAll("[data-timer-kind]");
    for (const node of nodes) {
      const kind = node.dataset.timerKind;
      const prefix = node.dataset.timerPrefix || "";
      if (kind === "elapsed") {
        node.textContent = formatElapsedText(node.dataset.startedAt, node.dataset.completedAt, prefix);
      } else if (kind === "countdown") {
        const nextAt = node.dataset.nextAt || "";
        const txt = formatCountdownText(nextAt, prefix);
        node.textContent = txt;
        const nextMs = Date.parse(nextAt);
        if (Number.isFinite(nextMs) && nextMs <= Date.now() && !state.pulsedTimers.has(nextAt)) {
          state.pulsedTimers.add(nextAt);
        }
      }
    }
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

  function lookupCommandMeta(snap, command) {
    const sections = [snap?.setup, ...(snap?.stages || [])];
    for (const sec of sections) {
      if (!sec) continue;
      for (const list of [sec.commands, sec.autoSubCommands, sec.moreCommands]) {
        const found = list?.find((c) => c.command === command);
        if (found) return found;
      }
    }
    const doc = window.ASTACK_CATALOG?.commandDocs?.[command];
    if (!doc) return null;
    const invocable = doc.invocable !== false;
    return { command, invocable, copyText: invocable ? command : null, ...doc };
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
    if (item.invocable === false) {
      const kindLabel = item.kind === "agent" ? "internal agent" : item.kind === "script" ? "internal script" : "internal";
      head.appendChild(el("span", "cmd-popover-kind", kindLabel));
    }
    if (typeof item.docsUrl === "string" && item.docsUrl.startsWith(DOCS_URL_PREFIX)) {
      const link = el("a", "cmd-popover-doc");
      link.href = item.docsUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.appendChild(el("span", "", "Docs"));
      link.appendChild(svgIcon("external", 11));
      head.appendChild(link);
    }

    const footText = item.invocable === false
      ? (item.invokedBy ? `Runs automatically via ${item.invokedBy} (not a slash command)` : "Internal step (not a slash command)")
      : `Click to copy and focus chat (${PASTE_SHORTCUT})`;

    pop.replaceChildren(
      head,
      el("p", "cmd-popover-desc", item.description),
      el("div", "cmd-popover-foot", footText),
    );
    pop.classList.remove("hidden");
    positionCommandPopover(pop, anchorEl);
  }

  function showStatusPopover(anchorEl, title, statusText, mode, description) {
    if (!description) return;
    const pop = document.getElementById("cmd-popover");
    if (!pop) return;
    cancelHidePopover();
    if (state.popoverAnchor && state.popoverAnchor !== anchorEl) {
      state.popoverAnchor.removeAttribute("aria-describedby");
    }
    state.popoverAnchor = anchorEl;
    anchorEl.setAttribute("aria-describedby", "cmd-popover");

    const head = el("div", "cmd-popover-head");
    head.appendChild(el("span", "cmd-popover-name", title));
    if (statusText) {
      head.appendChild(el("span", `cmd-popover-status ${mode}`, statusText));
    }

    pop.replaceChildren(head, el("p", "cmd-popover-desc", description));
    pop.classList.remove("hidden");
    positionCommandPopover(pop, anchorEl);
  }

  function attachStatusPopover(elNode, title, statusText, mode, description) {
    if (!description) return;
    elNode.addEventListener("mouseenter", () => showStatusPopover(elNode, title, statusText, mode, description));
    elNode.addEventListener("mouseleave", scheduleHidePopover);
    elNode.addEventListener("focus", () => showStatusPopover(elNode, title, statusText, mode, description));
    elNode.addEventListener("blur", scheduleHidePopover);
  }

  function attachCommandPopover(elNode, item) {
    if (!item?.description) return;
    elNode.addEventListener("mouseenter", () => showCommandPopover(elNode, item));
    elNode.addEventListener("mouseleave", () => {
      if (state.suppressedPopoverEl === elNode) state.suppressedPopoverEl = null;
      scheduleHidePopover();
    });
    elNode.addEventListener("focus", () => {
      if (state.suppressedPopoverEl === elNode) {
        state.suppressedPopoverEl = null;
        return;
      }
      showCommandPopover(elNode, item);
    });
    elNode.addEventListener("blur", () => {
      if (state.suppressedPopoverEl === elNode) state.suppressedPopoverEl = null;
      scheduleHidePopover();
    });
  }

  function wireCommandAction(node, itemOrText, stopPropagation = true) {
    const displayCmd = typeof itemOrText === "string" ? itemOrText : itemOrText?.command ?? "";
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
      const ic = svgIcon("check-sm", 11);
      ic.classList.add("chip-icon");
      chip.appendChild(ic);
    } else if (item.state === "stale") {
      const ic = svgIcon("warn", 11);
      ic.classList.add("chip-icon");
      chip.appendChild(ic);
    } else if (item.state === "active") {
      const dot = el("span", "chip-active-dot");
      dot.setAttribute("aria-hidden", "true");
      chip.appendChild(dot);
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
        if (sub.invocable === false) {
          const pill = el("span", sub.ran ? "subcmd-pill is-internal ran" : "subcmd-pill is-internal");
          pill.tabIndex = 0;
          pill.setAttribute("role", "status");
          pill.dataset.kind = sub.kind || "script";
          attachCommandPopover(pill, sub);
          if (sub.ran) {
            const ic = svgIcon("check-sm", 11);
            ic.classList.add("chip-icon");
            pill.appendChild(ic);
          } else {
            pill.appendChild(el("span", "subcmd-dot", "·"));
          }
          pill.appendChild(el("span", "", sub.command));
          pill.appendChild(el("span", "subcmd-tag", sub.kind === "agent" ? "agent" : "script"));
          subList.appendChild(pill);
        } else {
          const pill = el("button", sub.ran ? "subcmd-pill ran" : "subcmd-pill");
          pill.type = "button";
          wireCommandAction(pill, sub);
          if (sub.ran) {
            const ic = svgIcon("check-sm", 11);
            ic.classList.add("chip-icon");
            pill.appendChild(ic);
          } else {
            pill.appendChild(el("span", "subcmd-dot", "·"));
          }
          pill.appendChild(el("span", "", sub.command));
          subList.appendChild(pill);
        }
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
      const chev = svgIcon("chevron", 12);
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

  function applyLiveStatus(snap) {
    const live = document.getElementById("live");
    const liveMode = !snap.hasConversation ? "idle" : snap.liveState;
    live.className = `live ${liveMode}`;
    live.title = snap.liveLabel || "";
    document.getElementById("live-label").textContent = snap.liveLabel;
  }

  function stageStatusLabel(stage, stages) {
    const rs = stage?.railState;
    if (rs === "running") return { text: "Running", cls: "running" };
    if (rs === "done") return { text: "Done", cls: "done" };
    if (rs === "yourturn") return { text: "Your turn", cls: "yourturn" };
    if (rs === "stale") {
      return { text: "Needs re-run", cls: "stale" };
    }
    if (rs === "error") return { text: "Escalated", cls: "error" };
    if (rs === "queued") {
      const idx = Array.isArray(stages) ? stages.findIndex((s) => s.id === stage.id) : -1;
      const earlierBusy = idx > 0 && stages.slice(0, idx).some((s) => s.railState === "running" || s.railState === "yourturn");
      if (earlierBusy) return { text: "Queued", cls: "queued" };
      if (stage?.id === "build" && stage.status === "active") {
        const editsDone = stage.subChecks?.some((c) => c.id === "edits" && c.status === "done");
        const cleanSub = stage.subChecks?.find((c) => c.id === "clean");
        const cleanPendingRequired = cleanSub?.status === "pending" && !cleanSub?.optional;
        const cleanDoneOrOptional =
          cleanSub?.status === "done" || (cleanSub?.status === "pending" && Boolean(cleanSub?.optional));
        const verifyStatus = stage.subChecks?.find((c) => c.id === "verify")?.status;
        if (editsDone && verifyStatus === "done" && cleanPendingRequired) {
          return { text: "Cleanup left", cls: "queued" };
        }
        if (editsDone && cleanDoneOrOptional && verifyStatus === "pending") {
          return { text: "Verify left", cls: "queued" };
        }
        if (editsDone && cleanPendingRequired && verifyStatus === "pending") {
          return { text: "2 steps left", cls: "queued" };
        }
        return { text: "In progress", cls: "queued" };
      }
      if (stage?.status === "active") return { text: "In progress", cls: "queued" };
      return { text: "Idle", cls: "queued" };
    }
    if (rs === "suggested") return { text: "Suggested", cls: "muted" };
    if (rs === "skipped") {
      return { text: stage?.skippedReason === "earlier" ? "Earlier" : "Skipped", cls: "faint" };
    }
    return null;
  }

  function prefillAskBar(question) {
    const input = document.getElementById("astk-btw");
    if (!input) return;
    if (state.view !== "timeline") switchView("timeline");
    input.value = question;
    input.focus();
  }

  function makeSubAccordionHeader(key, iconName, titleText, metaNode, isAccent = false, defaultOpen = false) {
    const isOpen = state.subExpanded[key] !== undefined ? Boolean(state.subExpanded[key]) : Boolean(defaultOpen);
    const btn = el("button", isAccent ? "sub-accordion-btn is-accent" : "sub-accordion-btn");
    btn.type = "button";
    btn.setAttribute("aria-expanded", String(isOpen));
    const icWrap = el("span", "sub-accordion-icon");
    if (isAccent) icWrap.style.color = "currentColor";
    icWrap.appendChild(svgIcon(iconName, 13));
    btn.appendChild(icWrap);
    btn.appendChild(el("span", "sub-accordion-title", titleText));
    if (metaNode) btn.appendChild(metaNode);
    const chev = svgIcon("chevron", 12);
    chev.classList.add("chev");
    btn.appendChild(chev);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      state.subExpanded[key] = !isOpen;
      render(state.snap);
    });
    return { btn, isOpen };
  }

  function buildStageSubagentsSection(stageId, act) {
    const stageSubagents = (act?.subagents || []).filter((a) => (a.stageId || "build") === stageId);
    if (stageSubagents.length === 0) return null;

    const testId = `stage-subagents-${stageId}`;
    const wrap = el("div", state.highlightTarget === testId ? "subagents-section is-highlighted" : "subagents-section");
    wrap.dataset.testid = testId;

    const runningN = stageSubagents.filter((a) => a.status === "running").length;
    const failedN = stageSubagents.filter((a) => a.status === "failed").length;
    const doneN = stageSubagents.filter((a) => a.status === "done").length;
    const metaText =
      runningN > 0
        ? `${runningN}/${stageSubagents.length} running`
        : failedN > 0
          ? `${doneN} done, ${failedN} failed`
          : `${doneN} done`;
    const meta = el("span", "sub-accordion-meta", metaText);
    const { btn, isOpen } = makeSubAccordionHeader(
      `subagents:${stageId}`,
      "orbit",
      "Subagents",
      meta,
      false,
      runningN > 0,
    );
    btn.dataset.testid = `accordion-subagents-${stageId}`;
    wrap.appendChild(btn);

    if (isOpen) {
      const ul = el("ul", "sub-accordion-list");
      for (const a of stageSubagents) {
        const li = el("li", "sub-row is-subagent");
        const head = el("div", "sub-row-head");
        const dw = el("span", "sub-row-dot-wrap");
        if (a.status === "done") {
          const chk = svgIcon("check-sm", 10);
          chk.style.color = "var(--tl-done)";
          dw.appendChild(chk);
        } else if (a.status === "failed") {
          const errIc = svgIcon("warn", 10);
          errIc.style.color = "var(--tl-error)";
          dw.appendChild(errIc);
        } else {
          dw.appendChild(el("span", "sub-row-dot active"));
        }
        head.appendChild(dw);

        const displayName = String(a.role || a.type || "Subagent").trim();
        const titleEl = el("span", "sub-row-title", displayName);
        titleEl.title = displayName;
        head.appendChild(titleEl);

        if (a.type && a.type !== "self" && a.type.toLowerCase() !== displayName.toLowerCase()) {
          head.appendChild(el("span", "sub-row-badge", a.type));
        }
        if (a.workspace && a.workspace !== "inherit") {
          head.appendChild(el("span", "sub-row-badge", a.workspace));
        }

        const timerEl = el("span", "sub-row-timer", formatElapsedText(a.startedAt, a.completedAt));
        if (a.status === "running" && a.startedAt) {
          timerEl.dataset.timerKind = "elapsed";
          timerEl.dataset.startedAt = a.startedAt;
        }
        head.appendChild(timerEl);
        appendAskButton(head, `What is ${displayName} finding?`, `Ask /btw about ${displayName}`);
        li.appendChild(head);

        const desc = String(a.task || "").trim();
        if (desc && desc.toLowerCase() !== displayName.toLowerCase()) {
          const descEl = el("div", "sub-row-desc", desc);
          descEl.title = desc;
          li.appendChild(descEl);
        }
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    return wrap;
  }

  function appendAskButton(row, question, ariaLabel) {
    const askBtn = el("button", "row-ask-btn");
    askBtn.type = "button";
    askBtn.setAttribute("aria-label", ariaLabel);
    askBtn.title = "Ask /btw";
    askBtn.appendChild(svgIcon("fork", 12));
    askBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      prefillAskBar(question);
    });
    row.appendChild(askBtn);
  }

  function buildSubChecksBar(stage) {
    const subChecks = stage.subChecks || [];
    if (subChecks.length === 0) return null;
    const segGrid = el("div", subChecks.length === 2 ? "progress-segments is-two" : "progress-segments");
    segGrid.setAttribute("role", "list");
    segGrid.setAttribute("aria-label", "Progress");
    let activeAssigned = false;
    for (const sub of subChecks) {
      const seg = el("div", "progress-seg");
      seg.setAttribute("role", "listitem");
      let mode = sub.status;
      if (mode === "pending" && stage.status === "active" && !activeAssigned && stage.id !== "plan") {
        mode = "run";
        activeAssigned = true;
      }
      const bar = el("span", `progress-seg-bar ${mode}`);
      if (mode === "run") bar.classList.add("pulse");
      const title = sub.label.charAt(0).toUpperCase() + sub.label.slice(1);
      const labelText =
        mode === "done"
          ? `✓ ${title}`
          : mode === "stale"
            ? `! ${title}`
            : mode === "run"
              ? `${title}…`
              : mode === "optional"
                ? `${title} (opt)`
                : title;
      const statusText =
        mode === "done"
          ? "Done"
          : mode === "stale"
            ? "Stale"
            : mode === "run"
              ? "In progress"
              : mode === "optional"
                ? "Optional"
                : "Pending";
      if (sub.detail) {
        seg.tabIndex = 0;
        attachStatusPopover(seg, title, statusText, mode, sub.detail);
      }
      seg.appendChild(bar);
      seg.appendChild(el("span", `progress-seg-label ${mode}`, labelText));
      segGrid.appendChild(seg);
    }
    return segGrid;
  }

  function buildBuildStageDetail(stage, snap) {
    const detail = el("div", "detail");
    const act = snap.activity || {};

    const subChecks = stage.subChecks || [];
    const segGrid = buildSubChecksBar(stage);
    if (segGrid) detail.appendChild(segGrid);

    if (stage.status === "active" && stage.railState !== "running") {
      const editsDone = subChecks.some((c) => c.id === "edits" && c.status === "done");
      const pendingSubs = subChecks.filter((c) => c.status === "pending" && c.id !== "edits" && !c.optional);
      if (editsDone && pendingSubs.length > 0) {
        const callout = el("div", "subcheck-callout is-info");
        callout.dataset.testid = "build-remaining-callout";
        const msgRow = el("div", "subcheck-callout-msg");
        const dot = el("span", "status-banner-dot");
        dot.style.marginTop = "4px";
        dot.setAttribute("aria-hidden", "true");
        msgRow.append(dot, el("span", "", `Still left in Build & Prove: ${pendingSubs.map((s) => s.detail).join(" ")}`));
        callout.appendChild(msgRow);

        const actionCmds = [];
        if (pendingSubs.some((s) => s.id === "clean")) actionCmds.push("/deslop", "/no-comments");
        if (pendingSubs.some((s) => s.id === "verify")) actionCmds.push("/astack-mode");
        if (actionCmds.length > 0) {
          const actionRow = el("div", "subcheck-callout-actions");
          for (const cmd of actionCmds) {
            const meta = lookupCommandMeta(snap, cmd);
            const btn = el("button", "subcmd-pill");
            btn.type = "button";
            btn.appendChild(el("span", "", cmd));
            wireCommandAction(btn, meta ? { ...meta, command: cmd } : cmd);
            actionRow.appendChild(btn);
          }
          callout.appendChild(actionRow);
        }
        detail.appendChild(callout);
      }
    }
    const accGroup = el("div", "accordion-group");
    const swarm = act.swarm || {};
    if (swarm.active || (swarm.members && swarm.members.length > 0)) {
      const wrap = el("div", state.highlightTarget === "accordion-swarm" ? "subagents-section is-highlighted" : "");
      const meta = el("span", "sub-accordion-meta", `${swarm.workingCount || 0} of ${swarm.totalCount || 0} working`);
      const { btn, isOpen } = makeSubAccordionHeader("swarm", "swarm", "Swarm", meta);
      btn.dataset.testid = "accordion-swarm";
      wrap.appendChild(btn);
      if (isOpen) {
        const ul = el("ul", "sub-accordion-list");
        for (const m of swarm.members || []) {
          const li = el("li", "sub-row");
          const dw = el("span", "sub-row-dot-wrap");
          const dotCls = m.role === "verifier" ? "sub-row-dot ring" : "sub-row-dot";
          const d = el("span", m.status === "working" ? `${dotCls} active` : dotCls);
          dw.appendChild(d);
          li.appendChild(dw);
          li.appendChild(el("span", "sub-row-name", m.name));
          li.appendChild(el("span", "sub-row-task", m.task));
          li.appendChild(el("span", m.status === "working" ? "sub-row-stat active" : "sub-row-stat", m.status));
          appendAskButton(li, `What is ${m.name} working on right now?`, `Ask /btw about ${m.name}`);
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      }
      accGroup.appendChild(wrap);
    }

    const buildSubagentsEl = buildStageSubagentsSection("build", act);
    if (buildSubagentsEl) {
      accGroup.appendChild(buildSubagentsEl);
    }

    const goal = act.goal || {};
    const teamwork = act.teamwork || {};
    if (goal.detected || teamwork.detected) {
      const wrap = el("div", "");
      const labelTitle = goal.detected ? "Goal" : "Teamwork";
      const meta = el("span", "sub-accordion-meta");
      if (goal.active && goal.startedAt) {
        meta.textContent = formatElapsedText(goal.startedAt, null, "active ");
        meta.dataset.timerKind = "elapsed";
        meta.dataset.startedAt = goal.startedAt;
        meta.dataset.timerPrefix = "active ";
      } else {
        meta.textContent = goal.completed ? "completed" : "active";
      }
      const { btn, isOpen } = makeSubAccordionHeader("goal", goal.detected ? "loop" : "milestone", labelTitle, meta);
      btn.dataset.testid = "accordion-goal";
      wrap.appendChild(btn);
      if (isOpen) {
        const note = el("p", "goal-detail-note");
        const predText = goal.predicate || "Keeps working until verified checks pass.";
        note.appendChild(document.createTextNode(predText));
        if (goal.checkInNextAt) {
          note.appendChild(document.createTextNode(" Next check-in "));
          const cd = el("span", "", formatCountdownText(goal.checkInNextAt));
          cd.dataset.timerKind = "countdown";
          cd.dataset.nextAt = goal.checkInNextAt;
          note.appendChild(cd);
          note.appendChild(document.createTextNode("."));
        }
        wrap.appendChild(note);
      }
      accGroup.appendChild(wrap);
    }

    const menuItems = window.ASTACK_CATALOG?.delegateGuide?.delegateMenu || [];
    const runningSet = new Set();
    if (swarm.active) runningSet.add("swarm");
    if (goal.active) runningSet.add("goal");
    if (act.boost?.active) runningSet.add("boost");
    if (act.workflow?.active) runningSet.add("rw");
    if (act.teamwork?.active) runningSet.add("teamwork");
    if ((act.schedules || []).some((s) => s.active)) runningSet.add("schedule");
    const filteredMenu = menuItems.filter((item) => !runningSet.has(item.id));

    if (filteredMenu.length > 0) {
      const moreMenuWrap = el("div", "");
      const { btn, isOpen } = makeSubAccordionHeader("more", "plus", "Delegate more work", null, true);
      btn.dataset.testid = "delegate-more-toggle";
      moreMenuWrap.appendChild(btn);
      if (isOpen) {
        const list = el("div", "delegate-menu-list");
        list.dataset.testid = "delegate-more-menu";
        list.appendChild(el("p", "delegate-menu-caption", "Pick one to copy a ready prompt, then paste it in the chat."));
        for (const item of filteredMenu) {
          const row = el("button", "delegate-menu-row");
          row.type = "button";
          const docMeta = lookupCommandMeta(snap, item.command);
          if (docMeta) {
            attachCommandPopover(row, docMeta);
          }
          const ic = el("span", "delegate-menu-icon");
          ic.appendChild(svgIcon(item.icon, 13));
          row.appendChild(ic);
          row.appendChild(el("span", "delegate-menu-cmd", item.command));
          row.appendChild(el("span", "delegate-menu-desc", item.summary));
          const cp = el("span", "delegate-menu-copy");
          cp.appendChild(svgIcon("copy", 12));
          row.appendChild(cp);
          row.addEventListener("click", (ev) => {
            ev.stopPropagation();
            copyCommand({ command: item.command, copyText: item.prompt }, row, true);
          });
          list.appendChild(row);
        }
        const guideBtn = el("button", "delegate-menu-guide");
        guideBtn.type = "button";
        guideBtn.dataset.testid = "delegate-more-guide-link";
        guideBtn.appendChild(el("span", "", "All commands in the Guide"));
        guideBtn.appendChild(svgIcon("chevron", 10));
        guideBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          switchView("delegate");
        });
        list.appendChild(guideBtn);
        moreMenuWrap.appendChild(list);
      }
      accGroup.appendChild(moreMenuWrap);
    }

    detail.appendChild(accGroup);
    detail.appendChild(buildCommandChips(stage.commands));
    appendStageTail(detail, stage);
    return detail;
  }

  function buildCommandChips(commands) {
    const chips = el("div", "chips");
    for (const item of commands || []) {
      chips.appendChild(buildCommandChip(item));
    }
    return chips;
  }

  function appendStageTail(detail, stage) {
    if (Array.isArray(stage.artifacts) && stage.artifacts.length > 0) {
      detail.appendChild(buildArtifactButtons(stage.artifacts));
    }
    appendSubCommands(detail, stage.id, stage.autoSubCommands, stage.moreCommands);
  }

  function buildArtifactButtons(artifacts) {
    const row = el("div", "artifact-row");
    for (const art of artifacts) {
      const btn = el("button", "artifact-btn");
      btn.type = "button";
      const isPr = art.kind === "pr";
      const ic = svgIcon(isPr ? (art.status === "merged" ? "pr-merged" : "pr") : "diamond", isPr ? 12 : 10);
      if (art.status === "updating") {
        ic.classList.add("pulse");
        ic.style.color = "var(--tl-primary)";
      } else if (art.status === "stale") {
        ic.style.color = "var(--tl-warning)";
      } else if (art.status === "merged") {
        ic.style.color = isPr ? "var(--tl-merged)" : "var(--tl-done)";
      } else if (art.status === "open" && isPr) {
        ic.style.color = "var(--tl-done)";
      }
      btn.appendChild(ic);
      btn.appendChild(el("span", "", art.label || art.name));
      if (art.badge) {
        btn.appendChild(el("span", `artifact-badge ${art.status || ""}`, art.badge));
      }
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openArtifact(art, btn);
      });
      row.appendChild(btn);
    }
    return row;
  }

  function buildGenericStageDetail(stage, snap) {
    const detail = el("div", "detail");
    const act = snap.activity || {};
    if (stage.id === "plan") {
      const segGrid = buildSubChecksBar(stage);
      if (segGrid) detail.appendChild(segGrid);
      if (stage.readOnlyActive) {
        const roBadge = el("span", "stage-readonly-pill", "Read-only");
        roBadge.dataset.testid = "plan-readonly-pill";
        detail.appendChild(roBadge);
      }
    }
    detail.appendChild(el("p", "detail-text", stage.detail));
    if (stage.id === "review" && stage.status === "pending") {
      const buildStage = (snap.stages || []).find((s) => s.id === "build");
      if (buildStage?.status === "active" || buildStage?.status === "stale") {
        const prereq = el(
          "p",
          "detail-note",
          "Finish Step 2 (Build & Prove) first, or run /pre-pr now to check HEAD immediately.",
        );
        prereq.dataset.testid = "review-prerequisite-note";
        detail.appendChild(prereq);
      }
    }
    const stageSubagentsEl = buildStageSubagentsSection(stage.id, act);
    if (stageSubagentsEl) {
      const accGroup = el("div", "accordion-group");
      accGroup.appendChild(stageSubagentsEl);
      detail.appendChild(accGroup);
    }
    detail.appendChild(buildCommandChips(stage.commands));

    if (stage.id === "review" && snap.trust?.riskAssessment && snap.trust.scopeKind !== "non_repo") {
      const ra = snap.trust.riskAssessment;
      const rp = snap.trust.riskPresentation || null;
      const cat = snap.trust.activeCatState;
      const cardTone = rp?.tone
        ? rp.tone === "done"
          ? "risk-card is-done"
          : rp.tone === "err"
            ? "risk-card is-err"
            : rp.tone === "warn"
              ? "risk-card is-warn"
              : "risk-card"
        : ra.residual === "blocked"
          ? "risk-card is-err"
          : ra.residual !== "low"
            ? "risk-card is-warn"
            : "risk-card";
      const rc = el("div", cardTone);
      rc.dataset.testid = "timeline-risk-card";
      rc.appendChild(el("p", "risk-card-lead", rp?.headline || ra.summary || `${ra.residual} risk (R ${(ra.score ?? 0).toFixed(2)})`));
      const whyWithEvidence = (rp?.whyItems || []).filter((w) => w.evidence);
      if (whyWithEvidence.length > 0) {
        const evWrap = el("div", "risk-card-evidence");
        for (const w of whyWithEvidence) {
          evWrap.appendChild(el("div", "risk-card-ev-line", `${w.id}: ${w.evidence}`));
        }
        rc.appendChild(evWrap);
      }
      if (rp?.nextHint) {
        rc.appendChild(el("p", "risk-card-next", rp.nextHint));
      }
      if (snap.trust.enrolled && cat) {
        const whyTone =
          rp?.mode === "resolved_merged"
            ? "is-done"
            : rp?.mode === "defect_blocked"
              ? "is-err"
              : snap.trust.beastOn && ra.residual === "low" && cat.level >= 3
                ? "is-done"
                : "is-warn";
        const whyText =
          rp?.mode === "resolved_merged"
            ? `Merged · category ${cat.id} is L${cat.level} (T ${cat.score.toFixed(2)}, cap L${cat.ceiling}).`
            : !snap.trust.beastOn
              ? `Beast Mode is Off. Category ${cat.id} is L${cat.level} (T ${cat.score.toFixed(2)}, cap L${cat.ceiling}).`
              : rp?.mode === "human_gate" && ra.residual === "blocked"
                ? `Requires human review (${cat.id} capped at L${cat.ceiling}).`
                : ra.residual === "blocked"
                  ? `Action needed on ${(ra.signals || []).map((s) => s.id).join(", ")}.`
                  : ra.residual === "low" && cat.level >= 3
                    ? `Auto-eligible at L${cat.level} (${cat.id}, T ${cat.score.toFixed(2)}). Sampled 1-in-5 async audit active.`
                    : `Paused. Merge needs L3 for ${cat.id}, current L${cat.level} (T ${cat.score.toFixed(2)}). Residual ${ra.residual} (R ${(ra.score ?? 0).toFixed(2)}).`;
        rc.appendChild(el("p", `risk-card-why ${whyTone}`, whyText));
      }
      const sigRow = el("div", "subcmd-list");
      const defectIds = new Set(["test_regression", "deletes_assertions", "bundled_sidecar_permissions", "scope_drift"]);
      for (const sig of ra.signals || []) {
        const cls = defectIds.has(sig.id)
          ? "subcmd-pill is-err-action"
          : sig.id === "touches_governance"
            ? "subcmd-pill is-warn-action"
            : "subcmd-pill";
        const sp = el("span", cls);
        sp.appendChild(el("span", "", `${sig.id} (${Math.round((sig.weight ?? 0) * 100)}%)`));
        sigRow.appendChild(sp);
      }
      for (const sat of ra.satisfied || []) {
        const sp = el("span", "subcmd-pill ran");
        const ic = svgIcon("check-sm", 10);
        ic.classList.add("chip-icon");
        sp.append(ic, el("span", "", sat.id));
        sigRow.appendChild(sp);
      }
      if (sigRow.childNodes.length > 0) rc.appendChild(sigRow);

      const rollbackCmd = rp?.rollbackCommand || (ra.rollback?.kind && ra.rollback.kind !== "none" ? ra.rollback.plan : null);
      if (rollbackCmd) {
        const rbDetails = el("details", "risk-card-rollback-details");
        rbDetails.dataset.testid = "risk-card-rollback";
        rbDetails.appendChild(el("summary", "risk-card-rollback-sum", "Undo / rollback command (only after commit or merge)"));
        rbDetails.appendChild(el("p", "risk-card-rb-note", "Safety reference only — not a workflow next step."));
        const rbRow = el("div", "risk-card-rollback");
        rbRow.appendChild(el("code", "risk-card-rb-code", rollbackCmd));
        const cpBtn = el("button", "subcmd-pill is-sans", "Copy");
        cpBtn.type = "button";
        cpBtn.setAttribute("aria-label", `Copy rollback command ${rollbackCmd}`);
        cpBtn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          const ok = await writeClipboard(rollbackCmd);
          showToast(ok ? `Copied "${rollbackCmd}"` : rollbackCmd);
        });
        rbRow.appendChild(cpBtn);
        rbDetails.appendChild(rbRow);
        rc.appendChild(rbDetails);
      }

      if (snap.trust.enrolled && snap.fullHeadSha) {
        const outWrap = el("div", "subcmd-section");
        outWrap.appendChild(el("span", "subcmd-label", "Record PR outcome (updates local EMA ledger T):"));
        const outRow = el("div", "subcmd-list");
        for (const [outcomeKey, lbl] of [
          ["clean", "Approve clean (y=1)"],
          ["approved_with_edits", "Approve w/ edits (y=0.5)"],
          ["reverted", "Reject / revert (y=0)"],
        ]) {
          const btn = el("button", outcomeKey === "reverted" ? "subcmd-pill is-sans is-warn-action" : "subcmd-pill is-sans", lbl);
          btn.type = "button";
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            updateTrustSettings(
              {
                recordOutcome: {
                  category: ra.category || snap.trust.activeCategory,
                  outcome: outcomeKey,
                  headSha: snap.fullHeadSha,
                  predictedR: ra.score ?? 0,
                },
              },
              `Recorded ${outcomeKey} for ${ra.category || snap.trust.activeCategory}`,
            );
          });
          outRow.appendChild(btn);
        }
        outWrap.appendChild(outRow);
        rc.appendChild(outWrap);
      }
      detail.appendChild(rc);
    }

    if (
      stage.id === "review" &&
      act.workflow?.suggestedReview &&
      (stage.status === "next" || stage.status === "stale" || stage.status === "active")
    ) {
      const sug = act.workflow.suggestedReview;
      const box = el("div", "faster-workflow");
      const p = el("p", "faster-workflow-text");
      p.appendChild(el("span", "faster-workflow-lead", "Optional alternative: "));
      p.appendChild(document.createTextNode(`${sug.summary} `));
      p.appendChild(el("span", "faster-workflow-cmd", sug.command));
      p.appendChild(document.createTextNode(" (instead of single-pass /pre-pr)."));
      box.appendChild(p);
      const copyBtn = el("button", "subcmd-pill is-sans", "Copy");
      copyBtn.type = "button";
      copyBtn.setAttribute("aria-label", "Copy the /run-workflow prompt");
      copyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        copyCommand({ command: sug.command, copyText: sug.prompt }, copyBtn, true);
      });
      box.appendChild(copyBtn);
      detail.appendChild(box);
    }

    if (stage.id === "ship") {
      const activeScheds = (act.schedules || []).filter((s) => s.active);
      const shipOnly = activeScheds.filter((s) => s.stageId === "ship");
      const shipScheds = shipOnly.length > 0 ? shipOnly : activeScheds;
      const shipAutos = (act.automations || []).filter((a) => a.active);
      if (shipScheds.length > 0 || shipAutos.length > 0) {
        const jobsWrap = el("div", "ship-jobs");
        for (const s of shipScheds) {
          const row = el("div", "ship-job-row");
          const ic = el("span", "ship-job-icon");
          ic.appendChild(svgIcon("clock", 12));
          row.appendChild(ic);
          const text = el("span", "ship-job-text");
          text.appendChild(document.createTextNode(`${s.label} (${s.cadence}) `));
          text.appendChild(el("span", "ship-job-cmd", "/schedule"));
          row.appendChild(text);
          if (s.nextAt) {
            const cd = el("span", "sub-row-timer", formatCountdownText(s.nextAt));
            cd.dataset.timerKind = "countdown";
            cd.dataset.nextAt = s.nextAt;
            row.appendChild(cd);
          }
          jobsWrap.appendChild(row);
        }
        for (const au of shipAutos) {
          const row = el("div", "ship-job-row");
          const ic = el("span", "ship-job-icon");
          ic.appendChild(svgIcon("cycle", 12));
          row.appendChild(ic);
          const text = el("span", "ship-job-text");
          text.appendChild(document.createTextNode(`${au.label} `));
          text.appendChild(el("span", "ship-job-cmd", "/automation"));
          row.appendChild(text);
          jobsWrap.appendChild(row);
        }
        detail.appendChild(jobsWrap);
      }
    }

    appendStageTail(detail, stage);
    return detail;
  }

  function jumpToAgentsSection(snap) {
    state.solo = null;
    if (state.view !== "timeline") switchView("timeline");
    if (state.panelMode !== "build") state.panelMode = "build";

    const act = snap?.activity || {};
    const subagents = act.subagents || [];
    const swarmMembers = act.swarm?.members || [];
    if (subagents.length === 0 && swarmMembers.length === 0) {
      showToast("No subagents or swarm workers executed yet.");
      renderTotalsStrip(state.snap);
      return;
    }

    let targetTestId = null;
    if (subagents.length > 0) {
      const stages = snap?.stages || [];
      const runningStage = stages.find((s) =>
        subagents.some((a) => (a.stageId || "build") === s.id && a.status === "running"),
      );
      const latestStage = [...stages]
        .reverse()
        .find((s) => subagents.some((a) => (a.stageId || "build") === s.id));
      const targetStageId = runningStage?.id || latestStage?.id || subagents[0]?.stageId || "build";
      state.userToggled = true;
      state.expanded.add(targetStageId);
      state.subExpanded[`subagents:${targetStageId}`] = true;
      targetTestId = `stage-subagents-${targetStageId}`;
    } else {
      state.userToggled = true;
      state.expanded.add("build");
      state.subExpanded.swarm = true;
      targetTestId = "accordion-swarm";
    }

    state.highlightTarget = targetTestId;
    render(state.snap);
    state.highlightTarget = null;
    const targetEl = typeof document.querySelector === "function"
      ? document.querySelector(`[data-testid="${targetTestId}"]`)
      : null;
    targetEl?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }

  function renderTotalsStrip(snap) {
    const act = snap.activity || {};

    const strip = document.getElementById("focus-strip");
    strip.replaceChildren();
    const agentsWorking = act.agentsWorkingCount ?? 0;
    const agentsTotal = act.agentsTotalCount ?? ((act.subagents || []).length + (act.swarm?.totalCount || 0));
    const agentsDone = Math.max(0, agentsTotal - agentsWorking);
    const prsInfo = act.prs || { totalCount: 0, openCount: 0, mergedCount: 0, closedCount: 0, items: [] };
    const prTotal = prsInfo.totalCount ?? 0;
    const schedCount = act.scheduledCount ?? 0;
    const bgCount = act.backgroundJobs?.count ?? 0;
    const runningTasks = act.runningTasksCount ?? ((act.backgroundJobs?.runningCount || 0) + schedCount);
    const tasksTotal = act.tasksTotalCount ?? (bgCount + schedCount);
    const artCount = act.artifactCount ?? 0;

    const prParts = [];
    if (prsInfo.openCount > 0) prParts.push(`${prsInfo.openCount} open`);
    if (prsInfo.mergedCount > 0) prParts.push(`${prsInfo.mergedCount} merged`);
    if (prsInfo.closedCount > 0) prParts.push(`${prsInfo.closedCount} closed`);
    const prBreakdown = prParts.length > 0 ? prParts.join(", ") : "none yet";

    const focusDefs = [
      {
        key: "agents",
        countText: agentsWorking > 0 ? `${agentsWorking}/${agentsTotal}` : String(agentsTotal),
        label: agentsWorking > 0 ? "active" : agentsTotal === 1 ? "agent" : "agents",
        icon: "dot",
        dotMode: agentsWorking > 0 ? "pulse" : agentsTotal > 0 ? "done" : "idle",
        popTitle: "Subagents & Swarm",
        popStatus: agentsWorking > 0 ? `${agentsWorking} running` : agentsTotal > 0 ? `${agentsDone} done` : "Idle",
        popMode: agentsWorking > 0 ? "active" : agentsTotal > 0 ? "done" : "",
        popDesc:
          agentsTotal > 0
            ? `${agentsTotal} total executed (${agentsDone} done, ${agentsWorking} running). Click to jump to its stage.`
            : "No subagents or swarm workers executed in this conversation yet.",
      },
      {
        key: "prs",
        countText: String(prTotal),
        label: prTotal === 1 ? "PR" : "PRs",
        icon: prsInfo.openCount === 0 && prsInfo.mergedCount > 0 ? "pr-merged" : "pr",
        iconTone: prsInfo.openCount > 0 ? "open" : prsInfo.mergedCount > 0 ? "merged" : "",
        popTitle: "Pull Requests",
        popStatus: prTotal > 0 ? prBreakdown : "None",
        popMode: prsInfo.openCount > 0 ? "done" : "",
        popDesc:
          prTotal > 0
            ? `${prTotal} pull request${prTotal === 1 ? "" : "s"} tracked in this conversation (${prBreakdown}). Click to open list.`
            : "No pull requests opened in this conversation yet.",
      },
      {
        key: "art",
        countText: String(artCount),
        label: artCount === 1 ? "artifact" : "artifacts",
        icon: "diamond",
        popTitle: "Artifacts",
        popStatus: `${artCount} file${artCount === 1 ? "" : "s"}`,
        popMode: artCount > 0 ? "done" : "",
        popDesc:
          artCount > 0
            ? `${artCount} file artifact${artCount === 1 ? "" : "s"} (excludes PRs). Click to preview in panel.`
            : "No plan, walkthrough, or review artifacts generated yet.",
      },
      {
        key: "later",
        countText: runningTasks > 0 ? `${runningTasks}/${tasksTotal}` : String(tasksTotal),
        label: runningTasks > 0 ? "running" : tasksTotal === 1 ? "task" : "tasks",
        icon: "clock",
        iconTone: runningTasks > 0 ? "active" : "",
        popTitle: "Background Tasks",
        popStatus: runningTasks > 0 ? `${runningTasks} running` : `${tasksTotal} total`,
        popMode: runningTasks > 0 ? "active" : tasksTotal > 0 ? "done" : "",
        popDesc:
          tasksTotal > 0
            ? `${bgCount} background task${bgCount === 1 ? "" : "s"}${schedCount > 0 ? ` (${schedCount} scheduled)` : ""}. Click to scroll and open task logs.`
            : "No background tasks or active schedules in this conversation yet.",
      },
    ];
    for (const f of focusDefs) {
      const chip = el("button", "focus-chip");
      chip.type = "button";
      chip.dataset.focus = f.key;
      chip.dataset.testid = `focus-chip-${f.key}`;
      chip.setAttribute("aria-pressed", f.key === "agents" ? "false" : String(state.solo === f.key));
      if (f.icon === "dot") {
        const d = el("span", `focus-dot ${f.dotMode || ""}`.trim());
        chip.appendChild(d);
      } else {
        const ic = svgIcon(f.icon, f.icon === "diamond" ? 10 : 11);
        if (f.iconTone) ic.classList.add(`focus-icon-${f.iconTone}`);
        chip.appendChild(ic);
      }
      chip.appendChild(el("span", "focus-count", f.countText));
      chip.appendChild(el("span", "", f.label));
      attachStatusPopover(chip, f.popTitle, f.popStatus, f.popMode, f.popDesc);
      chip.addEventListener("click", () => {
        hideCommandPopover();
        if (f.key === "agents") {
          jumpToAgentsSection(state.snap);
          return;
        }
        state.solo = state.solo === f.key ? null : f.key;
        renderTotalsStrip(state.snap);
      });
      strip.appendChild(chip);
    }
    strip.appendChild(el("span", "focus-spacer"));
    const nav = el("nav", "view-nav-group");
    nav.setAttribute("aria-label", "AStack views");

    const dossierBtn = el("button", "guide-link-btn");
    dossierBtn.type = "button";
    dossierBtn.id = "open-dossier-view";
    dossierBtn.dataset.testid = "open-dossier-view";
    dossierBtn.appendChild(el("span", "", "Dossier"));
    dossierBtn.appendChild(svgIcon("chevron", 10));
    dossierBtn.addEventListener("click", () => switchView("dossier"));
    nav.appendChild(dossierBtn);

    const auditBtn = el("button", "guide-link-btn");
    auditBtn.type = "button";
    auditBtn.id = "open-audit-view";
    auditBtn.dataset.testid = "open-audit-view";
    auditBtn.appendChild(el("span", "", "Audit"));
    auditBtn.appendChild(svgIcon("chevron", 10));
    auditBtn.addEventListener("click", () => switchView("audit"));
    nav.appendChild(auditBtn);

    if (snap.trust?.enrolled) {
      const trustBtn = el("button", "guide-link-btn");
      trustBtn.type = "button";
      trustBtn.id = "open-trust-view";
      trustBtn.dataset.testid = "open-trust-view";
      const activeLvl = snap.trust.activeCatState?.level ?? 0;
      trustBtn.appendChild(el("span", "", `Trust · L${activeLvl}`));
      trustBtn.appendChild(svgIcon("chevron", 10));
      trustBtn.addEventListener("click", () => switchView("trust"));
      nav.appendChild(trustBtn);
    }
    const guideBtn = el("button", "guide-link-btn");
    guideBtn.type = "button";
    guideBtn.id = "open-delegate-guide";
    guideBtn.dataset.testid = "open-delegate-guide";
    guideBtn.appendChild(el("span", "", "Guide"));
    guideBtn.appendChild(svgIcon("chevron", 10));
    guideBtn.addEventListener("click", () => switchView("delegate"));
    nav.appendChild(guideBtn);
    strip.appendChild(nav);

    const focusDrawer = document.getElementById("focus-artifacts");
    if (focusDrawer) {
      renderFocusDrawer(focusDrawer, snap, act);
    }
  }

  function renderFocusDrawer(container, snap, act) {
    if (!state.solo) {
      container.replaceChildren();
      container.classList.add("hidden");
      return;
    }

    if (state.solo === "art") {
      const box = el("div", "focus-drawer");
      box.dataset.testid = "focus-drawer-artifacts";
      const fileArtifacts = (snap.stages || []).flatMap((s) => (s.artifacts || []).filter((a) => a.kind !== "pr"));
      if (fileArtifacts.length === 0) {
        box.appendChild(el("p", "focus-empty", "No file artifacts generated in this conversation yet."));
      } else {
        const ul = el("ul", "sub-accordion-list focus-drawer-list");
        for (const art of fileArtifacts) {
          const li = el("li", "drawer-item-row");
          const btn = el("button", "drawer-select-btn");
          btn.type = "button";
          const ic = svgIcon("diamond", 10);
          if (art.status === "updating") {
            ic.classList.add("pulse");
            ic.style.color = "var(--tl-primary)";
          } else if (art.status === "stale") {
            ic.style.color = "var(--tl-warning)";
          } else {
            ic.style.color = "var(--tl-done)";
          }
          btn.appendChild(ic);
          btn.appendChild(el("span", "drawer-item-title", art.label || art.name));
          if (art.badge) {
            btn.appendChild(el("span", `artifact-badge ${art.status || ""}`, art.badge));
          }
          const chev = svgIcon("chevron", 11);
          chev.classList.add("drawer-item-chev");
          btn.appendChild(chev);
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openArtifact(art, btn);
          });
          li.appendChild(btn);
          ul.appendChild(li);
        }
        box.appendChild(ul);
      }
      container.replaceChildren(box);
      container.classList.remove("hidden");
      return;
    }

    if (state.solo === "prs") {
      const box = el("div", "focus-drawer");
      box.dataset.testid = "focus-drawer-prs";
      const prItems = act.prs?.items || [];
      if (prItems.length === 0) {
        box.appendChild(el("p", "focus-empty", "No pull requests opened in this conversation yet."));
      } else {
        const ul = el("ul", "sub-accordion-list focus-drawer-list");
        for (const p of prItems) {
          const li = el("li", "sub-row pr-row");
          const st = p.state || "open";
          const icWrap = el("span", `pr-icon ${st}`);
          icWrap.appendChild(svgIcon(st === "merged" ? "pr-merged" : "pr", 12));
          li.appendChild(icWrap);
          const label = `#${p.number}`;
          if (p.url) {
            const link = el("a", "pr-link");
            link.href = p.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.appendChild(el("span", "pr-num", label));
            if (p.title) link.appendChild(el("span", "pr-title", p.title));
            link.appendChild(svgIcon("external", 10));
            li.appendChild(link);
          } else {
            li.appendChild(el("span", "pr-num", label));
            if (p.title) li.appendChild(el("span", "pr-title", p.title));
          }
          li.appendChild(el("span", `pr-badge ${st}`, st));
          ul.appendChild(li);
        }
        box.appendChild(ul);
      }
      container.replaceChildren(box);
      container.classList.remove("hidden");
      return;
    }

    if (state.solo === "later") {
      const box = el("div", "focus-drawer");
      box.dataset.testid = "focus-drawer-tasks";
      const bgItems = act.backgroundJobs?.items || [];
      const bgTaskIds = new Set(bgItems.map((j) => j.taskId).filter(Boolean));
      const activeScheds = (act.schedules || []).filter((s) => s.active && (!s.taskId || !bgTaskIds.has(s.taskId)));
      const activeAutos = (act.automations || []).filter((a) => a.active);
      if (activeScheds.length === 0 && activeAutos.length === 0 && bgItems.length === 0) {
        box.appendChild(el("p", "focus-empty", "No background tasks or active schedules yet."));
      } else {
        const ul = el("ul", "sub-accordion-list focus-drawer-list");
        for (const s of activeScheds) {
          const li = el("li", "sub-row");
          const dw = el("span", "sub-row-dot-wrap");
          dw.appendChild(el("span", "sub-row-dot active"));
          li.appendChild(dw);
          li.appendChild(el("span", "sub-row-name", s.cadence || "timer"));
          li.appendChild(el("span", "sub-row-task", s.label));
          if (s.nextAt) {
            const cd = el("span", "sub-row-timer", formatCountdownText(s.nextAt));
            cd.dataset.timerKind = "countdown";
            cd.dataset.nextAt = s.nextAt;
            li.appendChild(cd);
          }
          ul.appendChild(li);
        }
        for (const a of activeAutos) {
          const li = el("li", "sub-row");
          const dw = el("span", "sub-row-dot-wrap");
          dw.appendChild(el("span", "sub-row-dot active"));
          li.appendChild(dw);
          li.appendChild(el("span", "sub-row-name", "auto"));
          li.appendChild(el("span", "sub-row-task", a.label));
          li.appendChild(el("span", "sub-row-stat active", a.cadence || "on"));
          ul.appendChild(li);
        }
        for (const job of [...bgItems].reverse()) {
          const li = el("li", "drawer-item-row task-item-row");
          const btn = el("button", "drawer-select-btn");
          btn.type = "button";
          const title = job.title || job.summary || job.taskSlug || "Task";
          btn.title = job.command ? `${title}\n${job.command}` : title;
          const dw = el("span", "sub-row-dot-wrap");
          if (job.status === "running") {
            dw.appendChild(el("span", "sub-row-dot active"));
          } else if (job.status === "stopped") {
            const stIc = svgIcon("stop", 11);
            stIc.style.color = "var(--tl-fg-muted)";
            dw.appendChild(stIc);
          } else if (job.status === "failed") {
            const failIc = svgIcon("warn", 11);
            failIc.style.color = "var(--tl-error)";
            dw.appendChild(failIc);
          } else {
            const chk = svgIcon("check-sm", 10);
            chk.style.color = "var(--tl-done)";
            dw.appendChild(chk);
          }
          btn.appendChild(dw);
          btn.appendChild(el("span", "drawer-item-title", title));
          if (job.startedAt) {
            const timerEl = el("span", "sub-row-timer", formatElapsedText(job.startedAt, job.completedAt));
            if (job.status === "running") {
              timerEl.dataset.timerKind = "elapsed";
              timerEl.dataset.startedAt = job.startedAt;
            }
            btn.appendChild(timerEl);
          }
          const chev = svgIcon("chevron", 10);
          chev.classList.add("drawer-item-chev");
          btn.appendChild(chev);
          btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            openTaskLog(job, btn);
          });
          li.appendChild(btn);
          appendAskButton(li, `What happened in background task "${title}"?`, `Ask /btw about ${title}`);
          ul.appendChild(li);
        }
        box.appendChild(ul);
      }
      container.replaceChildren(box);
      container.classList.remove("hidden");
      return;
    }

    container.replaceChildren();
    container.classList.add("hidden");
  }

  function renderStatusBanner(snap, isNonRepo) {
    const wrap = document.getElementById("status-banner-wrap");
    const banner = document.getElementById("status-banner");
    if (!wrap || !banner) return;
    banner.replaceChildren();
    if (isNonRepo || snap.setup?.status === "needs_setup" || (!snap.hasConversation && !snap.nextAction)) {
      wrap.classList.add("hidden");
      return;
    }

    const stages = snap.stages || [];
    const byId = new Map(stages.map((s) => [s.id, s]));
    const plan = byId.get("plan");
    const build = byId.get("build");
    const review = byId.get("review");
    const ship = byId.get("ship");
    const liveIds = snap.activity?.liveStageIds || [];

    let tone = "is-idle";
    let iconKind = "dot";
    let badge = "Next";
    let text = "";
    let guided = false;
    let title = "";
    let instruction = "";
    let cmdPrompt = null;
    let cmdLabel = null;
    let secondaryAction = null;
    const alternative = snap.nextAction?.alternative || null;

    if (state.panelMode === "review_pr" && snap.colleagueReview?.detected) {
      tone = snap.colleagueReview.running ? "is-running" : "is-done";
      iconKind = snap.colleagueReview.running ? "dot" : "check";
      badge = snap.colleagueReview.running ? "Working" : "Reviewing";
      const cmds = snap.colleagueReview.detectedCommands || [];
      text = cmds.length > 0
        ? `Colleague PR review active (${cmds.join(", ")}).`
        : "Colleague PR review mode active.";
    } else if (state.panelMode === "review_pr") {
      wrap.classList.add("hidden");
      return;
    } else if (liveIds.length > 0) {
      const liveStage = stages.find((s) => liveIds.includes(s.id));
      tone = "is-running";
      iconKind = "dot";
      badge = "Working";
      text = liveStage ? `${liveStage.label} · ${liveStage.collapsedSummary || liveStage.detail}` : "Agents running.";
    } else if (
      plan?.readOnlyComplete &&
      !snap.nextAction &&
      build?.status === "pending" &&
      review?.status === "pending" &&
      ship?.status === "pending"
    ) {
      tone = "is-done";
      iconKind = "check";
      badge = "Done";
      text = plan.collapsedSummary || "Investigation complete (read-only).";
    } else if (ship?.status === "done" && !snap.nextAction) {
      tone = "is-done";
      iconKind = "check";
      badge = "All done";
      text = ship.collapsedSummary || "All workflow stages complete.";
    } else if (review?.status === "error") {
      guided = true;
      tone = "is-err";
      iconKind = "warn";
      badge = "Needs attention";
      title = snap.nextAction?.title || "Resolve escalated Pre-PR findings";
      instruction = snap.nextAction?.instruction || review.detail || "Remediation round cap reached.";
      cmdLabel = snap.nextAction?.command || "/pre-pr";
      cmdPrompt = snap.nextAction?.prompt || "/pre-pr";
    } else if (review?.status === "stale") {
      guided = true;
      tone = "is-yourturn";
      iconKind = "warn";
      badge = "Needs attention";
      title = snap.nextAction?.title || "Re-run Pre-PR Check on updated HEAD";
      instruction = snap.nextAction?.instruction || snap.nextAction?.hint || "New edits invalidated the PR check. Re-run /pre-pr.";
      cmdLabel = snap.nextAction?.command || "/pre-pr";
      cmdPrompt = snap.nextAction?.prompt || cmdLabel;
    } else if (plan?.status === "waiting_gate") {
      guided = true;
      tone = "is-yourturn";
      iconKind = "dot";
      badge = "Your turn";
      if (plan.waitingArtifact === "diagnosis") {
        const diagArt = (plan.artifacts || []).find((a) => a.name === "diagnosis.md") || plan.artifact;
        title = snap.nextAction?.title || "Review root-cause diagnosis";
        instruction =
          snap.nextAction?.instruction || "Review diagnosis.md, then run /plan to draft a fix or close read-only.";
        cmdLabel = "/plan";
        cmdPrompt = snap.nextAction?.prompt || "/plan";
        if (diagArt) {
          secondaryAction = { type: "artifact", label: "Open Diagnosis", artifact: diagArt };
        }
      } else {
        const planArt = (plan.artifacts || []).find((a) => a.name === "implementation_plan.md") || plan.artifact;
        title =
          snap.nextAction?.title ||
          (plan.combinedGate ? "Approve combined diagnosis and plan" : "Approve implementation plan");
        instruction =
          snap.nextAction?.instruction ||
          (plan.combinedGate
            ? "Review diagnosis and implementation plan, then click Proceed."
            : "Review implementation_plan.md, then click Proceed.");
        cmdLabel = "Proceed";
        cmdPrompt = snap.nextAction?.prompt || "Proceed";
        if (planArt) {
          secondaryAction = { type: "artifact", label: "Open Plan", artifact: planArt };
        }
      }
    } else if (review?.status === "waiting_gate") {
      guided = true;
      tone = "is-yourturn";
      iconKind = "dot";
      badge = "Your turn";
      title = snap.nextAction?.title || "Inspect PR dossier, then open PR";
      instruction = snap.nextAction?.instruction || "Review the PR dossier, then open or merge the PR.";
      cmdLabel = snap.nextAction?.command || "/astack-mode open the pr";
      cmdPrompt = snap.nextAction?.prompt || "/astack-mode open the pr";
      secondaryAction = review.artifact
        ? { type: "artifact", label: "Open Dossier", artifact: review.artifact }
        : { type: "view", label: "Open Dossier", view: "dossier" };
    } else if (snap.nextAction) {
      guided = true;
      tone = "is-idle";
      iconKind = "dot";
      badge = "Recommended next";
      title = snap.nextAction.title || snap.nextAction.stageLabel || "Next step";
      instruction = snap.nextAction.instruction || snap.nextAction.hint || "Ready to start.";
      cmdLabel = snap.nextAction.command || null;
      cmdPrompt = snap.nextAction.prompt || cmdLabel;
    } else {
      wrap.classList.add("hidden");
      return;
    }

    const appendIcon = (parent) => {
      if (iconKind === "check") {
        const ic = svgIcon("check-sm", 12);
        ic.classList.add("status-banner-icon");
        parent.appendChild(ic);
      } else if (iconKind === "warn") {
        const ic = svgIcon("warn", 12);
        ic.classList.add("status-banner-icon");
        parent.appendChild(ic);
      } else {
        const dot = el("span", tone === "is-running" ? "status-banner-dot pulse" : "status-banner-dot");
        dot.setAttribute("aria-hidden", "true");
        parent.appendChild(dot);
      }
    };

    wrap.classList.remove("hidden");
    if (!guided) {
      banner.className = `status-banner ${tone}`;
      const lead = el("div", "status-banner-lead");
      appendIcon(lead);
      lead.appendChild(el("span", "status-banner-badge", badge));
      lead.appendChild(el("span", "status-banner-copy", text));
      banner.appendChild(lead);
      return;
    }

    banner.className = `status-banner is-guided ${tone}`;
    const head = el("div", "status-banner-head");
    appendIcon(head);
    head.appendChild(el("span", "status-banner-badge", badge));
    if (title) head.appendChild(el("span", "status-banner-title", title));
    banner.appendChild(head);

    if (instruction) {
      banner.appendChild(el("p", "status-banner-instruction", instruction));
    }

    if (cmdPrompt || secondaryAction) {
      const cmdRow = el("div", "status-banner-cmd-row");
      if (cmdPrompt) {
        const codeEl = el("code", "status-banner-cmd", cmdPrompt);
        codeEl.dataset.testid = "status-banner-cmd";
        cmdRow.appendChild(codeEl);
      }
      const actions = el("div", "status-banner-actions");
      if (secondaryAction) {
        const secBtn = el("button", "status-banner-action", secondaryAction.label);
        secBtn.type = "button";
        if (secondaryAction.type === "artifact") {
          secBtn.addEventListener("click", () => openArtifact(secondaryAction.artifact, secBtn));
        } else if (secondaryAction.type === "view") {
          secBtn.addEventListener("click", () => switchView(secondaryAction.view));
        }
        actions.appendChild(secBtn);
      }
      if (cmdPrompt) {
        const isProceed = cmdPrompt === "Proceed";
        const copyBtn = el("button", "status-banner-action is-primary");
        copyBtn.type = "button";
        copyBtn.dataset.testid = "status-banner-copy";
        if (!isProceed) {
          copyBtn.appendChild(svgIcon("copy", 11));
        }
        copyBtn.appendChild(el("span", "", isProceed ? "Proceed" : "Copy command"));
        const meta = cmdLabel ? lookupCommandMeta(snap, cmdLabel) : null;
        copyBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          copyCommand(
            { ...(meta || {}), command: cmdLabel || cmdPrompt, copyText: cmdPrompt },
            copyBtn,
            cmdPrompt !== (cmdLabel || cmdPrompt),
          );
        });
        actions.appendChild(copyBtn);
      }
      cmdRow.appendChild(actions);
      banner.appendChild(cmdRow);
    }

    if (alternative && alternative.prompt) {
      const altRow = el("div", "status-banner-alt");
      altRow.appendChild(el("span", "status-banner-alt-label", "Optional:"));
      const altBtn = el("button", "subcmd-pill is-sans", alternative.label || alternative.command);
      altBtn.type = "button";
      altBtn.dataset.testid = "status-banner-alt";
      if (alternative.summary) {
        attachStatusPopover(altBtn, alternative.label || alternative.command, alternative.command, "", alternative.summary);
      }
      altBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        copyCommand({ command: alternative.command, copyText: alternative.prompt }, altBtn, true);
      });
      altRow.appendChild(altBtn);
      banner.appendChild(altRow);
    }
  }

  function renderFooter(snap) {
    const footer = document.getElementById("panel-footer");
    if (!footer) return;
    const helpMeta = (snap && lookupCommandMeta(snap, "/astack-help")) || {
      command: "/astack-help",
      copyText: "/astack-help",
      state: "pending",
      optional: true,
    };
    const helpChip = buildCommandChip(helpMeta);
    const refLink = el("a", "footer-link");
    refLink.href = `${DOCS_URL_PREFIX}blob/main/docs/user-guide.md`;
    refLink.target = "_blank";
    refLink.rel = "noopener noreferrer";
    refLink.appendChild(el("span", "", "Full timeline reference"));
    refLink.appendChild(svgIcon("external", 10));
    footer.replaceChildren(helpChip, refLink);
  }

  function resolveDefaultGuideStage(snap, stages) {
    if (snap?.setup?.status === "needs_setup") return "setup";
    const targetId = snap?.activity?.liveStageIds?.[0] || snap?.activity?.suggestedStageId;
    if (targetId && Array.isArray(stages) && stages.some((s) => s.id === targetId)) {
      return targetId;
    }
    return "plan";
  }

  function resolveStageGuideBadge(stageId, snap) {
    if (!snap) return null;
    if (stageId === "setup") {
      return snap.setup?.status === "needs_setup" ? { text: "needed", cls: "warn" } : null;
    }
    const stage = snap.stages?.find((s) => s.id === stageId);
    const act = snap.activity || {};
    if (stage?.status === "error") return { text: "escalated", cls: "warn" };
    if (stage?.status === "stale") return { text: "re-run", cls: "warn" };
    if (stage?.status === "waiting_gate") return { text: "review", cls: "warn" };
    if (
      stageId === "build" &&
      (act.agentsWorkingCount > 0 || act.boost?.active || act.goal?.active || act.teamwork?.active)
    ) {
      return {
        text: act.agentsWorkingCount > 0 ? `${act.agentsWorkingCount} live` : "active",
        cls: "active",
      };
    }
    if (stageId === "ship") {
      const count = (act.schedules || []).filter((s) => s.active).length;
      if (count > 0) {
        return { text: `${count} timer${count === 1 ? "" : "s"}`, cls: "active" };
      }
    }
    if (stage?.status === "active") return { text: "running", cls: "active" };
    if (stage?.status === "next") return { text: "next", cls: "active" };
    return null;
  }

  const COMMAND_GUIDE_BADGES = {
    "/swarm": (act) => {
      const sw = act.swarm || {};
      if (!sw.active) return "";
      return sw.totalCount > 0 ? `${sw.workingCount || 0}/${sw.totalCount} live` : "active";
    },
    "/browser": (act) =>
      (act.subagents || []).some((a) => a.type === "browser" && a.status === "running") ? "in use" : "",
    "/run-workflow": (act) =>
      act.workflow?.active ? "running" : act.workflow?.suggestedReview ? "for Pre-PR Check" : "",
    "/boost": (act) => (act.boost?.active ? "active" : ""),
    "/goal": (act) => (act.goal?.active ? "active" : ""),
    "/teamwork": (act) => (act.teamwork?.active ? "active" : ""),
    "/schedule": (act) => {
      const count = (act.schedules || []).filter((s) => s.active).length;
      return count > 0 ? `${count} timer${count === 1 ? "" : "s"}` : "";
    },
    "/automation": (act) => {
      const count = (act.automations || []).filter((a) => a.active).length;
      return count > 0 ? `${count} on` : "";
    },
    subagents: (act) => {
      const count = act.runningSubagentsCount || 0;
      return count > 0 ? `${count} live` : "";
    },
  };

  function resolveCommandGuideBadge(cmd, snap) {
    const resolver = COMMAND_GUIDE_BADGES[cmd];
    return resolver ? resolver(snap?.activity || {}) : "";
  }

  const GUIDE_STAGE_STATUS = {
    active: { word: "running", cls: "" },
    waiting_gate: { word: "review", cls: "warn" },
    error: { word: "escalated", cls: "warn" },
    stale: { word: "re-run", cls: "warn" },
    done: { word: "done", cls: "done" },
  };

  function resolveGuideHeaderStatus(snap) {
    if (snap?.setup?.status === "needs_setup") {
      return { text: "Setup needed", cls: "warn" };
    }
    const stages = snap?.stages || [];
    const liveIds = snap?.activity?.liveStageIds || [];
    const focalStage =
      stages.find((s) => liveIds.includes(s.id)) ||
      stages.find((s) => s.railState === "error" || s.railState === "stale" || s.railState === "yourturn") ||
      stages.find((s) => s.id === snap?.activity?.suggestedStageId) ||
      stages.find((s) => s.railState === "done");
    if (focalStage) {
      const mapped = GUIDE_STAGE_STATUS[focalStage.status];
      return {
        text: `${focalStage.label} ${mapped ? mapped.word : focalStage.status}`,
        cls: mapped ? mapped.cls : "",
      };
    }
    return { text: "Ready", cls: "" };
  }

  function buildGuideCommandChip(cmd, snap, liveText = "") {
    const meta = lookupCommandMeta(snap, cmd);
    const isInternal = meta?.invocable === false;
    const chip = el(isInternal ? "span" : "button", isInternal ? "guide-cmd-chip is-internal" : "guide-cmd-chip");
    if (isInternal) {
      chip.tabIndex = 0;
      chip.setAttribute("role", "status");
      attachCommandPopover(chip, meta);
    } else {
      chip.type = "button";
      wireCommandAction(chip, meta || cmd);
    }
    chip.appendChild(el("span", "", cmd));
    if (liveText) {
      chip.appendChild(el("span", "guide-cmd-live", liveText));
    }
    return chip;
  }

  function buildGuidePromptCard(selected, snap) {
    const card = el("div", "prompt-card");
    card.dataset.testid = "guide-prompt-card";

    const cardHead = el("div", "prompt-card-head");
    cardHead.appendChild(el("span", "prompt-card-kicker", selected.kicker));
    const copyBtn = el("button", "copy-inline-btn");
    copyBtn.type = "button";
    copyBtn.setAttribute("aria-label", `Copy ${selected.label} prompt`);
    copyBtn.appendChild(svgIcon("copy", 12));
    copyBtn.appendChild(el("span", "", "Copy"));
    copyBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copyCommand({ command: selected.commands[0] || selected.label, copyText: selected.prompt }, copyBtn, true);
    });
    cardHead.appendChild(copyBtn);
    card.appendChild(cardHead);

    card.appendChild(el("p", "prompt-card-code", selected.prompt));
    card.appendChild(el("p", "prompt-card-how", selected.how));

    const foot = el("div", "prompt-card-foot");
    const tags = el("div", "prompt-cmd-tags");
    for (const cmd of selected.commands || []) {
      tags.appendChild(buildGuideCommandChip(cmd, snap));
    }
    foot.appendChild(tags);
    if (selected.ownership) {
      foot.appendChild(el("span", "guide-owner-note", selected.ownership));
    }
    card.appendChild(foot);
    return card;
  }

  function renderDelegateGuide(snap) {
    const container = document.getElementById("delegate-view");
    const guide = window.ASTACK_CATALOG?.delegateGuide;
    const stages = guide?.stages || [];
    if (!container || stages.length === 0) return;

    const activeEl = container.contains(document.activeElement) ? document.activeElement : null;
    const activeTestId = activeEl?.dataset?.testid || null;
    const restoreFocusVisible = Boolean(activeTestId && activeEl?.matches?.(":focus-visible"));

    const contextStageId = resolveDefaultGuideStage(snap, stages);
    if (!state.guideUserToggled) {
      state.guideExpandedStage = contextStageId;
    }

    const header = el("header", "delegate-header");
    const backBtn = el("button", "back-btn");
    backBtn.type = "button";
    backBtn.id = "back-to-timeline";
    backBtn.dataset.testid = "back-to-timeline";
    backBtn.appendChild(svgIcon("back", 12));
    backBtn.appendChild(el("span", "", "Timeline"));
    backBtn.addEventListener("click", () => switchView("timeline", true));
    header.appendChild(backBtn);

    const pillInfo = resolveGuideHeaderStatus(snap);
    const titleRow = el("div", "delegate-title-row");
    titleRow.appendChild(el("h1", "title", "Command Guide"));
    const statusPill = el("span", pillInfo.cls ? `delegate-status-pill ${pillInfo.cls}` : "delegate-status-pill");
    const pDot = el("span", "live-dot");
    pDot.style.background = "currentColor";
    statusPill.appendChild(pDot);
    statusPill.appendChild(el("span", "", pillInfo.text));
    titleRow.appendChild(statusPill);
    header.appendChild(titleRow);
    header.appendChild(
      el("p", "delegate-lead", "Pick a stage to see combined prompts and commands you can copy straight into chat."),
    );

    const groupsWrap = el("div", "guide-stage-groups");
    groupsWrap.dataset.testid = "guide-stage-groups";

    for (const stage of stages) {
      const isOpen = state.guideExpandedStage === stage.id;
      const isContext = stage.id === contextStageId;
      const sec = el("section", isContext ? "guide-stage-group is-context" : "guide-stage-group");
      sec.setAttribute("aria-label", stage.title);

      const heading = el("h2", "guide-acc-heading");
      const accBtn = el("button", "guide-acc-btn");
      accBtn.type = "button";
      accBtn.dataset.testid = `guide-stage-${stage.id}`;
      accBtn.setAttribute("aria-expanded", String(isOpen));
      accBtn.addEventListener("click", () => {
        state.guideUserToggled = true;
        state.guideExpandedStage = state.guideExpandedStage === stage.id ? null : stage.id;
        state.guideCmdDrawerOpen = false;
        renderDelegateGuide(state.snap);
      });

      const iconWrap = el("span", "guide-acc-icon");
      iconWrap.appendChild(svgIcon(stage.icon, 14));
      accBtn.appendChild(iconWrap);

      const copyWrap = el("span", "guide-acc-copy");
      copyWrap.appendChild(el("span", "guide-acc-title", stage.title));
      copyWrap.appendChild(el("span", "guide-acc-sub", stage.subtitle));
      accBtn.appendChild(copyWrap);

      const badge = resolveStageGuideBadge(stage.id, snap);
      if (badge) {
        accBtn.appendChild(el("span", `guide-live-badge ${badge.cls}`.trim(), badge.text));
      }

      const chev = svgIcon("chevron", 13);
      chev.classList.add("chev");
      accBtn.appendChild(chev);
      heading.appendChild(accBtn);
      sec.appendChild(heading);

      if (isOpen) {
        const panel = el("div", "guide-stage-panel");
        panel.dataset.testid = `guide-panel-${stage.id}`;
        const selectedId = state.guideSelectedExampleByStage[stage.id] || stage.examples[0].id;
        const selected = stage.examples.find((e) => e.id === selectedId) || stage.examples[0];

        const chipsRow = el("div", "guide-example-chips");
        chipsRow.setAttribute("role", "group");
        chipsRow.setAttribute("aria-label", `${stage.title} examples`);
        for (const ex of stage.examples) {
          const chip = el("button", "pick-chip", ex.label);
          chip.type = "button";
          chip.dataset.testid = `guide-example-${ex.id}`;
          chip.setAttribute("aria-pressed", String(ex.id === selected.id));
          chip.addEventListener("click", () => {
            state.guideSelectedExampleByStage[stage.id] = ex.id;
            renderDelegateGuide(state.snap);
          });
          chipsRow.appendChild(chip);
        }
        panel.appendChild(chipsRow);
        panel.appendChild(buildGuidePromptCard(selected, snap));

        const drawer = el("div", "guide-cmd-drawer");
        const toggle = el("button", "guide-cmd-drawer-btn");
        toggle.type = "button";
        toggle.dataset.testid = `guide-cmds-toggle-${stage.id}`;
        toggle.setAttribute("aria-expanded", String(state.guideCmdDrawerOpen));
        const dChev = svgIcon("chevron", 11);
        dChev.classList.add("chev");
        toggle.appendChild(dChev);
        toggle.appendChild(el("span", "", `Commands (${stage.commands.length})`));
        toggle.addEventListener("click", () => {
          state.guideCmdDrawerOpen = !state.guideCmdDrawerOpen;
          renderDelegateGuide(state.snap);
        });
        drawer.appendChild(toggle);

        if (state.guideCmdDrawerOpen) {
          const drawerChips = el("div", "guide-cmd-drawer-chips");
          for (const cmd of stage.commands) {
            drawerChips.appendChild(buildGuideCommandChip(cmd, snap, resolveCommandGuideBadge(cmd, snap)));
          }
          drawer.appendChild(drawerChips);
        }
        panel.appendChild(drawer);
        sec.appendChild(panel);
      }

      groupsWrap.appendChild(sec);
    }

    const footerClone = el("footer", "panel-footer");
    footerClone.dataset.testid = "delegate-footer";
    const fLeft = el("a", "footer-link");
    fLeft.href = "https://antigravity.google/docs/commands/";
    fLeft.target = "_blank";
    fLeft.rel = "noopener noreferrer";
    fLeft.appendChild(el("span", "", "Antigravity commands"));
    fLeft.appendChild(svgIcon("external", 10));
    const fRight = el("a", "footer-link");
    fRight.href = `${DOCS_URL_PREFIX}blob/main/docs/agent-timeline.md`;
    fRight.target = "_blank";
    fRight.rel = "noopener noreferrer";
    fRight.appendChild(el("span", "", "agent-timeline.md"));
    fRight.appendChild(svgIcon("external", 10));
    footerClone.replaceChildren(fLeft, fRight);

    container.replaceChildren(header, groupsWrap, footerClone);
    if (state.popoverAnchor && !document.contains(state.popoverAnchor)) {
      hideCommandPopover();
    }
    if (restoreFocusVisible && activeTestId) {
      const replacement = container.querySelector(`[data-testid="${CSS.escape(activeTestId)}"]`);
      replacement?.focus({ preventScroll: true });
    }
  }

  function renderTrustView(snap) {
    const container = document.getElementById("trust-view");
    const trust = snap?.trust;
    if (!container || !trust) return;

    const header = el("header", "delegate-header");
    const backBtn = el("button", "back-btn");
    backBtn.type = "button";
    backBtn.id = "back-from-trust";
    backBtn.dataset.testid = "back-from-trust";
    backBtn.appendChild(svgIcon("back", 10));
    backBtn.appendChild(el("span", "", "Timeline"));
    backBtn.addEventListener("click", () => switchView("timeline", true));
    header.appendChild(backBtn);

    const titleRow = el("div", "delegate-title-row");
    titleRow.appendChild(el("h1", "title", "Trust & Autonomy"));
    const statusPill = el("span", "delegate-status-pill");
    const pDot = el("span", "live-dot");
    pDot.style.background = "currentColor";
    statusPill.appendChild(pDot);
    statusPill.appendChild(
      el(
        "span",
        "",
        trust.frozen
          ? "Frozen (ledger invalid)"
          : trust.beastOn
            ? `Beast On · ${trust.promotionMode === "auto" ? "Auto promote" : "Manual promote"}`
            : "Beast Off",
      ),
    );
    titleRow.appendChild(statusPill);
    header.appendChild(titleRow);
    header.appendChild(
      el("p", "delegate-lead", "Earned per (repo, category) from graded outcomes (clean 1, edited 0.5, reverted 0). Plain code routes; human ceilings always cap autonomy."),
    );

    const picker = el("section", "delegate-picker");
    picker.appendChild(el("span", "delegate-picker-label", "Autonomy & Promotion Settings (local plugin data, protected from agent writes)"));
    const row1 = el("div", "delegate-pick-chips");
    for (const [val, lbl] of [[false, "Beast: Off"], [true, "Beast: On"]]) {
      const b = el("button", "pick-chip", lbl);
      b.type = "button";
      b.setAttribute("aria-pressed", String(Boolean(trust.beastOn) === val));
      b.addEventListener("click", () => updateTrustSettings({ beastOn: val }, `Beast Mode ${val ? "On" : "Off"}`));
      row1.appendChild(b);
    }
    for (const [val, lbl] of [["manual", "Promote: Manual (default)"], ["auto", "Promote: Auto up to Ceiling"]]) {
      const b = el("button", "pick-chip", lbl);
      b.type = "button";
      b.disabled = val === "auto" && Boolean(trust.promotionLockedByPolicy);
      b.setAttribute("aria-pressed", String(trust.promotionMode === val));
      b.addEventListener("click", () => updateTrustSettings({ promotionMode: val }, `Promotion set to ${val}`));
      row1.appendChild(b);
    }
    picker.appendChild(row1);

    const secWrap = el("div", "guide-sections");
    const sec = el("section", "guide-section");
    const head = el("div", "guide-section-head");
    head.append(
      el("span", "guide-section-title", "Categories"),
      el("span", "guide-section-sub", `Active: ${trust.activeCategory}`),
      el("span", trust.chainValid ? "guide-section-stat active" : "guide-section-stat", trust.chainValid ? "Ledger hash chain valid" : "Ledger broken (L0 frozen)"),
    );
    sec.appendChild(head);

    for (const cat of trust.categories || []) {
      const row = el("div", cat.id === trust.activeCategory ? "trust-cat-row is-active-cat" : "trust-cat-row");
      const top = el("div", "trust-cat-top");
      top.appendChild(el("span", "trust-cat-name", cat.id));
      top.appendChild(el("span", cat.level >= 2 ? "guide-status-pill done" : "guide-status-pill", `L${cat.level}`));
      top.appendChild(el("span", "guide-badge", `T ${Number(cat.score ?? 0).toFixed(2)}`));
      top.appendChild(el("span", "guide-badge", `Brier ${Number(cat.brier ?? 0).toFixed(2)}`));
      top.appendChild(el("span", "trust-cat-spacer"));
      top.appendChild(el("span", "beast-ctrl-label", cat.maxCeiling < 3 ? "Cap (L2 max):" : "Ceiling:"));
      for (const cap of [1, 2, 3]) {
        const locked = cap > cat.maxCeiling;
        const btn = el("button", locked ? "subcmd-pill is-sans is-locked" : "subcmd-pill is-sans", `L${cap}`);
        btn.type = "button";
        btn.disabled = locked;
        btn.setAttribute("aria-pressed", String(cat.ceiling === cap));
        btn.title = locked ? `${cat.id} is capped at L${cat.maxCeiling}` : `Set ${cat.id} ceiling to L${cap}`;
        btn.addEventListener("click", () => updateTrustSettings({ setCeiling: { category: cat.id, ceiling: cap } }, `${cat.id} ceiling set to L${cap}`));
        top.appendChild(btn);
      }

      const bar = el("div", "trust-ema-bar");
      const fill = el("div", "trust-ema-fill");
      fill.style.width = `${Math.round(Number(cat.score ?? 0) * 100)}%`;
      bar.appendChild(fill);

      const meta = el("div", "trust-cat-meta");
      meta.appendChild(el("span", "", `${cat.label} · ${cat.clean} clean · ${cat.edited} edited · ${cat.reverted} reverted`));
      if (cat.promoReady && cat.eligibleNextLevel !== null) {
        const pBtn = el("button", "subcmd-pill is-sans ran", `Promote -> L${cat.eligibleNextLevel}`);
        pBtn.type = "button";
        pBtn.addEventListener("click", () => updateTrustSettings({ promoteCategory: cat.id }, `${cat.id} promoted to L${cat.eligibleNextLevel}`));
        meta.appendChild(pBtn);
      }

      row.append(top, bar, meta);
      sec.appendChild(row);
    }
    secWrap.appendChild(sec);
    container.replaceChildren(header, picker, secWrap);
  }

  function buildSubViewHeader({ backId, refreshId, title, pillText, pillClass = "", leadText, loading = false, onRefresh }) {
    const header = el("header", "delegate-header");
    const navRow = el("div", "artifact-nav-row");
    const backBtn = el("button", "back-btn");
    backBtn.type = "button";
    backBtn.id = backId;
    backBtn.dataset.testid = backId;
    backBtn.appendChild(svgIcon("back", 10));
    backBtn.appendChild(el("span", "", "Timeline"));
    backBtn.addEventListener("click", () => switchView("timeline", true));
    navRow.appendChild(backBtn);

    if (onRefresh) {
      const refBtn = el("button", "refresh-btn");
      refBtn.type = "button";
      refBtn.id = refreshId;
      refBtn.dataset.testid = refreshId;
      refBtn.disabled = Boolean(loading);
      refBtn.textContent = loading ? "Refreshing..." : "Refresh";
      refBtn.addEventListener("click", onRefresh);
      navRow.appendChild(refBtn);
    }
    header.appendChild(navRow);

    const titleRow = el("div", "delegate-title-row");
    titleRow.appendChild(el("h1", "title", title));
    if (pillText) {
      const statusPill = el("span", pillClass ? `delegate-status-pill ${pillClass}` : "delegate-status-pill");
      const pDot = el("span", "live-dot");
      pDot.style.background = "currentColor";
      statusPill.appendChild(pDot);
      statusPill.appendChild(el("span", "", pillText));
      titleRow.appendChild(statusPill);
    }
    header.appendChild(titleRow);
    if (leadText) {
      header.appendChild(el("p", "delegate-lead", leadText));
    }
    return header;
  }

  function buildCopyActionPill(label, copyText, extraClass = "") {
    const btn = el("button", `subcmd-pill is-sans ${extraClass}`.trim(), label);
    btn.type = "button";
    btn.addEventListener("click", () => copyCommand({ command: label, copyText }, btn, copyText !== label));
    return btn;
  }

  async function loadPanelEndpoint(slotKey, endpoint, renderFn) {
    const slot = state[slotKey];
    const reqSeq = ++slot.reqSeq;
    slot.loading = true;
    slot.error = null;
    renderFn();
    try {
      const res = await apiFetch(endpoint, {
        conversationId: getConversationId(false),
        workspaceUri: state.workspaceUri,
      });
      if (reqSeq !== slot.reqSeq) return;
      if (!res.ok) {
        slot.error = `Request failed (${res.status})`;
      } else {
        slot.data = await res.json();
      }
    } catch (err) {
      if (reqSeq !== slot.reqSeq) return;
      slot.error = err?.message || "Could not load view.";
    } finally {
      if (reqSeq === slot.reqSeq) {
        slot.loading = false;
        renderFn();
      }
    }
  }

  function loadDossierView() {
    return loadPanelEndpoint("dossier", "/api/dossier", renderDossierView);
  }

  function loadAuditView() {
    return loadPanelEndpoint("audit", "/api/arch-audit", renderAuditView);
  }

  function renderDossierView() {
    const container = document.getElementById("dossier-view");
    if (!container) return;
    const slot = state.dossier;
    const res = slot.data;
    const ev = res?.ok ? res.evidence : null;
    const findingsDoc = res?.ok ? res.findingsDoc : null;

    let pillText = slot.loading ? "Compiling..." : "Idle";
    let pillClass = "";
    let leadText = "Branch diff blast radius, guided reading clusters, and PR verifier findings for the active repository.";

    if (ev) {
      pillText = `Tier ${ev.riskTier} (${ev.riskLabel})`;
      pillClass = ev.riskTier >= 3 ? "err" : ev.riskTier === 2 ? "warn" : ev.riskTier === 0 ? "done" : "";
      const shortHead = (ev.headSha || "none").slice(0, 7);
      leadText = `${ev.freshness} · ${shortHead} · Round ${ev.reviewRound}/${ev.maxReviewRounds} (${ev.roundState})`;
    } else if (slot.error || (res && !res.ok)) {
      pillText = res?.reason === "non_repo" || res?.reason === "no_workspace" ? "Unavailable" : "Error";
      pillClass = res?.reason === "non_repo" || res?.reason === "no_workspace" ? "warn" : "err";
    }

    const header = buildSubViewHeader({
      backId: "back-from-dossier",
      refreshId: "refresh-dossier",
      title: "PR Dossier",
      pillText,
      pillClass,
      leadText,
      loading: slot.loading,
      onRefresh: () => loadDossierView(),
    });

    const body = el("div", "dossier-sections");

    if (!res && slot.loading) {
      const sec = el("section", "dossier-section");
      sec.appendChild(el("p", "audit-empty", "Compiling PR review dossier..."));
      body.appendChild(sec);
    } else if (slot.error || (res && !res.ok)) {
      const sec = el("section", "dossier-section");
      sec.appendChild(el("p", "audit-empty", slot.error || res.message || "Could not compile PR dossier."));
      const acts = el("div", "dossier-actions");
      if (slot.error) {
        const retryBtn = el("button", "subcmd-pill is-sans", "Retry");
        retryBtn.type = "button";
        retryBtn.addEventListener("click", () => loadDossierView());
        acts.appendChild(retryBtn);
      }
      acts.appendChild(buildCopyActionPill("/pre-pr", "/pre-pr"));
      sec.appendChild(acts);
      body.appendChild(sec);
    } else if (ev) {
      const delta = ev.assertionDelta || { added: 0, removed: 0, weakeningRatio: 0, flagged: false };
      const deltaSec = el("section", "dossier-section");
      const deltaHead = el("div", "dossier-section-head");
      deltaHead.appendChild(el("h2", "dossier-section-title", "Diff Signals & Test Integrity"));
      deltaHead.appendChild(
        el(
          "span",
          `dossier-badge ${delta.flagged ? "err" : "done"}`,
          delta.flagged ? "FLAGGED" : ev.autoMergeEligible ? "Tier 0 Auto" : "Human Review",
        ),
      );
      deltaSec.appendChild(deltaHead);
      deltaSec.appendChild(
        el("p", "audit-detail", `Test assertions: +${delta.added} / -${delta.removed} (ratio ${delta.weakeningRatio})`),
      );
      const bar = el("div", "trust-ema-bar");
      const pct = Math.min(100, Math.round((Number(delta.weakeningRatio) || 0) * 100));
      const fill = el("div", `dossier-meter-fill ${delta.flagged ? "err" : pct > 10 ? "warn" : ""}`.trim());
      fill.style.width = `${Math.max(4, pct || 4)}%`;
      bar.appendChild(fill);
      deltaSec.appendChild(bar);
      body.appendChild(deltaSec);

      const clusters = Array.isArray(ev.clusters) ? ev.clusters : [];
      const clSec = el("section", "dossier-section");
      const clHead = el("div", "dossier-section-head");
      clHead.appendChild(el("h2", "dossier-section-title", `Guided Reading Clusters (${clusters.length})`));
      clSec.appendChild(clHead);
      if (clusters.length === 0) {
        clSec.appendChild(el("p", "audit-empty", "No changed files against base ref."));
      } else {
        clusters.forEach((cl, idx) => {
          const det = el("details", "dossier-cluster");
          if (idx === 0) det.open = true;
          const sum = el("summary", "dossier-cluster-sum");
          sum.appendChild(el("span", "", cl.title || cl.id));
          sum.appendChild(el("span", "dossier-section-sub", `${(cl.files || []).length} files · +${cl.additions}/-${cl.deletions}`));
          det.appendChild(sum);
          for (const f of Array.isArray(cl.fileLinks) ? cl.fileLinks : []) {
            const row = el("div", "audit-row");
            const btn = el("button", "audit-file-btn", `${f.path}:${f.line}`);
            btn.type = "button";
            btn.addEventListener("click", () => openWorkspaceFile(f.uri, `${f.path}:${f.line}`));
            row.appendChild(btn);
            det.appendChild(row);
          }
          clSec.appendChild(det);
        });
      }
      body.appendChild(clSec);

      const fSec = el("section", "dossier-section");
      const allFindings = Array.isArray(findingsDoc?.findings) ? findingsDoc.findings : [];
      const fHead = el("div", "dossier-section-head");
      fHead.appendChild(el("h2", "dossier-section-title", findingsDoc ? `PR Verifier (${findingsDoc.verdict})` : "PR Verifier"));
      fSec.appendChild(fHead);
      if (!findingsDoc) {
        fSec.appendChild(el("p", "audit-empty", "No findings.json attached yet."));
      } else {
        const tabs = el("div", "guide-example-chips");
        tabs.setAttribute("role", "group");
        tabs.setAttribute("aria-label", "Filter findings by severity");
        for (const sev of ["all", "important", "nit", "pre_existing"]) {
          const cnt = sev === "all" ? allFindings.length : allFindings.filter((f) => f.severity === sev).length;
          const tab = el("button", "pick-chip", `${sev} (${cnt})`);
          tab.type = "button";
          tab.setAttribute("aria-pressed", String(slot.severity === sev));
          tab.addEventListener("click", () => {
            slot.severity = sev;
            renderDossierView();
          });
          tabs.appendChild(tab);
        }
        fSec.appendChild(tabs);

        const visible = slot.severity === "all" ? allFindings : allFindings.filter((f) => f.severity === slot.severity);
        if (visible.length === 0) {
          fSec.appendChild(el("p", "audit-empty", "No matching findings in this category."));
        } else {
          for (const item of visible) {
            const row = el("div", "audit-row");
            row.appendChild(el("div", "audit-detail", `[${item.severity}] ${item.claim}`));
            if (item.uri || item.file) {
              const btn = el("button", "audit-file-btn", `${item.file}:${item.line} (${item.category})`);
              btn.type = "button";
              btn.addEventListener("click", () => openWorkspaceFile(item.uri, `${item.file}:${item.line}`));
              row.appendChild(btn);
            }
            fSec.appendChild(row);
          }
        }
      }
      body.appendChild(fSec);

      const acts = el("div", "dossier-actions");
      acts.appendChild(buildCopyActionPill("/pre-pr", "/pre-pr"));
      if (allFindings.some((f) => f.severity === "important")) {
        acts.appendChild(
          buildCopyActionPill(
            "Fix important findings",
            "/astack-mode Fix the verified important findings from findings.json and re-verify on HEAD.",
          ),
        );
      }
      body.appendChild(acts);
    }

    container.replaceChildren(header, body);
  }

  function buildAuditListSection(title, items, renderItem) {
    const sec = el("section", "dossier-section");
    const head = el("div", "dossier-section-head");
    head.appendChild(el("h2", "dossier-section-title", `${title} (${items.length})`));
    sec.appendChild(head);
    if (items.length === 0) {
      sec.appendChild(el("p", "audit-empty", "None detected."));
    } else {
      items.slice(0, 25).forEach((item) => sec.appendChild(renderItem(item)));
    }
    return sec;
  }

  function renderAuditView() {
    const container = document.getElementById("audit-view");
    if (!container) return;
    const slot = state.audit;
    const res = slot.data;
    const report = res?.ok ? res.report : null;
    const s = report?.summary;

    let pillText = slot.loading ? "Scanning..." : "Idle";
    let pillClass = "";
    let leadText = "Scans .agents/boundaries.json import rules, banned patterns, shallow modules, and gardening hits.";

    if (report && s) {
      pillText = report.ok ? "PASS" : "VIOLATIONS";
      pillClass = report.ok ? "done" : "err";
      leadText = `${s.filesScanned} files scanned · ${report.boundariesPresent ? "boundaries.json active" : "no boundaries.json"} · ${s.shallowModules} shallow · ${s.gardeningHits} gardening`;
    } else if (slot.error || (res && !res.ok)) {
      pillText = res?.reason === "no_workspace" ? "Unavailable" : "Error";
      pillClass = res?.reason === "no_workspace" ? "warn" : "err";
    }

    const header = buildSubViewHeader({
      backId: "back-from-audit",
      refreshId: "refresh-audit",
      title: "Architecture Audit",
      pillText,
      pillClass,
      leadText,
      loading: slot.loading,
      onRefresh: () => loadAuditView(),
    });

    const body = el("div", "dossier-sections");

    if (!res && slot.loading) {
      const sec = el("section", "dossier-section");
      sec.appendChild(el("p", "audit-empty", "Scanning repository architecture..."));
      body.appendChild(sec);
    } else if (slot.error || (res && !res.ok)) {
      const sec = el("section", "dossier-section");
      sec.appendChild(el("p", "audit-empty", slot.error || res.message || "Architecture audit failed."));
      const acts = el("div", "dossier-actions");
      if (slot.error) {
        const retryBtn = el("button", "subcmd-pill is-sans", "Retry");
        retryBtn.type = "button";
        retryBtn.addEventListener("click", () => loadAuditView());
        acts.appendChild(retryBtn);
      }
      acts.appendChild(buildCopyActionPill("/audit-architecture", "/audit-architecture"));
      sec.appendChild(acts);
      body.appendChild(sec);
    } else if (report && s) {
      const boundaryAndBanned = [
        ...(report.boundaryViolations || []),
        ...(report.bannedHits || []),
      ];
      body.appendChild(
        buildAuditListSection("Boundary & Banned Pattern Hits", boundaryAndBanned, (hit) => {
          const row = el("div", "audit-row");
          const btn = el("button", "audit-file-btn", hit.file);
          btn.type = "button";
          btn.addEventListener("click", () => openWorkspaceFile(hit.uri, hit.file));
          row.append(btn, el("div", "audit-detail", hit.detail));
          return row;
        }),
      );

      body.appendChild(
        buildAuditListSection("Shallow Module Warnings", report.shallowModules || [], (mod) => {
          const row = el("div", "audit-row");
          const btn = el("button", "audit-file-btn", mod.file);
          btn.type = "button";
          btn.addEventListener("click", () => openWorkspaceFile(mod.uri, mod.file));
          row.append(btn, el("div", "audit-detail", mod.reason));
          return row;
        }),
      );

      body.appendChild(
        buildAuditListSection("Gardening Hits", report.gardeningHits || [], (hit) => {
          const row = el("div", "audit-row");
          const btn = el("button", "audit-file-btn", `${hit.file}:${hit.line}`);
          btn.type = "button";
          btn.addEventListener("click", () => openWorkspaceFile(hit.uri, `${hit.file}:${hit.line}`));
          row.append(btn, el("div", "audit-detail mono", `[${hit.id}] ${hit.snippet}`));
          return row;
        }),
      );

      const hasIssues =
        !report.ok ||
        s.boundaryViolations > 0 ||
        s.bannedHits > 0 ||
        s.shallowModules > 0 ||
        s.gardeningHits > 0;
      const acts = el("div", "dossier-actions");
      acts.appendChild(buildCopyActionPill("/audit-architecture", "/audit-architecture"));
      if (!report.boundariesPresent) {
        acts.appendChild(buildCopyActionPill("/setup-astack", "/setup-astack"));
      }
      if (hasIssues) {
        acts.appendChild(
          buildCopyActionPill(
            "Run /correct",
            "/correct Review architecture audit findings and encode structural guards in types, lints, or .agents/boundaries.json.",
          ),
        );
      }
      body.appendChild(acts);
    }

    container.replaceChildren(header, body);
  }

  function switchView(nextView, restoreFocus = false) {
    const prevView = state.view;
    state.view = nextView;
    state.suppressedPopoverEl = null;
    hideCommandPopover();
    const tlView = document.getElementById("timeline-view");
    const trView = document.getElementById("trust-view");
    const dsView = document.getElementById("dossier-view");
    const auView = document.getElementById("audit-view");
    const dgView = document.getElementById("delegate-view");
    const artView = document.getElementById("artifact-view");
    if (!tlView || !dgView || !artView) return;

    const views = [
      { key: "timeline", el: tlView },
      ...(trView ? [{ key: "trust", el: trView }] : []),
      ...(dsView ? [{ key: "dossier", el: dsView }] : []),
      ...(auView ? [{ key: "audit", el: auView }] : []),
      { key: "delegate", el: dgView },
      { key: "artifact", el: artView },
    ];
    for (const v of views) {
      const active = v.key === nextView;
      v.el.classList.toggle("hidden", !active);
      if (active) v.el.removeAttribute("aria-hidden");
      else v.el.setAttribute("aria-hidden", "true");
    }

    if (nextView !== "artifact" && prevView === "artifact") {
      releaseArtifactObjectUrl();
    }

    if (nextView !== "timeline") {
      rail?.setVisible(false);
    }

    if (nextView === "trust") {
      renderTrustView(state.snap);
      document.getElementById("back-from-trust")?.focus();
    } else if (nextView === "dossier") {
      renderDossierView();
      loadDossierView();
      document.getElementById("back-from-dossier")?.focus();
    } else if (nextView === "audit") {
      renderAuditView();
      loadAuditView();
      document.getElementById("back-from-audit")?.focus();
    } else if (nextView === "delegate") {
      state.guideUserToggled = false;
      state.guideCmdDrawerOpen = false;
      renderDelegateGuide(state.snap);
      document.getElementById("back-to-timeline")?.focus();
    } else if (nextView === "artifact") {
      renderArtifactView();
      document.getElementById("back-from-artifact")?.focus();
    } else {
      renderFooter(state.snap);
      rail?.setVisible(!document.hidden);
      layoutRail();
      if (restoreFocus) {
        if (prevView === "artifact" && state.artifactReturnEl && document.contains(state.artifactReturnEl)) {
          state.artifactReturnEl.focus();
        } else if (prevView === "trust") {
          document.getElementById("open-trust-view")?.focus();
        } else if (prevView === "dossier") {
          document.getElementById("open-dossier-view")?.focus();
        } else if (prevView === "audit") {
          document.getElementById("open-audit-view")?.focus();
        } else if (prevView === "delegate") {
          document.getElementById("open-delegate-guide")?.focus();
        }
        state.artifactReturnEl = null;
      }
    }
  }

  function layoutRail() {
    if (!rail || !railWrap || !railList || state.view !== "timeline") return;
    const height = railList.scrollHeight;
    if (!height) return;
    const top = railWrap.getBoundingClientRect().top;
    const ys = [...railList.querySelectorAll("[data-rail-node]")].map((nodeEl) => {
      const r = nodeEl.getBoundingClientRect();
      return r.top + r.height / 2 - top + PAD_TOP;
    });
    rail.resize(height + PAD_TOP);
    rail.setNodes(railStages.map((s, i) => ({ state: s.railState, agents: s.agents, y: ys[i] ?? PAD_TOP })));
  }

  function scheduleRailAnnouncement(snap) {
    const liveIds = new Set(snap?.activity?.liveStageIds || []);
    if (!railAnnounceReady) {
      railAnnounceReady = true;
      prevLiveIds = liveIds;
      return;
    }
    const labelsById = new Map((snap?.stages || []).map((s) => [s.id, s.label]));
    const started = [...liveIds]
      .filter((id) => !prevLiveIds.has(id))
      .map((id) => `${labelsById.get(id) || id} started running`);
    const stopped = [...prevLiveIds]
      .filter((id) => !liveIds.has(id))
      .map((id) => `${labelsById.get(id) || id} stopped running`);
    prevLiveIds = liveIds;
    const msgs = [...started, ...stopped];
    if (msgs.length === 0) return;
    pendingAnnouncements.push(...msgs);
    if (railAnnounceTimer) clearTimeout(railAnnounceTimer);
    railAnnounceTimer = setTimeout(() => {
      const announcer = document.getElementById("rail-announcer");
      if (announcer && pendingAnnouncements.length > 0) {
        announcer.textContent = pendingAnnouncements.join(". ");
      }
      pendingAnnouncements = [];
      railAnnounceTimer = null;
    }, 2000);
  }

  function updateRail(snap) {
    railStages = (snap?.stages || []).map((s) => ({
      railState: s.railState || "pending",
      agents: snap?.activity?.liveAgentsByStage?.[s.id] ?? 0,
    }));
    layoutRail();
    scheduleRailAnnouncement(snap);
  }

  function railNodeAriaLabel(stage, stLabel, liveAgents) {
    const stateWord = (stLabel?.text || (stage.railState === "pending" ? "Not started" : stage.railState)).toLowerCase();
    if (stage.railState === "running" && liveAgents > 0) {
      return `${stage.label}, ${stateWord}, ${liveAgents} ${liveAgents === 1 ? "subagent" : "subagents"}`;
    }
    return `${stage.label}, ${stateWord}`;
  }

  function buildStageStatsRow(stage) {
    const st = stage?.stats;
    if (!st) return null;
    const items = [];
    if (st.agents?.total > 0) {
      const running = st.agents.running || 0;
      const total = st.agents.total;
      const done = Math.max(0, total - running);
      items.push({
        key: "agents",
        icon: "dot",
        dotMode: running > 0 ? "pulse" : "done",
        countText: running > 0 ? `${running}/${total}` : String(total),
        label: running > 0 ? "active" : total === 1 ? "agent" : "agents",
        popTitle: `${stage.label} · Agents`,
        popStatus: running > 0 ? `${running} running` : `${done} done`,
        popMode: running > 0 ? "active" : "done",
        popDesc: `${total} agent${total === 1 ? "" : "s"} in ${stage.label} (${done} done, ${running} running). Click to toggle stage details.`,
      });
    }
    const prOpen = st.prs?.open || 0;
    const prMerged = st.prs?.merged || 0;
    const prClosed = st.prs?.closed || 0;
    const prTotal = prOpen + prMerged + prClosed;
    if (prTotal > 0) {
      const prParts = [];
      if (prOpen > 0) prParts.push(`${prOpen} open`);
      if (prMerged > 0) prParts.push(`${prMerged} merged`);
      if (prClosed > 0) prParts.push(`${prClosed} closed`);
      const breakdown = prParts.join(", ");
      items.push({
        key: "prs",
        icon: prOpen === 0 && prMerged > 0 ? "pr-merged" : "pr",
        iconTone: prOpen > 0 ? "open" : prMerged > 0 ? "merged" : "",
        countText: String(prTotal),
        label: prTotal === 1 ? "PR" : "PRs",
        popTitle: `${stage.label} · Pull Requests`,
        popStatus: breakdown,
        popMode: prOpen > 0 ? "done" : "",
        popDesc: `${prTotal} pull request${prTotal === 1 ? "" : "s"} (${breakdown}). Click to toggle stage details.`,
      });
    }
    if (st.artifacts?.total > 0) {
      const total = st.artifacts.total;
      const updating = st.artifacts.updating || 0;
      items.push({
        key: "artifacts",
        icon: "diamond",
        pulseIcon: updating > 0,
        iconTone: updating > 0 ? "active" : "",
        countText: String(total),
        label: total === 1 ? "artifact" : "artifacts",
        popTitle: `${stage.label} · Artifacts`,
        popStatus: updating > 0 ? `${updating} updating` : `${total} file${total === 1 ? "" : "s"}`,
        popMode: updating > 0 ? "active" : "done",
        popDesc: `${total} artifact${total === 1 ? "" : "s"} in ${stage.label}${updating > 0 ? ` (${updating} updating)` : ""}. Click to toggle stage details.`,
      });
    }
    if (st.tasks?.total > 0) {
      const total = st.tasks.total;
      const running = st.tasks.running || 0;
      items.push({
        key: "tasks",
        icon: "clock",
        iconTone: running > 0 ? "active" : "",
        countText: running > 0 ? `${running}/${total}` : String(total),
        label: running > 0 ? "running" : total === 1 ? "task" : "tasks",
        popTitle: `${stage.label} · Tasks`,
        popStatus: running > 0 ? `${running} running` : `${total} total`,
        popMode: running > 0 ? "active" : "done",
        popDesc: `${total} task${total === 1 ? "" : "s"} in ${stage.label}${running > 0 ? ` (${running} running)` : ""}. Click to toggle stage details.`,
      });
    }
    if (items.length === 0) return null;

    const isExpanded = state.expanded.has(stage.id);
    const row = el("div", "stage-stats");
    row.dataset.testid = `stage-stats-${stage.id}`;
    for (const item of items) {
      const chip = el("button", "focus-chip stage-stat-chip");
      chip.type = "button";
      chip.dataset.testid = `stage-stat-${stage.id}-${item.key}`;
      chip.setAttribute("aria-expanded", String(isExpanded));
      if (item.icon === "dot") {
        chip.appendChild(el("span", `focus-dot ${item.dotMode}`.trim()));
      } else {
        const ic = svgIcon(item.icon, item.icon === "diamond" ? 10 : 11);
        if (item.pulseIcon) ic.classList.add("pulse");
        if (item.iconTone) ic.classList.add(`focus-icon-${item.iconTone}`);
        chip.appendChild(ic);
      }
      chip.appendChild(el("span", "focus-count", item.countText));
      chip.appendChild(el("span", "", item.label));
      attachStatusPopover(chip, item.popTitle, item.popStatus, item.popMode, item.popDesc);
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        hideCommandPopover();
        state.userToggled = true;
        if (state.expanded.has(stage.id)) state.expanded.delete(stage.id);
        else {
          state.expanded.add(stage.id);
          if (item.key === "agents") state.subExpanded[`subagents:${stage.id}`] = true;
        }
        render(state.snap);
      });
      row.appendChild(chip);
    }
    return row;
  }

  function syncPanelMode(snap) {
    const convKey = snap?.conversationId || "";
    if (convKey !== state.lastConversationId) {
      state.lastConversationId = convKey;
      state.panelModeUserToggled = false;
      state.reviewPrExpandedIntent = null;
      state.reviewPrMoreOpen = false;
    }
    if (!state.panelModeUserToggled) {
      state.panelMode = snap?.panelDefaultMode === "review_pr" ? "review_pr" : "build";
    }
    const buildBtn = document.getElementById("mode-btn-build");
    const reviewBtn = document.getElementById("mode-btn-review");
    if (buildBtn) buildBtn.setAttribute("aria-pressed", String(state.panelMode === "build"));
    if (reviewBtn) reviewBtn.setAttribute("aria-pressed", String(state.panelMode === "review_pr"));
  }

  function renderColleagueReviewStep(step, snap, detectedSet, idx, isNumbered) {
    const card = el("div", detectedSet.has(step.command) ? "cr-step-card is-active" : "cr-step-card");
    card.dataset.testid = `cr-step-${step.command.replace(/[^a-z0-9_-]/gi, "")}-${idx}`;

    const head = el("div", "cr-step-head");
    const titleText = isNumbered && step.step ? `${step.step}. ${step.title}` : step.title;
    head.appendChild(el("span", "cr-step-title", titleText));
    if (step.badge) {
      const badgeCls = step.badge === "Default" ? "cr-badge is-default" : "cr-badge";
      head.appendChild(el("span", badgeCls, step.badge));
    }
    if (detectedSet.has(step.command)) {
      head.appendChild(el("span", "cr-badge is-ran", "Ran"));
    }
    card.appendChild(head);

    if (step.condition) {
      card.appendChild(el("p", "cr-step-cond", step.condition));
    }

    const actions = el("div", "cr-step-actions");
    actions.appendChild(buildGuideCommandChip(step.command, snap));
    const copyBtn = el("button", "copy-inline-btn");
    copyBtn.type = "button";
    copyBtn.setAttribute("aria-label", `Copy ${step.command} prompt`);
    copyBtn.appendChild(svgIcon("copy", 11));
    copyBtn.appendChild(el("span", "", "Copy prompt"));
    copyBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      copyCommand({ command: step.command, copyText: step.prompt }, copyBtn, true);
    });
    actions.appendChild(copyBtn);
    card.appendChild(actions);

    if (step.prompt) {
      card.appendChild(el("p", "cr-step-prompt", step.prompt));
    }
    return card;
  }

  function renderColleagueReviewPanel(snap) {
    const container = document.getElementById("colleague-review-panel");
    if (!container) return;
    const intents = Array.isArray(window.ASTACK_CATALOG?.colleagueReviewGuide?.intents)
      ? window.ASTACK_CATALOG.colleagueReviewGuide.intents
      : [];
    const cr = snap?.colleagueReview || {};
    const detectedSet = new Set(Array.isArray(cr.detectedCommands) ? cr.detectedCommands : []);
    const activeIntentId = cr.activeIntent || intents.find((i) => i.defaultOpen)?.id || intents[0]?.id || "single";
    const expandedId = state.reviewPrExpandedIntent || activeIntentId;

    const intro = el("div", "cr-intro");
    const introTop = el("div", "cr-intro-top");
    const introCopy = el("div", "cr-intro-copy");
    introCopy.appendChild(el("div", "cr-intro-title", "Review a Colleague's PR"));
    introCopy.appendChild(el("p", "cr-intro-sub", "Pick the workflow matching your review scope. Authoring stages are hidden."));
    introTop.appendChild(introCopy);

    if (snap?.hasConversation && snap?.workspace) {
      const dossierBtn = el("button", "subcmd-pill is-sans", "PR Dossier");
      dossierBtn.type = "button";
      dossierBtn.dataset.testid = "cr-open-dossier";
      dossierBtn.addEventListener("click", () => switchView("dossier"));
      introTop.appendChild(dossierBtn);
    }
    intro.appendChild(introTop);

    const targetPrs = Array.isArray(cr.targetPrs) ? cr.targetPrs : [];
    if (targetPrs.length > 0) {
      const prRow = el("div", "cr-pr-row");
      for (const item of targetPrs.slice(0, 5)) {
        const label = `PR #${item.number}${item.state ? ` · ${item.state}` : ""}`;
        if (item.url) {
          const a = el("a", "meta-pill cr-pr-link", label);
          a.href = item.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          prRow.appendChild(a);
        } else {
          prRow.appendChild(el("span", "meta-pill", label));
        }
      }
      intro.appendChild(prRow);
    }

    const groups = el("div", "cr-intent-groups");
    for (const intent of intents) {
      const isOpen = expandedId === intent.id;
      const isDetected = cr.activeIntent === intent.id;
      const sec = el("section", isDetected ? "guide-stage-group is-context" : "guide-stage-group");
      sec.dataset.testid = `cr-intent-section-${intent.id}`;

      const btn = el("button", "guide-acc-btn");
      btn.type = "button";
      btn.dataset.testid = `cr-intent-${intent.id}`;
      btn.setAttribute("aria-expanded", String(isOpen));
      btn.addEventListener("click", () => {
        state.reviewPrExpandedIntent = intent.id;
        renderColleagueReviewPanel(state.snap);
      });

      const copyWrap = el("span", "guide-acc-copy");
      copyWrap.appendChild(el("span", "guide-acc-title", intent.title));
      copyWrap.appendChild(el("span", "guide-acc-sub", intent.subtitle));
      btn.appendChild(copyWrap);

      if (isDetected) {
        btn.appendChild(el("span", "guide-live-badge active", cr.running ? "running" : "active"));
      }
      const chev = svgIcon("chevron", 13);
      chev.classList.add("chev");
      btn.appendChild(chev);
      sec.appendChild(btn);

      if (isOpen) {
        const body = el("div", "cr-intent-body");
        body.dataset.testid = `cr-intent-body-${intent.id}`;
        const steps = Array.isArray(intent.steps) ? intent.steps : [];
        steps.forEach((step, idx) => {
          body.appendChild(renderColleagueReviewStep(step, snap, detectedSet, idx, intent.id === "single"));
        });

        const moreChecks = Array.isArray(intent.moreChecks) ? intent.moreChecks : [];
        if (moreChecks.length > 0) {
          const moreWrap = el("div", "more-section");
          const moreBtn = el("button", "more-toggle");
          moreBtn.type = "button";
          moreBtn.dataset.testid = "cr-more-toggle";
          moreBtn.setAttribute("aria-expanded", String(state.reviewPrMoreOpen));
          const mChev = svgIcon("chevron", 11);
          mChev.classList.add("chev");
          moreBtn.appendChild(mChev);
          moreBtn.appendChild(el("span", "", `More checks (${moreChecks.length})`));
          moreBtn.addEventListener("click", () => {
            state.reviewPrMoreOpen = !state.reviewPrMoreOpen;
            renderColleagueReviewPanel(state.snap);
          });
          moreWrap.appendChild(moreBtn);
          if (state.reviewPrMoreOpen) {
            moreChecks.forEach((chk, idx) => {
              moreWrap.appendChild(renderColleagueReviewStep(chk, snap, detectedSet, idx, false));
            });
          }
          body.appendChild(moreWrap);
        }
        sec.appendChild(body);
      }

      groups.appendChild(sec);
    }

    container.replaceChildren(intro, groups);
  }

  function clearLoadingTimer() {
    if (state.loadingTimer) {
      clearTimeout(state.loadingTimer);
      state.loadingTimer = null;
    }
  }

  function scheduleLoadingState() {
    if (state.snap || state.loadingTimer) return;
    state.loadingTimer = setTimeout(() => {
      state.loadingTimer = null;
      renderLoadingState();
    }, LOADING_GRACE_MS);
  }

  function renderLoadingState() {
    if (state.snap) return;
    const live = document.getElementById("live");
    const liveLabel = document.getElementById("live-label");
    if (live) {
      live.className = "live idle";
      live.title = "Loading…";
    }
    if (liveLabel) liveLabel.textContent = "Loading…";
    const list = document.getElementById("timeline");
    if (!list || list.children.length > 0) return;
    const card = el("li", "timeline-loading");
    card.dataset.testid = "timeline-loading";
    card.setAttribute("role", "status");
    const dot = el("span", "timeline-loading-dot");
    dot.setAttribute("aria-hidden", "true");
    card.appendChild(dot);
    card.appendChild(el("span", "timeline-loading-text", "Loading AStack Timeline…"));
    list.replaceChildren(card);
  }

  function render(snap) {
    if (!snap) return;
    clearLoadingTimer();
    syncPanelMode(snap);
    const progressEl = document.getElementById("progress");
    const WORKFLOW_MODE_COPY = {
      investigation: {
        title: "Investigation",
        status: "Read-only",
        desc: "Isolating root cause or exploring read-only before planning any edits.",
      },
      pr_iteration: {
        title: "PR Iteration",
        status: "Advisory",
        desc: "Iterating on an existing PR. Earlier stages are optional. Jump straight to Build, Pre-PR Check, or Ship.",
      },
      pr_review: {
        title: "Pre-PR Check",
        status: "Advisory",
        desc: "Checking an existing branch before opening or updating a PR. Plan and Build are optional when work was completed earlier.",
      },
      direct_build: {
        title: "Direct Flow",
        status: "Advisory",
        desc: "Jumped directly to implementation. Plan is optional and stages act as advisory checkpoints.",
      },
    };
    const modeInfo = WORKFLOW_MODE_COPY[snap.workflowMode];
    if (progressEl) {
      if (state.panelMode === "review_pr") {
        progressEl.textContent = "Review PR";
        progressEl.className = "progress is-mode";
        state.progressPopover = {
          title: "Colleague PR Review",
          statusText: "Dedicated",
          mode: "",
          desc: "Focused workflows for reviewing someone else's open PR without authoring stages.",
        };
      } else if (snap.workflowLabel && modeInfo) {
        progressEl.textContent = snap.workflowLabel;
        progressEl.className = "progress is-mode";
        state.progressPopover = { title: modeInfo.title, statusText: modeInfo.status, mode: "", desc: modeInfo.desc };
      } else {
        progressEl.textContent = `${snap.doneCount} / ${snap.totalCount}`;
        progressEl.className = "progress";
        state.progressPopover = {
          title: "Advisory Workflow Guide",
          statusText: `${snap.doneCount} / ${snap.totalCount}`,
          mode: "",
          desc: "Stages are advisory guidelines, not mandatory gates. Enter at any stage or skip steps already completed.",
        };
      }
      progressEl.tabIndex = 0;
    }
    applyLiveStatus(snap);

    const RISK_TITLES = ["Low risk", "Medium risk", "High risk", "Critical risk"];
    const FRESHNESS_DISPLAY = {
      fresh: { label: "✓ Verified", mode: "done", desc: "Tests or validation passed on the current git HEAD with no unverified edits." },
      fresh_rebase_patch_id: { label: "✓ Verified", mode: "done", desc: "Rebased commit matches previously verified patch-id on current HEAD." },
    };

    const rp = snap.trust?.riskPresentation || null;
    const metaParts = [];
    if (snap.riskTier !== null && snap.riskTier !== undefined) {
      const riskWord = RISK_TITLES[snap.riskTier] || `Tier ${snap.riskTier}`;
      const raScore = typeof snap.trust?.riskAssessment?.score === "number" ? snap.trust.riskAssessment.score : null;
      const riskPct = raScore !== null ? Math.round(raScore * 100) : null;
      const riskLabel = rp?.headerBadge || (riskPct !== null ? `${riskWord} · ${riskPct}%` : riskWord);
      const descParts = [];
      if (rp) {
        descParts.push(rp.headline);
        for (const w of rp.whyItems || []) {
          if (w.evidence) descParts.push(`${w.id}: ${w.evidence}`);
        }
        if (rp.nextHint) descParts.push(rp.nextHint);
      } else if (snap.trust?.riskAssessment?.summary) {
        descParts.push(snap.trust.riskAssessment.summary);
      } else {
        if (snap.riskDescription) {
          const cleanDesc = snap.riskDescription.trim().replace(/\.+$/, "");
          descParts.push(`${cleanDesc}.`);
        }
        if (Array.isArray(snap.riskMatchedGlobs) && snap.riskMatchedGlobs.length > 0) {
          descParts.push(`Matched: ${snap.riskMatchedGlobs.join(", ")}.`);
        }
        if (snap.riskTier >= 1) descParts.push("Requires human PR review.");
      }
      const riskCls = rp?.mode === "resolved_merged"
        ? "meta-pill meta-risk is-resolved"
        : `meta-pill meta-risk tier-${snap.riskTier}`;
      metaParts.push({
        text: riskLabel,
        cls: riskCls,
        testId: "timeline-risk-badge",
        popTitle: raScore !== null ? `Risk Score · ${riskWord}` : `Blast-Radius Risk · Tier ${snap.riskTier}`,
        popStatus: raScore !== null ? `Risk ${riskPct}% (R ${raScore.toFixed(2)})` : riskWord,
        popMode: rp?.mode === "resolved_merged" ? "done" : snap.riskTier >= 3 ? "stale" : snap.riskTier === 0 ? "done" : "",
        popDesc: descParts.join(" "),
      });
    }
    if (snap.freshness && FRESHNESS_DISPLAY[snap.freshness]) {
      const fm = FRESHNESS_DISPLAY[snap.freshness];
      metaParts.push({
        text: fm.label,
        cls: `meta-pill meta-fresh ${fm.mode}`.trim(),
        testId: "timeline-freshness",
        popTitle: "Receipt Freshness",
        popStatus: snap.freshness,
        popMode: fm.mode,
        popDesc: fm.desc,
      });
    }
    const setupReady = snap.setup?.status === "ready";
    const isNonRepo = snap.trust?.scopeKind === "non_repo" && Boolean(snap.workspace) && !setupReady;
    const hasTrustBadge = Boolean(snap.trust?.enrolled || snap.trust?.scopeKind === "git_unregistered");
    const metaRow = document.getElementById("meta-row");
    metaRow.replaceChildren();
    if (!isNonRepo && (metaParts.length > 0 || setupReady || hasTrustBadge)) {
      metaRow.classList.remove("hidden");
      metaParts.forEach((part, idx) => {
        if (idx > 0) metaRow.appendChild(el("span", "meta-sep", "·"));
        const node = el("span", part.cls || "", part.text);
        if (part.testId) node.dataset.testid = part.testId;
        if (part.popDesc) {
          node.tabIndex = 0;
          attachStatusPopover(node, part.popTitle, part.popStatus, part.popMode, part.popDesc);
        }
        metaRow.appendChild(node);
      });
      if (setupReady) {
        const setupToggle = el("button", "meta-btn");
        setupToggle.type = "button";
        setupToggle.dataset.testid = "timeline-setup-toggle";
        setupToggle.setAttribute("aria-expanded", String(state.setupDrawerOpen));
        setupToggle.appendChild(svgIcon("check-sm", 10));
        setupToggle.appendChild(el("span", "", "Setup ready"));
        setupToggle.addEventListener("click", () => {
          state.setupDrawerOpen = !state.setupDrawerOpen;
          if (state.setupDrawerOpen) state.beastDrawerOpen = false;
          render(state.snap);
        });
        metaRow.appendChild(setupToggle);
      }
      if (snap.trust?.enrolled) {
        const activeCat = snap.trust.activeCatState;
        const beastToggle = el("button", snap.trust.beastOn ? "meta-btn is-beast" : "meta-btn is-neutral");
        beastToggle.type = "button";
        beastToggle.dataset.testid = "timeline-beast-toggle";
        beastToggle.setAttribute("aria-expanded", String(state.beastDrawerOpen));
        beastToggle.textContent = snap.trust.beastOn
          ? `Beast · L${activeCat?.level ?? 0}`
          : "Beast · Off";
        beastToggle.addEventListener("click", () => {
          state.beastDrawerOpen = !state.beastDrawerOpen;
          if (state.beastDrawerOpen) state.setupDrawerOpen = false;
          render(state.snap);
        });
        metaRow.appendChild(beastToggle);
      } else if (snap.trust?.scopeKind === "git_unregistered") {
        const offBtn = el("button", "meta-btn is-neutral", "Trust: Off");
        offBtn.type = "button";
        offBtn.dataset.testid = "timeline-trust-off";
        offBtn.setAttribute("aria-expanded", String(state.beastDrawerOpen));
        const offDesc = "Beast Mode is enabled per repository. Click to see how to enroll this repo.";
        attachStatusPopover(offBtn, "Earned Trust", "Off", "", offDesc);
        offBtn.addEventListener("click", () => {
          hideCommandPopover();
          state.beastDrawerOpen = !state.beastDrawerOpen;
          if (state.beastDrawerOpen) state.setupDrawerOpen = false;
          render(state.snap);
        });
        metaRow.appendChild(offBtn);
      }
    } else {
      metaRow.classList.add("hidden");
    }

    const setupDrawer = document.getElementById("setup-drawer");
    setupDrawer.replaceChildren();
    if (setupReady && state.setupDrawerOpen) {
      setupDrawer.classList.remove("hidden");
      setupDrawer.appendChild(el("p", "setup-drawer-detail", snap.setup.detail));
      setupDrawer.appendChild(buildCommandChips(snap.setup.commands));
      appendSubCommands(setupDrawer, "setup", snap.setup.autoSubCommands, snap.setup.moreCommands);
    } else {
      setupDrawer.classList.add("hidden");
    }

    const beastDrawer = document.getElementById("beast-drawer");
    if (beastDrawer) {
      beastDrawer.replaceChildren();
      if (snap.trust?.enrolled && state.beastDrawerOpen) {
        const activeCat = snap.trust.activeCatState || { id: snap.trust.activeCategory, level: 0, ceiling: 2, maxCeiling: 3, score: 0, brier: 0 };
        beastDrawer.classList.remove("hidden");

        const r1 = el("div", "beast-ctrl-row");
        r1.appendChild(el("span", "beast-ctrl-label", "Beast Mode (run up to earned level)"));
        const g1 = el("div", "beast-seg-group");
        for (const [val, lbl] of [[false, "Off"], [true, "On"]]) {
          const b = el("button", "subcmd-pill is-sans", lbl);
          b.type = "button";
          b.setAttribute("aria-pressed", String(Boolean(snap.trust.beastOn) === val));
          b.addEventListener("click", () => updateTrustSettings({ beastOn: val }, `Beast Mode ${val ? "On" : "Off"}`));
          g1.appendChild(b);
        }
        r1.appendChild(g1);

        const r2 = el("div", "beast-ctrl-row");
        r2.appendChild(el("span", "beast-ctrl-label", "Promotion"));
        const g2 = el("div", "beast-seg-group");
        for (const [val, lbl] of [["manual", "Manual"], ["auto", "Auto"]]) {
          const b = el("button", "subcmd-pill is-sans", lbl);
          b.type = "button";
          b.disabled = val === "auto" && Boolean(snap.trust.promotionLockedByPolicy);
          b.setAttribute("aria-pressed", String(snap.trust.promotionMode === val));
          b.addEventListener("click", () => updateTrustSettings({ promotionMode: val }, `Promotion set to ${val}`));
          g2.appendChild(b);
        }
        r2.appendChild(g2);

        const r3 = el("div", "beast-ctrl-row");
        r3.appendChild(el("span", "beast-ctrl-label", `Ceiling (${activeCat.id})`));
        const g3 = el("div", "beast-seg-group");
        for (const cap of [1, 2, 3]) {
          const locked = cap > activeCat.maxCeiling;
          const b = el("button", locked ? "subcmd-pill is-sans is-locked" : "subcmd-pill is-sans", `L${cap}`);
          b.type = "button";
          b.disabled = locked;
          b.setAttribute("aria-pressed", String(activeCat.ceiling === cap));
          b.addEventListener("click", () => updateTrustSettings({ setCeiling: { category: activeCat.id, ceiling: cap } }, `${activeCat.id} ceiling set to L${cap}`));
          g3.appendChild(b);
        }
        r3.appendChild(g3);

        const foot = el("div", "beast-foot-row");
        foot.appendChild(el("span", "", `Enrolled · T ${Number(activeCat.score ?? 0).toFixed(2)} · Brier ${Number(activeCat.brier ?? 0).toFixed(2)}`));
        const openTrust = el("button", "guide-link-btn", "Open Trust");
        openTrust.type = "button";
        openTrust.style.height = "20px";
        openTrust.appendChild(svgIcon("chevron", 10));
        openTrust.addEventListener("click", () => switchView("trust"));
        foot.appendChild(openTrust);

        beastDrawer.append(r1, r2, r3, foot);
      } else if (snap.trust?.scopeKind === "git_unregistered" && state.beastDrawerOpen) {
        beastDrawer.classList.remove("hidden");
        beastDrawer.appendChild(
          el(
            "p",
            "setup-drawer-detail",
            "Beast Mode is enabled per repository. Add .agents/risk-policy.json on your base branch (main) to enroll this repo.",
          ),
        );
        const chips = el("div", "chips");
        const setupMeta = lookupCommandMeta(snap, "/setup-astack") || {
          command: "/setup-astack",
          copyText: "/setup-astack",
          state: "next",
        };
        chips.appendChild(buildCommandChip({ ...setupMeta, command: "/setup-astack", copyText: "/setup-astack", state: "next" }));
        beastDrawer.appendChild(chips);
      } else {
        beastDrawer.classList.add("hidden");
      }
    }

    const promoWrap = document.getElementById("promo-wrap");
    const promoCard = document.getElementById("promo-card");
    if (promoWrap && promoCard) {
      promoCard.replaceChildren();
      const banner = snap.trust?.enrolled ? snap.trust.promoBanner : null;
      if (banner) {
        promoWrap.classList.remove("hidden");
        promoCard.className = "setup-card is-info";
        const copy = el("div", "setup-card-copy");
        if (banner.kind === "auto") {
          copy.appendChild(el("div", "setup-card-kicker", `Auto promoted · ${banner.catId}`));
          copy.appendChild(el("p", "setup-card-hint", `${banner.catId} moved L${banner.fromLvl} -> L${banner.toLvl} (T ${Number(banner.score ?? 0).toFixed(2)} · cap L${banner.ceiling}).`));
          const undoBtn = el("button", "chip next", "Undo");
          undoBtn.type = "button";
          undoBtn.dataset.testid = "timeline-promo-undo";
          undoBtn.addEventListener("click", () => updateTrustSettings({ undoAutoPromo: true }, `Reverted ${banner.catId} · Promotion set to Manual`));
          promoCard.append(copy, undoBtn);
        } else {
          copy.appendChild(el("div", "setup-card-kicker", `Ready for L${banner.toLvl} · ${banner.catId}`));
          copy.appendChild(el("p", "setup-card-hint", `${banner.count} graded outcomes · T ${Number(banner.score ?? 0).toFixed(2)} · Brier ${Number(banner.brier ?? 0).toFixed(2)}.`));
          const promoteBtn = el("button", "chip next", `Promote L${banner.toLvl}`);
          promoteBtn.type = "button";
          promoteBtn.dataset.testid = "timeline-promo-confirm";
          promoteBtn.addEventListener("click", () => updateTrustSettings({ promoteCategory: banner.catId }, `${banner.catId} promoted to L${banner.toLvl}`));
          promoCard.append(copy, promoteBtn);
        }
      } else {
        promoWrap.classList.add("hidden");
        promoCard.className = "setup-card hidden";
      }
    }

    const setupWrap = document.getElementById("setup-wrap");
    const setupCard = document.getElementById("setup-card");
    setupCard.replaceChildren();
    if (isNonRepo) {
      setupWrap.classList.remove("hidden");
      setupCard.className = "setup-card is-muted";
      const copyWrap = el("div", "setup-card-copy");
      copyWrap.appendChild(el("div", "setup-card-kicker", "Not a git repository (AStack inactive)"));
      copyWrap.appendChild(el("p", "setup-card-hint", "Media, slide deck, and scratch conversations write zero receipts and never affect software engineering trust."));
      setupCard.appendChild(copyWrap);
    } else if (snap.setup?.status === "needs_setup") {
      setupWrap.classList.remove("hidden");
      setupCard.className = "setup-card";
      const copyWrap = el("div", "setup-card-copy");
      copyWrap.appendChild(el("div", "setup-card-kicker", "First-time setup · Once per repo"));
      copyWrap.appendChild(el("p", "setup-card-hint", snap.setup.summary));
      setupCard.appendChild(copyWrap);
      const setupItem = snap.setup.commands?.[0];
      if (setupItem) {
        setupCard.appendChild(buildCommandChip(setupItem, "chip next"));
      }
    } else {
      setupWrap.classList.add("hidden");
      setupCard.className = "setup-card hidden";
    }

    renderTotalsStrip(snap);
    renderStatusBanner(snap, isNonRepo);

    if (!state.userToggled) {
      state.expanded.clear();
      const focus =
        snap.stages.find((s) => s.railState === "error") ||
        snap.stages.find((s) => s.railState === "running") ||
        snap.stages.find((s) => s.railState === "stale") ||
        snap.stages.find((s) => s.railState === "yourturn") ||
        snap.stages.find((s) => s.id === snap.nextAction?.stageId && s.status !== "pending");
      if (focus) state.expanded.add(focus.id);
    }

    const list = document.getElementById("timeline");
    const tlWrapEl = document.getElementById("timeline-wrap") || railWrap;
    const crPanel = document.getElementById("colleague-review-panel");
    if (state.panelMode === "review_pr") {
      tlWrapEl?.classList.add("hidden");
      crPanel?.classList.remove("hidden");
      renderColleagueReviewPanel(snap);
      rail?.setVisible(false);
    } else {
      crPanel?.classList.add("hidden");
      tlWrapEl?.classList.remove("hidden");
      rail?.setVisible(!document.hidden && state.view === "timeline");

      list.replaceChildren();
      list.classList.toggle("is-dimmed", isNonRepo);
      railWrap?.classList.toggle("is-dimmed", isNonRepo);
      const liveIds = snap.activity?.liveStageIds || [];

      snap.stages.forEach((stage, idx) => {
        const isLast = idx === snap.stages.length - 1;
        const isExpanded = state.expanded.has(stage.id);
        const rs = stage.railState || "pending";
        const stLabel = stageStatusLabel(stage, snap.stages);
        const liveAgents = snap.activity?.liveAgentsByStage?.[stage.id] ?? 0;

        const li = el("li", `step ${rs}`);
        li.dataset.testid = `timeline-step-${stage.id}`;
        if (
          rs === "running" ||
          (liveIds.length === 0 && (rs === "yourturn" || rs === "suggested"))
        ) {
          li.setAttribute("aria-current", "step");
        }

        const railEl = el("div", "rail");
        const node = el("span", `node ${rs}`);
        node.dataset.railNode = "1";
        node.setAttribute("role", "img");
        node.setAttribute("aria-label", railNodeAriaLabel(stage, stLabel, liveAgents));
        railEl.appendChild(node);
        if (!isLast) {
          const stem = el("span", "stem");
          stem.setAttribute("aria-hidden", "true");
          railEl.appendChild(stem);
        }
        li.appendChild(railEl);

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
        if (stLabel) {
          stepBtn.appendChild(el("span", `status-text ${stLabel.cls}`, stLabel.text));
        } else if (stage.id === "plan" && rs === "pending") {
          stepBtn.appendChild(el("span", "status-text muted", "Optional"));
        }
        const chev = svgIcon("chevron", 14);
        chev.classList.add("chev");
        stepBtn.appendChild(chev);
        body.appendChild(stepBtn);

        const summaryText = isExpanded ? stage.summary : stage.collapsedSummary || stage.summary;
        if (summaryText) {
          body.appendChild(el("p", "stage-summary", summaryText));
        }

        const statsRow = buildStageStatsRow(stage);
        if (statsRow) {
          body.appendChild(statsRow);
        }

        if (isExpanded) {
          body.appendChild(
            stage.id === "build" ? buildBuildStageDetail(stage, snap) : buildGenericStageDetail(stage, snap),
          );
        }

        li.appendChild(body);
        list.appendChild(li);
      });

      updateRail(snap);
    }

    renderFooter(snap);
    if (state.view === "trust") {
      renderTrustView(snap);
    }
    if (state.view === "delegate") {
      renderDelegateGuide(snap);
    }
    if (state.popoverAnchor && !document.contains(state.popoverAnchor)) {
      hideCommandPopover();
    }
  }

  function scheduleNextPoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollTimer = setTimeout(() => {
      state.pollTimer = null;
      poll();
    }, POLL_MS);
  }

  function renderLoadFallback(title, detail) {
    clearLoadingTimer();
    if (state.snap) return;
    const list = document.getElementById("timeline");
    if (!list) return;
    const card = el("li", "timeline-fallback");
    card.dataset.testid = "timeline-fallback";
    card.appendChild(el("div", "timeline-fallback-title", title));
    if (detail) {
      card.appendChild(el("p", "timeline-fallback-detail", detail));
    }
    const actions = el("div", "timeline-fallback-actions");
    const retryBtn = el("button", "chip next", "Retry");
    retryBtn.type = "button";
    retryBtn.dataset.testid = "timeline-retry";
    retryBtn.addEventListener("click", () => poll({ force: true }));
    actions.appendChild(retryBtn);
    card.appendChild(actions);
    list.replaceChildren(card);
    renderFooter(null);
  }

  async function poll({ force = false } = {}) {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (document.hidden && state.snap && !force) {
      scheduleNextPoll();
      return;
    }
    if (state.pollInFlight) {
      if (!force) return;
      state.pollAbort?.abort();
    }
    const reqSeq = ++state.pollSeq;
    state.pollInFlight = true;
    if (!state.snap) scheduleLoadingState();
    const convId = getConversationId(false);
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    state.pollAbort = ctrl;
    const timeoutId = ctrl ? setTimeout(() => ctrl.abort(), POLL_TIMEOUT_MS) : null;
    try {
      const res = await apiFetch(
        "/api/timeline",
        {
          conversationId: convId,
          workspaceUri: state.workspaceUri,
          etag: state.etag,
        },
        ctrl ? { signal: ctrl.signal } : {},
      );
      if (reqSeq !== state.pollSeq) return;
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        if (reqSeq !== state.pollSeq) return;
        const msg = errBody?.error || `HTTP ${res.status}`;
        state.lastPollError = { status: res.status, message: msg };
        const live = document.getElementById("live");
        const liveLabel = document.getElementById("live-label");
        const statusText = res.status === 401 ? "Auth error" : "Error";
        if (live) {
          live.className = res.status === 401 || res.status === 503 ? "live idle" : "live error";
          live.title = statusText;
        }
        if (liveLabel) liveLabel.textContent = statusText;
        if (!state.snap) {
          renderLoadFallback(
            "Could not load AStack Timeline",
            `${msg} (HTTP ${res.status}). Check that the sidecar is running or retry.`,
          );
        }
        return;
      }
      const data = await res.json();
      if (reqSeq !== state.pollSeq) return;
      state.lastPollError = null;
      if (data.unchanged) {
        if (state.snap) applyLiveStatus(state.snap);
        return;
      }
      const prevSnap = state.snap;
      const prevEtag = state.etag;
      state.etag = data.etag || "";
      state.snap = data;
      try {
        render(data);
      } catch (renderErr) {
        state.snap = prevSnap;
        state.etag = prevEtag;
        throw renderErr;
      }
    } catch (err) {
      if (reqSeq !== state.pollSeq) return;
      const live = document.getElementById("live");
      const liveLabel = document.getElementById("live-label");
      if (live) {
        live.className = "live idle";
        live.title = "Offline";
      }
      if (liveLabel) liveLabel.textContent = "Offline";
      if (!state.snap) {
        const reason =
          err?.name === "AbortError"
            ? "Timeline request timed out. Retrying automatically."
            : "Could not reach the AStack sidecar. Retrying automatically.";
        renderLoadFallback("AStack Timeline unavailable", reason);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (reqSeq === state.pollSeq) {
        state.pollInFlight = false;
        state.pollAbort = null;
        scheduleNextPoll();
      }
    }
  }

  function applyWorkspaceUris(uris, allowEmpty) {
    const first = Array.isArray(uris) && typeof uris[0] === "string" ? uris[0].trim() : "";
    if ((allowEmpty || first) && first !== state.workspaceUri) {
      state.workspaceUri = first;
      state.etag = "";
      state.dossier.data = null;
      state.dossier.error = null;
      state.audit.data = null;
      state.audit.error = null;
      poll({ force: true });
      if (state.view === "dossier") loadDossierView();
      else if (state.view === "audit") loadAuditView();
    }
  }

  async function syncWorkspaceUri() {
    if (typeof window.sidecar?.getWorkspaceUris !== "function") return;
    try {
      applyWorkspaceUris(await window.sidecar.getWorkspaceUris(), false);
    } catch {
    }
  }

  if (typeof window.sidecar?.onWorkspaceChange === "function") {
    try {
      window.sidecar.onWorkspaceChange((uris) => applyWorkspaceUris(uris, true));
    } catch {
    }
  }

  const railCanvas = document.getElementById("living-rail");
  railList = document.getElementById("timeline");
  railWrap = railCanvas?.parentElement || null;
  if (window.createLivingRail && railCanvas) {
    rail = window.createLivingRail(railCanvas);
  }
  if (railList && typeof ResizeObserver === "function") {
    new ResizeObserver(layoutRail).observe(railList);
  }
  document.fonts?.ready?.then(layoutRail);
  if (railWrap && typeof IntersectionObserver === "function") {
    new IntersectionObserver(([entry]) => {
      rail?.setVisible(Boolean(entry?.isIntersecting) && state.view === "timeline" && state.panelMode === "build" && !document.hidden);
    }).observe(railWrap);
  }
  new MutationObserver(() => rail?.refreshTheme()).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  const askIcon = document.getElementById("askbar-icon");
  if (askIcon) askIcon.appendChild(svgIcon("fork", 14));
  const btwSubmit = document.getElementById("btw-submit");
  if (btwSubmit) btwSubmit.appendChild(svgIcon("arrow-return", 11));
  const btwForm = document.getElementById("btw-form");
  if (btwForm) {
    btwForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const input = document.getElementById("astk-btw");
      const raw = (input?.value || "").trim();
      if (!raw) {
        input?.focus();
        return;
      }
      const cleanQ = raw.replace(/^\/btw\s+/i, "").trim();
      const payload = `/btw ${cleanQ}`;
      if (input) input.value = "";
      copyCommand({ command: "/btw", copyText: payload }, btwSubmit);
    });
  }

  const modeBuildBtn = document.getElementById("mode-btn-build");
  const modeReviewBtn = document.getElementById("mode-btn-review");
  for (const [btn, mode] of [[modeBuildBtn, "build"], [modeReviewBtn, "review_pr"]]) {
    btn?.addEventListener("click", () => {
      state.panelMode = mode;
      state.panelModeUserToggled = true;
      if (state.snap) {
        render(state.snap);
      } else {
        modeBuildBtn?.setAttribute("aria-pressed", String(mode === "build"));
        modeReviewBtn?.setAttribute("aria-pressed", String(mode === "review_pr"));
      }
    });
  }

  const popEl = document.getElementById("cmd-popover");
  if (popEl) {
    popEl.addEventListener("mouseenter", cancelHidePopover);
    popEl.addEventListener("mouseleave", scheduleHidePopover);
    popEl.addEventListener("focusin", cancelHidePopover);
    popEl.addEventListener("focusout", scheduleHidePopover);
  }

  const progressElInit = document.getElementById("progress");
  if (progressElInit) {
    const openProgressPopover = () => {
      const info = state.progressPopover;
      if (info?.desc) showStatusPopover(progressElInit, info.title, info.statusText, info.mode, info.desc);
    };
    progressElInit.addEventListener("mouseenter", openProgressPopover);
    progressElInit.addEventListener("mouseleave", scheduleHidePopover);
    progressElInit.addEventListener("focus", openProgressPopover);
    progressElInit.addEventListener("blur", scheduleHidePopover);
  }

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (popEl && !popEl.classList.contains("hidden")) {
        const returnTarget = state.popoverAnchor;
        const focusWasInside = Boolean(returnTarget && popEl.contains(document.activeElement));
        hideCommandPopover();
        if (focusWasInside) {
          state.suppressedPopoverEl = returnTarget;
          returnTarget.focus();
        }
        return;
      }
      if (state.view === "delegate" || state.view === "artifact" || state.view === "trust" || state.view === "dossier" || state.view === "audit") {
        switchView("timeline", true);
      }
    }
  });
  document.addEventListener("scroll", hideCommandPopover, { capture: true, passive: true });
  document.addEventListener("click", (ev) => {
    if (!popEl || popEl.classList.contains("hidden")) return;
    if (popEl.contains(ev.target)) return;
    if (state.popoverAnchor && state.popoverAnchor.contains(ev.target)) return;
    hideCommandPopover();
  });

  if (state.view === "delegate" || state.view === "dossier" || state.view === "audit" || state.view === "trust") {
    switchView(state.view);
  }

  if (!state.workspaceUri && typeof window.sidecar?.getWorkspaceUris === "function") {
    Promise.race([
      syncWorkspaceUri(),
      new Promise((resolve) => setTimeout(resolve, INITIAL_WS_WAIT_MS)),
    ]).then(() => {
      if (!state.pollInFlight && !state.snap) {
        poll();
      }
    });
  } else {
    syncWorkspaceUri();
    poll();
  }
  setInterval(tickTimers, 1000);
  document.addEventListener("visibilitychange", () => {
    rail?.setVisible(!document.hidden && state.view === "timeline");
    if (!document.hidden) {
      poll();
      tickTimers();
    }
  });
  window.addEventListener("focus", () => {
    if (!document.hidden) poll();
  });
  window.addEventListener("pageshow", () => {
    poll();
  });
})();
