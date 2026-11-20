import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTimelineServer } from "./main.mjs";

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

    const cssRes = await fetch(`${srv.url}styles.css`);
    assert.equal(cssRes.status, 200);
    assert.match(cssRes.headers.get("content-type") ?? "", /text\/css/);
    const cssText = await cssRes.text();
    assert.match(cssText, /--tl-done:/);
    assert.match(cssText, /\.setup-card\b/);

    const jsRes = await fetch(`${srv.url}app.js`);
    assert.equal(jsRes.status, 200);
    assert.match(jsRes.headers.get("content-type") ?? "", /javascript/);

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
    assert.ok(Array.isArray(first.setup.autoSubCommands) && first.setup.autoSubCommands.length > 0);
    assert.ok(Array.isArray(first.setup.moreCommands) && first.setup.moreCommands.length > 0);
    for (const st of first.stages) {
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
