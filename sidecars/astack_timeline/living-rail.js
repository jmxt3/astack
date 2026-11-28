(function () {
  const TAU = Math.PI * 2;
  const RAIL_W = 40;
  const X = 20;
  const GAP = 13;
  const FLOW_SPEED = 34;
  const MAX_AGENTS = 6;

  function toRgb(ctx, color, fallback) {
    ctx.fillStyle = fallback;
    if (color) ctx.fillStyle = color;
    const s = String(ctx.fillStyle);
    if (s[0] === "#") {
      return [
        parseInt(s.slice(1, 3), 16),
        parseInt(s.slice(3, 5), 16),
        parseInt(s.slice(5, 7), 16),
      ];
    }
    const m = s.match(/[\d.]+/g) || [0, 0, 0];
    const scale = s.startsWith("color(") ? 255 : 1;
    return [
      Math.round(Number(m[0]) * scale),
      Math.round(Number(m[1]) * scale),
      Math.round(Number(m[2]) * scale),
    ];
  }

  function rgba(c, a) {
    return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  }

  function readColors(ctx, el) {
    const cs = getComputedStyle(el);
    const v = (name) => cs.getPropertyValue(name).trim();
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
    const accent = toRgb(ctx, v("--tl-primary"), dark ? "#5aa2ff" : "#0068b8");
    return {
      dark,
      blend: dark ? "lighter" : "source-over",
      accent,
      done: toRgb(ctx, v("--tl-done"), dark ? "#22c55e" : "#15803d"),
      doneInk: toRgb(ctx, v("--tl-done-fg"), dark ? "#052e16" : "#ffffff"),
      warn: toRgb(ctx, v("--tl-warning"), dark ? "#cab43e" : "#8f6d00"),
      error: toRgb(ctx, v("--tl-error"), dark ? "#cb3d3d" : "#c43030"),
      ink: dark ? [255, 255, 255] : [0, 0, 0],
      spark: dark ? [220, 235, 255] : accent,
      core: dark ? [15, 26, 43] : toRgb(ctx, v("--tl-card"), "#ffffff"),
      hand: toRgb(ctx, v("--tl-queued"), dark ? "#8fb6ee" : "#3b6fb6"),
      beastOuter: dark ? [37, 99, 235] : [29, 78, 216],
      beastAmber: dark ? [90, 162, 255] : [0, 104, 184],
      beastYellow: dark ? [56, 189, 248] : [2, 132, 199],
      beastCore: dark ? [240, 249, 255] : [224, 242, 254],
      beastDisc: dark ? [10, 22, 42] : [239, 246, 255],
      beastLine: dark ? [90, 162, 255] : [0, 104, 184],
      beastSpark: dark ? [224, 242, 254] : [56, 189, 248],
    };
  }

  function disc(c, x, y, r) {
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
  }

  function ring(c, x, y, r) {
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.stroke();
  }

  function drawFlameTongue(c, baseX, baseY, width, height, swayTop, swayMid) {
    c.beginPath();
    c.moveTo(baseX, baseY);
    c.bezierCurveTo(
      baseX - width * 1.15, baseY - height * 0.24,
      baseX - width * 0.52 + swayMid, baseY - height * 0.68,
      baseX + swayTop, baseY - height,
    );
    c.bezierCurveTo(
      baseX + width * 0.52 + swayMid, baseY - height * 0.68,
      baseX + width * 1.15, baseY - height * 0.24,
      baseX, baseY,
    );
    c.closePath();
    c.fill();
  }

  function drawBalancedFlame(c, x, y, t, K, opts) {
    const scale = opts.scale ?? 1;
    const alphaMul = opts.alpha ?? 1;
    const isPilot = Boolean(opts.pilot);
    const surgeRemain = isPilot ? 0 : (opts.surgeRemain ?? 0);
    const hScale = scale * (1 + surgeRemain * 0.42);
    const wScale = scale * (1 + surgeRemain * 0.16);
    const phase = opts.phase ?? 0;

    c.save();
    c.globalCompositeOperation = K.blend;

    const auraR = (isPilot ? 13 : 21) * wScale;
    const aura = c.createRadialGradient(x, y - 3 * scale, 1, x, y - 3 * scale, auraR);
    aura.addColorStop(0, rgba(K.beastYellow, (isPilot ? 0.36 : 0.55) * alphaMul));
    aura.addColorStop(0.5, rgba(K.beastAmber, (isPilot ? 0.16 : 0.24) * alphaMul));
    aura.addColorStop(1, rgba(K.beastOuter, 0));
    c.fillStyle = aura;
    disc(c, x, y - 3 * scale, auraR);

    const sway1 = (Math.sin(t * 7.4 + phase) * 2.5 + Math.sin(t * 13.1 + phase) * 1.0) * scale;
    const sway2 = (Math.cos(t * 8.9 + 1.2 + phase) * 2.1 + Math.sin(t * 15.7 + phase) * 0.8) * scale;
    const breathe = 1 + Math.sin(t * 9.5 + phase) * 0.08 + Math.cos(t * 17.3 + phase) * 0.04;

    const hOuter = 26 * hScale * breathe;
    const gOuter = c.createLinearGradient(x, y + 2 * scale, x + sway1, y - hOuter);
    gOuter.addColorStop(0, rgba(K.beastAmber, (K.dark ? 0.85 : 0.92) * alphaMul));
    gOuter.addColorStop(0.55, rgba(K.beastOuter, (K.dark ? 0.64 : 0.78) * alphaMul));
    gOuter.addColorStop(1, rgba(K.beastOuter, 0));
    c.fillStyle = gOuter;
    drawFlameTongue(c, x, y + 2 * scale, 10.2 * wScale, hOuter, sway1, sway1 * 0.45);

    if (!isPilot) {
      c.fillStyle = rgba(K.beastAmber, (K.dark ? 0.5 : 0.58) * alphaMul);
      drawFlameTongue(c, x - 1.5, y + 2, 7.0 * wScale, 19.5 * hScale * (1 + Math.cos(t * 11) * 0.08), sway2 - 2.1, sway2 * 0.4);
      drawFlameTongue(c, x + 1.5, y + 2, 6.6 * wScale, 18.0 * hScale * (1 + Math.sin(t * 12.2) * 0.08), -sway1 + 2.0, -sway1 * 0.35);
    }

    const hYellow = 22 * hScale * (1 + Math.sin(t * 11.3 + 0.6 + phase) * 0.07);
    const gYellow = c.createLinearGradient(x, y + 1 * scale, x + sway2 * 0.7, y - hYellow);
    gYellow.addColorStop(0, rgba(K.beastYellow, 0.98 * alphaMul));
    gYellow.addColorStop(0.65, rgba(K.beastYellow, (K.dark ? 0.84 : 0.9) * alphaMul));
    gYellow.addColorStop(1, rgba(K.beastAmber, 0.08 * alphaMul));
    c.fillStyle = gYellow;
    drawFlameTongue(c, x, y + 1 * scale, 8.0 * wScale, hYellow, sway2 * 0.75, sway1 * 0.3);

    const hCore = 14 * hScale * (1 + Math.cos(t * 13.7 + phase) * 0.07);
    const gCore = c.createLinearGradient(x, y + 1 * scale, x, y - hCore);
    gCore.addColorStop(0, rgba(K.beastCore, alphaMul));
    gCore.addColorStop(0.7, rgba(K.beastYellow, 0.9 * alphaMul));
    gCore.addColorStop(1, rgba(K.beastYellow, 0));
    c.fillStyle = gCore;
    drawFlameTongue(c, x, y + 1 * scale, 5.0 * wScale, hCore, sway1 * 0.35, sway2 * 0.18);

    const emberN = isPilot ? 7 : 20;
    for (let j = 0; j < emberN; j++) {
      const f = (t * (isPilot ? 0.85 : 1.15) + j / emberN + j * 0.037 + phase) % 1;
      const py = y - 2 * scale - f * (27 * hScale);
      const px = x + Math.sin(f * 8.5 + j * 1.9) * (3.4 * wScale) * (1 - f * 0.45);
      const col = f < 0.3 ? K.beastCore : f < 0.72 ? K.beastYellow : K.beastAmber;
      c.fillStyle = rgba(col, (1 - f) * (isPilot ? 0.55 : 0.68) * alphaMul);
      disc(c, px, py, (2.2 * (1 - f) + 0.4) * wScale);
    }

    const sparkN = isPilot ? 2 : 5;
    for (let s = 0; s < sparkN; s++) {
      const sf = (t * 0.78 + s / sparkN + s * 0.17 + phase) % 1;
      const sy = y - 15 * hScale - sf * (18 * hScale);
      const sx = x + Math.sin(t * 4.5 + s * 2.7 + phase) * (5.0 * wScale);
      const alpha = Math.sin(Math.PI * sf) * 0.95 * alphaMul;
      c.fillStyle = rgba(sf < 0.45 ? K.beastCore : K.beastYellow, alpha);
      disc(c, sx, sy, 1.25 * (1 - sf * 0.4) * Math.max(0.75, scale));
    }

    c.restore();
  }

  function connectorKind(cur, next) {
    if (next.state === "running") return "flow";
    if (next.state === "yourturn") return "yourturn";
    if ((cur.state === "done" || cur.state === "skipped") && next.state === "done") return "done";
    if (next.state === "pilot") return "pilot";
    if (next.state === "suggested" || next.state === "queued") return "dashed";
    if (next.state === "skipped") return "faint";
    return "idle";
  }

  function drawConnector(c, cur, next, t, K, beastOn) {
    const a = cur.y + GAP;
    const b = next.y - GAP;
    if (b <= a) return;
    const kind = connectorKind(cur, next);
    c.save();
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(X, a);
    c.lineTo(X, b);
    if (kind === "flow") {
      const lineCol = beastOn ? K.beastLine : K.accent;
      const sparkCol = beastOn ? K.beastSpark : K.spark;
      c.strokeStyle = rgba(lineCol, beastOn ? 0.5 : 0.22);
      c.lineWidth = 2;
      c.stroke();
      c.globalCompositeOperation = K.blend;
      const len = b - a;
      const n = Math.max(3, Math.round(len / 10));
      const speed = beastOn ? 46 : FLOW_SPEED;
      for (let j = 0; j < n; j++) {
        const f = ((t * speed) / len + j / n) % 1;
        const y = a + f * len;
        const al = Math.sin(Math.PI * f);
        c.fillStyle = rgba(lineCol, (beastOn ? 0.36 : 0.25) * al);
        disc(c, X, y, 4);
        c.fillStyle = rgba(sparkCol, (beastOn ? 0.95 : 0.9) * al);
        disc(c, X, y, 1.4);
      }
    } else if (kind === "yourturn") {
      c.strokeStyle = rgba(K.warn, 0.58);
      c.lineWidth = 2;
      c.stroke();
    } else if (kind === "done") {
      c.strokeStyle = rgba(K.done, 0.68);
      c.lineWidth = 2;
      c.stroke();
    } else if (beastOn && kind === "pilot") {
      c.strokeStyle = rgba(K.beastLine, cur.state === "running" ? 0.52 : 0.34);
      c.lineWidth = 2;
      c.stroke();
    } else if (beastOn && (kind === "dashed" || kind === "idle")) {
      c.strokeStyle = rgba(K.beastLine, 0.2);
      c.lineWidth = 1.6;
      c.stroke();
    } else if (kind === "dashed" || kind === "faint") {
      c.setLineDash([3, 4]);
      c.strokeStyle = rgba(K.ink, kind === "faint" ? 0.12 : 0.24);
      c.lineWidth = 1.3;
      c.stroke();
    } else {
      c.strokeStyle = rgba(K.ink, 0.12);
      c.lineWidth = 1;
      c.stroke();
    }
    c.restore();
  }

  function drawBeastRunning(c, node, t, K, surgeRemain) {
    const y = node.y;
    const n = Math.min(MAX_AGENTS, node.agents || 0);
    const orbit = (front) => {
      c.save();
      c.globalCompositeOperation = K.blend;
      for (let k = 0; k < n; k++) {
        const angle = t * 2.0 + (k * TAU) / n;
        if (Math.sin(angle) > 0 !== front) continue;
        const ox = X + Math.cos(angle) * 15.5;
        const oy = y + 2 + Math.sin(angle) * 4.5;
        c.fillStyle = rgba(K.beastLine, 0.48);
        disc(c, ox, oy, 3.6);
        c.fillStyle = rgba(K.beastSpark, 0.98);
        disc(c, ox, oy, 1.7);
      }
      c.restore();
    };
    orbit(false);
    c.fillStyle = rgba(K.beastLine, 0.16);
    disc(c, X, y, 14);
    c.fillStyle = rgba(K.beastDisc, 1);
    disc(c, X, y, 10.5);
    c.strokeStyle = rgba(K.beastLine, 1);
    c.lineWidth = 1.9;
    ring(c, X, y, 10.5);
    drawBalancedFlame(c, X, y + 3.5, t, K, { scale: 1, alpha: 1, phase: 0, surgeRemain });
    orbit(true);
  }

  function drawRunning(c, node, t, K) {
    const y = node.y;
    const n = Math.min(MAX_AGENTS, node.agents || 0);
    const orbit = (front) => {
      for (let k = 0; k < n; k++) {
        const angle = t * 1.8 + (k * TAU) / n;
        if (Math.sin(angle) > 0 !== front) continue;
        const ox = X + Math.cos(angle) * 15;
        const oy = y + 1 + Math.sin(angle) * 4.5;
        c.fillStyle = rgba(K.accent, 0.35);
        disc(c, ox, oy, 3.4);
        c.fillStyle = rgba(K.spark, 1);
        disc(c, ox, oy, 1.6);
      }
    };
    c.globalCompositeOperation = K.blend;
    orbit(false);
    for (let j = 0; j < 30; j++) {
      const f = (t * 0.9 + (j / 30) * 1.7 + j * 0.013) % 1;
      const py = y - 3 - f * 27;
      const px = X + Math.sin(f * 7 + j) * 3.2 * (1 - f * 0.4);
      c.fillStyle = rgba(f < 0.22 ? K.spark : K.accent, (1 - f) * 0.75);
      disc(c, px, py, 3.4 * (1 - f) + 0.5);
    }
    const g = c.createRadialGradient(X, y, 0, X, y, 16);
    g.addColorStop(0, rgba(K.accent, 0.45));
    g.addColorStop(1, rgba(K.accent, 0));
    c.fillStyle = g;
    disc(c, X, y, 16);
    c.globalCompositeOperation = "source-over";
    c.fillStyle = rgba(K.core, 1);
    disc(c, X, y, 8);
    c.strokeStyle = rgba(K.accent, 1);
    c.lineWidth = 1.6;
    ring(c, X, y, 8);
    c.fillStyle = rgba(K.spark, 1);
    disc(c, X, y, 3);
    c.globalCompositeOperation = K.blend;
    orbit(true);
  }

  function drawBang(c, y, col) {
    c.fillStyle = rgba(col, 0.16);
    disc(c, X, y, 9);
    c.strokeStyle = rgba(col, 1);
    c.lineWidth = 1.5;
    ring(c, X, y, 9);
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(X, y - 4);
    c.lineTo(X, y + 1);
    c.stroke();
    c.fillStyle = rgba(col, 1);
    disc(c, X, y + 3.6, 1);
  }

  function drawNode(c, node, idx, t, K, beastOn, surgeRemain) {
    const y = node.y;
    c.save();
    switch (node.state) {
      case "done": {
        c.fillStyle = rgba(K.done, 0.22);
        disc(c, X, y, 12);
        c.fillStyle = rgba(K.done, 1);
        disc(c, X, y, 10);
        c.strokeStyle = rgba(K.doneInk, 1);
        c.lineWidth = 1.8;
        c.lineCap = "round";
        c.lineJoin = "round";
        c.beginPath();
        c.moveTo(X - 4, y + 0.3);
        c.lineTo(X - 1.2, y + 3);
        c.lineTo(X + 4, y - 3);
        c.stroke();
        break;
      }
      case "running":
        if (beastOn) drawBeastRunning(c, node, t, K, surgeRemain);
        else drawRunning(c, node, t, K);
        break;
      case "pilot": {
        const alpha = node.pilotAlpha ?? 1;
        c.fillStyle = rgba(K.beastDisc, 1);
        disc(c, X, y, 10);
        c.setLineDash([3, 3]);
        c.strokeStyle = rgba(K.beastLine, alpha >= 0.9 ? 0.68 : 0.44);
        c.lineWidth = 1.6;
        ring(c, X, y, 10);
        c.setLineDash([]);
        drawBalancedFlame(c, X, y + 3, t, K, {
          pilot: true,
          scale: node.pilotScale || 0.52,
          alpha,
          phase: idx * 1.7,
        });
        break;
      }
      case "lock": {
        c.fillStyle = K.dark ? "#121214" : "#f4f4f5";
        disc(c, X, y, 10);
        c.strokeStyle = K.dark ? "#4a4a52" : "#a1a1aa";
        c.lineWidth = 1.6;
        ring(c, X, y, 10);
        c.strokeStyle = K.dark ? "#d4d4da" : "#52525b";
        c.lineWidth = 1.3;
        c.strokeRect(X - 3.2, y - 0.4, 6.4, 4.6);
        c.beginPath();
        c.arc(X, y - 0.7, 2, Math.PI, 0);
        c.stroke();
        break;
      }
      case "yourturn": {
        const k = (t % 2.8) / 2.8;
        const g = c.createRadialGradient(X, y, 0, X, y, 15);
        g.addColorStop(0, rgba(K.warn, 0.34));
        g.addColorStop(1, rgba(K.warn, 0));
        c.fillStyle = g;
        disc(c, X, y, 15);
        c.strokeStyle = rgba(K.warn, 0.55 * (1 - k));
        c.lineWidth = 1.5;
        ring(c, X, y, 9 + k * 8);
        c.fillStyle = rgba(K.core, 1);
        disc(c, X, y, 8.5);
        c.fillStyle = rgba(K.warn, 0.18);
        disc(c, X, y, 8.5);
        c.strokeStyle = rgba(K.warn, 1);
        c.lineWidth = 1.6;
        ring(c, X, y, 8.5);
        c.fillStyle = rgba(K.warn, 1);
        disc(c, X, y, 3);
        break;
      }
      case "stale":
        drawBang(c, y, K.warn);
        break;
      case "error":
        drawBang(c, y, K.error);
        break;
      case "queued":
        c.strokeStyle = rgba(K.accent, 0.55);
        c.lineWidth = 1.5;
        ring(c, X, y, 9);
        c.strokeStyle = rgba(K.hand, 1);
        c.lineWidth = 1.4;
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(X, y - 3.5);
        c.lineTo(X, y);
        c.lineTo(X + 2.5, y + 1.5);
        c.stroke();
        break;
      case "suggested":
        c.setLineDash([2.5, 2.5]);
        c.strokeStyle = rgba(K.ink, 0.32);
        c.lineWidth = 1.5;
        ring(c, X, y, 9);
        break;
      case "skipped":
        c.strokeStyle = rgba(K.ink, 0.14);
        c.lineWidth = 1.5;
        ring(c, X, y, 9);
        c.strokeStyle = rgba(K.ink, 0.4);
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(X - 3, y + 3);
        c.lineTo(X + 3, y - 3);
        c.stroke();
        break;
      default:
        c.strokeStyle = rgba(K.ink, 0.18);
        c.lineWidth = 1.5;
        ring(c, X, y, 9);
    }
    c.restore();
  }

  function createLivingRail(canvas, options) {
    const opts = options || {};
    const ctx = canvas?.getContext?.("2d");
    if (!ctx) {
      return {
        resize() {},
        setNodes() {},
        setBeastMode() {},
        triggerIgnition() {},
        setVisible() {},
        refreshTheme() {},
        destroy() {},
      };
    }
    const schemeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const motionQuery = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let reduced = opts.reducedMotion ?? Boolean(motionQuery?.matches);
    const t0 = performance.now();
    let colors = readColors(ctx, canvas);
    let nodes = [];
    let beastOn = false;
    let ignitionUntil = 0;
    let cssH = 0;
    let dpr = 1;
    let raf = 0;
    let visible = true;
    let dirty = true;

    const isLive = () => nodes.some((n) => n.state === "running" || n.state === "yourturn");

    function schedule() {
      if (!raf && visible) raf = requestAnimationFrame(frame);
    }

    function draw(t, surgeRemain) {
      if (cssH <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, RAIL_W, cssH);
      for (let i = 0; i < nodes.length - 1; i++) drawConnector(ctx, nodes[i], nodes[i + 1], t, colors, beastOn);
      for (let i = 0; i < nodes.length; i++) drawNode(ctx, nodes[i], i, t, colors, beastOn, surgeRemain);
    }

    function frame(now) {
      raf = 0;
      if (!visible) return;
      const live = isLive();
      if (!live && !dirty) return;
      const elapsed = Math.max(0, (now - t0) / 1000);
      const t = reduced ? (beastOn ? 0 : elapsed * 0.25) : elapsed;
      const surgeRemain = reduced ? 0 : Math.max(0, (ignitionUntil - now) / 720);
      draw(t, surgeRemain);
      dirty = false;
      if (live && !(reduced && beastOn)) schedule();
    }

    const onSchemeChange = () => {
      colors = readColors(ctx, canvas);
      dirty = true;
      schedule();
    };
    const onMotionChange = (ev) => {
      if (opts.reducedMotion === undefined) {
        reduced = Boolean(ev.matches);
        dirty = true;
        schedule();
      }
    };
    schemeQuery?.addEventListener?.("change", onSchemeChange);
    motionQuery?.addEventListener?.("change", onMotionChange);

    return {
      resize(heightCss) {
        dpr = Math.min(2, window.devicePixelRatio || 1);
        cssH = Math.ceil(heightCss);
        canvas.style.width = `${RAIL_W}px`;
        canvas.style.height = `${cssH}px`;
        canvas.width = Math.round(RAIL_W * dpr);
        canvas.height = Math.round(cssH * dpr);
        dirty = true;
        schedule();
      },
      setNodes(next) {
        nodes = Array.isArray(next) ? next : [];
        dirty = true;
        schedule();
      },
      setBeastMode(on) {
        const next = Boolean(on);
        if (next === beastOn) return;
        beastOn = next;
        if (!beastOn) ignitionUntil = 0;
        dirty = true;
        schedule();
      },
      triggerIgnition() {
        ignitionUntil = performance.now() + 720;
        dirty = true;
        schedule();
      },
      setVisible(v) {
        visible = Boolean(v);
        if (visible) {
          dirty = true;
          schedule();
        } else if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      },
      refreshTheme() {
        colors = readColors(ctx, canvas);
        dirty = true;
        schedule();
      },
      destroy() {
        this.setVisible(false);
        nodes = [];
        schemeQuery?.removeEventListener?.("change", onSchemeChange);
        motionQuery?.removeEventListener?.("change", onMotionChange);
      },
    };
  }

  window.createLivingRail = createLivingRail;
})();
