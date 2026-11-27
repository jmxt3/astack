import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { createTimelineServer, startTimelineSidecar } from "./main.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_PATH = path.join(__dirname, "main.mjs");

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("main.mjs --help and -h exit 0 with Usage text and zero module warnings", () => {
  for (const flag of ["--help", "-h"]) {
    const res = spawnSync(process.execPath, [MAIN_PATH, flag], { encoding: "utf8" });
    assert.equal(res.status, 0, `${flag} failed: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /MODULE_TYPELESS_PACKAGE_JSON/);
    assert.match(res.stdout, /usage:/i);
  }
});

test("createTimelineServer serves static assets, ETag caching, traversal rejection, token auth, and live updates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-srv-"));
  const brainDir = path.join(root, "brain");
  const workspaceDir = path.join(root, "repo");
  const convId = "11111111-2222-3333-4444-555555555555";
  const headSha = "0123456789abcdef0123456789abcdef01234567";

  writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  writeText(path.join(workspaceDir, ".git", "HEAD"), `${headSha}\n`);
  writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: "2026-11-20T12:00:00Z",
      content: "<USER_REQUEST>/plan build feature</USER_REQUEST>",
    })}\n`,
  );

  const srv = await createTimelineServer({
    brainDir,
    workspaceDir,
    token: "secret-token",
    port: 0,
  });

  try {
    const htmlRes = await fetch(`${srv.url}`);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
    const htmlText = await htmlRes.text();
    assert.match(htmlText, /AStack Timeline/);
    assert.match(htmlText, /data-testid="cmd-popover"/);
    assert.match(htmlText, /data-testid="timeline-footer"/);
    assert.match(htmlText, /data-testid="timeline-setup"/);
    assert.match(htmlText, /data-testid="timeline-setup-drawer"/);
    assert.match(htmlText, /id="living-rail"/);
    assert.match(htmlText, /class="timeline-wrap"/);
    assert.match(htmlText, /data-testid="rail-announcer"/);
    assert.match(htmlText, /data-testid="focus-strip"/);
    assert.match(htmlText, /data-testid="focus-artifacts"/);
    assert.match(htmlText, /data-testid="btw-form"/);
    assert.match(htmlText, /data-testid="delegate-view"/);
    assert.match(htmlText, /data-testid="dossier-view"/);
    assert.match(htmlText, /data-testid="audit-view"/);
    assert.match(htmlText, /data-testid="artifact-view"/);
    assert.doesNotMatch(htmlText, /id="next-bar"|data-testid="timeline-next"|data-testid="timeline-scene"|id="scene-section"/);

    const logoRes = await fetch(`${srv.url}logo.svg`);
    assert.equal(logoRes.status, 200);
    assert.match(logoRes.headers.get("content-type") ?? "", /image\/svg\+xml/);
    const logoText = await logoRes.text();
    assert.match(logoText, /astack app icon \(dark\)/);

    const cssRes = await fetch(`${srv.url}styles.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/);
    const cssText = await cssRes.text();
    assert.match(cssText, /--tl-done:/);
    assert.match(cssText, /\.setup-card\b/);
    assert.match(cssText, /\.living-rail\b/);
    assert.match(cssText, /\.stage-stats\b/);
    assert.match(cssText, /\.chip-active-dot\b/);
    assert.doesNotMatch(cssText, /\.scene-next\b|\.scene-section\b/);

    const jsRes = await fetch(`${srv.url}app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("content-type") ?? "", /javascript/);
    const jsText = await jsRes.text();
    assert.match(jsText, /chip-active-dot/);
    assert.match(jsText, /showStatusPopover/);
    assert.match(jsText, /open-dossier-view/);
    assert.match(jsText, /open-audit-view/);
    assert.match(jsText, /is-internal/);
    assert.match(jsText, /not a slash command/);
    assert.doesNotMatch(jsText, /getElementById\("next-bar"\)/);

    const railRes = await fetch(`${srv.url}living-rail.js`);
    assert.equal(railRes.status, 200);
    assert.match(railRes.headers.get("content-type") ?? "", /javascript/);
    assert.match(await railRes.text(), /window\.createLivingRail/);

    const threeRes = await fetch(`${srv.url}vendor/three.min.js`);
    assert.equal(threeRes.status, 404);

    const sceneRes = await fetch(`${srv.url}scene-3d.js`);
    assert.equal(sceneRes.status, 404);

    const catalogRes = await fetch(`${srv.url}catalog.js`);
    assert.equal(catalogRes.status, 200);
    assert.match(catalogRes.headers.get("content-type") ?? "", /javascript/);
    const catalogText = await catalogRes.text();
    assert.match(catalogText, /window\.ASTACK_CATALOG\s*=/);
    assert.match(catalogText, /watch-pr\.mjs/);
    assert.match(catalogText, /pr-dossier\.mjs/);
    assert.match(catalogText, /\/astack-mode babysit/);
    assert.match(catalogText, /\/astack-mode release-and-postmortem/);
    assert.doesNotMatch(catalogText, /Not wired yet/);

    const preloadRes = await fetch(`${srv.url}preload.js`);
    assert.equal(preloadRes.status, 200);
    const preloadText = await preloadRes.text();
    assert.match(preloadText, /window\.sidecar/);
    assert.match(preloadText, /getWorkspaceUris/);

    const unauth = await fetch(`${srv.url}api/timeline?conversationId=${convId}`);
    assert.equal(unauth.status, 401);

    const headers = { "x-sidecar-token": "secret-token" };
    const badConv = await fetch(`${srv.url}api/timeline?conversationId=../escape`, { headers });
    assert.equal(badConv.status, 400);

    const badMethod = await fetch(`${srv.url}api/timeline?conversationId=${convId}`, {
      method: "POST",
      headers,
    });
    assert.equal(badMethod.status, 405);

    const firstRes = await fetch(`${srv.url}api/timeline?conversationId=${convId}`, { headers });
    assert.equal(firstRes.status, 200);
    const first = await firstRes.json();
    assert.equal(first.stages.length, 4);
    assert.equal(first.setup.status, "ready");
    assert.ok(first.activity && typeof first.activity.agentsWorkingCount === "number");
    assert.ok(Array.isArray(first.setup.autoSubCommands) && first.setup.autoSubCommands.length > 0);
    assert.ok(Array.isArray(first.setup.moreCommands) && first.setup.moreCommands.length > 0);
    for (const st of first.stages) {
      assert.ok(typeof st.collapsedSummary === "string" && st.collapsedSummary.length > 0);
      assert.ok(Array.isArray(st.artifacts));
      assert.ok(Array.isArray(st.autoSubCommands) && st.autoSubCommands.length > 0);
      assert.ok(Array.isArray(st.moreCommands) && st.moreCommands.length > 0);
    }
    const secAudit = first.stages[2].moreCommands.find((c) => c.command === "/security-audit");
    assert.equal(secAudit?.copyText, "/security-audit");
    assert.equal(first.stages[0].status, "waiting_gate");
    assert.equal(first.nextAction.command, "Proceed");
    assert.ok(first.etag);

    const cachedRes = await fetch(`${srv.url}api/timeline?conversationId=${convId}&etag=${first.etag}`, { headers });
    assert.equal(cachedRes.status, 200);
    const cached = await cachedRes.json();
    assert.equal(cached.unchanged, true);
    assert.equal(cached.etag, first.etag);

    fs.appendFileSync(
      path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
      `${JSON.stringify({
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T12:01:00Z",
        content: "approved",
      })}\n`,
      "utf8",
    );

    const nextRes = await fetch(`${srv.url}api/timeline?conversationId=${convId}&etag=${first.etag}`, { headers });
    assert.equal(nextRes.status, 200);
    const updated = await nextRes.json();
    assert.notEqual(updated.etag, first.etag);
    assert.equal(updated.stages[0].status, "done");
    assert.equal(updated.stages[1].status, "next");
    assert.equal(updated.nextAction.command, "/astack-mode");

    writeText(path.join(brainDir, convId, "diagram.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");

    const unauthArt = await fetch(`${srv.url}api/artifact?conversationId=${convId}&name=implementation_plan.md`);
    assert.equal(unauthArt.status, 401);

    const mdArtRes = await fetch(`${srv.url}api/artifact?conversationId=${convId}&name=implementation_plan.md`, { headers });
    assert.equal(mdArtRes.status, 200);
    const mdArt = await mdArtRes.json();
    assert.equal(mdArt.name, "implementation_plan.md");
    assert.equal(mdArt.kind, "markdown");
    assert.equal(mdArt.content, "# Plan\n");

    const rawMdRes = await fetch(`${srv.url}api/artifact?conversationId=${convId}&name=implementation_plan.md&raw=1`, { headers });
    assert.equal(rawMdRes.status, 200);
    assert.match(rawMdRes.headers.get("content-type") ?? "", /text\/markdown/);
    assert.equal(rawMdRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await rawMdRes.text(), "# Plan\n");

    const rawSvgRes = await fetch(`${srv.url}api/artifact?conversationId=${convId}&name=diagram.svg&raw=1`, { headers });
    assert.equal(rawSvgRes.status, 200);
    assert.match(rawSvgRes.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.equal(rawSvgRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(rawSvgRes.headers.get("content-security-policy"), "sandbox");

    const badConvArt = await fetch(`${srv.url}api/artifact?conversationId=not-a-uuid&name=implementation_plan.md`, { headers });
    assert.equal(badConvArt.status, 400);

    const traversalArt = await fetch(`${srv.url}api/artifact?conversationId=${convId}&name=..%2Ffoo.md`, { headers });
    assert.equal(traversalArt.status, 400);

    const disallowedExtArt = await fetch(`${srv.url}api/artifact?conversationId=${convId}&name=transcript.jsonl`, { headers });
    assert.equal(disallowedExtArt.status, 403);

    const missingArt = await fetch(`${srv.url}api/artifact?conversationId=${convId}&name=nonexistent.md`, { headers });
    assert.equal(missingArt.status, 404);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer resolves workspaceUri on idle conversations, rejects invalid paths, and preserves explicitWorkspace precedence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-ws-"));
  const brainDir = path.join(root, "brain");
  const configuredRepo = path.join(root, "configured");
  const unconfiguredRepo = path.join(root, "unconfigured");
  const notADirFile = path.join(root, "file.txt");

  writeText(path.join(configuredRepo, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  fs.mkdirSync(unconfiguredRepo, { recursive: true });
  fs.mkdirSync(brainDir, { recursive: true });
  writeText(notADirFile, "not a dir\n");

  const prevConvEnv = process.env.ANTIGRAVITY_CONVERSATION_ID;
  const prevWsEnv = process.env.ANTIGRAVITY_WORKSPACE_DIR;
  delete process.env.ANTIGRAVITY_CONVERSATION_ID;
  delete process.env.ANTIGRAVITY_WORKSPACE_DIR;

  const dynamicSrv = await createTimelineServer({ brainDir, conversationId: "", port: 0 });
  const pinnedSrv = await createTimelineServer({ brainDir, conversationId: "", workspaceDir: configuredRepo, port: 0 });

  try {
    const cfgUri = encodeURIComponent(pathToFileURL(configuredRepo).href);
    const uncfgUri = encodeURIComponent(pathToFileURL(unconfiguredRepo).href);
    const fileUri = encodeURIComponent(pathToFileURL(notADirFile).href);

    const cfgSnap = await (await fetch(`${dynamicSrv.url}api/timeline?workspaceUri=${cfgUri}`)).json();
    assert.equal(cfgSnap.hasConversation, false);
    assert.equal(cfgSnap.setup.status, "ready");
    assert.equal(cfgSnap.stages[0].status, "next");
    assert.equal(cfgSnap.nextAction.command, "/plan");

    const uncfgSnap = await (await fetch(`${dynamicSrv.url}api/timeline?workspaceUri=${uncfgUri}`)).json();
    assert.equal(uncfgSnap.setup.status, "needs_setup");
    assert.equal(uncfgSnap.nextAction.stageId, "setup");
    assert.equal(uncfgSnap.nextAction.command, "/setup-astack");

    const badUriSnap = await (await fetch(`${dynamicSrv.url}api/timeline?workspaceUri=${fileUri}`)).json();
    assert.equal(badUriSnap.setup.status, "unknown");
    assert.equal(badUriSnap.nextAction.command, "/plan");

    const relPathSnap = await (await fetch(`${dynamicSrv.url}api/timeline?workspaceUri=relative/path`)).json();
    assert.equal(relPathSnap.setup.status, "unknown");
    assert.equal(relPathSnap.nextAction.command, "/plan");

    for (const remoteTarget of ["file://evil.invalid/share", "\\\\evil.invalid\\share", "//evil.invalid/share"]) {
      const remoteSnap = await (
        await fetch(`${dynamicSrv.url}api/timeline?workspaceUri=${encodeURIComponent(remoteTarget)}`)
      ).json();
      assert.equal(remoteSnap.setup.status, "unknown");
      assert.equal(remoteSnap.workspace, null);
    }

    const pinnedSnap = await (await fetch(`${pinnedSrv.url}api/timeline?workspaceUri=${uncfgUri}`)).json();
    assert.equal(pinnedSnap.workspace, path.resolve(configuredRepo));
    assert.equal(pinnedSnap.setup.status, "ready");
  } finally {
    if (prevConvEnv !== undefined) process.env.ANTIGRAVITY_CONVERSATION_ID = prevConvEnv;
    if (prevWsEnv !== undefined) process.env.ANTIGRAVITY_WORKSPACE_DIR = prevWsEnv;
    await dynamicSrv.close();
    await pinnedSrv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function rawTcpHttpRequest(port, rawRequest) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(rawRequest));
    let raw = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      raw += chunk;
    });
    sock.on("end", () => resolve(raw));
    sock.on("error", reject);
  });
}

function requestHostStatus(port, reqPath, hostHeader) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "GET",
        headers: { Host: hostHeader },
      },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject);
    req.end();
  });
}

