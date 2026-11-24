import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
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
    assert.match(htmlText, /data-testid="timeline-scene"/);
    assert.match(htmlText, /data-testid="focus-strip"/);
    assert.match(htmlText, /data-testid="focus-artifacts"/);
    assert.match(htmlText, /data-testid="btw-form"/);
    assert.match(htmlText, /data-testid="delegate-view"/);
    assert.match(htmlText, /data-testid="artifact-view"/);
    assert.doesNotMatch(htmlText, /id="next-bar"|data-testid="timeline-next"/);

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
    assert.match(cssText, /height:\s*188px;/);
    assert.match(cssText, /\.chip-active-dot\b/);
    assert.doesNotMatch(cssText, /\.scene-next\b/);

    const jsRes = await fetch(`${srv.url}app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("content-type") ?? "", /javascript/);
    const jsText = await jsRes.text();
    assert.match(jsText, /chip-active-dot/);
    assert.match(jsText, /showStatusPopover/);
    assert.doesNotMatch(jsText, /getElementById\("next-bar"\)/);

    const threeRes = await fetch(`${srv.url}vendor/three.min.js`);
    assert.equal(threeRes.status, 200);
    assert.match(threeRes.headers.get("content-type") ?? "", /javascript/);

    const sceneRes = await fetch(`${srv.url}scene-3d.js`);
    assert.equal(sceneRes.status, 200);
    assert.match(sceneRes.headers.get("content-type") ?? "", /javascript/);

    const catalogRes = await fetch(`${srv.url}catalog.js`);
    assert.equal(catalogRes.status, 200);
    assert.match(catalogRes.headers.get("content-type") ?? "", /javascript/);
    const catalogText = await catalogRes.text();
    assert.match(catalogText, /window\.ASTACK_CATALOG\s*=/);

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
    assert.equal(snap.stages[0].commands[0].state, "active");
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
    assert.match(appJs, /snap\.branch !== snap\.workspaceName/);
    assert.match(appJs, /timeline-risk-badge/);
    assert.match(appJs, /timeline-freshness/);
    assert.match(appJs, /build-stale-callout/);
    assert.match(appJs, /Critical risk/);
    assert.match(appJs, /focus-drawer-agents/);
    assert.match(appJs, /focus-drawer-prs/);
    assert.match(appJs, /focus-drawer-tasks/);
    assert.match(cssText, /\.scene-section[\s\S]*height:\s*188px/);
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

    const [appJs, cssText, sceneJs] = await Promise.all([
      (await fetch(`${srv.url}app.js`)).text(),
      (await fetch(`${srv.url}styles.css`)).text(),
      (await fetch(`${srv.url}scene-3d.js`)).text(),
    ]);
    assert.match(appJs, /focus-drawer-artifacts/);
    assert.match(appJs, /openTaskLog\(/);
    assert.match(appJs, /PR Iteration/);
    assert.match(appJs, /"Earlier"/);
    assert.match(appJs, /"Optional"/);
    assert.doesNotMatch(appJs, /bgItems\.slice\(-8\)/);
    assert.match(cssText, /\.focus-drawer-list[\s\S]*overflow-y:\s*auto/);
    assert.match(cssText, /\.progress\.is-mode\b/);
    assert.match(cssText, /\.scene-stage-dot\.skipped\s*\{\s*background:\s*#6f757a/);
    assert.match(sceneJs, /merged:\s*new T\.Color\("#a855f7"\)/);
    assert.match(sceneJs, /prMergedEdges/);
    assert.match(sceneJs, /prOpenEdges/);
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
