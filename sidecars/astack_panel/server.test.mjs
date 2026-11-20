import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startSidecar } from './server.mjs';

describe('astack_panel sidecar server', () => {
  it('serves health, ui.html, token-gated overview, and cleans up server_info.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'astack-sidecar-test-'));
    const token = 'test-sidecar-token';
    const handle = await startSidecar({ port: 0, dataDir: tmpDir, token });

    try {
      const infoPath = path.join(tmpDir, 'server_info.json');
      assert.equal(fs.existsSync(infoPath), true);
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
      assert.equal(info.host, '127.0.0.1');
      assert.equal(info.port, handle.port);
      assert.equal(info.token, token);

      const base = `http://127.0.0.1:${handle.port}`;
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('access-control-allow-origin'), null);
      const healthBody = await health.json();
      assert.equal(healthBody.ok, true);
      assert.equal(healthBody.plugin, 'astack');

      const ui = await fetch(`${base}/ui.html`);
      assert.equal(ui.status, 200);
      const uiText = await ui.text();
      assert.match(uiText, /<title>AStack<\/title>/);

      const unauth = await fetch(`${base}/api/overview`);
      assert.equal(unauth.status, 401);

      const overview = await fetch(`${base}/api/overview`, {
        headers: { 'X-Sidecar-Token': token }
      });
      assert.equal(overview.status, 200);
      const body = await overview.json();
      assert.equal(body.name, 'astack');
      assert.ok(body.counts.skills >= 60);
      assert.ok(body.counts.playbooks >= 20);

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
      assert.equal(fs.existsSync(path.join(tmpDir, 'server_info.json')), false);
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
      const unauth = await fetch(`${base}/api/overview`);
      assert.equal(unauth.status, 401);
      const authed = await fetch(`${base}/api/overview`, {
        headers: { 'X-Sidecar-Token': 'fallback-secret' }
      });
      assert.equal(authed.status, 200);
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
