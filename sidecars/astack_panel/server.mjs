import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const HOST = '127.0.0.1';
const SAFE_CONV_ID = /^[a-zA-Z0-9_-]{4,128}$/;

function resolveAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function resolveBrainDir(options = {}) {
  if (options.brainDir) return options.brainDir;
  return path.join(resolveAppDataDir(), 'brain');
}

function resolveDataDir() {
  const envDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(resolveAppDataDir(), 'sidecar_data', 'astack', 'astack_panel', 'data');
}

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonlSafe(filePath, maxBytes = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    let raw;
    if (stat.size > maxBytes) {
      const fd = fs.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
        raw = buf.toString('utf8');
        const firstNl = raw.indexOf('\n');
        if (firstNl !== -1) raw = raw.slice(firstNl + 1);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(filePath, 'utf8');
    }
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed));
      } catch {}
    }
    return items;
  } catch {
    return [];
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

function parseHooksJson(hooksJson) {
  const entries = [];
  if (!hooksJson || typeof hooksJson !== 'object') return entries;

  if (hooksJson.hooks && typeof hooksJson.hooks === 'object' && !Array.isArray(hooksJson.hooks)) {
    for (const [eventName, list] of Object.entries(hooksJson.hooks)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        for (const h of item.hooks || []) {
          entries.push({
            name: eventName,
            enabled: true,
            event: eventName,
            matcher: item.matcher || '*',
            command: h.command || ''
          });
        }
      }
    }
    return entries;
  }

  for (const [hookName, def] of Object.entries(hooksJson)) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
    const enabled = def.enabled !== false;
    const events = Object.keys(def).filter((k) => k !== 'enabled' && Array.isArray(def[k]));
    entries.push({
      name: hookName,
      enabled,
      events
    });
  }
  return entries;
}

export function collectOverview(pluginRoot = PLUGIN_ROOT) {
  const plugin = readJsonSafe(path.join(pluginRoot, 'plugin.json'), {
    name: 'astack',
    displayName: 'AStack',
    version: '0.0.0',
    description: ''
  });
  const hooksJson = readJsonSafe(path.join(pluginRoot, 'hooks.json'), {});
  const skills = listDirNames(path.join(pluginRoot, 'skills'));
  const playbooks = listFiles(path.join(pluginRoot, 'skills', 'astack-mode', 'playbooks'));
  const agents = listFiles(path.join(pluginRoot, 'agents'));
  const rules = listFiles(path.join(pluginRoot, 'rules'));
  const hookEntries = parseHooksJson(hooksJson);
  const hooksEnabled = hookEntries.filter((h) => h.enabled).length;

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
      hooks: hookEntries.length,
      hooksEnabled,
      hooksOptIn: hookEntries.length - hooksEnabled
    },
    skills,
    playbooks,
    agents,
    rules,
    hooks: hookEntries
  };
}

function extractUserPromptText(content) {
  if (typeof content !== 'string') return '';
  const match = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  const raw = match ? match[1] : content;
  return raw.replace(/\s+/g, ' ').trim();
}

function unquoteArg(val) {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function safeConversationDir(brainDir, convId) {
  if (!SAFE_CONV_ID.test(convId)) return null;
  const resolvedBrain = path.resolve(brainDir);
  const resolvedConv = path.resolve(resolvedBrain, convId);
  const rel = path.relative(resolvedBrain, resolvedConv);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return null;
  if (!fs.existsSync(resolvedConv)) return null;
  return resolvedConv;
}

function readFirstPromptTitle(transcriptPath, fallbackId) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(16384);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const chunk = buf.slice(0, bytes).toString('utf8');
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const step = JSON.parse(line);
          if (step.type === 'USER_INPUT' && step.content) {
            const text = extractUserPromptText(step.content);
            if (text) return text.length > 72 ? `${text.slice(0, 69)}...` : text;
          }
        } catch {}
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return fallbackId.slice(0, 8);
}

export function listConversations(brainDir, limit = 15) {
  const results = [];
  let entries = [];
  try {
    entries = fs.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_CONV_ID.test(entry.name)) continue;
    const convDir = path.join(brainDir, entry.name);
    const transcriptPath = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(transcriptPath).mtimeMs;
    } catch {
      continue;
    }
    const trustDir = path.join(convDir, 'astack-trust');
    results.push({
      id: entry.name,
      title: readFirstPromptTitle(transcriptPath, entry.name),
      updatedAt: new Date(mtimeMs).toISOString(),
      mtimeMs,
      hasTrust: fs.existsSync(trustDir)
    });
  }

  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit).map(({ mtimeMs: _m, ...rest }) => rest);
}