test("createTimelineServer blocks DNS rebinding Host headers, malformed request targets, and sidecar_sdk routes use POST", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-sec-"));
  const brainDir = path.join(root, "brain");
  const convId = "11111111-2222-3333-4444-555555555555";
  writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\nSafe\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>/plan ok</USER_REQUEST>" })}\n`,
  );

  const srv = await createTimelineServer({ brainDir, token: "sec-tok", port: 0 });
  try {
    const port = srv.port;
    const postTl = await fetch(`${srv.url}api/timeline`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sidecar-Token": "sec-tok" },
      body: JSON.stringify({ conversationId: convId }),
    });
    assert.equal(postTl.status, 405, "Standalone server remains strictly read-only GET/HEAD");

    assert.equal(await requestHostStatus(port, "/", `rebind.attacker.example:${port}`), 403);
    assert.equal(await requestHostStatus(port, "/preload.js", `127.0.0.1:${port + 1}`), 403);

    const malformedResp = await rawTcpHttpRequest(
      port,
      `GET http://a:b/ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`,
    );
    assert.match(malformedResp, /^HTTP\/1\.1 400 Bad Request/);

    const aliveAfter = await fetch(`${srv.url}api/timeline?conversationId=${convId}`, {
      headers: { "X-Sidecar-Token": "sec-tok" },
    });
    assert.equal(aliveAfter.status, 200);

    const routes = [];
    class MockResponse {
      constructor(body, opts = {}) {
        this.body = body;
        this.contentType = opts.contentType || "text/plain";
        this.status = opts.status || 200;
        this.headers = opts.headers;
      }
    }
    class MockSidecarApp {
      constructor() {
        this.config = { conversationId: convId };
      }
      page() {}
      api(routePath, handler, method) {
        routes.push({ routePath, handler, method });
      }
      async run() {}
    }

    const started = await startTimelineSidecar({
      brainDir,
      sdk: { SidecarApp: MockSidecarApp, Response: MockResponse },
    });
    assert.equal(started.mode, "sidecar_sdk");

    const tlRoute = routes.find((r) => r.routePath === "/api/timeline");
    const artRoute = routes.find((r) => r.routePath === "/api/artifact");
    assert.equal(tlRoute?.method, "POST");
    assert.equal(artRoute?.method, "POST");

    const tlResp = await tlRoute.handler({});
    assert.equal(tlResp.status, 200);
    assert.equal(JSON.parse(tlResp.body).conversationId, convId);

    const artResp = await artRoute.handler({ name: "implementation_plan.md" });
    assert.equal(artResp.status, 200);
    assert.equal(JSON.parse(artResp.body).kind, "markdown");
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --standalone generates an ephemeral token when ANTIGRAVITY_SIDECAR_UI_TOKEN is unset", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-cli-"));
  const brainDir = path.join(root, "brain");
  const convId = "conv-cli-check";
  writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>/plan ok</USER_REQUEST>" })}\n`,
  );

  const env = { ...process.env };
  delete env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
  const child = spawn(process.execPath, [MAIN_PATH, "--port", "0", "--standalone", "--allow-fixture-ids", "--brain-dir", brainDir], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const urlStr = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for startup banner: ${buf}`)), 5000);
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const m = buf.match(/listening at (http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]+)/i);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.stderr.on("data", (chunk) => {
        buf += chunk.toString("utf8");
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Exited early with ${code}: ${buf}`));
      });
    });

    const parsed = new URL(urlStr);
    const token = parsed.searchParams.get("token");
    assert.ok(token && token.length >= 32);

    const noTok = await fetch(`${parsed.origin}/api/timeline?conversationId=${convId}`);
    assert.equal(noTok.status, 401);

    const withHeader = await fetch(`${parsed.origin}/api/timeline?conversationId=${convId}`, {
      headers: { "X-Sidecar-Token": token },
    });
    assert.equal(withHeader.status, 200);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer reports nextAction.inProgress when /plan is active before implementation_plan.md", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-active-"));
  const brainDir = path.join(root, "brain");
  const workspaceDir = path.join(root, "repo");
  const convId = "22222222-3333-4444-5555-666666666666";

  writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      created_at: "2026-11-20T12:00:00Z",
      content: "<USER_REQUEST>/plan /astack-mode design auth</USER_REQUEST>",
    })}\n`,
  );

  const srv = await createTimelineServer({ brainDir, workspaceDir, port: 0 });
  try {
    const res = await fetch(`${srv.url}api/timeline?conversationId=${convId}`);
    assert.equal(res.status, 200);
    const snap = await res.json();
    assert.equal(snap.doneCount, 0);
    assert.equal(snap.stages[0].status, "active");
    assert.equal(snap.stages[0].commands.find((c) => c.command === "/plan")?.state, "active");
    assert.equal(snap.stages[1].status, "pending");
    assert.equal(snap.nextAction.stageId, "plan");
    assert.equal(snap.nextAction.inProgress, true);

    const [appRes, cssRes] = await Promise.all([
      fetch(`${srv.url}app.js`),
      fetch(`${srv.url}styles.css`),
    ]);
    assert.equal(appRes.status, 200);
    assert.equal(cssRes.status, 200);
    const [appJs, cssText] = await Promise.all([appRes.text(), cssRes.text()]);
    assert.doesNotMatch(appJs, /snap\.branch !== snap\.workspaceName/);
    assert.match(appJs, /timeline-risk-badge/);
    assert.match(appJs, /timeline-freshness/);
    assert.match(appJs, /build-stale-callout/);
    assert.match(appJs, /Critical risk/);
    assert.match(appJs, /focus-drawer-agents/);
    assert.match(appJs, /focus-drawer-prs/);
    assert.match(appJs, /focus-drawer-tasks/);
    assert.match(cssText, /\.living-rail\s*\{[^}]*top:\s*-32px/);
    assert.match(cssText, /\.pr-badge\.merged/);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer caches async PR status enrichment and returns open/merged PR KPI counts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-prs-"));
  const brainDir = path.join(root, "brain");
  const workspaceDir = path.join(root, "repo");
  const convId = "33333333-4444-5555-6666-777777777777";

  writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T11:00:00Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: 'gh pr create --title "PR A" --body "ok"' } }],
      }),
      JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        created_at: "2026-11-21T11:00:02Z",
        content: "https://github.com/acme/demo/pull/21\nhttps://github.com/acme/demo/pull/22\n",
      }),
    ].join("\n") + "\n",
  );

  let fetchCalls = 0;
  const srv = await createTimelineServer({
    brainDir,
    workspaceDir,
    port: 0,
    enableGhLookup: true,
    prStatusFetcher: async () => {
      fetchCalls += 1;
      return new Map([
        [21, { number: 21, title: "First PR", state: "merged", url: "https://github.com/acme/demo/pull/21" }],
        [22, { number: 22, title: "Second PR", state: "open", url: "https://github.com/acme/demo/pull/22" }],
      ]);
    },
  });

  try {
    const first = await (await fetch(`${srv.url}api/timeline?conversationId=${convId}`)).json();
    assert.equal(first.activity.artifactCount, 1);
    assert.equal(first.activity.prs.totalCount, 2);
    assert.equal(first.activity.prs.openCount, 1);
    assert.equal(first.activity.prs.mergedCount, 1);
    assert.equal(first.activity.prs.items[0].number, 22);
    assert.equal(first.activity.prs.items[0].state, "open");
    assert.equal(first.activity.prs.items[1].number, 21);
    assert.equal(first.activity.prs.items[1].state, "merged");
    assert.equal(fetchCalls, 1);

    const second = await (await fetch(`${srv.url}api/timeline?conversationId=${convId}`)).json();
    assert.equal(second.activity.prs.totalCount, 2);
    assert.equal(fetchCalls, 1, "PR status cache must avoid repeated gh calls inside TTL");
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer serves selectable task logs safely and exposes vertical scrollable drawers without truncation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-tasklog-"));
  const brainDir = path.join(root, "brain");
  const workspaceDir = path.join(root, "repo");
  const convId = "44444444-5555-6666-7777-888888888888";

  writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  writeText(path.join(brainDir, convId, ".system_generated", "tasks", "task-42.log"), "TAP version 13\nok 1 - suite passed\n");

  const srv = await createTimelineServer({ brainDir, workspaceDir, port: 0 });
  try {
    const okRes = await fetch(`${srv.url}api/artifact?conversationId=${convId}&taskLog=task-42.log`);
    assert.equal(okRes.status, 200);
    const payload = await okRes.json();
    assert.equal(payload.kind, "text");
    assert.match(payload.content, /ok 1 - suite passed/);

    const badRes = await fetch(`${srv.url}api/artifact?conversationId=${convId}&taskLog=../secret.txt`);
    assert.equal(badRes.status, 400);

    const missingRes = await fetch(`${srv.url}api/artifact?conversationId=${convId}&taskLog=task-999.log`);
    assert.equal(missingRes.status, 404);

    const [appJs, cssText, livingRailJs] = await Promise.all([
      (await fetch(`${srv.url}app.js`)).text(),
      (await fetch(`${srv.url}styles.css`)).text(),
      (await fetch(`${srv.url}living-rail.js`)).text(),
    ]);
    assert.match(appJs, /focus-drawer-artifacts/);
    assert.match(appJs, /openTaskLog\(/);
    assert.match(appJs, /PR Iteration/);
    assert.match(appJs, /"Earlier"/);
    assert.match(appJs, /"Optional"/);
    assert.doesNotMatch(appJs, /bgItems\.slice\(-8\)/);
    assert.match(cssText, /\.focus-drawer-list[\s\S]*overflow-y:\s*auto/);
    assert.match(cssText, /\.progress\.is-mode\b/);
    assert.match(cssText, /\.status-text\.skipped\s*\{\s*color:\s*var\(--tl-fg-faint\)/);
    assert.match(cssText, /\.subcmd-pill\.is-internal\b/);
    assert.match(cssText, /\.subcmd-tag\b/);
    assert.match(livingRailJs, /globalCompositeOperation\s*=\s*K\.blend/);
    assert.match(livingRailJs, /createLivingRail/);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/trust/settings enforces auth, method, size limits, enrollment, and updates Beast/Promotion/Ceiling/Promote/Undo in standalone and sidecar_sdk modes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-trust-"));
  const brainDir = path.join(root, "brain");
  const dataDir = path.join(root, "plugin-data");
  const enrolledRepo = path.join(root, "enrolled");
  const nonRepo = path.join(root, "non-repo");
  const convId = "55555555-6666-7777-8888-999999999999";

  fs.mkdirSync(enrolledRepo, { recursive: true });
  fs.mkdirSync(nonRepo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: enrolledRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: enrolledRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: enrolledRepo, stdio: "ignore" });
  writeText(path.join(enrolledRepo, ".agents", "risk-policy.json"), JSON.stringify({
    schemaVersion: 1,
    autonomy: { defaultCeiling: 2, ceilings: { ui: 3, docs: 3, governance: 2 } },
  }, null, 2));
  execFileSync("git", ["add", "."], { cwd: enrolledRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "enroll"], { cwd: enrolledRepo, stdio: "ignore" });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: enrolledRepo, encoding: "utf8" }).trim();
  writeText(path.join(brainDir, convId, "implementation_plan.md"), "# Plan\n");

  const srv = await createTimelineServer({
    brainDir,
    workspaceDir: enrolledRepo,
    conversationId: convId,
    token: "trust-tok",
    dataDir,
    port: 0,
  });
  const nonRepoSrv = await createTimelineServer({
    brainDir,
    workspaceDir: nonRepo,
    conversationId: convId,
    token: "trust-tok",
    dataDir,
    port: 0,
  });

  try {
    const authHeaders = { "Content-Type": "application/json", "X-Sidecar-Token": "trust-tok" };
    assert.equal((await fetch(`${srv.url}api/trust/settings`, { method: "POST", body: "{}" })).status, 401);
    assert.equal(
      (await fetch(`${srv.url}api/trust/settings`, {
        method: "POST",
        headers: { ...authHeaders, Origin: "https://evil.example" },
        body: JSON.stringify({ beastOn: true }),
      })).status,
      403,
    );
    assert.equal(
      (await fetch(`${srv.url}api/trust/settings`, {
        method: "POST",
        headers: { ...authHeaders, "Sec-Fetch-Site": "cross-site" },
        body: JSON.stringify({ beastOn: true }),
      })).status,
      403,
    );
    assert.equal(
      (await fetch(`${srv.url}api/trust/settings`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "X-Sidecar-Token": "trust-tok" },
        body: JSON.stringify({ beastOn: true }),
      })).status,
      415,
    );
    assert.equal(
      (await fetch(`${srv.url}api/trust/settings`, {
        method: "POST",
        headers: { ...authHeaders, Origin: `http://127.0.0.1:${srv.port}` },
        body: JSON.stringify({ beastOn: false, conversationId: convId }),
      })).status,
      200,
    );
    assert.equal((await fetch(`${srv.url}api/trust/settings`, { method: "GET", headers: authHeaders })).status, 405);
    assert.equal(
      (await fetch(`${srv.url}api/trust/settings`, { method: "POST", headers: authHeaders, body: "x".repeat(20_000) })).status,
      413,
    );
    assert.equal(
      (await fetch(`${nonRepoSrv.url}api/trust/settings`, { method: "POST", headers: authHeaders, body: JSON.stringify({ beastOn: true }) })).status,
      400,
    );

    const nonRepoSnap = await (await fetch(`${nonRepoSrv.url}api/timeline?conversationId=${convId}`, { headers: authHeaders })).json();
    assert.equal(nonRepoSnap.trust.scopeKind, "non_repo");
    assert.equal(nonRepoSnap.trust.enrolled, false);

    const beastRes = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ beastOn: true, conversationId: convId }),
    });
    assert.equal(beastRes.status, 200);
    assert.equal((await beastRes.json()).trust.beastOn, true);

    for (let i = 0; i < 5; i++) {
      const outRes = await fetch(`${srv.url}api/trust/settings`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          recordOutcome: { category: "ui", outcome: "clean", headSha, predictedR: 0.1 },
          conversationId: convId,
        }),
      });
      assert.equal(outRes.status, 200);
    }

    const beforePromoSnap = await (await fetch(`${srv.url}api/timeline?conversationId=${convId}`, { headers: authHeaders })).json();
    assert.equal(beforePromoSnap.trust.enrolled, true);
    assert.equal(beforePromoSnap.trust.promoBanner?.kind, "manual");
    assert.equal(beforePromoSnap.trust.promoBanner?.toLvl, 1);

    const autoRes = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ promotionMode: "auto", conversationId: convId }),
    });
    assert.equal(autoRes.status, 200);
    assert.equal((await autoRes.json()).trust.categories.ui.level, 1);

    const undoRes = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ undoAutoPromo: true, conversationId: convId }),
    });
    assert.equal(undoRes.status, 200);
    const undoBody = await undoRes.json();
    assert.equal(undoBody.trust.promotionMode, "manual");
    assert.equal(undoBody.trust.categories.ui.level, 0);

    const promoRes = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ promoteCategory: "ui", conversationId: convId }),
    });
    assert.equal(promoRes.status, 200);
    assert.equal((await promoRes.json()).trust.categories.ui.level, 1);

    const routes = [];
    class MockResponse {
      constructor(body, opts = {}) {
        this.body = body;
        this.status = opts.status || 200;
        this.contentType = opts.contentType || "text/plain";
      }
    }
    class MockSidecarApp {
      constructor() { this.config = { conversationId: convId }; }
      page() {}
      api(routePath, handler, method) { routes.push({ routePath, handler, method }); }
      async run() {}
    }
    await startTimelineSidecar({
      brainDir,
      workspaceDir: enrolledRepo,
      dataDir,
      sdk: { SidecarApp: MockSidecarApp, Response: MockResponse },
    });
    const settingsRoute = routes.find((r) => r.routePath === "/api/trust/settings");
    assert.equal(settingsRoute?.method, "POST");
    const sdkResp = await settingsRoute.handler({ setCeiling: { category: "ui", ceiling: 3 } });
    assert.equal(sdkResp.status, 200);
    assert.equal(JSON.parse(sdkResp.body).trust.categories.ui.ceiling, 3);
  } finally {
    await srv.close();
    await nonRepoSrv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer serves app.js without duplicate native title tooltips on popover-backed labels", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-tooltip-"));
  const brainDir = path.join(root, "brain");
  fs.mkdirSync(brainDir, { recursive: true });

  const srv = await createTimelineServer({ brainDir, port: 0 });
  try {
    const appRes = await fetch(`${srv.url}app.js`);
    assert.equal(appRes.status, 200);
    const appJs = await appRes.text();

    assert.match(appJs, /attachStatusPopover\(seg,/);
    assert.match(appJs, /showStatusPopover\(progressElInit,/);
    assert.match(appJs, /attachStatusPopover\(node,\s*part\.popTitle,/);

    assert.doesNotMatch(appJs, /\bseg\.title\s*=/);
    assert.doesNotMatch(appJs, /\bprogressEl\.title\s*=/);
    assert.doesNotMatch(appJs, /\bnode\.title\s*=\s*part\.popDesc\b/);
    assert.doesNotMatch(appJs, /\.title\s*=[^\n;]*;?\s*\n\s*attach(?:Status|Command)Popover\(/);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/dossier and /api/arch-audit stay read-only, enforce auth and validation, and serve sidecar_sdk POST routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-dossier-"));
  const brainDir = path.join(root, "brain");
  const gitRepo = path.join(root, "git-repo");
  const nonRepo = path.join(root, "non-repo");
  const convId = "66666666-7777-8888-9999-aaaaaaaaaaaa";

  fs.mkdirSync(gitRepo, { recursive: true });
  fs.mkdirSync(nonRepo, { recursive: true });
  fs.mkdirSync(path.join(brainDir, convId), { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: gitRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: gitRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: gitRepo, stdio: "ignore" });
  writeText(path.join(gitRepo, "src", "index.js"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: gitRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: gitRepo, stdio: "ignore" });
  writeText(path.join(gitRepo, "src", "index.js"), "export const a = 2;\n");

  const srv = await createTimelineServer({
    brainDir,
    workspaceDir: gitRepo,
    conversationId: convId,
    token: "dos-tok",
    port: 0,
  });
  const nonRepoSrv = await createTimelineServer({
    brainDir,
    workspaceDir: nonRepo,
    conversationId: convId,
    token: "dos-tok",
    port: 0,
  });

  try {
    const headers = { "X-Sidecar-Token": "dos-tok" };

    assert.equal((await fetch(`${srv.url}api/dossier?conversationId=${convId}`)).status, 401);
    assert.equal((await fetch(`${srv.url}api/arch-audit?conversationId=${convId}`)).status, 401);
    assert.equal((await fetch(`${srv.url}api/dossier`, { method: "POST", headers })).status, 405);
    assert.equal((await fetch(`${srv.url}api/arch-audit`, { method: "POST", headers })).status, 405);
    assert.equal((await fetch(`${srv.url}api/dossier?conversationId=../bad`, { headers })).status, 400);
    assert.equal((await fetch(`${srv.url}api/arch-audit?conversationId=../bad`, { headers })).status, 400);

    const nonRepoDossier = await (await fetch(`${nonRepoSrv.url}api/dossier?conversationId=${convId}`, { headers })).json();
    assert.equal(nonRepoDossier.ok, false);
    assert.equal(nonRepoDossier.reason, "non_repo");
    assert.deepEqual(fs.readdirSync(nonRepo), []);

    const dossierRes = await fetch(`${srv.url}api/dossier?conversationId=${convId}`, { headers });
    assert.equal(dossierRes.status, 200);
    const dossierBody = await dossierRes.json();
    assert.equal(dossierBody.ok, true);
    assert.ok(Array.isArray(dossierBody.evidence.clusters) && dossierBody.evidence.clusters.length > 0);
    assert.match(dossierBody.evidence.clusters[0].fileLinks[0].uri, /^file:\/\//);
    assert.equal(fs.existsSync(path.join(brainDir, convId, "astack-trust", "evidence.json")), false);

    const auditRes = await fetch(`${srv.url}api/arch-audit?conversationId=${convId}`, { headers });
    assert.equal(auditRes.status, 200);
    const auditBody = await auditRes.json();
    assert.equal(auditBody.ok, true);
    assert.ok(auditBody.report.summary.filesScanned >= 1);

    const routes = [];
    class MockResponse {
      constructor(body, opts = {}) {
        this.body = body;
        this.status = opts.status || 200;
        this.contentType = opts.contentType || "text/plain";
      }
    }
    class MockSidecarApp {
      constructor() { this.config = { conversationId: convId }; }
      page() {}
      api(routePath, handler, method) { routes.push({ routePath, handler, method }); }
      async run() {}
    }
    await startTimelineSidecar({
      brainDir,
      workspaceDir: gitRepo,
      sdk: { SidecarApp: MockSidecarApp, Response: MockResponse },
    });
    const dossierRoute = routes.find((r) => r.routePath === "/api/dossier");
    const auditRoute = routes.find((r) => r.routePath === "/api/arch-audit");
    assert.equal(dossierRoute?.method, "POST");
    assert.equal(auditRoute?.method, "POST");
    assert.equal(JSON.parse((await dossierRoute.handler({})).body).ok, true);
    assert.equal(JSON.parse((await auditRoute.handler({})).body).ok, true);
  } finally {
    await srv.close();
    await nonRepoSrv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serves status banner, interactive Trust: Off drawer, calm Risk Card UI, and stationary amber yourturn rail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-ux-"));
  const brainDir = path.join(root, "brain");
  fs.mkdirSync(brainDir, { recursive: true });
  const srv = await createTimelineServer({ brainDir, port: 0 });
  try {
    const [html, appJs, railJs, cssText] = await Promise.all([
      (await fetch(`${srv.url}`)).text(),
      (await fetch(`${srv.url}app.js`)).text(),
      (await fetch(`${srv.url}living-rail.js`)).text(),
      (await fetch(`${srv.url}styles.css`)).text(),
    ]);
    assert.match(html, /data-testid="timeline-status-banner"/);
    assert.doesNotMatch(html, /id="next-bar"|data-testid="timeline-next"/);
    assert.match(appJs, /renderStatusBanner\(/);
    assert.match(appJs, /snap\.trust\?\.riskPresentation/);
    assert.match(appJs, /const offBtn = el\("button", "meta-btn is-neutral", "Trust: Off"\)/);
    assert.match(appJs, /Beast Mode is enabled per repository/);
    assert.match(appJs, /a\.status === "failed"/);
    assert.match(railJs, /if \(next\.state === "yourturn"\) return "yourturn"/);
    assert.match(railJs, /else if \(kind === "yourturn"\)/);
    assert.match(cssText, /\.status-banner\.is-yourturn/);
    assert.match(cssText, /\.risk-card\.is-done/);
    assert.match(cssText, /\.meta-risk\.is-resolved/);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createAppJsTestHarness({
  appJs,
  conversationId = "11111111-2222-3333-4444-555555555555",
  hidden = false,
  workspaceUris = ["file:///repo"],
  fetchImpl,
}) {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  let docHidden = hidden;

  const scheduleTimer = (fn, ms, repeat = false) => {
    const id = nextTimerId++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { id, fn, due: now + delay, interval: repeat ? delay : null });
    return id;
  };
  const cancelTimer = (id) => {
    timers.delete(id);
  };
  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
  };
  const advanceBy = async (ms) => {
    await flushMicrotasks();
    const target = now + ms;
    while (true) {
      let next = null;
      for (const t of timers.values()) {
        if (t.due <= target && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) {
          next = t;
        }
      }
      if (!next) break;
      now = next.due;
      if (next.interval !== null) {
        next.due = now + next.interval;
      } else {
        timers.delete(next.id);
      }
      next.fn();
      await flushMicrotasks();
    }
    now = target;
    await flushMicrotasks();
  };

  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.id = "";
      this.className = "";
      this._text = "";
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.attrs = new Map();
      this.listeners = new Map();
      this.style = { setProperty() {} };
      this.scrollHeight = 160;
      this.value = "";
      this.tabIndex = -1;
      const self = this;
      this.classList = {
        _tokens() {
          return new Set(String(self.className || "").split(/\s+/).filter(Boolean));
        },
        add(...names) {
          const s = this._tokens();
          for (const n of names) if (n) s.add(n);
          self.className = [...s].join(" ");
        },
        remove(...names) {
          const s = this._tokens();
          for (const n of names) s.delete(n);
          self.className = [...s].join(" ");
        },
        toggle(name, force) {
          const s = this._tokens();
          const on = force === undefined ? !s.has(name) : Boolean(force);
          if (on) s.add(name);
          else s.delete(name);
          self.className = [...s].join(" ");
          return on;
        },
        contains(name) {
          return this._tokens().has(name);
        },
      };
    }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join("");
    }
    set textContent(v) {
      this._text = String(v ?? "");
      this.children = [];
    }
    setAttribute(k, v) {
      if (k === "id") this.id = String(v);
      this.attrs.set(k, String(v));
    }
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    }
    removeAttribute(k) {
      this.attrs.delete(k);
    }
    appendChild(node) {
      if (node) {
        node.parentElement = this;
        this.children.push(node);
      }
      return node;
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }
    replaceChildren(...nodes) {
      this._text = "";
      this.children = [];
      for (const n of nodes) this.appendChild(n);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() {
      for (const fn of this.listeners.get("click") || []) {
        fn({ stopPropagation() {}, preventDefault() {}, target: this, currentTarget: this });
      }
    }
    focus() {}
    remove() {}
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 120, bottom: 24, width: 120, height: 24 };
    }
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const ch of node.children || []) {
          if (sel === "[data-rail-node]" && ch.dataset?.railNode) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    }
    findByTestId(testId) {
      if (this.dataset?.testid === testId) return this;
      for (const ch of this.children || []) {
        const hit = ch.findByTestId?.(testId);
        if (hit) return hit;
      }
      return null;
    }
  }

  const ids = [
    "timeline-view", "panel-mode-switcher", "mode-btn-build", "mode-btn-review",
    "progress", "live", "live-label", "meta-row", "setup-drawer", "beast-drawer",
    "promo-wrap", "promo-card", "setup-wrap", "setup-card", "focus-strip", "focus-artifacts",
    "status-banner-wrap", "status-banner", "timeline-wrap", "living-rail", "timeline", "rail-announcer",
    "colleague-review-panel",
    "btw-form", "askbar-icon", "astk-btw", "btw-submit", "panel-footer",
    "trust-view", "dossier-view", "audit-view", "delegate-view", "artifact-view", "cmd-popover", "toast",
  ];
  const byId = new Map(ids.map((id) => {
    const el = new FakeElement("div");
    el.id = id;
    return [id, el];
  }));
  byId.get("living-rail").parentElement = new FakeElement("div");
  const docEl = new FakeElement("html");
  const docListeners = new Map();
  const winListeners = new Map();

  const document = {
    documentElement: docEl,
    body: new FakeElement("body"),
    activeElement: null,
    get hidden() {
      return docHidden;
    },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: () => [],
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createTextNode: (text) => {
      const n = new FakeElement("#text");
      n.textContent = text;
      return n;
    },
    contains: () => true,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  const sandbox = {
    URLSearchParams,
    AbortController,
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { platform: "Win32", userAgent: "node" },
    location: { search: "", hash: "" },
    getComputedStyle: () => ({ backgroundColor: "rgb(11, 11, 12)" }),
    document,
    ASTACK_CATALOG: {
      delegateGuide: {},
      colleagueReviewGuide: {
        intents: [
          {
            id: "single",
            title: "Review one PR",
            subtitle: "Default for most daily reviews",
            defaultOpen: true,
            steps: [
              { step: 1, title: "Understand first", condition: "Only if large or unfamiliar", badge: "Optional", command: "/teach", prompt: "/teach PR" },
              { step: 2, title: "Hunt real bugs", condition: "Recommended default", badge: "Default", command: "/interrogate", prompt: "/interrogate PR" },
              { step: 3, title: "Check downstream impact", condition: "Only if shared helper", badge: "Optional", command: "/blast-radius", prompt: "/blast-radius PR" },
            ],
            moreChecks: [
              { title: "Security check", condition: "Only if auth", command: "/security-audit", prompt: "/security-audit PR" },
            ],
          },
          {
            id: "queue",
            title: "Triage a queue of PRs",
            subtitle: "Multiple independent PRs",
            defaultOpen: false,
            steps: [{ title: "2 to 9 PRs", condition: "Batch", badge: "2-9 PRs", command: "/fanout", prompt: "/fanout PRs" }],
          },
          {
            id: "stack",
            title: "Review a PR stack",
            subtitle: "Dependent PRs",
            defaultOpen: false,
            steps: [{ title: "Stacked PRs", condition: "Stack", badge: "Stack", command: "/swarm", prompt: "/swarm PRs" }],
          },
        ],
      },
      commandDocs: {},
    },
    setTimeout: (fn, ms) => scheduleTimer(fn, ms, false),
    clearTimeout: cancelTimer,
    setInterval: (fn, ms) => scheduleTimer(fn, ms, true),
    clearInterval: cancelTimer,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    sidecar: {
      conversationId,
      getWorkspaceUris: async () => workspaceUris,
      onWorkspaceChange: () => () => {},
      fetch: fetchImpl,
    },
  };
  sandbox.window = sandbox;

  vm.runInNewContext(appJs, sandbox, { filename: "app.js" });
  return {
    byId,
    advanceBy,
    flushMicrotasks,
    setHidden(next) {
      docHidden = Boolean(next);
      for (const fn of docListeners.get("visibilitychange") || []) fn();
    },
  };
}

function makeFakeSnapshot(etag = "etag-1") {
  return {
    conversationId: "11111111-2222-3333-4444-555555555555",
    hasConversation: true,
    workspace: "/repo",
    workspaceName: "repo",
    branch: "main",
    setup: { status: "ready", commands: [], autoSubCommands: [], moreCommands: [] },
    trust: { scopeKind: "enrolled_repo", enrolled: true, beastOn: false, categories: [] },
    workflowMode: "standard",
    workflowLabel: null,
    panelDefaultMode: "build",
    colleagueReview: { detected: false, activeIntent: null, detectedCommands: [], running: false, targetPrs: [] },
    doneCount: 1,
    totalCount: 4,
    liveState: "ok",
    liveLabel: "Live",
    nextAction: { stageId: "build", command: "/astack-mode", inProgress: false },
    stages: [
      { id: "plan", number: 1, label: "Plan", status: "done", railState: "done", summary: "Plan done", artifacts: [], commands: [], autoSubCommands: [], moreCommands: [] },
      { id: "build", number: 2, label: "Build & Prove", status: "next", railState: "suggested", summary: "Build", artifacts: [], commands: [], autoSubCommands: [], moreCommands: [] },
      { id: "review", number: 3, label: "Pre-PR Check", status: "pending", railState: "pending", summary: "Pre-PR Check", artifacts: [], commands: [], autoSubCommands: [], moreCommands: [] },
      { id: "ship", number: 4, label: "Ship", status: "pending", railState: "pending", summary: "Ship", artifacts: [], commands: [], autoSubCommands: [], moreCommands: [] },
    ],
    activity: { liveStageIds: [], liveAgentsByStage: {}, subagents: [], schedules: [], automations: [], backgroundJobs: { count: 0, runningCount: 0, items: [] }, prs: { totalCount: 0, openCount: 0, mergedCount: 0, closedCount: 0, items: [] } },
    etag,
  };
}

test("app.js avoids slow-poll livelock, loads initial snapshot while hidden, and renders Retry fallback on errors", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-ui-"));
  const brainDir = path.join(root, "brain");
  fs.mkdirSync(brainDir, { recursive: true });
  const srv = await createTimelineServer({ brainDir, port: 0 });
  try {
    const appJs = await (await fetch(`${srv.url}app.js`)).text();

    let slowCalls = 0;
    let slowAborts = 0;
    let resolveSlow = null;
    const slowHarness = createAppJsTestHarness({
      appJs,
      fetchImpl: (_url, opts) => {
        slowCalls += 1;
        opts?.signal?.addEventListener("abort", () => {
          slowAborts += 1;
        });
        return new Promise((resolve) => {
          resolveSlow = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => makeFakeSnapshot("etag-slow"),
            });
        });
      },
    });
    await slowHarness.advanceBy(100);
    assert.equal(slowCalls, 1);
    await slowHarness.advanceBy(4000);
    assert.equal(slowCalls, 1, "Must not queue overlapping polls while first request is still in flight");
    assert.equal(slowAborts, 0, "Slow 4s response below POLL_TIMEOUT_MS must not be aborted");
    resolveSlow();
    await slowHarness.flushMicrotasks();
    assert.equal(slowHarness.byId.get("timeline").children.length, 4);
    assert.equal(slowHarness.byId.get("live-label").textContent, "Live");

    let hiddenCalls = 0;
    const hiddenHarness = createAppJsTestHarness({
      appJs,
      hidden: true,
      fetchImpl: async () => {
        hiddenCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => makeFakeSnapshot("etag-hidden"),
        };
      },
    });
    await hiddenHarness.advanceBy(100);
    assert.equal(hiddenCalls, 1, "Initial snapshot must load even when document.hidden is true");
    assert.equal(hiddenHarness.byId.get("timeline").children.length, 4);
    await hiddenHarness.advanceBy(5000);
    assert.equal(hiddenCalls, 1, "Subsequent polls wait while document remains hidden");

    let failMode = true;
    const errHarness = createAppJsTestHarness({
      appJs,
      fetchImpl: async () => {
        if (failMode) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "boom" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => makeFakeSnapshot("etag-recovered"),
        };
      },
    });
    await errHarness.advanceBy(100);
    assert.equal(errHarness.byId.get("live-label").textContent, "Error");
    const fallbackEl = errHarness.byId.get("timeline").findByTestId("timeline-fallback");
    const retryBtn = errHarness.byId.get("timeline").findByTestId("timeline-retry");
    assert.ok(fallbackEl, "Fallback card must appear instead of blank timeline");
    assert.ok(retryBtn, "Retry button must be present");

    failMode = false;
    retryBtn.click();
    await errHarness.flushMicrotasks();
    assert.equal(errHarness.byId.get("timeline").children.length, 4);
    assert.equal(errHarness.byId.get("live-label").textContent, "Live");
    assert.equal(errHarness.byId.get("timeline").findByTestId("timeline-fallback"), null);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer coalesces concurrent polls, bounds slow agentapi lookups, and negatively caches failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-coalesce-"));
  const brainDir = path.join(root, "brain");
  const wsDir = path.join(root, "repo");
  const convId = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
  writeText(path.join(wsDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>/plan ok</USER_REQUEST>" })}\n`,
  );

  let wsFetcherCalls = 0;
  let releaseWsFetcher = null;
  const slowSrv = await createTimelineServer({
    brainDir,
    port: 0,
    workspaceWaitBudgetMs: 30,
    workspaceFetcher: () => {
      wsFetcherCalls += 1;
      return new Promise((resolve) => {
        releaseWsFetcher = () => resolve(wsDir);
      });
    },
  });

  let emptyFetcherCalls = 0;
  const negSrv = await createTimelineServer({
    brainDir,
    port: 0,
    workspaceNegativeTtlMs: 5000,
    workspaceFetcher: async () => {
      emptyFetcherCalls += 1;
      return "";
    },
  });

  try {
    const wsUri = encodeURIComponent(pathToFileURL(wsDir).href);
    const t0 = Date.now();
    const first = await (await fetch(`${slowSrv.url}api/timeline?conversationId=${convId}&workspaceUri=${wsUri}`)).json();
    const elapsedMs = Date.now() - t0;
    assert.equal(first.setup.status, "ready");
    assert.equal(first.workspace, path.resolve(wsDir));
    assert.ok(elapsedMs < 1500, `Expected bounded wait via workspaceUri fallback, got ${elapsedMs}ms`);
    assert.equal(wsFetcherCalls, 1);

    releaseWsFetcher();
    await new Promise((r) => setTimeout(r, 15));

    const [p1, p2] = await Promise.all([
      fetch(`${slowSrv.url}api/timeline?conversationId=${convId}&workspaceUri=${wsUri}`).then((r) => r.json()),
      fetch(`${slowSrv.url}api/timeline?conversationId=${convId}&workspaceUri=${wsUri}&etag=${first.etag}`).then((r) => r.json()),
    ]);
    assert.equal(p1.etag, first.etag);
    assert.equal(p2.unchanged, true);
    assert.equal(p2.etag, first.etag);
    assert.equal(wsFetcherCalls, 1, "Cached workspace result should avoid further agentapi calls");

    await fetch(`${negSrv.url}api/timeline?conversationId=${convId}&workspaceUri=${wsUri}`);
    await fetch(`${negSrv.url}api/timeline?conversationId=${convId}&workspaceUri=${wsUri}`);
    assert.equal(emptyFetcherCalls, 1, "Empty agentapi result must be negatively cached across consecutive polls");
  } finally {
    await slowSrv.close();
    await negSrv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("POST /api/trust/settings invalidates in-flight /api/timeline coalescing so post-toggle reads never return stale beastOn=false", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-inflight-trust-"));
  const brainDir = path.join(root, "brain");
  const dataDir = path.join(root, "plugin_data");
  const enrolledRepo = path.join(root, "enrolled");
  const convId = "88888888-9999-4aaa-8bbb-cccccccccccc";
  fs.mkdirSync(enrolledRepo, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: enrolledRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: enrolledRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: enrolledRepo, stdio: "ignore" });
  writeText(
    path.join(enrolledRepo, ".agents", "risk-policy.json"),
    JSON.stringify({ schemaVersion: 1, autonomy: { defaultCeiling: 2, ceilings: { ui: 3 } } }, null, 2),
  );
  execFileSync("git", ["add", "."], { cwd: enrolledRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "enroll"], { cwd: enrolledRepo, stdio: "ignore" });
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-21T11:00:00Z",
        tool_calls: [{ name: "run_command", args: { CommandLine: 'gh pr create --title "PR 12" --body "ok"' } }],
      }),
      JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        created_at: "2026-11-21T11:00:02Z",
        content: "https://github.com/acme/demo/pull/12\n",
      }),
    ].join("\n") + "\n",
  );

  let releasePrMeta = null;
  let prFetchCount = 0;
  const srv = await createTimelineServer({
    brainDir,
    workspaceDir: enrolledRepo,
    conversationId: convId,
    token: "inflight-tok",
    dataDir,
    port: 0,
    enableGhLookup: true,
    prStatusResolver: () => {
      prFetchCount += 1;
      if (prFetchCount === 1) {
        return new Promise((resolve) => {
          releasePrMeta = () => resolve(null);
        });
      }
      return Promise.resolve(new Map([[12, { number: 12, title: "PR 12", state: "open", url: null }]]));
    },
  });

  try {
    const headers = { "Content-Type": "application/json", "X-Sidecar-Token": "inflight-tok" };
    const slowPollPromise = fetch(`${srv.url}api/timeline?conversationId=${convId}`, { headers }).then((r) => r.json());
    const deadline = Date.now() + 3000;
    while (!releasePrMeta && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(releasePrMeta, "Expected first timeline poll to block on prStatusResolver");

    const postRes = await fetch(`${srv.url}api/trust/settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ beastOn: true, conversationId: convId }),
    });
    assert.equal(postRes.status, 200);
    assert.equal((await postRes.json()).trust.beastOn, true);

    const postToggleSnapPromise = fetch(`${srv.url}api/timeline?conversationId=${convId}`, { headers }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 30));
    releasePrMeta();

    const [slowSnap, postToggleSnap] = await Promise.all([slowPollPromise, postToggleSnapPromise]);
    assert.equal(slowSnap.trust.beastOn, false);
    assert.equal(postToggleSnap.trust.beastOn, true, "Post-toggle timeline poll must not coalesce onto pre-mutation in-flight request");
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function findButtonByText(rootNode, text) {
  if (!rootNode) return null;
  if (rootNode.tagName === "BUTTON" && rootNode.textContent === text) return rootNode;
  for (const ch of rootNode.children || []) {
    const hit = findButtonByText(ch, text);
    if (hit) return hit;
  }
  return null;
}

test("app.js Beast toggle updates UI immediately, recovers polling after failed POST during in-flight poll, and ignores out-of-order responses", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-beast-ui-"));
  const brainDir = path.join(root, "brain");
  fs.mkdirSync(brainDir, { recursive: true });
  const srv = await createTimelineServer({ brainDir, port: 0 });
  try {
    const appJs = await (await fetch(`${srv.url}app.js`)).text();

    let serverBeastOn = false;
    let resolveInFlightPoll = null;
    let timelineCalls = 0;
    let failNextPost = false;

    const makeSnap = (beastOn, etag) => ({
      ...makeFakeSnapshot(etag),
      trust: {
        scopeKind: "enrolled_repo",
        enrolled: true,
        activeCategory: "ui",
        beastOn,
        promotionMode: "manual",
        promotionLockedByPolicy: false,
        chainValid: true,
        frozen: false,
        totalOutcomes: 0,
        activeCatState: { id: "ui", level: 0, ceiling: 2, maxCeiling: 3, score: 0, brier: 0 },
        categories: [{ id: "ui", level: 0, ceiling: 2, maxCeiling: 3, score: 0, brier: 0, clean: 0, edited: 0, reverted: 0 }],
      },
    });

    const harness = createAppJsTestHarness({
      appJs,
      fetchImpl: (url, opts) => {
        if (url === "/api/timeline") {
          timelineCalls += 1;
          if (timelineCalls === 2) {
            return new Promise((resolve) => {
              resolveInFlightPoll = () =>
                resolve({ ok: true, status: 200, json: async () => makeSnap(serverBeastOn, `etag-${serverBeastOn}`) });
            });
          }
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => makeSnap(serverBeastOn, `etag-${serverBeastOn}-${timelineCalls}`),
          });
        }
        if (url === "/api/trust/settings") {
          const body = JSON.parse(opts.body || "{}");
          if (failNextPost) {
            failNextPost = false;
            return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "boom" }) });
          }
          serverBeastOn = Boolean(body.beastOn);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, trust: makeSnap(serverBeastOn, "p").trust }),
          });
        }
        throw new Error(`Unexpected endpoint: ${url}`);
      },
    });

    await harness.advanceBy(100);
    const beastBtn0 = harness.byId.get("meta-row").findByTestId("timeline-beast-toggle");
    assert.equal(beastBtn0?.textContent, "Beast · Off");
    beastBtn0.click();

    const onBtn = findButtonByText(harness.byId.get("beast-drawer"), "On");
    assert.ok(onBtn, "Beast drawer On button must render");

    await harness.advanceBy(1800);
    assert.equal(timelineCalls, 2, "Second poll must be in flight");
    failNextPost = true;
    onBtn.click();
    await harness.flushMicrotasks();
    assert.equal(harness.byId.get("toast").textContent, "boom");

    resolveInFlightPoll?.();
    await harness.advanceBy(2000);
    assert.ok(timelineCalls >= 3, `Polling must recover after failed POST while poll was in flight (got ${timelineCalls} calls)`);

    findButtonByText(harness.byId.get("beast-drawer"), "On").click();
    await harness.flushMicrotasks();
    const beastBtnOn = harness.byId.get("meta-row").findByTestId("timeline-beast-toggle");
    assert.equal(beastBtnOn?.textContent, "Beast · L0");
    assert.equal(beastBtnOn?.classList.contains("is-beast"), true);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("app.js ignores stale out-of-order /api/trust/settings responses from rapid consecutive clicks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-beast-ooo-"));
  const brainDir = path.join(root, "brain");
  fs.mkdirSync(brainDir, { recursive: true });
  const srv = await createTimelineServer({ brainDir, port: 0 });
  try {
    const appJs = await (await fetch(`${srv.url}app.js`)).text();
    let serverBeastOn = false;
    const pendingResolvers = [];
    const makeTrust = (beastOn) => ({
      scopeKind: "enrolled_repo",
      enrolled: true,
      activeCategory: "ui",
      beastOn,
      promotionMode: "manual",
      promotionLockedByPolicy: false,
      chainValid: true,
      frozen: false,
      totalOutcomes: 0,
      activeCatState: { id: "ui", level: 0, ceiling: 2, maxCeiling: 3, score: 0, brier: 0 },
      categories: [{ id: "ui", level: 0, ceiling: 2, maxCeiling: 3, score: 0, brier: 0, clean: 0, edited: 0, reverted: 0 }],
    });

    const harness = createAppJsTestHarness({
      appJs,
      fetchImpl: (url, opts) => {
        if (url === "/api/timeline") {
          const trust = makeTrust(serverBeastOn);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ...makeFakeSnapshot(`etag-${serverBeastOn}`), trust }),
          });
        }
        if (url === "/api/trust/settings") {
          const body = JSON.parse(opts.body || "{}");
          return new Promise((resolve) => {
            pendingResolvers.push({
              beastOn: Boolean(body.beastOn),
              resolve: () => {
                serverBeastOn = Boolean(body.beastOn);
                resolve({
                  ok: true,
                  status: 200,
                  json: async () => ({ ok: true, trust: makeTrust(serverBeastOn) }),
                });
              },
            });
          });
        }
        throw new Error(`Unexpected endpoint: ${url}`);
      },
    });

    await harness.advanceBy(100);
    harness.byId.get("meta-row").findByTestId("timeline-beast-toggle").click();
    findButtonByText(harness.byId.get("beast-drawer"), "On").click();
    findButtonByText(harness.byId.get("beast-drawer"), "Off").click();
    assert.equal(pendingResolvers.length, 2);

    pendingResolvers[1].resolve();
    await harness.flushMicrotasks();
    assert.equal(harness.byId.get("meta-row").findByTestId("timeline-beast-toggle")?.textContent, "Beast · Off");

    pendingResolvers[0].resolve();
    await harness.flushMicrotasks();
    assert.equal(
      harness.byId.get("meta-row").findByTestId("timeline-beast-toggle")?.textContent,
      "Beast · Off",
      "Stale earlier On response must not overwrite newer Off click",
    );
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar serves colleagueReviewGuide and toggles between Build (Pre-PR Check) and Review PR modes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-modes-"));
  const brainDir = path.join(root, "brain");
  fs.mkdirSync(brainDir, { recursive: true });
  const srv = await createTimelineServer({ brainDir, port: 0 });
  try {
    const catalogRes = await (await fetch(`${srv.url}catalog.js`)).text();
    assert.match(catalogRes, /colleagueReviewGuide/);
    assert.match(catalogRes, /Pre-PR Check/);
    assert.doesNotMatch(catalogRes, /\/review-pr/);

    const appJs = await (await fetch(`${srv.url}app.js`)).text();
    let currentSnap = makeFakeSnapshot("etag-build-mode");
    const harness = createAppJsTestHarness({
      appJs,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => currentSnap,
      }),
    });

    await harness.advanceBy(100);
    assert.equal(harness.byId.get("mode-btn-build").getAttribute("aria-pressed"), "true");
    assert.equal(harness.byId.get("mode-btn-review").getAttribute("aria-pressed"), "false");
    assert.equal(harness.byId.get("timeline-wrap").classList.contains("hidden"), false);
    assert.equal(harness.byId.get("colleague-review-panel").classList.contains("hidden"), true);
    assert.equal(harness.byId.get("timeline").findByTestId("timeline-step-review").children.length > 0, true);

    harness.byId.get("mode-btn-review").click();
    assert.equal(harness.byId.get("mode-btn-review").getAttribute("aria-pressed"), "true");
    assert.equal(harness.byId.get("timeline-wrap").classList.contains("hidden"), true);
    assert.equal(harness.byId.get("colleague-review-panel").classList.contains("hidden"), false);
    assert.ok(harness.byId.get("colleague-review-panel").findByTestId("cr-intent-single"));
    assert.ok(harness.byId.get("colleague-review-panel").findByTestId("cr-intent-queue"));
    assert.ok(harness.byId.get("colleague-review-panel").findByTestId("cr-intent-stack"));
    assert.ok(harness.byId.get("colleague-review-panel").findByTestId("cr-intent-body-single"));

    currentSnap = {
      ...makeFakeSnapshot("etag-review-auto"),
      conversationId: "22222222-3333-4444-8555-666666666666",
      panelDefaultMode: "review_pr",
      colleagueReview: {
        detected: true,
        activeIntent: "queue",
        detectedCommands: ["/fanout"],
        running: false,
        targetPrs: [{ number: 231, state: "open", url: "https://github.com/acme/demo/pull/231" }],
      },
    };
    harness.byId.get("mode-btn-build").click();
    assert.equal(harness.byId.get("mode-btn-build").getAttribute("aria-pressed"), "true");
    await harness.advanceBy(2000);
    assert.equal(
      harness.byId.get("mode-btn-review").getAttribute("aria-pressed"),
      "true",
      "Conversation change must reset manual mode override and auto-select Review PR",
    );
    assert.ok(harness.byId.get("colleague-review-panel").findByTestId("cr-intent-body-queue"));
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startTimelineSidecar overrides /_sidecar/get-conversation-metadata asynchronously, deduplicates with /api/timeline, bounds empty-fallback waits, and caches empty workspaces", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-meta-dedupe-"));
  const brainDir = path.join(root, "brain");
  const wsDir = path.join(root, "repo");
  const convId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const emptyConvId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  writeText(path.join(wsDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    `${JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>/plan ok</USER_REQUEST>" })}\n`,
  );

  let metaCalls = 0;
  let releaseMeta = null;
  const routes = [];
  let ranServer = false;
  class MockResponse {
    constructor(body, opts = {}) {
      this.body = body;
      this.status = opts.status || 200;
      this.contentType = opts.contentType || "text/plain";
    }
  }
  class MockSidecarApp {
    constructor() {
      this.config = { conversationId: convId };
    }
    page() {}
    api(routePath, handler, method) {
      routes.push({ routePath, handler, method, afterRun: ranServer });
    }
    async run() {
      ranServer = true;
    }
  }

  try {
    await startTimelineSidecar({
      brainDir,
      workspaceWaitBudgetMs: 25,
      workspaceEmptyTtlMs: 60_000,
      metadataFetcher: (id) => {
        metaCalls += 1;
        if (id === emptyConvId) {
          return Promise.resolve({
            ok: true,
            payload: { response: { conversationMetadata: { metadata: { workspaces: [] } } } },
            workspaceDir: "",
            emptyWorkspace: true,
          });
        }
        return new Promise((resolve) => {
          releaseMeta = () =>
            resolve({
              ok: true,
              payload: {
                response: {
                  conversationMetadata: {
                    metadata: { projectId: "proj-1", workspaceUris: [pathToFileURL(wsDir).href] },
                  },
                },
              },
              workspaceDir: wsDir,
              emptyWorkspace: false,
            });
        });
      },
      sdk: { SidecarApp: MockSidecarApp, Response: MockResponse },
    });

    const metaOverride = [...routes].reverse().find((r) => r.routePath === "/_sidecar/get-conversation-metadata");
    const timelineRoute = routes.find((r) => r.routePath === "/api/timeline");
    assert.equal(metaOverride?.afterRun, true, "/_sidecar/get-conversation-metadata must be overridden after app.run()");
    assert.equal(metaOverride?.method, "POST");

    const invalidMeta = await metaOverride.handler({ conversationId: "../bad" });
    assert.equal(invalidMeta.status, 400);

    const t0 = Date.now();
    const metaPromise = metaOverride.handler({ conversationId: convId });
    const tlBounded = await timelineRoute.handler({ conversationId: convId });
    const boundedMs = Date.now() - t0;
    assert.ok(boundedMs < 1000, `Empty-fallback timeline load must respect waitBudgetMs (got ${boundedMs}ms)`);
    assert.equal(tlBounded.status, 200);
    assert.equal(metaCalls, 1, "Concurrent metadata + timeline requests must share one metadata lookup");

    releaseMeta();
    const metaRes = await metaPromise;
    assert.equal(metaRes.status, 200);
    assert.equal(JSON.parse(metaRes.body).response.conversationMetadata.metadata.projectId, "proj-1");

    const tlResolved = await timelineRoute.handler({ conversationId: convId });
    assert.equal(JSON.parse(tlResolved.body).setup.status, "ready");
    assert.equal(metaCalls, 1, "Cached metadata must serve subsequent timeline polls without re-spawning");

    const callsBeforeEmpty = metaCalls;
    await metaOverride.handler({ conversationId: emptyConvId });
    await metaOverride.handler({ conversationId: emptyConvId });
    await timelineRoute.handler({ conversationId: emptyConvId });
    assert.equal(metaCalls, callsBeforeEmpty + 1, "Workspace-less conversations must cache empty workspaces across polls");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("app.js displays timeline-loading on slow first load and falls back cleanly if render throws", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-loading-"));
  const brainDir = path.join(root, "brain");
  fs.mkdirSync(brainDir, { recursive: true });
  const srv = await createTimelineServer({ brainDir, port: 0 });
  try {
    const appJs = await (await fetch(`${srv.url}app.js`)).text();

    let resolveInitial = null;
    const slowInit = createAppJsTestHarness({
      appJs,
      fetchImpl: () =>
        new Promise((resolve) => {
          resolveInitial = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => makeFakeSnapshot("etag-loaded"),
            });
        }),
    });
    await slowInit.advanceBy(250);
    assert.ok(slowInit.byId.get("timeline").findByTestId("timeline-loading"), "Slow initial load must show loading card");
    assert.equal(slowInit.byId.get("live-label").textContent, "Loading…");

    resolveInitial();
    await slowInit.flushMicrotasks();
    assert.equal(slowInit.byId.get("timeline").findByTestId("timeline-loading"), null);
    assert.equal(slowInit.byId.get("timeline").children.length, 4);
    assert.equal(slowInit.byId.get("live-label").textContent, "Live");

    const malformedHarness = createAppJsTestHarness({
      appJs,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ etag: "bad", stages: null }),
      }),
    });
    await malformedHarness.advanceBy(100);
    assert.ok(
      malformedHarness.byId.get("timeline").findByTestId("timeline-fallback"),
      "Render exception on malformed payload must restore snap=null and show fallback card",
    );
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer negatively caches null and failing prStatusFetcher results inside TTL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-pr-neg-"));
  const brainDir = path.join(root, "brain");
  const workspaceDir = path.join(root, "repo");
  const convId = "66666666-7777-8888-9999-000000000001";

  writeText(path.join(workspaceDir, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T12:00:00Z",
        content: "check pr",
      }),
      JSON.stringify({
        step_index: 1,
        type: "GENERIC",
        created_at: "2026-11-20T12:00:02Z",
        content: "https://github.com/acme/demo/pull/99\n",
      }),
    ].join("\n") + "\n",
  );

  let nullFetchCalls = 0;
  const nullSrv = await createTimelineServer({
    brainDir,
    workspaceDir,
    port: 0,
    enableGhLookup: true,
    prStatusFetcher: async () => {
      nullFetchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 180));
      return null;
    },
  });

  try {
    const first = await (await fetch(`${nullSrv.url}api/timeline?conversationId=${convId}`)).json();
    assert.equal(first.activity.prs.totalCount, 1);
    assert.equal(nullFetchCalls, 1);

    const t0 = Date.now();
    const second = await (await fetch(`${nullSrv.url}api/timeline?conversationId=${convId}`)).json();
    const elapsedMs = Date.now() - t0;
    assert.equal(second.activity.prs.totalCount, 1);
    assert.equal(nullFetchCalls, 1, "Null PR lookup result must be negatively cached inside TTL");
    assert.ok(elapsedMs < 120, `Negatively cached PR poll should return promptly without blocking, took ${elapsedMs}ms`);
  } finally {
    await nullSrv.close();
  }

  let throwCalls = 0;
  const errSrv = await createTimelineServer({
    brainDir,
    workspaceDir,
    port: 0,
    enableGhLookup: true,
    prStatusFetcher: async () => {
      throwCalls += 1;
      throw new Error("gh unavailable");
    },
  });

  try {
    await (await fetch(`${errSrv.url}api/timeline?conversationId=${convId}`)).json();
    await (await fetch(`${errSrv.url}api/timeline?conversationId=${convId}`)).json();
    assert.equal(throwCalls, 1, "Failed PR lookup must be negatively cached inside TTL");
  } finally {
    await errSrv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("createTimelineServer serves diagnosis.md via /api/artifact and renders 1. Investigate & Plan labels", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astack-tl-diag-"));
  const brainDir = path.join(root, "brain");
  const workspaceDir = path.join(root, "repo");
  const convId = "77777777-8888-4999-aaaa-bbbbbbbbbbbb";

  writeText(path.join(workspaceDir, ".agents", "skills", "verify-app", "SKILL.md"), "# Verify\n");
  writeText(path.join(brainDir, convId, "diagnosis.md"), "# Diagnosis\nRoot cause verified.\n");
  writeText(
    path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl"),
    [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        created_at: "2026-11-20T12:00:00Z",
        content: "<USER_REQUEST>/investigate why CI failed</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-20T12:00:10Z",
        tool_calls: [{ name: "write_file", args: { Path: path.join(brainDir, convId, "diagnosis.md") } }],
      }),
    ].join("\n") + "\n",
  );

  const srv = await createTimelineServer({ brainDir, workspaceDir, port: 0 });
  try {
    const [tlRes, artRes, appRes] = await Promise.all([
      fetch(`${srv.url}api/timeline?conversationId=${convId}`),
      fetch(`${srv.url}api/artifact?conversationId=${convId}&name=diagnosis.md`),
      fetch(`${srv.url}app.js`),
    ]);
    assert.equal(tlRes.status, 200);
    assert.equal(artRes.status, 200);
    assert.equal(appRes.status, 200);

    const snap = await tlRes.json();
    assert.equal(snap.stages[0].label, "Investigate & Plan");
    assert.equal(snap.stages[0].status, "waiting_gate");
    assert.equal(snap.stages[0].waitingArtifact, "diagnosis");
    assert.equal(snap.workflowMode, "investigation");
    assert.equal(snap.workflowLabel, "Investigation");

    const artJson = await artRes.json();
    assert.equal(artJson.kind, "markdown");
    assert.match(artJson.content, /Root cause verified/);

    const appJs = await appRes.text();
    assert.match(appJs, /Open Diagnosis/);
    assert.match(appJs, /plan-readonly-pill/);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
