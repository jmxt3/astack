import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startSidecar } from './server.mjs';

function seedFixtureBrain(rootDir) {
  const convId = 'conv-demo-1234';
  const logsDir = path.join(rootDir, convId, '.system_generated', 'logs');
  const trustDir = path.join(rootDir, convId, 'astack-trust');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(trustDir, { recursive: true });

  const transcript = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-11-20T19:00:00Z',
      content: '<USER_REQUEST>\nFix the sidecar panel timeline\n</USER_REQUEST>'
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-20T19:00:05Z',
      tool_calls: [
        { name: 'read_file', args: { Path: '"c:\\\\dev\\\\astack\\\\skills\\\\astack-mode\\\\SKILL.md"' } },
        { name: 'edit_file', args: { Path: '"c:\\\\dev\\\\astack\\\\sidecars\\\\astack_panel\\\\server.mjs"' } }
      ]
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-20T19:00:10Z',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"node --run test:sidecar"', toolSummary: '"Run sidecar tests"' } }
      ]
    }
  ];
  fs.writeFileSync(
    path.join(logsDir, 'transcript.jsonl'),
    transcript.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(trustDir, 'findings.json'),
    JSON.stringify({ verdict: 'PASS', round: 1, summary: 'All clear', findings: [] }),
    'utf8'
  );
  return convId;
}

describe('astack_panel sidecar server', () => {
  it('serves health, ui.html, overview with hooks, conversation timeline, and cleans up server_info.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astack-sidecar-test-'));
    const brainDir = path.join(tmpDir, 'brain');
    const convId = seedFixtureBrain(brainDir);
    const token = 'test-sidecar-token';
    const handle = await startSidecar({ port: 0, dataDir: path.join(tmpDir, 'data'), brainDir, token });

    try {
      const infoPath = path.join(tmpDir, 'data', 'server_info.json');
      assert.equal(fs.existsSync(infoPath), true);
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      assert.equal(info.host, '127.0.0.1');
      assert.equal(info.port, handle.port);
      assert.equal(info.token, token);

      const base = `http://127.0.0.1:${handle.port}`;
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('access-control-allow-origin'), null);

      const ui = await fetch(`${base}/ui.html`);
      assert.equal(ui.status, 200);
      assert.match(await ui.text(), /<title>AStack<\/title>/);

      assert.equal((await fetch(`${base}/api/overview`)).status, 401);
      assert.equal((await fetch(`${base}/api/conversations`)).status, 401);
      assert.equal((await fetch(`${base}/api/conversation?id=${convId}`)).status, 401);

      const authHeaders = { 'X-Sidecar-Token': token };
      const overview = await (await fetch(`${base}/api/overview`, { headers: authHeaders })).json();
      assert.equal(overview.name, 'astack');
      assert.ok(overview.counts.skills >= 60);
      assert.ok(overview.counts.playbooks >= 20);
      assert.ok(overview.counts.hooks >= 8);

      const convList = await (await fetch(`${base}/api/conversations`, { headers: authHeaders })).json();
      assert.equal(convList.activeId, convId);
      assert.equal(convList.conversations.length, 1);

      const scanned = await (await fetch(`${base}/api/conversation?id=${convId}`, { headers: authHeaders })).json();
      assert.equal(scanned.id, convId);
      assert.equal(scanned.title, 'Fix the sidecar panel timeline');
      assert.equal(scanned.stages.length, 6);
      assert.equal(scanned.stages[0].status, 'done');
      assert.equal(scanned.stages[2].status, 'done');
      assert.equal(scanned.stages[3].status, 'done');
      assert.equal(scanned.stages[4].status, 'done');
      assert.equal(scanned.trust.verifierVerdict, 'PASS');
      assert.ok(scanned.timeline.length >= 3);

      const traversal = await fetch(`${base}/api/conversation?id=..%2F..`, { headers: authHeaders });
      assert.equal(traversal.status, 404);

      const rawStatus = await new Promise((resolve, reject) => {
        const sock = net.connect(handle.port, '127.0.0.1', () => {
          sock.write('GET http://[invalid HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        });
        let data = '';
        sock.on('data', (chunk) => {
          data += chunk.toString('utf8');
          if (data.includes('\r\n\r\n')) {
            sock.destroy();
            resolve(data);
          }
        });
        sock.on('error', reject);
      });
      assert.match(rawStatus, /^HTTP\/1\.1 400 /);
    } finally {
      await handle.stop();
      assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'server_info.json')), false);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('skips empty string tokens and falls back to ANTIGRAVITY_SIDECAR_AUTH_TOKEN', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astack-sidecar-env-'));
    const prevUi = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
    const prevAuth = process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN;
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = '';
    process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN = 'fallback-secret';
    const handle = await startSidecar({ port: 0, dataDir: tmpDir });

    try {
      const base = `http://127.0.0.1:${handle.port}`;
      assert.equal((await fetch(`${base}/api/overview`)).status, 401);
      assert.equal(
        (await fetch(`${base}/api/overview`, { headers: { 'X-Sidecar-Token': 'fallback-secret' } })).status,
        200
      );
    } finally {
      if (prevUi === undefined) delete process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN = prevUi;
      if (prevAuth === undefined) delete process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN;
      else process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN = prevAuth;
      await handle.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
