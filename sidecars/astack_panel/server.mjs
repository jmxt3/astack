import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const HOST = '127.0.0.1';

function resolveDataDir() {
  const envDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (envDir) return envDir;
  const appData = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim() || path.join(os.homedir(), '.gemini', 'antigravity');
  return path.join(appData, 'sidecar_data', 'astack', 'astack_panel', 'data');
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function listDirNames(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(dirPath, ext = '.md') {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(ext))
      .map((entry) => entry.name.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

export function collectOverview(pluginRoot = PLUGIN_ROOT) {
  const plugin = readJsonSafe(path.join(pluginRoot, 'plugin.json'), {
    name: 'astack',
    displayName: 'AStack',
    version: '0.0.0',
    description: ''
  });
  const hooksJson = readJsonSafe(path.join(pluginRoot, 'hooks.json'), { hooks: {} });
  const skills = listDirNames(path.join(pluginRoot, 'skills'));
  const playbooks = listFiles(path.join(pluginRoot, 'skills', 'astack-mode', 'playbooks'));
  const agents = listFiles(path.join(pluginRoot, 'agents'));
  const rules = listFiles(path.join(pluginRoot, 'rules'));

  const hookEntries = [];
  for (const [eventName, list] of Object.entries(hooksJson.hooks || {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      for (const h of item.hooks || []) {
        hookEntries.push({
          event: eventName,
          matcher: item.matcher || '*',
          command: h.command || ''
        });
      }
    }
  }

  return {
    name: plugin.name || 'astack',
    displayName: plugin.displayName || 'AStack',
    version: plugin.version || '0.0.0',
    description: plugin.description || '',
    counts: {
      skills: skills.length,
      playbooks: playbooks.length,
      agents: agents.length,
      rules: rules.length,
      hooks: hookEntries.length
    },
    skills,
    playbooks,
    agents,
    rules,
    hooks: hookEntries
  };
}

function getToken(req, urlObj) {
  const headerToken = req.headers['x-sidecar-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();
  const queryToken = urlObj.searchParams.get('token');
  return queryToken ? queryToken.trim() : '';
}

function pickNonEmpty(...values) {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

export function createSidecarServer(options = {}) {
  const token = pickNonEmpty(
    options.token,
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN,
    process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN,
    process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN
  );
  const pluginRoot = options.pluginRoot || PLUGIN_ROOT;
  const uiHtmlPath = path.join(__dirname, 'ui.html');

  const server = http.createServer((req, res) => {
    let urlObj;
    try {
      urlObj = new URL(req.url || '/', `http://${HOST}`);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Bad request' }));
      return;
    }
    const pathname = urlObj.pathname || '/';

    if (pathname === '/health') {
      const overview = collectOverview(pluginRoot);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, plugin: overview.name, version: overview.version }));
      return;
    }

    if (pathname === '/' || pathname === '/ui.html') {
      try {
        const html = fs.readFileSync(uiHtmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Failed to read ui.html: ${err.message}`);
      }
      return;
    }

    if (pathname === '/api/overview') {
      if (token && getToken(req, urlObj) !== token) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const overview = collectOverview(pluginRoot);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(overview));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return { server, token };
}

export async function startSidecar(options = {}) {
  const envPort = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '', 10);
  const port = options.port ?? (Number.isNaN(envPort) ? 0 : envPort);
  const dataDir = options.dataDir || resolveDataDir();
  const { server, token } = createSidecarServer(options);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });

  const actualPort = server.address()?.port ?? port;
  let serverInfoPath = null;
  if (dataDir) {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      serverInfoPath = path.join(dataDir, 'server_info.json');
      fs.writeFileSync(
        serverInfoPath,
        JSON.stringify({ host: HOST, port: actualPort, token: token || null, pid: process.pid }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch (err) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      throw err;
    }
  }

  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    if (serverInfoPath) {
      try {
        fs.rmSync(serverInfoPath, { force: true });
      } catch {}
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  };

  return { server, port: actualPort, serverInfoPath, stop };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startSidecar()
    .then(({ stop }) => {
      const handleSignal = () => {
        stop().finally(() => process.exit(0));
      };
      process.once('SIGINT', handleSignal);
      process.once('SIGTERM', handleSignal);
    })
    .catch((err) => {
      console.error('[astack-panel] Fatal startup error:', err);
      process.exitCode = 1;
    });
}
