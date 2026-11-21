(() => {
  const STAGE_IDS = ["plan", "build", "review", "ship"];
  const FOCUS_MAP = {
    agents: ["subagents", "swarm"],
    later: ["sched"],
    art: ["art"],
    swarm: ["swarm"],
    subagents: ["subagents"],
    goal: ["goal"],
    schedule: ["sched"],
    rw: ["lanes"],
    boost: ["helix"],
  };

  function makeNoopController() {
    return {
      updateState() {},
      setHighlight() {},
      setSolo() {},
      setAccent() {},
      spawnFork() {},
      pulseSchedule() {},
      setPointer() {},
      resize() {},
      destroy() {},
    };
  }

  function makeRadialDotTexture(T) {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.2, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.45, "rgba(255,255,255,0.28)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new T.CanvasTexture(c);
  }

  function create(canvasEl, options = {}) {
    const T = window.THREE;
    if (!T || !canvasEl) {
      options.onUnavailable?.();
      return makeNoopController();
    }

    let renderer;
    try {
      renderer = new T.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: false,
        powerPreference: "low-power",
      });
    } catch {
      options.onUnavailable?.();
      return makeNoopController();
    }

    const reducedMotion = Boolean(
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    const ADD = T.AdditiveBlending;
    const v3 = new T.Vector3();
    const cA = new T.Color();
    const cB = new T.Color();
    const tint = new T.Color();
    const COLORS = {
      done: new T.Color("#22c55e"),
      stale: new T.Color("#cab43e"),
      error: new T.Color("#f06b6b"),
      white: new T.Color("#e8e8ea"),
      grey: new T.Color("#6f757a"),
    };
    const accent = new T.Color(options.accent || "#5aa2ff");

    const parent = canvasEl.parentElement;
    let width = Math.max(260, parent?.clientWidth || canvasEl.clientWidth || 600);
    let height = parent?.clientHeight || canvasEl.clientHeight || 164;

    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    renderer.setClearColor(0x0b0b0c, 1);

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(30, width / height, 0.1, 100);
    camera.position.set(0, 1.25, 6.4);
    camera.lookAt(0, 0.05, 0);
    camera.updateMatrixWorld(true);

    const world = new T.Group();
    scene.add(world);
    const dot = makeRadialDotTexture(T);

    const state = {
      stages: STAGE_IDS.map((id) => ({ id, status: "pending" })),
      focalIdx: 0,
      agents: [],
      swarmActive: false,
      members: [],
      swarmPosts: 0,
      goalActive: false,
      goalTarget: 0,
      boostActive: false,
      workflowActive: false,
      schedCount: 0,
      artifacts: [],
      solo: null,
    };
    const hl = { stage: null, agent: null, member: null, art: null, cmd: null };
    const ptr = { x: 0, y: 0 };
    const sparkQ = [];
    let lastPosts = -1;
    let lastGoal = 0;
    let loopProg = 0;
    let pulseAt = 0;
    let inView = true;
    let dead = false;
    let t = 0;

    function projectStagePositions() {
      const xs = [-0.8, -0.2, 0.4, 0.8];
      const ny = -0.02;
      return xs.map((nx) => {
        const vec = new T.Vector3(nx, ny, 0.5).unproject(camera);
        const dir = vec.sub(camera.position).normalize();
        const k = -camera.position.z / dir.z;
        return camera.position.clone().add(dir.multiplyScalar(k));
      });
    }

    let P = projectStagePositions();

    function statusColor(status) {
      if (status === "done" || status === "skipped") return COLORS.done;
      if (status === "stale" || status === "waiting_gate") return COLORS.stale;
      if (status === "error") return COLORS.error;
      if (status === "active" || status === "next") return accent;
      return COLORS.grey;
    }

    const ringGeo = new T.RingGeometry(0.2, 0.22, 64);
    const coreGeo = new T.SphereGeometry(0.085, 20, 14);
    const nodes = STAGE_IDS.map((id, idx) => {
      const g = new T.Group();
      g.position.copy(P[idx]);
      world.add(g);
      const col = statusColor(state.stages[idx].status);
      const core = new T.Mesh(coreGeo, new T.MeshBasicMaterial({ color: col.clone() }));
      const ring = new T.Mesh(
        ringGeo,
        new T.MeshBasicMaterial({
          color: col.clone(),
          transparent: true,
          opacity: 0.6,
          side: T.DoubleSide,
          depthWrite: false,
        }),
      );
      const halo = new T.Sprite(
        new T.SpriteMaterial({
          map: dot,
          color: col.clone(),
          transparent: true,
          opacity: 0.28,
          blending: ADD,
          depthWrite: false,
        }),
      );
      g.add(halo, ring, core);
      const pulses = [0, 1.2].map((off) => {
        const pm = new T.Mesh(
          ringGeo,
          new T.MeshBasicMaterial({
            color: col.clone(),
            transparent: true,
            opacity: 0,
            side: T.DoubleSide,
            depthWrite: false,
            blending: ADD,
          }),
        );
        g.add(pm);
        return { m: pm, off };
      });
      return { id, status: "pending", g, core, ring, halo, pulses, hl: 0 };
    });

    const LR = 0.36;
    const LSEG = 128;
    const loopPts = [];
    for (let k = 0; k <= LSEG; k++) {
      const a = Math.PI / 2 - (k / LSEG) * Math.PI * 2;
      loopPts.push(new T.Vector3(Math.cos(a) * LR, Math.sin(a) * LR, 0));
    }
    const loopG = new T.Group();
    nodes[1].g.add(loopG);
    const trackMat = new T.LineBasicMaterial({ color: 0x9ba1a6, transparent: true, opacity: 0, depthWrite: false });
    loopG.add(new T.Line(new T.BufferGeometry().setFromPoints(loopPts), trackMat));
    const arcGeo = new T.BufferGeometry().setFromPoints(loopPts);
    const arcMat = new T.LineBasicMaterial({ color: accent.clone(), transparent: true, opacity: 0, depthWrite: false });
    loopG.add(new T.Line(arcGeo, arcMat));
    const loopHead = new T.Sprite(
      new T.SpriteMaterial({ map: dot, color: accent.clone(), transparent: true, opacity: 0, blending: ADD, depthWrite: false }),
    );
    loopHead.scale.set(0.17, 0.17, 1);
    loopG.add(loopHead);

    const SEG = 320;
    const TS = 96;
    const sp = new Float32Array((SEG + 1) * 3);
    const sc = new Float32Array((SEG + 1) * 3);
    const spineGeo = new T.BufferGeometry();
    spineGeo.setAttribute("position", new T.BufferAttribute(sp, 3));
    spineGeo.setAttribute("color", new T.BufferAttribute(sc, 3));
    world.add(
      new T.Line(
        spineGeo,
        new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: ADD, depthWrite: false }),
      ),
    );

    const tubeMat = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.32, blending: ADD, depthWrite: false });
    const haloMat = new T.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.09, blending: ADD, depthWrite: false });
    const tubeMesh = new T.Mesh(new T.BufferGeometry(), tubeMat);
    const haloMesh = new T.Mesh(new T.BufferGeometry(), haloMat);
    world.add(haloMesh, tubeMesh);

    let curve = null;
    let segCurve = null;
    let tNode = [1 / 8, 3 / 8, 5 / 8, 7 / 8];
    let segA0 = 0;
    let segA1 = 1 / 8;
    let segI0 = 0;
    let segI1 = 40;
    let streamFromCol = COLORS.done;
    let streamToCol = accent;

    function buildSpineAndStream() {
      const pts = [P[0].clone().add(new T.Vector3(-2.6, -0.08, -0.7))];
      for (let i = 0; i < 4; i++) {
        pts.push(P[i].clone());
        if (i < 3) {
          const m = P[i].clone().lerp(P[i + 1], 0.5);
          m.z -= 0.6;
          m.y += 0.16;
          pts.push(m);
        }
      }
      pts.push(P[3].clone().add(new T.Vector3(2.6, -0.08, -0.7)));
      curve = new T.CatmullRomCurve3(pts, false, "centripetal");
      const NSEG = pts.length - 1;
      tNode = [1 / NSEG, 3 / NSEG, 5 / NSEG, 7 / NSEG];

      for (let i = 0; i <= SEG; i++) {
        curve.getPoint(i / SEG, v3);
        sp[i * 3] = v3.x;
        sp[i * 3 + 1] = v3.y;
        sp[i * 3 + 2] = v3.z;
      }
      spineGeo.attributes.position.needsUpdate = true;

      const idx = Math.max(0, Math.min(3, state.focalIdx));
      segA0 = idx === 0 ? 0.03 : tNode[idx - 1];
      segA1 = tNode[idx];
      segI0 = Math.ceil(segA0 * SEG);
      segI1 = Math.floor(segA1 * SEG);
      streamFromCol = idx === 0 ? accent : statusColor(nodes[idx - 1].status);
      streamToCol = statusColor(nodes[idx].status);

      const segPts = [];
      for (let i = 0; i <= 48; i++) segPts.push(curve.getPoint(segA0 + (segA1 - segA0) * (i / 48)));
      segCurve = new T.CatmullRomCurve3(segPts);

      const nextTube = new T.TubeGeometry(segCurve, TS, 0.03, 8, false);
      const nextHalo = new T.TubeGeometry(segCurve, TS, 0.11, 10, false);
      tubeMesh.geometry.dispose();
      haloMesh.geometry.dispose();
      tubeMesh.geometry = nextTube;
      haloMesh.geometry = nextHalo;
      paintSpine();
      paintTube();
    }

    function paintSpine() {
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        const edge = Math.max(0, Math.min(1, u / tNode[0], (1 - u) / (1 - tNode[3])));
        if (u >= segA0 && u <= segA1) {
          const frac = (u - segA0) / Math.max(0.001, segA1 - segA0);
          cA.copy(streamFromCol).lerp(streamToCol, frac).multiplyScalar(0.55);
        } else if (u < segA0) {
          cA.copy(COLORS.done).multiplyScalar(0.28);
        } else {
          cA.setRGB(0.2, 0.2, 0.21);
        }
        cA.multiplyScalar(edge);
        sc[i * 3] = cA.r;
        sc[i * 3 + 1] = cA.g;
        sc[i * 3 + 2] = cA.b;
      }
      spineGeo.attributes.color.needsUpdate = true;
    }

    function paintTube() {
      [
        [tubeMesh.geometry, 9],
        [haloMesh.geometry, 11],
      ].forEach(([geo, rs]) => {
        if (!geo.attributes?.position) return;
        const cols = new Float32Array(geo.attributes.position.count * 3);
        for (let i = 0; i <= TS; i++) {
          const f = i / TS;
          cA.copy(streamFromCol)
            .lerp(streamToCol, f)
            .multiplyScalar(Math.min(1, f / 0.12) * Math.min(1, (1 - f) / 0.05 + 0.4));
          for (let j = 0; j < rs; j++) {
            const k = (i * rs + j) * 3;
            if (k + 2 < cols.length) {
              cols[k] = cA.r;
              cols[k + 1] = cA.g;
              cols[k + 2] = cA.b;
            }
          }
        }
        geo.setAttribute("color", new T.BufferAttribute(cols, 3));
      });
    }

    const SN = 160;
    const BN = 30;
    const sPos = new Float32Array(SN * 3);
    const sCol = new Float32Array(SN * 3);
    const sGeo = new T.BufferGeometry();
    sGeo.setAttribute("position", new T.BufferAttribute(sPos, 3));
    sGeo.setAttribute("color", new T.BufferAttribute(sCol, 3));
    const sPts = new T.Points(
      sGeo,
      new T.PointsMaterial({ size: 0.36, map: dot, vertexColors: true, transparent: true, blending: ADD, depthWrite: false, sizeAttenuation: true }),
    );
    world.add(sPts);

    const bPos = new Float32Array(BN * 3);
    const bCol = new Float32Array(BN * 3);
    const bGeo = new T.BufferGeometry();
    bGeo.setAttribute("position", new T.BufferAttribute(bPos, 3));
    bGeo.setAttribute("color", new T.BufferAttribute(bCol, 3));
    const bPts = new T.Points(
      bGeo,
      new T.PointsMaterial({ size: 1.0, map: dot, vertexColors: true, transparent: true, blending: ADD, depthWrite: false, sizeAttenuation: true }),
    );
    world.add(bPts);

    const sSeed = [];
    for (let i = 0; i < SN + BN; i++) {
      sSeed.push({
        o: Math.random(),
        s: 0.8 + Math.random() * 0.5,
        r: 0.02 + Math.random() * 0.1,
        a: Math.random() * 6.283,
        w: (Math.random() - 0.5) * 7,
        fl: Math.random() * 6.283,
      });
    }

    function placeMote(i, arr, carr, speed, gain, e) {
      if (!segCurve) return;
      const sd = sSeed[i];
      const f = (sd.o + t * speed * sd.s) % 1;
      const u = Math.pow(f, 1.2);
      segCurve.getPoint(u, v3);
      const rr = sd.r * (1 - 0.75 * u);
      const ang = sd.a + sd.w * f;
      const k = (i < SN ? i : i - SN) * 3;
      arr[k] = v3.x;
      arr[k + 1] = v3.y + Math.cos(ang) * rr;
      arr[k + 2] = v3.z + Math.sin(ang) * rr;
      const b = Math.min(1, f / 0.08) * Math.min(1, (1 - u) / 0.05) * (0.6 + 0.4 * u) * (0.85 + 0.15 * Math.sin(t * 9 + sd.fl)) * gain * e;
      cA.copy(streamFromCol).lerp(streamToCol, u).multiplyScalar(b);
      carr[k] = cA.r;
      carr[k + 1] = cA.g;
      carr[k + 2] = cA.b;
    }

    function streamFrame(e) {
      for (let i = 0; i < SN; i++) placeMote(i, sPos, sCol, 0.26, 1, e);
      for (let i = SN; i < SN + BN; i++) placeMote(i, bPos, bCol, 0.17, 0.3, e);
      sGeo.attributes.position.needsUpdate = true;
      sGeo.attributes.color.needsUpdate = true;
      bGeo.attributes.position.needsUpdate = true;
      bGeo.attributes.color.needsUpdate = true;
      const span = Math.max(0.001, segA1 - segA0);
      for (let i = segI0; i <= segI1; i++) {
        const f = (i / SEG - segA0) / span;
        const band = Math.pow(0.5 + 0.5 * Math.sin((f * 3 - t * 1.4) * Math.PI * 2), 8);
        cA.copy(streamFromCol).lerp(streamToCol, f).multiplyScalar((0.5 + 0.9 * band) * e);
        sc[i * 3] = cA.r;
        sc[i * 3 + 1] = cA.g;
        sc[i * 3 + 2] = cA.b;
      }
      spineGeo.attributes.color.needsUpdate = true;
      tubeMat.opacity = 0.32 * e;
      haloMat.opacity = 0.09 * e;
    }

    buildSpineAndStream();

    const agentGroup = new T.Group();
    world.add(agentGroup);
    const TR = 26;
    const particles = new Map();
    const flashes = [];

    function spawnParticle(birth, stageIdx) {
      const spr = new T.Sprite(
        new T.SpriteMaterial({ map: dot, color: 0xffffff, transparent: true, blending: ADD, depthWrite: false }),
      );
      spr.scale.set(0.22, 0.22, 1);
      const tp = new Float32Array(TR * 3);
      const tc = new Float32Array(TR * 3);
      const tg = new T.BufferGeometry();
      tg.setAttribute("position", new T.BufferAttribute(tp, 3));
      tg.setAttribute("color", new T.BufferAttribute(tc, 3));
      const line = new T.Line(tg, new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: ADD, depthWrite: false }));
      agentGroup.add(line, spr);
      const az = Math.random() * Math.PI * 2;
      const tilt = 0.45 + Math.random() * 0.75;
      const q = new T.Quaternion().setFromAxisAngle(new T.Vector3(Math.cos(az), 0, Math.sin(az)), tilt);
      return {
        spr,
        line,
        tp,
        tc,
        tg,
        q,
        stageIdx,
        R: 0.54 + Math.random() * 0.26,
        w: (0.9 + Math.random() * 0.8) * (Math.random() < 0.5 ? -1 : 1),
        ph: Math.random() * 6.28,
        birth,
        death: -1,
        filled: false,
        heat: 0,
      };
    }

    function flash(strength = 1, nodeIdx = 1) {
      const targetNode = nodes[nodeIdx] || nodes[1];
      const fm = new T.Mesh(
        ringGeo,
        new T.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.7 * strength,
          side: T.DoubleSide,
          depthWrite: false,
          blending: ADD,
        }),
      );
      targetNode.g.add(fm);
      flashes.push({ m: fm, born: t, k0: strength });
    }

    const swarmG = new T.Group();
    world.add(swarmG);
    const SR = 1.15;
    const boardGeo = new T.BufferGeometry();
    const boardMat = new T.LineBasicMaterial({ color: 0x9ba1a6, transparent: true, opacity: 0, depthWrite: false });
    const boardRing = new T.Line(boardGeo, boardMat);
    swarmG.add(boardRing);

    function rebuildBoardRing() {
      const ringPts = [];
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        ringPts.push(new T.Vector3(P[1].x + Math.cos(a) * SR, P[1].y + 0.05, P[1].z + Math.sin(a) * SR));
      }
      boardGeo.setFromPoints(ringPts);
    }
    rebuildBoardRing();

    const memberMeshes = new Map();
    const sparks = [];
    let swarmSignature = "";

    function syncSwarmMembers() {
      const list = state.members;
      const sig = list.map((m) => `${m.id}:${m.role}`).join("|");
      if (sig === swarmSignature) return;
      swarmSignature = sig;
      memberMeshes.forEach((m) => {
        swarmG.remove(m.obj, m.link);
        m.obj.material.dispose();
        if (m.obj.geometry && m.disposeGeo) m.obj.geometry.dispose();
        m.link.material.dispose();
        m.linkGeo.dispose();
      });
      memberMeshes.clear();
      list.forEach((d, k) => {
        let obj;
        let disposeGeo = false;
        if (d.role === "verifier") {
          obj = new T.Mesh(
            new T.RingGeometry(0.055, 0.082, 32),
            new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, blending: ADD }),
          );
          disposeGeo = true;
        } else {
          obj = new T.Sprite(
            new T.SpriteMaterial({ map: dot, color: 0xffffff, transparent: true, opacity: 0, blending: ADD, depthWrite: false }),
          );
        }
        const linkGeo = new T.BufferGeometry();
        linkGeo.setAttribute("position", new T.BufferAttribute(new Float32Array(6), 3));
        const link = new T.Line(linkGeo, new T.LineBasicMaterial({ color: 0x9ba1a6, transparent: true, opacity: 0, depthWrite: false }));
        swarmG.add(link, obj);
        memberMeshes.set(d.id, {
          obj,
          disposeGeo,
          link,
          linkGeo,
          role: d.role,
          a0: (k / Math.max(1, list.length)) * Math.PI * 2 + 0.5,
          pos: new T.Vector3(),
          heat: 0,
        });
      });
    }

    const schedG = new T.Group();
    world.add(schedG);
    const schedRingGeo = new T.BufferGeometry();
    const schedRingMat = new T.LineBasicMaterial({ color: 0x9ba1a6, transparent: true, opacity: 0, depthWrite: false });
    schedG.add(new T.Line(schedRingGeo, schedRingMat));
    const schedDots = [];
    for (let k = 0; k < 6; k++) {
      const spr = new T.Sprite(
        new T.SpriteMaterial({ map: dot, color: 0xd9dde0, transparent: true, opacity: 0, blending: ADD, depthWrite: false }),
      );
      schedG.add(spr);
      schedDots.push({ spr, k, a0: k * 1.1 + 0.6, w: 0.14 + (k % 3) * 0.03 });
    }

    function rebuildSchedRing() {
      const pts = [];
      for (let k = 0; k <= 96; k++) {
        const a = (k / 96) * Math.PI * 2;
        pts.push(new T.Vector3(P[3].x + Math.cos(a) * 0.95, P[3].y - 0.02, P[3].z + Math.sin(a) * 0.95));
      }
      schedRingGeo.setFromPoints(pts);
    }
    rebuildSchedRing();

    const lanesG = new T.Group();
    world.add(lanesG);
    const lanes = [-0.34, 0, 0.34].map((dx, k) => {
      const geo = new T.BufferGeometry();
      const lm = new T.LineBasicMaterial({ color: accent.clone(), transparent: true, opacity: 0, depthWrite: false });
      const spr = new T.Sprite(
        new T.SpriteMaterial({ map: dot, color: accent.clone(), transparent: true, opacity: 0, blending: ADD, depthWrite: false }),
      );
      spr.scale.set(0.16, 0.16, 1);
      lanesG.add(new T.Line(geo, lm), spr);
      return { dx, geo, a: new T.Vector3(), b: new T.Vector3(), lm, spr, ph: k * 0.33 };
    });
    let lanesHeat = 0;

    function rebuildLanes() {
      lanes.forEach((ln) => {
        ln.a.set(P[2].x + ln.dx, P[2].y - 0.05, P[2].z - 1.05);
        ln.b.set(P[2].x, P[2].y - 0.05, P[2].z + 0.3);
        ln.geo.setFromPoints([ln.a, ln.b]);
      });
    }
    rebuildLanes();

    const HN = 140;
    const helixGeo = new T.BufferGeometry();
    const helixMat = new T.LineBasicMaterial({ color: accent.clone(), transparent: true, opacity: 0, depthWrite: false });
    const helixDot = new T.Sprite(
      new T.SpriteMaterial({ map: dot, color: accent.clone(), transparent: true, opacity: 0, blending: ADD, depthWrite: false }),
    );
    helixDot.scale.set(0.16, 0.16, 1);
    world.add(new T.Line(helixGeo, helixMat), helixDot);
    let helixPts = [];
    let helixHeat = 0;

    function rebuildHelix() {
      const anchor = P[Math.max(0, Math.min(3, state.focalIdx))] || P[1];
      helixPts = [];
      for (let k = 0; k <= HN; k++) {
        const u = k / HN;
        const a = u * Math.PI * 2 * 2.5;
        helixPts.push(new T.Vector3(anchor.x + Math.cos(a) * 0.2, anchor.y - 0.14 - u * 0.48, anchor.z + Math.sin(a) * 0.2));
      }
      helixGeo.setFromPoints(helixPts);
    }
    rebuildHelix();

    const forks = [];
    function spawnFork() {
      const origin = P[Math.max(0, Math.min(3, state.focalIdx))] || P[1];
      const curveFork = new T.CatmullRomCurve3([
        origin.clone(),
        origin.clone().add(new T.Vector3(0.35, 0.42, 0.25)),
        origin.clone().add(new T.Vector3(0.95, 0.85, 0.1)),
        origin.clone().add(new T.Vector3(1.55, 1.05, -0.3)),
      ]);
      const fpts = curveFork.getPoints(60);
      const g = new T.BufferGeometry().setFromPoints(fpts);
      const cols = new Float32Array(61 * 3);
      g.setAttribute("color", new T.BufferAttribute(cols, 3));
      const line = new T.Line(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: ADD, depthWrite: false }));
      const spr = new T.Sprite(new T.SpriteMaterial({ map: dot, color: 0xffffff, transparent: true, blending: ADD, depthWrite: false }));
      spr.scale.set(0.16, 0.16, 1);
      world.add(line, spr);
      forks.push({ line, g, cols, spr, pts: fpts, born: t });
    }

    const artGroup = new T.Group();
    world.add(artGroup);
    const octEdges = new T.EdgesGeometry(new T.OctahedronGeometry(0.1, 0));
    let arts = [];
    let artSignature = "";

    function rebuildArtifacts(force = false) {
      const sig = state.artifacts.map((a) => `${a.key}:${a.stageIdx}:${a.status}`).join("|");
      if (!force && sig === artSignature) return;
      artSignature = sig;
      arts.forEach((d) => {
        artGroup.remove(d.teth, d.glow, d.m);
        d.m.material.dispose();
        d.glow.material.dispose();
        d.teth.material.dispose();
        d.teth.geometry.dispose();
      });
      arts = state.artifacts.map((d, n) => {
        const col =
          d.status === "stale"
            ? COLORS.stale
            : d.status === "updating"
              ? accent
              : d.status === "merged"
                ? COLORS.done
                : COLORS.white;
        const m = new T.LineSegments(
          octEdges,
          new T.LineBasicMaterial({ color: col.clone(), transparent: true, opacity: 0.9, depthWrite: false }),
        );
        const anchor = P[d.stageIdx] || P[1];
        const base = anchor.clone().add(new T.Vector3(d.dx, 0.96, 0));
        m.position.copy(base);
        const glow = new T.Sprite(
          new T.SpriteMaterial({ map: dot, color: col.clone(), transparent: true, opacity: 0.16, blending: ADD, depthWrite: false }),
        );
        glow.scale.set(0.5, 0.5, 1);
        glow.position.copy(base);
        const tethGeo = new T.BufferGeometry().setFromPoints([
          anchor.clone().add(new T.Vector3(0, 0.24, 0)),
          base.clone().add(new T.Vector3(0, -0.12, 0)),
        ]);
        const teth = new T.Line(tethGeo, new T.LineBasicMaterial({ color: col.clone(), transparent: true, opacity: 0.2, depthWrite: false }));
        artGroup.add(teth, glow, m);
        return { key: d.key, stage: STAGE_IDS[d.stageIdx], status: d.status, m, glow, teth, base, ph: n * 1.3, heat: 0 };
      });
    }

    const DN = 220;
    const dp = new Float32Array(DN * 3);
    for (let i = 0; i < DN; i++) {
      dp[i * 3] = (Math.random() - 0.5) * 16;
      dp[i * 3 + 1] = -2.6 + Math.random() * 5.6;
      dp[i * 3 + 2] = -7 + Math.random() * 9;
    }
    const dGeo = new T.BufferGeometry();
    dGeo.setAttribute("position", new T.BufferAttribute(dp, 3));
    const dust = new T.Points(
      dGeo,
      new T.PointsMaterial({ size: 0.16, map: dot, color: 0x8a9099, transparent: true, opacity: 0.45, blending: ADD, depthWrite: false }),
    );
    scene.add(dust);

    let io = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver((es) => {
        inView = es.length ? es[es.length - 1].isIntersecting : true;
      });
      io.observe(canvasEl);
    }

    let firstAgentSync = true;
    function syncAgents() {
      const live = new Map();
      state.agents.forEach((a) => live.set(a.id, a));
      live.forEach((a, id) => {
        const sIdx = Math.max(0, STAGE_IDS.indexOf(a.stageId || "build"));
        let p = particles.get(id);
        if (!p && a.status === "running") {
          p = spawnParticle(firstAgentSync ? t - 10 : t, sIdx);
          particles.set(id, p);
        }
        if (p && a.status !== "running" && p.death < 0) p.death = t;
      });
      particles.forEach((p, id) => {
        if (!live.has(id) && p.death < 0) p.death = t;
      });
      firstAgentSync = false;
    }

    function retireParticle(p, id) {
      agentGroup.remove(p.spr, p.line);
      p.spr.material.dispose();
      p.line.material.dispose();
      p.tg.dispose();
      particles.delete(id);
      flash(1, p.stageIdx);
    }

    function recolorAll() {
      nodes.forEach((nd, i) => {
        nd.status = state.stages[i].status;
        const col = statusColor(nd.status);
        nd.core.material.color.copy(col);
        nd.ring.material.color.copy(col);
        nd.halo.material.color.copy(col);
        nd.pulses.forEach((p) => p.m.material.color.copy(col));
      });
      arcMat.color.copy(accent);
      loopHead.material.color.copy(accent);
      helixMat.color.copy(accent);
      helixDot.material.color.copy(accent);
      lanes.forEach((ln) => {
        ln.lm.color.copy(accent);
        ln.spr.material.color.copy(accent);
      });
      arts.forEach((d) => {
        if (d.status === "updating") {
          d.m.material.color.copy(accent);
          d.glow.material.color.copy(accent);
          d.teth.material.color.copy(accent);
        }
      });
      buildSpineAndStream();
    }

    function getFocus() {
      const key = hl.cmd || state.solo;
      return key ? FOCUS_MAP[key] || null : null;
    }

    const clock = new T.Clock();
    let raf = 0;

    function loop() {
      if (dead) return;
      raf = requestAnimationFrame(loop);
      if (document.hidden || !inView) {
        clock.getDelta();
        return;
      }
      const motion = reducedMotion ? 0.25 : 1;
      const dt = Math.min(clock.getDelta(), 0.05) * motion;
      t += dt;

      const focus = getFocus();
      const em = (layer) => (!focus ? 1 : focus.indexOf(layer) >= 0 ? 1 : 0.2);

      world.rotation.y += ((ptr.x * 0.07 + Math.sin(t * 0.15) * 0.03) - world.rotation.y) * 0.05;
      world.rotation.x += ((ptr.y * 0.03) - world.rotation.x) * 0.05;

      const hs = hl.stage;
      nodes.forEach((nd) => {
        const target = hs ? (hs === nd.id ? 1 : -1) : 0;
        nd.hl += (target - nd.hl) * 0.12;
        const isActive = nd.status === "active" || nd.status === "next";
        const isWarn = nd.status === "stale" || nd.status === "waiting_gate" || nd.status === "error";
        const breathe = isActive ? 0.12 * Math.sin(t * 2.4) : isWarn ? 0.08 * Math.sin(t * 1.3) : 0;
        const s = 1 + Math.max(0, nd.hl) * 0.5 + breathe;
        nd.halo.scale.set(s, s, 1);
        nd.halo.material.opacity = (isActive ? 0.45 : 0.28) * (1 + nd.hl * 0.6);
        nd.ring.material.opacity = 0.6 * (nd.hl < 0 ? 1 + nd.hl * 0.5 : 1);
        nd.ring.lookAt(camera.position);
        nd.pulses.forEach((p) => {
          if (nd.status === "active" && !state.goalActive) {
            const k = ((t + p.off) % 2.4) / 2.4;
            const ps = 1 + k * 1.9;
            p.m.scale.set(ps, ps, ps);
            p.m.material.opacity = 0.45 * (1 - k);
            p.m.lookAt(camera.position);
          } else {
            p.m.material.opacity = 0;
          }
        });
      });

      const showGoal = state.goalActive || (focus && focus.indexOf("goal") >= 0);
      if (showGoal) {
        if (state.goalTarget > lastGoal + 0.01) flash(1.2, 1);
        lastGoal = state.goalTarget;
        loopProg += (state.goalTarget - loopProg) * 0.04;
        const cnt = Math.max(2, Math.min(LSEG + 1, Math.round(loopProg * LSEG) + 1));
        arcGeo.setDrawRange(0, cnt);
        loopHead.position.copy(loopPts[cnt - 1]);
        loopG.lookAt(camera.position);
        const eg = em("goal");
        arcMat.opacity = 0.95 * eg;
        trackMat.opacity = 0.16 * eg;
        loopHead.material.opacity = (0.75 + 0.25 * Math.sin(t * 3)) * eg;
      } else {
        arcMat.opacity = 0;
        trackMat.opacity = 0;
        loopHead.material.opacity = 0;
      }

      streamFrame(focus ? 0.45 : 1);

      syncAgents();
      tint.copy(accent).lerp(COLORS.white, 0.55);
      const eSub = em("subagents");
      particles.forEach((p, id) => {
        let rs = Math.min(1, (t - p.birth) / 0.9);
        rs = 1 - Math.pow(1 - rs, 3);
        let alive = 1;
        if (p.death >= 0) {
          const k = (t - p.death) / 0.7;
          if (k >= 1) {
            retireParticle(p, id);
            return;
          }
          rs *= 1 - k * k;
          alive = 1 - k * 0.5;
        }
        const center = P[p.stageIdx] || P[1];
        const a = p.ph + t * p.w;
        v3.set(Math.cos(a) * p.R * rs, 0, Math.sin(a) * p.R * rs).applyQuaternion(p.q).add(center);
        p.spr.position.copy(v3);
        const hot = hl.agent === id ? 1 : 0;
        p.heat += (hot - p.heat) * 0.15;
        const ss = 0.22 + p.heat * 0.22;
        p.spr.scale.set(ss, ss, 1);
        cB.copy(tint).lerp(COLORS.white, p.heat * 0.6);
        p.spr.material.color.copy(cB);
        p.spr.material.opacity = alive * eSub;
        if (!p.filled) {
          for (let k = 0; k < TR; k++) {
            p.tp[k * 3] = v3.x;
            p.tp[k * 3 + 1] = v3.y;
            p.tp[k * 3 + 2] = v3.z;
          }
          p.filled = true;
        } else {
          p.tp.copyWithin(3, 0, (TR - 1) * 3);
          p.tp[0] = v3.x;
          p.tp[1] = v3.y;
          p.tp[2] = v3.z;
        }
        for (let k = 0; k < TR; k++) {
          const f = Math.pow(1 - k / TR, 1.6) * (0.55 + p.heat * 0.4) * alive * eSub;
          p.tc[k * 3] = cB.r * f;
          p.tc[k * 3 + 1] = cB.g * f;
          p.tc[k * 3 + 2] = cB.b * f;
        }
        p.tg.attributes.position.needsUpdate = true;
        p.tg.attributes.color.needsUpdate = true;
      });

      for (let i = flashes.length - 1; i >= 0; i--) {
        const fl = flashes[i];
        const k = (t - fl.born) / 0.9;
        if (k >= 1 || flashes.length > 8) {
          fl.m.parent?.remove(fl.m);
          fl.m.material.dispose();
          flashes.splice(i, 1);
          continue;
        }
        const fs = 1 + k * 3.2;
        fl.m.scale.set(fs, fs, fs);
        fl.m.material.opacity = 0.7 * fl.k0 * (1 - k) * (1 - k);
        fl.m.lookAt(camera.position);
      }

      const showSwarm = state.swarmActive || (focus && focus.indexOf("swarm") >= 0);
      const eSw = showSwarm ? em("swarm") : 0;
      const statusMap = new Map(state.members.map((m) => [m.id, m.status]));
      boardMat.opacity = 0.07 * eSw;
      memberMeshes.forEach((m, id) => {
        const a = m.a0 + t * 0.08;
        m.pos.set(P[1].x + Math.cos(a) * SR, P[1].y + 0.05, P[1].z + Math.sin(a) * SR);
        const active = statusMap.get(id) === "working";
        const hot = hl.member === id ? 1 : 0;
        m.heat += (hot - m.heat) * 0.15;
        m.obj.position.copy(m.pos);
        if (m.role === "verifier") {
          m.obj.lookAt(camera.position);
          const vs = 1 + m.heat * 0.8 + (active ? 0.15 * Math.sin(t * 4) : 0);
          m.obj.scale.set(vs, vs, vs);
          m.obj.material.color.copy(active ? tint : COLORS.grey);
          m.obj.material.opacity = (active ? 0.95 : 0.5) * eSw;
        } else {
          const ms = (m.role === "monitor" ? 0.1 : active ? 0.21 : 0.13) + m.heat * 0.18;
          m.obj.scale.set(ms, ms, 1);
          m.obj.material.color.copy(active ? tint : COLORS.grey);
          m.obj.material.opacity = (active ? 1 : 0.5) * eSw;
        }
        const lp = m.linkGeo.attributes.position.array;
        lp[0] = P[1].x;
        lp[1] = P[1].y;
        lp[2] = P[1].z;
        lp[3] = m.pos.x;
        lp[4] = m.pos.y;
        lp[5] = m.pos.z;
        m.linkGeo.attributes.position.needsUpdate = true;
        m.link.material.opacity = ((active ? 0.22 : 0.07) + m.heat * 0.25) * eSw;
      });
      while (sparkQ.length) {
        const sq = sparkQ.shift();
        const spr = new T.Sprite(
          new T.SpriteMaterial({ map: dot, color: 0xffffff, transparent: true, blending: ADD, depthWrite: false }),
        );
        spr.scale.set(0.13, 0.13, 1);
        swarmG.add(spr);
        sparks.push({ spr, from: sq.from, to: sq.to, born: t });
      }
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s2 = sparks[i];
        const k = (t - s2.born) / 1.3;
        if (k >= 1 || sparks.length > 10) {
          swarmG.remove(s2.spr);
          s2.spr.material.dispose();
          sparks.splice(i, 1);
          continue;
        }
        const from = s2.from === "coord" || !memberMeshes.has(s2.from) ? P[1] : memberMeshes.get(s2.from).pos;
        const to = s2.to === "coord" || !memberMeshes.has(s2.to) ? null : memberMeshes.get(s2.to).pos;
        if (!to) v3.copy(from).lerp(P[1], k);
        else if (k < 0.5) v3.copy(from).lerp(P[1], k * 2);
        else v3.copy(P[1]).lerp(to, (k - 0.5) * 2);
        s2.spr.position.copy(v3);
        s2.spr.material.opacity = Math.sin(Math.PI * k) * eSw;
      }

      const showSched = state.schedCount > 0 || (focus && focus.indexOf("sched") >= 0);
      const eSc = showSched ? em("sched") : 0;
      schedRingMat.opacity = 0.13 * eSc;
      const visibleDots = state.schedCount > 0 ? Math.min(schedDots.length, state.schedCount) : focus && focus.indexOf("sched") >= 0 ? 1 : 0;
      const pulseK = pulseAt ? (performance.now() - pulseAt) / 1600 : 9;
      schedDots.forEach((d, idx) => {
        if (idx >= visibleDots) {
          d.spr.material.opacity = 0;
          return;
        }
        const a = d.a0 + t * d.w;
        d.spr.position.set(P[3].x + Math.cos(a) * 0.95, P[3].y - 0.02, P[3].z + Math.sin(a) * 0.95);
        let s = idx === 1 ? 0.2 : 0.16;
        let o = idx === 1 ? 0.75 : 0.8 + 0.2 * Math.sin(t * 1.7);
        if (idx === 0 && pulseK < 1) {
          s += 0.35 * (1 - pulseK);
          o = 1;
        }
        d.spr.scale.set(s, s, 1);
        d.spr.material.opacity = o * eSc;
      });

      const lf = state.workflowActive || (focus && focus.indexOf("lanes") >= 0) ? 1 : 0;
      lanesHeat += (lf - lanesHeat) * 0.1;
      lanes.forEach((ln) => {
        ln.lm.opacity = 0.55 * lanesHeat;
        const k = (t * 0.5 + ln.ph) % 1;
        ln.spr.position.copy(ln.a).lerp(ln.b, k);
        ln.spr.material.opacity = lanesHeat * Math.sin(Math.PI * k);
      });

      const hf = state.boostActive || (focus && focus.indexOf("helix") >= 0) ? 1 : 0;
      helixHeat += (hf - helixHeat) * 0.1;
      helixMat.opacity = 0.55 * helixHeat;
      if (helixPts.length > 0) {
        helixDot.position.copy(helixPts[Math.floor(((t * 0.4) % 1) * HN)]);
        helixDot.material.opacity = helixHeat;
      }

      for (let i = forks.length - 1; i >= 0; i--) {
        const fk = forks[i];
        const age = t - fk.born;
        if (age > 4.2) {
          world.remove(fk.line, fk.spr);
          fk.line.material.dispose();
          fk.spr.material.dispose();
          fk.g.dispose();
          forks.splice(i, 1);
          continue;
        }
        const travel = Math.min(1, age / 1.6);
        const head = Math.floor(travel * 60);
        const fade = Math.max(0, Math.min(1, 1 - (age - 1.6) / 2.4));
        for (let j = 0; j <= 60; j++) {
          const on = j <= head && Math.floor(j / 3) % 2 === 0;
          const b = on ? 0.6 * fade : 0;
          fk.cols[j * 3] = b;
          fk.cols[j * 3 + 1] = b;
          fk.cols[j * 3 + 2] = b;
        }
        fk.g.attributes.color.needsUpdate = true;
        fk.spr.position.copy(fk.pts[head]);
        fk.spr.material.opacity = travel < 1 ? 1 : fade;
      }

      const eArt = focus ? (focus.indexOf("art") >= 0 ? 1 : 0.4) : 1;
      arts.forEach((d) => {
        const hot = hl.art === d.key || hl.stage === d.stage || (focus && focus.indexOf("art") >= 0) ? 1 : 0;
        d.heat += (hot - d.heat) * 0.15;
        d.m.rotation.x = 0.35;
        d.m.rotation.y = t * 0.7 + d.ph;
        d.m.position.set(d.base.x, d.base.y + Math.sin(t * 1.1 + d.ph) * 0.04, d.base.z);
        d.glow.position.copy(d.m.position);
        const ds = 1 + d.heat * 0.7;
        d.m.scale.set(ds, ds, ds);
        const pul = d.status === "updating" ? 0.5 + 0.5 * Math.sin(t * 3) : 1;
        d.m.material.opacity = (0.55 + 0.35 * pul) * eArt;
        d.teth.material.opacity = 0.2 * eArt;
        d.glow.material.opacity = (0.14 + d.heat * 0.35 + (d.status === "updating" ? 0.15 * pul : 0)) * eArt;
        const gs = 0.5 + d.heat * 0.4;
        d.glow.scale.set(gs, gs, 1);
      });

      for (let i = 0; i < DN; i++) {
        let y = dp[i * 3 + 1] + dt * 0.06;
        if (y > 3) y = -2.6;
        dp[i * 3 + 1] = y;
      }
      dGeo.attributes.position.needsUpdate = true;

      renderer.render(scene, camera);
    }

    function resize() {
      if (dead || !parent) return;
      const nextW = Math.max(260, parent.clientWidth || 600);
      const nextH = parent.clientHeight || 164;
      if (nextW === width && nextH === height) return;
      width = nextW;
      height = nextH;
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      P = projectStagePositions();
      nodes.forEach((nd, i) => nd.g.position.copy(P[i]));
      buildSpineAndStream();
      rebuildBoardRing();
      rebuildSchedRing();
      rebuildLanes();
      rebuildHelix();
      rebuildArtifacts(true);
    }

    let ro = null;
    if ("ResizeObserver" in window && parent) {
      ro = new ResizeObserver(resize);
      ro.observe(parent);
    }

    loop();

    return {
      updateState(snap) {
        if (dead || !snap) return;
        const stages = snap.stages || [];
        STAGE_IDS.forEach((id, idx) => {
          const found = stages.find((s) => s.id === id);
          state.stages[idx].status = found ? found.status : "pending";
        });
        const act = snap.activity || {};
        state.focalIdx = Math.max(0, STAGE_IDS.indexOf(act.activeStageId || "plan"));
        state.agents = Array.isArray(act.subagents) ? act.subagents : [];
        state.swarmActive = Boolean(act.swarm?.active);
        state.members = Array.isArray(act.swarm?.members) ? act.swarm.members : [];
        const posts = Number(act.swarm?.posts || 0);
        if (lastPosts >= 0 && posts > lastPosts && state.members.length > 0) {
          const workers = state.members.filter((m) => m.role === "worker");
          const fromId = workers[0]?.id || state.members[0]?.id || "coord";
          const verifier = state.members.find((m) => m.role === "verifier");
          sparkQ.push({ from: fromId, to: verifier ? verifier.id : "coord" });
          if (sparkQ.length > 6) sparkQ.shift();
        }
        lastPosts = posts;
        state.swarmPosts = posts;
        state.goalActive = Boolean(act.goal?.active || act.teamwork?.active);
        const totalChecks = Math.max(1, Number(act.goal?.checksTotal || 3));
        const doneChecks = Number(act.goal?.checksDone || 0);
        state.goalTarget = state.goalActive ? Math.max(0.12, doneChecks / totalChecks) : 0;
        state.boostActive = Boolean(act.boost?.active);
        state.workflowActive = Boolean(act.workflow?.active);
        state.schedCount = Number(act.scheduledCount || 0);

        const nextArts = [];
        stages.forEach((stg, sIdx) => {
          const list = Array.isArray(stg.artifacts) ? stg.artifacts : [];
          list.forEach((a, k) => {
            const dx = list.length === 1 ? 0 : (k - (list.length - 1) / 2) * 0.36;
            nextArts.push({ key: a.key || a.id, stageIdx: sIdx, dx, status: a.status || "done" });
          });
        });
        state.artifacts = nextArts;

        recolorAll();
        rebuildHelix();
        syncSwarmMembers();
        rebuildArtifacts(false);
      },
      setHighlight(kind, value) {
        if (kind in hl) hl[kind] = value || null;
      },
      setSolo(soloKey) {
        state.solo = soloKey || null;
      },
      setAccent(hex) {
        if (!hex || dead) return;
        try {
          accent.set(hex);
          recolorAll();
        } catch {
        }
      },
      spawnFork() {
        if (!dead) spawnFork();
      },
      pulseSchedule() {
        if (!dead) pulseAt = performance.now();
      },
      setPointer(nx, ny) {
        ptr.x = Number.isFinite(nx) ? nx : 0;
        ptr.y = Number.isFinite(ny) ? ny : 0;
      },
      resize,
      destroy() {
        dead = true;
        if (raf) cancelAnimationFrame(raf);
        if (io) io.disconnect();
        if (ro) ro.disconnect();
        octEdges.dispose();
        ringGeo.dispose();
        coreGeo.dispose();
        spineGeo.dispose();
        tubeMesh.geometry.dispose();
        haloMesh.geometry.dispose();
        sGeo.dispose();
        bGeo.dispose();
        boardGeo.dispose();
        schedRingGeo.dispose();
        helixGeo.dispose();
        dGeo.dispose();
        dot.dispose();
        try {
          renderer.dispose();
        } catch {
        }
      },
    };
  }

  window.AStackScene3D = { create };
})();
