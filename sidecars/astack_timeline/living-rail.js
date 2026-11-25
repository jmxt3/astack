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

  function connectorKind(cur, next) {
    if (next.state === "running") return "flow";
    if ((cur.state === "done" || cur.state === "skipped") && next.state === "done") return "done";
    if (next.state === "suggested" || next.state === "queued") return "dashed";
    if (next.state === "skipped") return "faint";
    return "idle";
  }

  function drawConnector(c, cur, next, t, K) {
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
      c.strokeStyle = rgba(K.accent, 0.22);
      c.lineWidth = 2;
      c.stroke();
      c.globalCompositeOperation = K.blend;
      const len = b - a;
      const n = Math.max(3, Math.round(len / 10));
      for (let j = 0; j < n; j++) {
        const f = ((t * FLOW_SPEED) / len + j / n) % 1;
        const y = a + f * len;
        const al = Math.sin(Math.PI * f);
        c.fillStyle = rgba(K.accent, 0.25 * al);
        disc(c, X, y, 4);
        c.fillStyle = rgba(K.spark, 0.9 * al);
        disc(c, X, y, 1.4);
      }
    } else if (kind === "done") {
      c.strokeStyle = rgba(K.done, 0.68);
      c.lineWidth = 2;
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

  function drawNode(c, node, t, K) {
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
        drawRunning(c, node, t, K);
        break;
      case "yourturn": {
        const k = (t % 2.4) / 2.4;
        c.strokeStyle = rgba(K.warn, 0.6 * (1 - k));
        c.lineWidth = 1.5;
        ring(c, X, y, 9 + k * 9);
        c.fillStyle = rgba(K.warn, 0.18);
        disc(c, X, y, 9);
        c.strokeStyle = rgba(K.warn, 1);
        ring(c, X, y, 9);
        c.fillStyle = rgba(K.warn, 1);
        disc(c, X, y, 2.6);
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
    let cssH = 0;
    let dpr = 1;
    let raf = 0;
    let visible = true;
    let dirty = true;

    const isLive = () => nodes.some((n) => n.state === "running" || n.state === "yourturn");

    function schedule() {
      if (!raf && visible) raf = requestAnimationFrame(frame);
    }

    function draw(t) {
      if (cssH <= 0) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, RAIL_W, cssH);
      for (let i = 0; i < nodes.length - 1; i++) drawConnector(ctx, nodes[i], nodes[i + 1], t, colors);
      for (const node of nodes) drawNode(ctx, node, t, colors);
    }

    function frame(now) {
      raf = 0;
      if (!visible) return;
      const live = isLive();
      if (!live && !dirty) return;
      const elapsed = Math.max(0, (now - t0) / 1000);
      draw(elapsed * (reduced ? 0.25 : 1));
      dirty = false;
      if (live) schedule();
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
