(() => {
  const POLL_MS = 1800;
  const DOCS_URL_PREFIX = "https://github.com/jmxt3/astack/";
  const PASTE_SHORTCUT = /mac/i.test(navigator.platform || navigator.userAgent || "") ? "Cmd+V" : "Ctrl+V";
  const params = new URLSearchParams(location.search);

  const state = {
    etag: "",
    snap: null,
    workspaceUri: params.get("workspaceUri") || "",
    view: params.get("view") === "delegate" || location.hash === "#delegate" ? "delegate" : "timeline",
    guideExpandedStage: null,
    guideUserToggled: false,
    guideCmdDrawerOpen: false,
    guideSelectedExampleByStage: {},
    setupDrawerOpen: false,
    expanded: new Set(),
    moreExpanded: new Set(),
    subExpanded: { swarm: false, helpers: false, goal: false, more: false },
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

  let scene = null;

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

  function resolveSceneAccent(theme) {
    const rawPrimary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
    return theme === "dark" && rawPrimary ? rawPrimary : "#5aa2ff";
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
      if (scene) {
        scene.setAccent(resolveSceneAccent(theme));
      }
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

  function apiFetch(endpoint, payload) {
    if (isSdkHost()) {
      return window.sidecar.fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(payload || {})) {
      if (v === undefined || v === null || v === "" || v === false) continue;
      qs.set(k, v === true ? "1" : String(v));
    }
    const query = qs.toString();
    const urlToken = params.get("token");
    const headers = urlToken ? { "X-Sidecar-Token": urlToken } : undefined;
    return fetch(query ? `${endpoint}?${query}` : endpoint, { method: "GET", headers });
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
          scene?.pulseSchedule();
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
    return doc ? { command, copyText: command, ...doc } : null;
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
      link.appendChild(svgIcon("external", 11));
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
    document.getElementById("live-label").textContent = snap.liveLabel;
  }

  function stageStatusLabel(status, stage) {
    if (status === "done") return { text: "Done", cls: "done" };
    if (status === "active") return { text: "Running", cls: "active" };
    if (status === "stale") {
      if (stage?.id === "build") {
        const cleanStale = stage.subChecks?.some((c) => c.id === "clean" && c.status === "stale");
        const verifyStale = stage.subChecks?.some((c) => c.id === "verify" && c.status === "stale");
        if (cleanStale && !verifyStale) return { text: "Re-clean", cls: "stale" };
        if (verifyStale) return { text: "Re-verify", cls: "stale" };
      }
      return { text: "Needs re-run", cls: "stale" };
    }
    if (status === "waiting_gate") return { text: "Review", cls: "waiting_gate" };
    if (status === "error") return { text: "Escalated", cls: "error" };
    if (status === "next") return { text: "Next", cls: "next" };
    if (status === "skipped") {
      return { text: stage?.skippedReason === "earlier" ? "Earlier" : "Skipped", cls: "muted" };
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

  function makeSubAccordionHeader(key, iconName, titleText, metaNode, isAccent = false) {
    const isOpen = Boolean(state.subExpanded[key]);
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
      state.subExpanded[key] = !state.subExpanded[key];
      render(state.snap);
    });
    return { btn, isOpen };
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

  function buildBuildStageDetail(stage, snap) {
    const detail = el("div", "detail");
    const act = snap.activity || {};

    const segGrid = el("div", "progress-segments");
    segGrid.setAttribute("role", "list");
    segGrid.setAttribute("aria-label", "Progress");
    const subChecks = stage.subChecks || [];
    let activeAssigned = false;
    for (const sub of subChecks) {
      const seg = el("div", "progress-seg");
      seg.setAttribute("role", "listitem");
      let mode = sub.status;
      if (mode === "pending" && stage.status === "active" && !activeAssigned) {
        mode = "run";
        activeAssigned = true;
      }
      const bar = el("span", `progress-seg-bar ${mode}`);
      if (mode === "run") bar.classList.add("pulse");
      const title = sub.label.charAt(0).toUpperCase() + sub.label.slice(1);
      const labelText = mode === "done" ? `✓ ${title}` : mode === "stale" ? `! ${title}` : mode === "run" ? `${title}…` : title;
      const statusText = mode === "done" ? "Done" : mode === "stale" ? "Stale" : mode === "run" ? "Next up" : "Pending";
      if (sub.detail) {
        seg.tabIndex = 0;
        seg.title = sub.detail;
        attachStatusPopover(seg, title, statusText, mode, sub.detail);
      }
      seg.appendChild(bar);
      seg.appendChild(el("span", `progress-seg-label ${mode}`, labelText));
      segGrid.appendChild(seg);
    }
    detail.appendChild(segGrid);

    const staleSubs = subChecks.filter((c) => c.status === "stale");
    if (staleSubs.length > 0) {
      const callout = el("div", "subcheck-callout");
      callout.dataset.testid = "build-stale-callout";
      const msgRow = el("div", "subcheck-callout-msg");
      const warnIc = svgIcon("warn", 12);
      warnIc.classList.add("subcheck-callout-icon");
      msgRow.append(warnIc, el("span", "", staleSubs.map((s) => s.detail).join(" ")));
      callout.appendChild(msgRow);

      const actionCmds = [];
      if (staleSubs.some((s) => s.id === "clean")) actionCmds.push("/deslop", "/no-comments");
      if (staleSubs.some((s) => s.id === "verify")) actionCmds.push("/astack-mode");
      if (actionCmds.length > 0) {
        const actionRow = el("div", "subcheck-callout-actions");
        for (const cmd of actionCmds) {
          const meta = lookupCommandMeta(snap, cmd);
          const btn = el("button", "subcmd-pill stale-action");
          btn.type = "button";
          btn.appendChild(el("span", "", cmd));
          wireCommandAction(btn, meta ? { ...meta, command: cmd } : cmd);
          actionRow.appendChild(btn);
        }
        callout.appendChild(actionRow);
      }
      detail.appendChild(callout);
    }

    const accGroup = el("div", "accordion-group");
    const swarm = act.swarm || {};
    if (swarm.active || (swarm.members && swarm.members.length > 0)) {
      const wrap = el("div", "");
      wrap.addEventListener("mouseenter", () => scene?.setHighlight("cmd", "swarm"));
      wrap.addEventListener("mouseleave", () => scene?.setHighlight("cmd", null));
      const meta = el("span", "sub-accordion-meta", `${swarm.workingCount || 0} of ${swarm.totalCount || 0} working`);
      const { btn, isOpen } = makeSubAccordionHeader("swarm", "swarm", "Swarm", meta);
      btn.dataset.testid = "accordion-swarm";
      wrap.appendChild(btn);
      if (isOpen) {
        const ul = el("ul", "sub-accordion-list");
        for (const m of swarm.members || []) {
          const li = el("li", "sub-row");
          li.addEventListener("mouseenter", () => scene?.setHighlight("member", m.id));
          li.addEventListener("mouseleave", () => scene?.setHighlight("member", null));
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

    const subagents = act.subagents || [];
    if (subagents.length > 0) {
      const wrap = el("div", "");
      wrap.addEventListener("mouseenter", () => scene?.setHighlight("cmd", "subagents"));
      wrap.addEventListener("mouseleave", () => scene?.setHighlight("cmd", null));
      const runningN = act.runningSubagentsCount || 0;
      const metaText = runningN > 0 ? `${runningN}/${subagents.length} running` : `${subagents.length} done`;
      const meta = el("span", "sub-accordion-meta", metaText);
      const { btn, isOpen } = makeSubAccordionHeader("helpers", "orbit", "Subagents", meta);
      btn.dataset.testid = "accordion-subagents";
      wrap.appendChild(btn);
      if (isOpen) {
        const ul = el("ul", "sub-accordion-list");
        for (const a of subagents) {
          const li = el("li", "sub-row");
          li.addEventListener("mouseenter", () => scene?.setHighlight("agent", a.id));
          li.addEventListener("mouseleave", () => scene?.setHighlight("agent", null));
          const dw = el("span", "sub-row-dot-wrap");
          if (a.status === "done") {
            const chk = svgIcon("check-sm", 10);
            chk.style.color = "var(--tl-done)";
            dw.appendChild(chk);
          } else {
            dw.appendChild(el("span", "sub-row-dot active"));
          }
          li.appendChild(dw);
          li.appendChild(el("span", "sub-row-name", a.type));
          li.appendChild(el("span", "sub-row-task", a.task));
          const timerEl = el("span", "sub-row-timer", formatElapsedText(a.startedAt, a.completedAt));
          if (a.status === "running" && a.startedAt) {
            timerEl.dataset.timerKind = "elapsed";
            timerEl.dataset.startedAt = a.startedAt;
          }
          li.appendChild(timerEl);
          appendAskButton(li, `What is the ${a.type} subagent finding?`, `Ask /btw about the ${a.type} subagent`);
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      }
      accGroup.appendChild(wrap);
    }

    const goal = act.goal || {};
    const teamwork = act.teamwork || {};
    if (goal.detected || teamwork.detected) {
      const wrap = el("div", "");
      wrap.addEventListener("mouseenter", () => scene?.setHighlight("cmd", "goal"));
      wrap.addEventListener("mouseleave", () => scene?.setHighlight("cmd", null));
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
          row.addEventListener("mouseenter", () => scene?.setHighlight("cmd", item.id));
          row.addEventListener("mouseleave", () => scene?.setHighlight("cmd", null));
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
      btn.addEventListener("mouseenter", () => scene?.setHighlight("art", art.key || art.id));
      btn.addEventListener("mouseleave", () => scene?.setHighlight("art", null));
      btn.addEventListener("focus", () => scene?.setHighlight("art", art.key || art.id));
      btn.addEventListener("blur", () => scene?.setHighlight("art", null));
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
    detail.appendChild(el("p", "detail-text", stage.detail));
    detail.appendChild(buildCommandChips(stage.commands));

    if (stage.id === "review" && act.workflow?.suggestedReview) {
      const sug = act.workflow.suggestedReview;
      const box = el("div", "faster-workflow");
      box.addEventListener("mouseenter", () => scene?.setHighlight("cmd", "rw"));
      box.addEventListener("mouseleave", () => scene?.setHighlight("cmd", null));
      const p = el("p", "faster-workflow-text");
      p.appendChild(el("span", "faster-workflow-lead", "Faster: "));
      p.appendChild(document.createTextNode(`${sug.summary} `));
      p.appendChild(el("span", "faster-workflow-cmd", sug.command));
      p.appendChild(document.createTextNode("."));
      box.appendChild(p);
      const copyBtn = el("button", "copy-inline-btn", "Copy");
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
        jobsWrap.addEventListener("mouseenter", () => scene?.setHighlight("cmd", "schedule"));
        jobsWrap.addEventListener("mouseleave", () => scene?.setHighlight("cmd", null));
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

  function renderSceneSection(snap) {
    const act = snap.activity || {};
    const focalId = act.activeStageId || "plan";

    const stagesEl = document.getElementById("scene-stages");
    stagesEl.replaceChildren();
    for (const stg of snap.stages) {
      const btn = el("button", stg.id === focalId ? "scene-stage-btn is-active" : "scene-stage-btn");
      btn.type = "button";
      const dot = el("span", `scene-stage-dot ${stg.status}`);
      if (stg.status === "active") dot.classList.add("pulse");
      btn.appendChild(dot);
      btn.appendChild(el("span", "", stg.label));
      btn.addEventListener("mouseenter", () => scene?.setHighlight("stage", stg.id));
      btn.addEventListener("mouseleave", () => scene?.setHighlight("stage", null));
      btn.addEventListener("focus", () => scene?.setHighlight("stage", stg.id));
      btn.addEventListener("blur", () => scene?.setHighlight("stage", null));
      btn.addEventListener("click", () => {
        state.userToggled = true;
        state.expanded.add(stg.id);
        render(state.snap);
      });
      stagesEl.appendChild(btn);
    }

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
            ? `${agentsTotal} total executed (${agentsDone} done, ${agentsWorking} running). Click to inspect without opening Step 2.`
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
      chip.setAttribute("aria-pressed", String(state.solo === f.key));
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
      chip.addEventListener("mouseenter", () => scene?.setHighlight("cmd", f.key));
      chip.addEventListener("mouseleave", () => scene?.setHighlight("cmd", null));
      chip.addEventListener("focus", () => scene?.setHighlight("cmd", f.key));
      chip.addEventListener("blur", () => scene?.setHighlight("cmd", null));
      chip.addEventListener("click", () => {
        hideCommandPopover();
        state.solo = state.solo === f.key ? null : f.key;
        scene?.setSolo(state.solo);
        renderSceneSection(state.snap);
      });
      strip.appendChild(chip);
    }
    strip.appendChild(el("span", "focus-spacer"));
    const guideBtn = el("button", "guide-link-btn");
    guideBtn.type = "button";
    guideBtn.id = "open-delegate-guide";
    guideBtn.dataset.testid = "open-delegate-guide";
    guideBtn.appendChild(el("span", "", "Guide"));
    guideBtn.appendChild(svgIcon("chevron", 10));
    guideBtn.addEventListener("click", () => switchView("delegate"));
    strip.appendChild(guideBtn);

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
          btn.addEventListener("mouseenter", () => scene?.setHighlight("art", art.key || art.id));
          btn.addEventListener("mouseleave", () => scene?.setHighlight("art", null));
          btn.addEventListener("focus", () => scene?.setHighlight("art", art.key || art.id));
          btn.addEventListener("blur", () => scene?.setHighlight("art", null));
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

    if (state.solo === "agents") {
      const box = el("div", "focus-drawer");
      box.dataset.testid = "focus-drawer-agents";
      const swarmMembers = act.swarm?.members || [];
      const subagents = act.subagents || [];
      if (swarmMembers.length === 0 && subagents.length === 0) {
        box.appendChild(el("p", "focus-empty", "No subagents or swarm workers executed yet."));
      } else {
        const ul = el("ul", "sub-accordion-list focus-drawer-list");
        for (const m of swarmMembers) {
          const li = el("li", "sub-row");
          li.addEventListener("mouseenter", () => scene?.setHighlight("member", m.id));
          li.addEventListener("mouseleave", () => scene?.setHighlight("member", null));
          const dw = el("span", "sub-row-dot-wrap");
          const dotCls = m.role === "verifier" ? "sub-row-dot ring" : "sub-row-dot";
          dw.appendChild(el("span", m.status === "working" ? `${dotCls} active` : dotCls));
          li.appendChild(dw);
          li.appendChild(el("span", "sub-row-name", m.name));
          li.appendChild(el("span", "sub-row-task", m.task));
          li.appendChild(el("span", m.status === "working" ? "sub-row-stat active" : "sub-row-stat", m.status));
          appendAskButton(li, `What is ${m.name} working on right now?`, `Ask /btw about ${m.name}`);
          ul.appendChild(li);
        }
        for (const a of subagents) {
          const li = el("li", "sub-row");
          li.addEventListener("mouseenter", () => scene?.setHighlight("agent", a.id));
          li.addEventListener("mouseleave", () => scene?.setHighlight("agent", null));
          const dw = el("span", "sub-row-dot-wrap");
          if (a.status === "done") {
            const chk = svgIcon("check-sm", 10);
            chk.style.color = "var(--tl-done)";
            dw.appendChild(chk);
          } else {
            dw.appendChild(el("span", "sub-row-dot active"));
          }
          li.appendChild(dw);
          li.appendChild(el("span", "sub-row-name", a.type));
          li.appendChild(el("span", "sub-row-task", a.task));
          const timerEl = el("span", "sub-row-timer", formatElapsedText(a.startedAt, a.completedAt));
          if (a.status === "running" && a.startedAt) {
            timerEl.dataset.timerKind = "elapsed";
            timerEl.dataset.startedAt = a.startedAt;
          }
          li.appendChild(timerEl);
          appendAskButton(li, `What is the ${a.type} subagent finding?`, `Ask /btw about the ${a.type} subagent`);
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
    const activeId = snap?.activity?.activeStageId;
    if (activeId && Array.isArray(stages) && stages.some((s) => s.id === activeId)) {
      return activeId;
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
    if (stage?.status === "stale") return { text: "re-verify", cls: "warn" };
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
      act.workflow?.active ? "running" : act.workflow?.suggestedReview ? "for PR Review" : "",
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
    stale: { word: "re-verify", cls: "warn" },
    done: { word: "done", cls: "done" },
  };

  function resolveGuideHeaderStatus(snap) {
    if (snap?.setup?.status === "needs_setup") {
      return { text: "Setup needed", cls: "warn" };
    }
    const focalStage = snap?.stages?.find((s) => s.id === snap?.activity?.activeStageId);
    if (focalStage) {
      const mapped = GUIDE_STAGE_STATUS[focalStage.status];
      return {
        text: `${focalStage.label} ${mapped ? mapped.word : focalStage.status}`,
        cls: mapped ? mapped.cls : "",
      };
    }
    return { text: "Ready", cls: "" };
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
      const meta = lookupCommandMeta(snap, cmd);
      const chip = el("button", "guide-cmd-chip", cmd);
      chip.type = "button";
      wireCommandAction(chip, meta || cmd);
      tags.appendChild(chip);
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
            const meta = lookupCommandMeta(snap, cmd);
            const chip = el("button", "guide-cmd-chip");
            chip.type = "button";
            chip.appendChild(el("span", "", cmd));
            const liveText = resolveCommandGuideBadge(cmd, snap);
            if (liveText) {
              chip.appendChild(el("span", "guide-cmd-live", liveText));
            }
            wireCommandAction(chip, meta || cmd);
            drawerChips.appendChild(chip);
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

  function switchView(nextView, restoreFocus = false) {
    const prevView = state.view;
    state.view = nextView;
    state.suppressedPopoverEl = null;
    hideCommandPopover();
    const tlView = document.getElementById("timeline-view");
    const dgView = document.getElementById("delegate-view");
    const artView = document.getElementById("artifact-view");
    if (!tlView || !dgView || !artView) return;

    const views = [
      { key: "timeline", el: tlView },
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

    if (nextView === "delegate") {
      state.guideUserToggled = false;
      state.guideCmdDrawerOpen = false;
      renderDelegateGuide(state.snap);
      document.getElementById("back-to-timeline")?.focus();
    } else if (nextView === "artifact") {
      renderArtifactView();
      document.getElementById("back-from-artifact")?.focus();
    } else {
      renderFooter(state.snap);
      scene?.resize();
      if (restoreFocus) {
        if (prevView === "artifact" && state.artifactReturnEl && document.contains(state.artifactReturnEl)) {
          state.artifactReturnEl.focus();
        } else if (prevView === "delegate") {
          document.getElementById("open-delegate-guide")?.focus();
        }
        state.artifactReturnEl = null;
      }
    }
  }

  function render(snap) {
    if (!snap) return;
    const progressEl = document.getElementById("progress");
    const WORKFLOW_MODE_COPY = {
      pr_iteration: {
        title: "PR Iteration",
        status: "Advisory",
        desc: "Iterating on an existing PR. Earlier stages are optional—jump straight to Build, PR Review, or Ship.",
      },
      pr_review: {
        title: "PR Review",
        status: "Advisory",
        desc: "Reviewing an existing PR. Plan and Build are optional when work was completed earlier.",
      },
      direct_build: {
        title: "Direct Flow",
        status: "Advisory",
        desc: "Jumped directly to implementation. Plan is optional and stages act as advisory checkpoints.",
      },
    };
    const modeInfo = WORKFLOW_MODE_COPY[snap.workflowMode];
    if (progressEl) {
      if (snap.workflowLabel && modeInfo) {
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
      progressEl.title = state.progressPopover.desc;
    }
    applyLiveStatus(snap);

    const RISK_TITLES = ["Low risk", "Medium risk", "High risk", "Critical risk"];
    const FRESHNESS_DISPLAY = {
      fresh: { label: "Verified", mode: "done", desc: "Tests or validation passed on the current git HEAD with no unverified edits." },
      fresh_rebase_patch_id: { label: "Verified", mode: "done", desc: "Rebased commit matches previously verified patch-id on current HEAD." },
      dirty_after_verify: { label: "Needs re-verify", mode: "stale", desc: "Files changed after the last verification run. Re-run tests on HEAD." },
      stale_sha: { label: "Stale commit", mode: "stale", desc: "Receipts belong to an older git commit. Re-run verification on HEAD." },
      missing_receipts: { label: "Unverified", mode: "", desc: "No passing verification receipt recorded for this commit yet." },
    };

    const metaParts = [];
    if (snap.workspaceName) {
      const repoLabel =
        snap.branch && snap.branch !== snap.workspaceName ? `${snap.workspaceName} (${snap.branch})` : snap.workspaceName;
      metaParts.push({ text: repoLabel });
    }
    if (snap.riskTier !== null && snap.riskTier !== undefined) {
      const riskWord = RISK_TITLES[snap.riskTier] || `Tier ${snap.riskTier}`;
      const descParts = [];
      if (snap.riskDescription) {
        const cleanDesc = snap.riskDescription.trim().replace(/\.+$/, "");
        descParts.push(`${cleanDesc}.`);
      }
      if (Array.isArray(snap.riskMatchedGlobs) && snap.riskMatchedGlobs.length > 0) {
        descParts.push(`Matched: ${snap.riskMatchedGlobs.join(", ")}.`);
      }
      if (snap.riskTier >= 1) descParts.push("Requires human PR review.");
      metaParts.push({
        text: riskWord,
        cls: `meta-pill meta-risk tier-${snap.riskTier}`,
        testId: "timeline-risk-badge",
        popTitle: `Blast-Radius Risk · Tier ${snap.riskTier}`,
        popStatus: riskWord,
        popMode: snap.riskTier >= 3 ? "stale" : snap.riskTier === 0 ? "done" : "",
        popDesc: descParts.join(" "),
      });
    }
    if (snap.freshness) {
      const fm = FRESHNESS_DISPLAY[snap.freshness] || {
        label: snap.freshness,
        mode: "",
        desc: `Trust ledger freshness status: ${snap.freshness}.`,
      };
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
    const metaRow = document.getElementById("meta-row");
    metaRow.replaceChildren();
    if (metaParts.length > 0 || setupReady) {
      metaRow.classList.remove("hidden");
      metaParts.forEach((part, idx) => {
        if (idx > 0) metaRow.appendChild(el("span", "meta-sep", "·"));
        const node = el("span", part.cls || "", part.text);
        if (part.testId) node.dataset.testid = part.testId;
        if (part.popDesc) {
          node.tabIndex = 0;
          node.title = part.popDesc;
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
      setupDrawer.appendChild(buildCommandChips(snap.setup.commands));
      appendSubCommands(setupDrawer, "setup", snap.setup.autoSubCommands, snap.setup.moreCommands);
    } else {
      setupDrawer.classList.add("hidden");
    }

    const setupWrap = document.getElementById("setup-wrap");
    const setupCard = document.getElementById("setup-card");
    setupCard.replaceChildren();
    if (snap.setup?.status === "needs_setup") {
      setupWrap.classList.remove("hidden");
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
      setupWrap.classList.add("hidden");
      setupCard.classList.add("hidden");
    }

    renderSceneSection(snap);
    scene?.updateState(snap);

    if (!state.userToggled) {
      state.expanded.clear();
      const focus =
        snap.stages.find((s) => s.status === "error") ||
        snap.stages.find((s) => s.status === "active") ||
        snap.stages.find((s) => s.status === "stale") ||
        snap.stages.find((s) => s.status === "waiting_gate");
      if (focus) state.expanded.add(focus.id);
    }

    const list = document.getElementById("timeline");
    list.replaceChildren();

    snap.stages.forEach((stage, idx) => {
      const isLast = idx === snap.stages.length - 1;
      const isExpanded = state.expanded.has(stage.id);
      const li = el("li", `step ${stage.status}`);
      if (stage.id === snap.activity?.activeStageId) {
        li.setAttribute("aria-current", "step");
      }
      li.addEventListener("mouseenter", () => scene?.setHighlight("stage", stage.id));
      li.addEventListener("mouseleave", () => scene?.setHighlight("stage", null));

      const rail = el("div", "rail");
      const node = el("span", `node ${stage.status}`);
      node.setAttribute("aria-hidden", "true");
      if (stage.status === "done") node.appendChild(svgIcon("check", 11));
      else if (stage.status === "stale" || stage.status === "error") node.appendChild(svgIcon("warn", 11));
      else if (stage.status === "waiting_gate") node.appendChild(svgIcon("gate", 11));
      else if (stage.status === "active") {
        const arc = svgIcon("active-arc", 18);
        arc.classList.add("node-spin-svg", "spin");
        node.appendChild(arc);
        node.appendChild(el("span", "node-active-core"));
      }
      rail.appendChild(node);
      if (!isLast) {
        const stemCls =
          stage.status === "active"
            ? "stem flow"
            : stage.status === "done"
              ? "stem done"
              : "stem";
        const stem = el("span", stemCls);
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
      const stLabel = stageStatusLabel(stage.status, stage);
      if (stLabel) {
        stepBtn.appendChild(el("span", `status-text ${stLabel.cls}`, stLabel.text));
      } else if (stage.id === "plan" && stage.status === "pending") {
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

      if (isExpanded) {
        body.appendChild(
          stage.id === "build" ? buildBuildStageDetail(stage, snap) : buildGenericStageDetail(stage, snap),
        );
      }

      li.appendChild(body);
      list.appendChild(li);
    });

    renderFooter(snap);
    if (state.view === "delegate") {
      renderDelegateGuide(snap);
    }
    if (state.popoverAnchor && !document.contains(state.popoverAnchor)) {
      hideCommandPopover();
    }
  }

  async function poll() {
    if (document.hidden) return;
    const convId = getConversationId(false);
    try {
      const res = await apiFetch("/api/timeline", {
        conversationId: convId,
        workspaceUri: state.workspaceUri,
        etag: state.etag,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.unchanged) {
        if (state.snap) applyLiveStatus(state.snap);
        return;
      }
      state.etag = data.etag || "";
      state.snap = data;
      render(data);
    } catch {
      document.getElementById("live").className = "live idle";
      document.getElementById("live-label").textContent = "Offline";
    }
  }

  function applyWorkspaceUris(uris, allowEmpty) {
    const first = Array.isArray(uris) && typeof uris[0] === "string" ? uris[0].trim() : "";
    if ((allowEmpty || first) && first !== state.workspaceUri) {
      state.workspaceUri = first;
      state.etag = "";
      poll();
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

  const sceneEl = document.getElementById("scene-section");
  const canvasEl = document.getElementById("scene-canvas");
  const fallbackEl = document.getElementById("scene-fallback");
  if (window.AStackScene3D && canvasEl) {
    const theme = document.documentElement.dataset.theme || "light";
    scene = window.AStackScene3D.create(canvasEl, {
      accent: resolveSceneAccent(theme),
      onUnavailable: () => fallbackEl?.classList.remove("hidden"),
    });
  } else {
    fallbackEl?.classList.remove("hidden");
  }

  if (sceneEl) {
    sceneEl.addEventListener("mousemove", (e) => {
      const r = sceneEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      scene?.setPointer(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    });
    sceneEl.addEventListener("mouseleave", () => scene?.setPointer(0, 0));
  }

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
      scene?.spawnFork();
      if (input) input.value = "";
      copyCommand({ command: "/btw", copyText: payload }, btwSubmit);
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
      if (state.view === "delegate" || state.view === "artifact") {
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

  if (state.view === "delegate") {
    switchView("delegate");
  }

  syncWorkspaceUri();
  poll();
  setInterval(poll, POLL_MS);
  setInterval(tickTimers, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      poll();
      tickTimers();
    }
  });
})();