export function scanConversation(brainDir, convId) {
  const convDir = safeConversationDir(brainDir, convId);
  if (!convDir) return null;

  const transcriptPath = path.join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
  const steps = readJsonlSafe(transcriptPath);
  const trustDir = path.join(convDir, 'astack-trust');
  const evidence = readJsonSafe(path.join(trustDir, 'evidence.json'), null);
  const findings = readJsonSafe(path.join(trustDir, 'findings.json'), null);

  let receipts = [];
  try {
    for (const name of fs.readdirSync(trustDir)) {
      if (name.startsWith('receipts.') && name.endsWith('.jsonl')) {
        receipts = receipts.concat(readJsonlSafe(path.join(trustDir, name)));
      }
    }
  } catch {}

  const hasPlanArtifact = fs.existsSync(path.join(convDir, 'implementation_plan.md'));
  const hasPrReviewArtifact = fs.existsSync(path.join(convDir, 'pr-review.md'));
  const hasWalkthroughArtifact = fs.existsSync(path.join(convDir, 'walkthrough.md'));

  const skillsUsed = new Set();
  const playbooksUsed = new Set();
  const editedFiles = new Set();
  const timeline = [];

  let readCount = 0;
  let editCount = 0;
  let lastEditIndex = -1;
  let lastTestIndex = -1;
  let lastValidateIndex = -1;
  let lastCommitIndex = -1;
  let prOpened = false;
  let prUrl = null;
  let watchPrReady = false;
  let verifierRan = Boolean(findings);
  let title = convId.slice(0, 8);
  let firstPromptSet = false;
  let updatedAt = null;

  for (const step of steps) {
    if (step.created_at) updatedAt = step.created_at;

    if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT' && step.content) {
      const prompt = extractUserPromptText(step.content);
      if (prompt) {
        if (!firstPromptSet) {
          title = prompt.length > 72 ? `${prompt.slice(0, 69)}...` : prompt;
          firstPromptSet = true;
        }
        timeline.push({
          ts: step.created_at || null,
          kind: 'user',
          label: 'User prompt',
          detail: prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt,
          status: 'done'
        });
      }
    }

    if (typeof step.content === 'string') {
      const prMatch = step.content.match(/https:\/\/github\.com\/[^\s"']+\/pull\/\d+/);
      if (prMatch) {
        prOpened = true;
        prUrl = prMatch[0];
      }
      if (step.content.includes('READY: no merge conflicts')) {
        watchPrReady = true;
      }
    }

    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const name = tc?.name || '';
        const args = tc?.args || {};

        if (name === 'read_file') {
          readCount += 1;
          const filePath = unquoteArg(args.Path || '');
          const skillMatch = filePath.match(/skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i);
          if (skillMatch) {
            skillsUsed.add(skillMatch[1]);
            timeline.push({
              ts: step.created_at || null,
              kind: 'skill',
              label: `Loaded /${skillMatch[1]}`,
              detail: path.basename(path.dirname(filePath)),
              status: 'done'
            });
          }
          const pbMatch = filePath.match(/playbooks[\\/]([^\\/]+)\.md$/i);
          if (pbMatch) {
            playbooksUsed.add(pbMatch[1]);
            timeline.push({
              ts: step.created_at || null,
              kind: 'playbook',
              label: `Playbook: ${pbMatch[1]}`,
              detail: path.basename(filePath),
              status: 'done'
            });
          }
        } else if (name === 'write_file' || name === 'edit_file') {
          const filePath = unquoteArg(args.Path || '');
          const isScratch = filePath.includes('.gemini') && (filePath.includes('scratch') || filePath.includes('brain'));
          if (!isScratch && filePath) {
            editCount += 1;
            lastEditIndex = step.step_index ?? editCount;
            editedFiles.add(path.basename(filePath));
            timeline.push({
              ts: step.created_at || null,
              kind: 'edit',
              label: name === 'write_file' ? 'Created file' : 'Edited file',
              detail: path.basename(filePath),
              status: 'done'
            });
          }
        } else if (name === 'run_command') {
          const cmd = unquoteArg(args.CommandLine || '');
          const summary = unquoteArg(args.toolSummary || '') || cmd.slice(0, 70);
          if (/\b(test|vitest|jest|pytest)\b|node --run test|node --test/.test(cmd)) {
            lastTestIndex = step.step_index ?? lastTestIndex + 1;
            timeline.push({
              ts: step.created_at || null,
              kind: 'verify',
              label: 'Tests',
              detail: summary,
              status: 'done'
            });
          }
          if (/validate|arch-audit/.test(cmd)) {
            lastValidateIndex = step.step_index ?? lastValidateIndex + 1;
            timeline.push({
              ts: step.created_at || null,
              kind: 'verify',
              label: 'Validation',
              detail: summary,
              status: 'done'
            });
          }
          if (/\bgit commit\b/.test(cmd)) {
            lastCommitIndex = step.step_index ?? lastCommitIndex + 1;
            timeline.push({
              ts: step.created_at || null,
              kind: 'git',
              label: 'Git commit',
              detail: summary,
              status: 'done'
            });
          }
          if (/\bgh pr create\b/.test(cmd)) {
            prOpened = true;
            timeline.push({
              ts: step.created_at || null,
              kind: 'pr',
              label: 'Opened PR',
              detail: summary,
              status: 'done'
            });
          }
          if (/watch-pr\.mjs/.test(cmd)) {
            timeline.push({
              ts: step.created_at || null,
              kind: 'pr',
              label: 'Babysit watcher',
              detail: summary,
              status: 'done'
            });
          }
        } else if (name === 'invoke_subagent') {
          const role = unquoteArg(args.Role || '') || unquoteArg(args.TypeName || 'subagent');
          if (/verifier/i.test(role)) verifierRan = true;
          timeline.push({
            ts: step.created_at || null,
            kind: 'agent',
            label: `Subagent: ${role}`,
            detail: unquoteArg(args.TypeName || ''),
            status: 'done'
          });
        }
      }
    }
  }

  const testsAfterLastEdit = lastEditIndex === -1 || lastTestIndex > lastEditIndex || lastValidateIndex > lastEditIndex;
  const verifierVerdict = findings?.verdict || evidence?.verifier?.verdict || null;
  const importantCount = Array.isArray(findings?.findings)
    ? findings.findings.filter((f) => f.severity === 'important').length
    : evidence?.verifier?.importantCount || 0;

  const stages = [
    {
      number: 1,
      name: 'Understand & Align',
      status: readCount > 0 ? 'done' : 'pending',
      detail: readCount > 0 ? `${readCount} reads · ${skillsUsed.size} skills` : 'No reads recorded yet'
    },
    {
      number: 2,
      name: 'Implementation Plan',
      status: hasPlanArtifact ? 'done' : editCount > 0 ? 'skipped' : 'pending',
      detail: hasPlanArtifact
        ? 'implementation_plan.md present'
        : editCount > 0
          ? 'Skipped (edited directly without /plan)'
          : 'Not started'
    },
    {
      number: 3,
      name: 'Build & Guard',
      status: editCount > 0 ? 'done' : 'pending',
      detail: editCount > 0 ? `${editCount} edits across ${editedFiles.size} files` : 'No workspace edits yet'
    },
    {
      number: 4,
      name: 'Clean & Harden',
      status:
        editCount === 0
          ? 'pending'
          : testsAfterLastEdit && (lastTestIndex >= 0 || lastValidateIndex >= 0)
            ? 'done'
            : 'missed',
      detail:
        editCount === 0
          ? 'Waiting for edits'
          : testsAfterLastEdit
            ? 'Tests & validation ran after latest edit'
            : 'Edits made after last test/validation run'
    },
    {
      number: 5,
      name: 'Live Proof & AI Review',
      status:
        verifierVerdict === 'FAIL'
          ? 'failed'
          : verifierVerdict === 'PASS'
            ? 'done'
            : prOpened && !verifierRan
              ? 'missed'
              : evidence
                ? 'active'
                : 'pending',
      detail:
        verifierVerdict === 'PASS'
          ? `pr-verifier PASS (round ${findings?.round ?? 1})`
          : verifierVerdict === 'FAIL'
            ? `pr-verifier FAIL (${importantCount} important)`
            : prOpened
              ? 'PR opened without pr-verifier verdict'
              : 'Not run yet'
    },
    {
      number: 6,
      name: 'Visual PR Review & Merge',
      status: watchPrReady ? 'done' : prOpened || hasPrReviewArtifact ? 'waiting' : 'pending',
      detail: watchPrReady
        ? 'CI READY & clean for human merge'
        : prOpened
          ? 'PR open · waiting on checks/review'
          : hasWalkthroughArtifact
            ? 'walkthrough.md ready'
            : 'No PR opened yet'
    }
  ];

  let currentStage = stages[0];
  for (const st of stages) {
    if (st.status === 'failed' || st.status === 'missed' || st.status === 'active' || st.status === 'waiting') {
      currentStage = st;
      break;
    }
    if (st.status === 'done') currentStage = st;
  }

  const gaps = [];
  if (editCount > 0 && !testsAfterLastEdit) {
    gaps.push({ severity: 'error', message: 'Workspace files were edited after the last test or validation run.' });
  }
  if (verifierVerdict === 'FAIL') {
    gaps.push({ severity: 'error', message: `Isolated pr-verifier returned FAIL (${importantCount} important findings).` });
  }
  if (evidence?.freshness === 'stale_sha') {
    gaps.push({
      severity: 'warn',
      message: `evidence.json freshness is stale_sha on HEAD ${(evidence.headSha || '').slice(0, 7)} (receipt ledger did not record a fresh post-commit test receipt).`
    });
  }
  if (prOpened && !verifierRan && (evidence?.riskTier ?? 1) >= 1) {
    gaps.push({ severity: 'warn', message: 'PR opened without an isolated pr-verifier findings.json.' });
  }
  if (editCount > 0 && !hasPlanArtifact) {
    gaps.push({ severity: 'info', message: 'Stage 2 (Implementation Plan) was skipped; use /plan /astack-mode for an approval gate before edits.' });
  }
  if (editCount > 0 && lastCommitIndex === -1) {
    gaps.push({ severity: 'info', message: 'No git commit recorded in this conversation yet.' });
  }

  return {
    id: convId,
    title,
    updatedAt,
    stepCount: steps.length,
    currentStage,
    stages,
    gaps,
    skillsUsed: Array.from(skillsUsed).sort(),
    playbooksUsed: Array.from(playbooksUsed).sort(),
    trust: {
      riskTier: evidence?.riskTier ?? null,
      riskLabel: evidence?.riskLabel ?? null,
      freshness: evidence?.freshness ?? null,
      headSha: evidence?.headSha ? evidence.headSha.slice(0, 7) : null,
      verifierVerdict,
      verifierSummary: findings?.summary || null,
      importantCount,
      receiptCount: receipts.length,
      prUrl
    },
    timeline: timeline.slice(-40).reverse()
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
  const brainDir = resolveBrainDir(options);
  const uiHtmlPath = path.join(__dirname, 'ui.html');

  const checkAuth = (req, res, urlObj) => {
    if (token && getToken(req, urlObj) !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return false;
    }
    return true;
  };

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
      if (!checkAuth(req, res, urlObj)) return;
      const overview = collectOverview(pluginRoot);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(overview));
      return;
    }

    if (pathname === '/api/conversations') {
      if (!checkAuth(req, res, urlObj)) return;
      const conversations = listConversations(brainDir);
      const envConv = process.env.ANTIGRAVITY_CONVERSATION_ID?.trim() || null;
      const activeId =
        (envConv && conversations.some((c) => c.id === envConv) ? envConv : null) ||
        conversations[0]?.id ||
        null;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ activeId, conversations }));
      return;
    }

    if (pathname === '/api/conversation') {
      if (!checkAuth(req, res, urlObj)) return;
      let convId = urlObj.searchParams.get('id')?.trim() || process.env.ANTIGRAVITY_CONVERSATION_ID?.trim() || '';
      if (!convId) {
        const recent = listConversations(brainDir, 1);
        convId = recent[0]?.id || '';
      }
      if (!convId) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'No conversations found' }));
        return;
      }
      const scanned = scanConversation(brainDir, convId);
      if (!scanned) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Conversation not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(scanned));
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
