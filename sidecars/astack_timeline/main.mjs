#!/usr/bin/env node
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { COMMAND_DOCS, COLLEAGUE_REVIEW_GUIDE, DELEGATE_GUIDE_DATA } from "./command-catalog.mjs";
import { evaluateTimelineSnapshot, resolveSafeArtifactUri, resolveSafeTaskLogPath } from "./timeline-engine.mjs";
import {
  OUTCOME_SCORES,
  TRUST_CATEGORIES,
  applyTrustSettingsAction,
  compilePrDossier,
  loadRiskPolicy,
  readHeadShaFast,
  recordOutcomeWithTrustSync,
  resolveWorkspaceScope,
  runArchitectureAudit,
} from "../../scripts/trust/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRICT_ID_RE = /^[0-9a-f-]{8,}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_TASK_LOG_BYTES = 256 * 1024;
const MAX_SETTINGS_BODY_BYTES = 16 * 1024;
const ARTIFACT_MIME_TYPES = new Map([
  [".md", "text/markdown; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
]);

const STATIC_ASSETS = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/logo.svg", { file: "../../assets/logo.svg", type: "image/svg+xml; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/living-rail.js", { file: "living-rail.js", type: "application/javascript; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "application/javascript; charset=utf-8" }],
]);

const USAGE = `Usage: node sidecars/astack_timeline/main.mjs [options]

Options:
  --port <number>       HTTP port for standalone server (defaults to env or 0)
  --workspace <dir>     Explicit repository workspace directory
  --brain-dir <dir>     Explicit Antigravity brain directory
  --conversation <id>   Default conversation ID when query omits conversationId
  --standalone          Force zero-dependency node:http server instead of sidecar_sdk
  --allow-fixture-ids   Allow non-UUID fixture conversation IDs
  -h, --help            Show this help text and exit 0`;

function resolveBrainDir(explicitBrainDir) {
  if (explicitBrainDir) return path.resolve(explicitBrainDir);
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== path.dirname(d); d = path.dirname(d)) {
      if (path.basename(d) === "sidecar_data") {
        return path.join(path.dirname(d), "brain");
      }
    }
  }
  return path.join(os.homedir(), ".gemini", "antigravity", "brain");
}

function isValidConversationId(convId, allowFixtureIds) {
  if (!convId || typeof convId !== "string") return false;
  if (convId.includes("..") || convId.includes("/") || convId.includes("\\")) return false;
  return (allowFixtureIds ? SAFE_ID_RE : STRICT_ID_RE).test(convId);
}

function extractWorkspaceDirFromMetadata(parsed) {
  const meta = parsed?.response?.conversationMetadata?.metadata ?? parsed?.metadata ?? {};
  const uri = meta?.workspaces?.[0]?.workspaceFolderAbsoluteUri ?? meta?.workspaceUris?.[0] ?? "";
  if (!uri || typeof uri !== "string") return "";
  try {
    return uri.startsWith("file://") ? fileURLToPath(uri) : uri;
  } catch {
    return "";
  }
}

function fetchConversationMetadataFromAgentApi(convId) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const cmd = exe || "agentapi";
  const args = [...(exe ? ["agentapi"] : []), "get-conversation-metadata", convId];
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 4000 }, (err, stdout) => {
      if (err) {
        return resolve({ ok: false, payload: null, workspaceDir: "", emptyWorkspace: false });
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        if (parsed?.error) {
          return resolve({ ok: false, payload: parsed, workspaceDir: "", emptyWorkspace: false });
        }
        const workspaceDir = extractWorkspaceDirFromMetadata(parsed);
        return resolve({
          ok: true,
          payload: parsed,
          workspaceDir,
          emptyWorkspace: !workspaceDir,
        });
      } catch {
        return resolve({ ok: false, payload: null, workspaceDir: "", emptyWorkspace: false });
      }
    });
  });
}

function normalizeMetadataResult(res) {
  if (typeof res === "string") {
    const dir = res.trim();
    return { ok: Boolean(dir), payload: null, workspaceDir: dir, emptyWorkspace: false };
  }
  if (!res || typeof res !== "object") {
    return { ok: false, payload: null, workspaceDir: "", emptyWorkspace: false };
  }
  const workspaceDir =
    typeof res.workspaceDir === "string"
      ? res.workspaceDir
      : extractWorkspaceDirFromMetadata(res.payload ?? res);
  const ok = Boolean(res.ok || workspaceDir);
  return {
    ok,
    payload: res.payload ?? null,
    workspaceDir,
    emptyWorkspace: ok && !workspaceDir,
  };
}

function makeConversationMetadataResolver({
  fetcher = fetchConversationMetadataFromAgentApi,
  negativeTtlMs = 3000,
  maxNegativeTtlMs = 30_000,
  emptyWorkspaceTtlMs = 60_000,
  maxEntries = 128,
} = {}) {
  const cache = new Map();
  const getOrCreateEntry = (convId) => {
    let entry = cache.get(convId);
    if (!entry) {
      if (cache.size >= maxEntries) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) cache.delete(oldestKey);
      }
      entry = { workspaceDir: "", payload: null, emptyUntil: 0, negativeUntil: 0, failures: 0, pending: null };
      cache.set(convId, entry);
    }
    return entry;
  };
  const markFailure = (entry) => {
    entry.failures += 1;
    const backoff = Math.min(maxNegativeTtlMs, negativeTtlMs * 2 ** (entry.failures - 1));
    entry.negativeUntil = Date.now() + backoff;
  };
  const startPending = (convId, entry) => {
    if (!entry.pending) {
      entry.pending = Promise.resolve()
        .then(() => fetcher(convId))
        .then((res) => {
          entry.pending = null;
          const norm = normalizeMetadataResult(res);
          if (norm.workspaceDir) {
            entry.workspaceDir = norm.workspaceDir;
            entry.payload = norm.payload;
            entry.failures = 0;
            entry.negativeUntil = 0;
            entry.emptyUntil = 0;
          } else if (norm.ok) {
            entry.payload = norm.payload;
            entry.failures = 0;
            entry.negativeUntil = 0;
            entry.emptyUntil = Date.now() + emptyWorkspaceTtlMs;
          } else {
            markFailure(entry);
          }
          return norm;
        })
        .catch(() => {
          entry.pending = null;
          markFailure(entry);
          return { ok: false, payload: null, workspaceDir: "", emptyWorkspace: false };
        });
    }
    return entry.pending;
  };
  return {
    peek(convId) {
      if (!convId) return null;
      const entry = cache.get(convId);
      if (!entry) return null;
      const now = Date.now();
      return {
        workspaceDir: entry.workspaceDir,
        payload: entry.payload,
        hasEmptyCache: Boolean(entry.payload && now < entry.emptyUntil),
        inBackoff: now < entry.negativeUntil,
        pending: entry.pending,
      };
    },
    resolvePending(convId) {
      if (!convId) {
        return Promise.resolve({ ok: false, payload: null, workspaceDir: "", emptyWorkspace: false });
      }
      const entry = getOrCreateEntry(convId);
      return startPending(convId, entry);
    },
    async getMetadata(convId) {
      if (!convId) {
        return { ok: false, payload: null, workspaceDir: "", emptyWorkspace: false };
      }
      const entry = getOrCreateEntry(convId);
      const now = Date.now();
      if (entry.workspaceDir && entry.payload) {
        return { ok: true, payload: entry.payload, workspaceDir: entry.workspaceDir, emptyWorkspace: false };
      }
      if (entry.payload && now < entry.emptyUntil) {
        return { ok: true, payload: entry.payload, workspaceDir: "", emptyWorkspace: true };
      }
      if (!entry.pending && now < entry.negativeUntil) {
        return { ok: false, payload: entry.payload, workspaceDir: "", emptyWorkspace: false };
      }
      return startPending(convId, entry);
    },
  };
}

function resolveWorkspaceUriInput(rawUri) {
  if (typeof rawUri !== "string") return "";
  const trimmed = rawUri.trim();
  if (!trimmed || trimmed.includes("\0") || /^(?:\\\\|\/\/)/.test(trimmed)) return "";
  try {
    let dir = "";
    if (/^file:\/\//i.test(trimmed)) {
      const parsed = new URL(trimmed);
      if (parsed.hostname && parsed.hostname.toLowerCase() !== "localhost") return "";
      dir = fileURLToPath(parsed);
    } else if (path.isAbsolute(trimmed)) {
      dir = path.resolve(trimmed);
    } else {
      return "";
    }
    if (!dir || /^(?:\\\\|\/\/)/.test(dir)) return "";
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      return dir;
    }
  } catch {
    return "";
  }
  return "";
}

function makeWorkspaceResolver({
  explicitWorkspace = "",
  fetcher = null,
  metadataResolver = null,
  waitBudgetMs = 250,
  hasExplicitWaitBudget = false,
  negativeTtlMs = 3000,
  emptyWorkspaceTtlMs = 60_000,
} = {}) {
  const sharedMeta =
    metadataResolver ||
    makeConversationMetadataResolver({
      ...(fetcher
        ? {
            fetcher: async (convId) => {
              const dir = await fetcher(convId);
              return { ok: Boolean(dir), payload: null, workspaceDir: dir || "", emptyWorkspace: false };
            },
          }
        : {}),
      negativeTtlMs,
      emptyWorkspaceTtlMs,
    });
  return async (convId, workspaceUri = "") => {
    if (explicitWorkspace) return path.resolve(explicitWorkspace);
    const fallbackDir = resolveWorkspaceUriInput(workspaceUri) || process.env.ANTIGRAVITY_WORKSPACE_DIR || "";
    if (convId) {
      const peeked = sharedMeta.peek(convId);
      if (peeked?.workspaceDir) return peeked.workspaceDir;
      if (peeked && (peeked.hasEmptyCache || peeked.inBackoff) && !peeked.pending) {
        return fallbackDir;
      }
      const pending = peeked?.pending || sharedMeta.resolvePending(convId);
      if (waitBudgetMs > 0 && (!fallbackDir || hasExplicitWaitBudget)) {
        const res = await Promise.race([
          pending,
          new Promise((resolve) => setTimeout(() => resolve(null), waitBudgetMs)),
        ]);
        if (res?.workspaceDir) return res.workspaceDir;
      }
      return fallbackDir;
    }
    return fallbackDir;
  };
}

const staticAssetCache = new Map();
let cachedCatalogScript = null;

function readStaticAsset(asset) {
  const filePath = path.join(__dirname, ...asset.file.split("/"));
  try {
    const st = fs.statSync(filePath);
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = staticAssetCache.get(filePath);
    if (hit && hit.key === key) return hit.body;
    const body = fs.readFileSync(filePath, "utf8");
    staticAssetCache.set(filePath, { key, body });
    return body;
  } catch {
    return fs.readFileSync(filePath, "utf8");
  }
}

function buildStandalonePreloadScript(defaultConvId) {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const dark = params.get("theme") === "dark" || (params.get("theme") !== "light" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const root = document.documentElement.style;
  if (dark) {
    root.setProperty("--background", "#0b0b0c");
    root.setProperty("--card", "#141416");
    root.setProperty("--foreground", "#e8e8ea");
    root.setProperty("--muted-foreground", "#9ba1a6");
    root.setProperty("--border", "rgba(255, 255, 255, 0.08)");
    root.setProperty("--primary", "#5aa2ff");
    root.setProperty("--error", "#f06b6b");
  } else {
    root.setProperty("--background", "#f7f7f8");
    root.setProperty("--card", "#ffffff");
    root.setProperty("--foreground", "#1d1f21");
    root.setProperty("--muted-foreground", "#5d676f");
    root.setProperty("--border", "rgba(0, 0, 0, 0.08)");
    root.setProperty("--primary", "#0068b8");
    root.setProperty("--error", "#c43030");
  }
  window.sidecar = {
    standalone: true,
    conversationId: params.get("conversationId") || ${JSON.stringify(defaultConvId || "")},
    getWorkspaceUris: async () => {
      const w = params.get("workspaceUri");
      return w ? [w] : [];
    },
  };
})();\n`;
}

function buildCatalogScript() {
  if (!cachedCatalogScript) {
    cachedCatalogScript = `window.ASTACK_CATALOG = ${JSON.stringify({
      delegateGuide: DELEGATE_GUIDE_DATA,
      colleagueReviewGuide: COLLEAGUE_REVIEW_GUIDE,
      commandDocs: COMMAND_DOCS,
    })};\n`;
  }
  return cachedCatalogScript;
}

function fetchGhPrMeta(workspaceDir) {
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "40", "--json", "number,title,state,url"],
      { cwd: workspaceDir, encoding: "utf8", timeout: 4000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) return resolve(null);
          const map = new Map();
          for (const item of parsed) {
            const num = Number(item?.number);
            if (!Number.isFinite(num) || num <= 0) continue;
            map.set(num, {
              number: num,
              title: typeof item.title === "string" ? item.title : null,
              state: typeof item.state === "string" ? item.state.toLowerCase() : null,
              url: typeof item.url === "string" ? item.url : null,
            });
          }
          return resolve(map);
        } catch {
          return resolve(null);
        }
      },
    );
  });
}

function makePrStatusResolver({ enabled = true, fetcher = fetchGhPrMeta, ttlMs = 30_000, waitBudgetMs = 350 } = {}) {
  const cache = new Map();
  const resolver = async (workspaceDir) => {
    if (!enabled || !workspaceDir) return null;
    const key = path.resolve(workspaceDir);
    const now = Date.now();
    const entry = cache.get(key) || { map: null, fetchedAt: 0, pending: null };
    if (entry.fetchedAt && now - entry.fetchedAt < ttlMs) {
      return entry.map;
    }
    if (!entry.pending) {
      entry.pending = Promise.resolve()
        .then(() => fetcher(key))
        .then((res) => {
          entry.fetchedAt = Date.now();
          if (res instanceof Map) entry.map = res;
          entry.pending = null;
          return entry.map;
        })
        .catch(() => {
          entry.fetchedAt = Date.now();
          entry.pending = null;
          return entry.map;
        });
      cache.set(key, entry);
    }
    if (entry.map) return entry.map;
    if (waitBudgetMs <= 0) return null;
    return Promise.race([
      entry.pending,
      new Promise((resolve) => setTimeout(() => resolve(entry.map), waitBudgetMs)),
    ]);
  };
  resolver.peek = (workspaceDir) => {
    if (!enabled || !workspaceDir) return null;
    const entry = cache.get(path.resolve(workspaceDir));
    return entry?.map ?? null;
  };
  return resolver;
}

function toFileUrl(absPath, line = 1) {
  const safeLine = Number.isInteger(line) && line > 0 ? line : 1;
  return `${pathToFileURL(path.resolve(absPath)).href}#L${safeLine}`;
}

function createTimelineResponder({
  brainDir,
  defaultConversationId = "",
  allowFixtureIds = false,
  workspaceResolver,
  prStatusResolver = null,
  dataDir = null,
}) {
  const inFlight = new Map();
  let generation = 0;
  const respond = async ({ conversationId = "", etag = "", workspaceUri = "" } = {}) => {
    const rawConv = String(conversationId || defaultConversationId || "").trim();
    if (rawConv && !isValidConversationId(rawConv, allowFixtureIds)) {
      return { status: 400, body: { error: "Invalid conversationId" } };
    }

    const reqGen = generation;
    const flightKey = `${reqGen}|${rawConv}|${workspaceUri}`;
    let pending = inFlight.get(flightKey);
    if (!pending) {
      pending = (async () => {
        try {
          const workspaceDir = await workspaceResolver(rawConv, workspaceUri);
          const cachedPrMeta = prStatusResolver?.peek && workspaceDir ? prStatusResolver.peek(workspaceDir) : null;
          let snap = evaluateTimelineSnapshot({
            conversationId: rawConv,
            brainDir,
            workspaceDir,
            ...(cachedPrMeta ? { prMetaByNumber: cachedPrMeta } : {}),
            dataDir,
          });
          if (prStatusResolver && workspaceDir && (snap.activity?.prs?.totalCount ?? 0) > 0) {
            const prMetaByNumber = await prStatusResolver(workspaceDir);
            if (prMetaByNumber && prMetaByNumber.size > 0 && prMetaByNumber !== cachedPrMeta) {
              snap = evaluateTimelineSnapshot({
                conversationId: rawConv,
                brainDir,
                workspaceDir,
                prMetaByNumber,
                dataDir,
              });
            }
          }
          return { status: 200, body: snap };
        } catch (err) {
          return { status: 500, body: { error: err?.message || "Failed to evaluate timeline" } };
        } finally {
          inFlight.delete(flightKey);
        }
      })();
      inFlight.set(flightKey, pending);
    }

    const result = await pending;
    if (result.status === 200 && etag && etag === result.body.etag) {
      return { status: 200, body: { conversationId: rawConv || null, unchanged: true, etag: result.body.etag } };
    }
    return result;
  };
  respond.invalidate = () => {
    generation += 1;
    inFlight.clear();
  };
  return respond;
}

function createTrustSettingsResponder({
  defaultConversationId = "",
  allowFixtureIds = false,
  workspaceResolver,
  dataDir = null,
  onMutation = null,
}) {
  return async (payload = {}) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { status: 400, body: { error: "Invalid JSON payload" } };
    }
    const rawConv = String(payload.conversationId || defaultConversationId || "").trim();
    if (rawConv && !isValidConversationId(rawConv, allowFixtureIds)) {
      return { status: 400, body: { error: "Invalid conversationId" } };
    }
    const workspaceDir = await workspaceResolver(rawConv, payload.workspaceUri ?? "");
    const scope = workspaceDir ? resolveWorkspaceScope(workspaceDir) : { kind: "non_repo" };
    if (scope.kind !== "enrolled_repo" || !scope.repoId) {
      return { status: 400, body: { error: "Trust settings require an enrolled git repository" } };
    }
    const { policy } = loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
    try {
      if (payload.recordOutcome && typeof payload.recordOutcome === "object") {
        const ro = payload.recordOutcome;
        const cat = String(ro.category ?? "").toLowerCase();
        const outcome = String(ro.outcome ?? "").toLowerCase();
        if (!TRUST_CATEGORIES.includes(cat)) {
          return { status: 400, body: { error: "Invalid category" } };
        }
        if (!Object.hasOwn(OUTCOME_SCORES, outcome)) {
          return { status: 400, body: { error: "Invalid outcome" } };
        }
        const sha = typeof ro.headSha === "string" && ro.headSha.trim()
          ? ro.headSha.trim()
          : readHeadShaFast(scope.repoRoot);
        const res = recordOutcomeWithTrustSync({
          workspaceDir: scope.repoRoot,
          scope,
          policy,
          category: cat,
          outcome,
          headSha: sha,
          predictedR: Number.isFinite(Number(ro.predictedR)) ? Number(ro.predictedR) : 0,
          prNumber: Number.isInteger(ro.prNumber) ? ro.prNumber : null,
          source: "timeline",
          note: typeof ro.note === "string" ? ro.note : "",
          dataDir,
        });
        onMutation?.();
        return { status: 200, body: { ok: true, entry: res.entry, trust: res.trust } };
      }

      const action = {};
      if (typeof payload.beastOn === "boolean") action.beastOn = payload.beastOn;
      if (payload.promotionMode === "manual" || payload.promotionMode === "auto") {
        action.promotionMode = payload.promotionMode;
      } else if (payload.promotionMode !== undefined) {
        return { status: 400, body: { error: "promotionMode must be manual or auto" } };
      }
      if (payload.setCeiling !== undefined) {
        if (!payload.setCeiling || typeof payload.setCeiling !== "object") {
          return { status: 400, body: { error: "Invalid setCeiling payload" } };
        }
        action.setCeiling = payload.setCeiling;
      }
      if (payload.promoteCategory !== undefined) {
        action.promoteCategory = String(payload.promoteCategory);
      }
      if (payload.undoAutoPromo === true) {
        action.undoAutoPromo = true;
      }
      if (Object.keys(action).length === 0) {
        return { status: 400, body: { error: "No valid trust settings action supplied" } };
      }

      const res = applyTrustSettingsAction({
        repoId: scope.repoId,
        policy,
        action,
        dataDir,
      });
      onMutation?.();
      return { status: 200, body: { ok: true, settings: res.settings, trust: res.trust } };
    } catch (err) {
      return { status: 400, body: { error: err.message } };
    }
  };
}

function readBoundedJsonBody(req, maxBytes = MAX_SETTINGS_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      req.resume();
      reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
      return;
    }
    const chunks = [];
    let total = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (overflow) {
        if (total > maxBytes * 8) req.destroy();
        return;
      }
      if (total > maxBytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflow) {
        reject(Object.assign(new Error("Payload too large"), { statusCode: 413 }));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text.trim() ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error("Malformed JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function artifactJson(status, payload) {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(payload),
  };
}

function readTaskLogBounded(filePath) {
  const st = fs.statSync(filePath);
  if (st.size <= MAX_TASK_LOG_BYTES) {
    return fs.readFileSync(filePath, "utf8");
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(MAX_TASK_LOG_BYTES);
    fs.readSync(fd, buf, 0, MAX_TASK_LOG_BYTES, st.size - MAX_TASK_LOG_BYTES);
    const totalKb = Math.round(st.size / 1024);
    return `[...showing last 256 KB of ${totalKb} KB task log...]\n\n${buf.toString("utf8")}`;
  } finally {
    fs.closeSync(fd);
  }
}

function createArtifactResponder({
  brainDir,
  defaultConversationId = "",
  allowFixtureIds = false,
}) {
  return async ({ conversationId = "", name = "", taskLog = "", raw = false } = {}) => {
    const rawConv = String(conversationId || defaultConversationId || "").trim();
    const rawTaskLog = String(taskLog || "").trim();
    const rawName = String(name || "").trim();
    if (!rawConv || !isValidConversationId(rawConv, allowFixtureIds)) {
      return artifactJson(400, { error: "Invalid conversationId" });
    }
    if (rawTaskLog) {
      if (!/^task-\d+\.log$/.test(rawTaskLog)) {
        return artifactJson(400, { error: "Invalid task log name" });
      }
      const logPath = resolveSafeTaskLogPath(path.join(brainDir, rawConv), rawTaskLog);
      if (!logPath) {
        return artifactJson(404, { error: "Task log not found" });
      }
      try {
        const content = readTaskLogBounded(logPath);
        if (raw) {
          return {
            status: 200,
            contentType: "text/plain; charset=utf-8",
            headers: { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
            body: Buffer.from(content, "utf8"),
          };
        }
        return artifactJson(200, {
          name: rawTaskLog,
          kind: "text",
          mimeType: "text/plain; charset=utf-8",
          content,
        });
      } catch {
        return artifactJson(404, { error: "Task log not found" });
      }
    }
    if (!rawName || /[\\/%:\0]/.test(rawName) || rawName === "." || rawName === "..") {
      return artifactJson(400, { error: "Invalid artifact name" });
    }
    const ext = path.extname(rawName).toLowerCase();
    const mimeType = ARTIFACT_MIME_TYPES.get(ext);
    if (!mimeType) {
      return artifactJson(403, { error: "Unsupported artifact type" });
    }
    const uri = resolveSafeArtifactUri(path.join(brainDir, rawConv), rawName);
    if (!uri) {
      return artifactJson(404, { error: "Artifact not found" });
    }
    let filePath = "";
    try {
      filePath = fileURLToPath(uri);
      const st = fs.statSync(filePath);
      if (st.size > MAX_ARTIFACT_BYTES) {
        return artifactJson(413, { error: "Artifact exceeds size limit" });
      }
      if (raw) {
        const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
        if (ext === ".svg" || ext === ".html") {
          headers["Content-Security-Policy"] = "sandbox";
        }
        return { status: 200, contentType: mimeType, headers, body: fs.readFileSync(filePath) };
      }
      if (ext === ".md" || ext === ".txt" || ext === ".html") {
        return artifactJson(200, {
          name: rawName,
          kind: ext === ".md" ? "markdown" : "text",
          mimeType,
          content: fs.readFileSync(filePath, "utf8"),
        });
      }
      if (ext === ".pdf") {
        return artifactJson(200, { name: rawName, kind: "pdf", mimeType });
      }
      return artifactJson(200, { name: rawName, kind: "image", mimeType });
    } catch {
      return artifactJson(404, { error: "Artifact not found" });
    }
  };
}

function createDossierResponder({
  brainDir,
  defaultConversationId = "",
  allowFixtureIds = false,
  workspaceResolver,
}) {
  return async ({ conversationId = "", workspaceUri = "" } = {}) => {
    const rawConv = String(conversationId || defaultConversationId || "").trim();
    if (rawConv && !isValidConversationId(rawConv, allowFixtureIds)) {
      return { status: 400, body: { error: "Invalid conversationId" } };
    }
    const workspaceDir = await workspaceResolver(rawConv, workspaceUri);
    if (!workspaceDir) {
      return {
        status: 200,
        body: { ok: false, reason: "no_workspace", message: "Open a git repository to inspect its PR dossier." },
      };
    }
    const scope = resolveWorkspaceScope(workspaceDir, { checkEnrollment: false });
    if (scope.kind === "non_repo") {
      return {
        status: 200,
        body: { ok: false, reason: "non_repo", workspaceDir, message: "Current workspace is not a git repository." },
      };
    }
    const convDir = rawConv ? path.join(brainDir, rawConv) : null;
    const artifactDir = convDir && fs.existsSync(convDir) ? convDir : null;
    try {
      const result = compilePrDossier({
        cwd: scope.repoRoot,
        artifactDir,
        writeEvidence: false,
      });
      const clustersWithUris = (result.evidence.clusters ?? []).slice(0, 40).map((c) => ({
        ...c,
        fileLinks: (c.files ?? []).slice(0, 50).map((rel) => {
          const line = c.firstLines?.[rel] ?? 1;
          return {
            path: rel,
            line,
            uri: toFileUrl(path.resolve(scope.repoRoot, rel), line),
          };
        }),
      }));
      const enrichedFindingsDoc = result.findingsDoc
        ? {
            ...result.findingsDoc,
            findings: Array.isArray(result.findingsDoc.findings)
              ? result.findingsDoc.findings.slice(0, 100).map((f) => ({
                  ...f,
                  uri: f.file ? toFileUrl(path.resolve(scope.repoRoot, f.file), f.line || 1) : null,
                }))
              : [],
          }
        : null;
      return {
        status: 200,
        body: {
          ok: true,
          workspaceDir: scope.repoRoot,
          evidence: { ...result.evidence, clusters: clustersWithUris },
          findingsDoc: enrichedFindingsDoc,
        },
      };
    } catch (err) {
      return {
        status: 200,
        body: { ok: false, reason: "error", workspaceDir: scope.repoRoot, message: err.message },
      };
    }
  };
}

function createArchAuditResponder({
  defaultConversationId = "",
  allowFixtureIds = false,
  workspaceResolver,
}) {
  return async ({ conversationId = "", workspaceUri = "" } = {}) => {
    const rawConv = String(conversationId || defaultConversationId || "").trim();
    if (rawConv && !isValidConversationId(rawConv, allowFixtureIds)) {
      return { status: 400, body: { error: "Invalid conversationId" } };
    }
    const workspaceDir = await workspaceResolver(rawConv, workspaceUri);
    if (!workspaceDir) {
      return {
        status: 200,
        body: { ok: false, reason: "no_workspace", message: "Open a workspace to run an architecture audit." },
      };
    }
    try {
      const report = runArchitectureAudit({ cwd: workspaceDir });
      return {
        status: 200,
        body: {
          ok: true,
          workspaceDir,
          report: {
            ...report,
            boundaryViolations: (report.boundaryViolations ?? []).slice(0, 100).map((v) => ({
              ...v,
              uri: toFileUrl(path.resolve(workspaceDir, v.file), 1),
            })),
            bannedHits: (report.bannedHits ?? []).slice(0, 100).map((b) => ({
              ...b,
              uri: toFileUrl(path.resolve(workspaceDir, b.file), 1),
            })),
            shallowModules: (report.shallowModules ?? []).slice(0, 100).map((m) => ({
              ...m,
              uri: toFileUrl(path.resolve(workspaceDir, m.file), 1),
            })),
            gardeningHits: (report.gardeningHits ?? []).slice(0, 100).map((g) => ({
              ...g,
              uri: toFileUrl(path.resolve(workspaceDir, g.file), g.line || 1),
            })),
          },
        },
      };
    } catch (err) {
      return {
        status: 200,
        body: { ok: false, reason: "error", workspaceDir, message: err.message },
      };
    }
  };
}

function isTokenAuthorized(req, url, expectedToken) {
  if (!expectedToken) return true;
  const headerToken = req.headers["x-sidecar-token"];
  if (typeof headerToken === "string" && headerToken === expectedToken) return true;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth === `Bearer ${expectedToken}`) return true;
  return url.searchParams.get("token") === expectedToken;
}

function isLoopbackHostHeader(hostHeader, boundPort) {
  if (typeof hostHeader !== "string") return false;
  const raw = hostHeader.trim();
  if (!raw || /[\s@\\/?#]/.test(raw)) return false;
  let parsed;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    return false;
  }
  if (!parsed.port) return boundPort === 80;
  return Number(parsed.port) === boundPort;
}

function isLoopbackOriginHeader(originHeader, boundPort) {
  if (originHeader === undefined || originHeader === "") return true;
  if (typeof originHeader !== "string") return false;
  const raw = originHeader.trim();
  if (!raw || raw === "null" || /\s/.test(raw)) return false;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    return false;
  }
  if (!parsed.port) return boundPort === 80;
  return Number(parsed.port) === boundPort;
}

function writeJsonResponse(res, status, payload, isHead = false) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(isHead ? "" : JSON.stringify(payload));
}

function createSidecarResponders(options = {}, defaultConvOverride = "") {
  const brainDir = resolveBrainDir(options.brainDir);
  const allowFixtureIds = Boolean(options.allowFixtureIds);
  const defaultConversationId = String(defaultConvOverride || options.conversationId || "").trim();
  const metadataResolver =
    !options.workspaceFetcher
      ? makeConversationMetadataResolver({
          ...(options.metadataFetcher ? { fetcher: options.metadataFetcher } : {}),
          ...(Number.isFinite(options.workspaceNegativeTtlMs) ? { negativeTtlMs: options.workspaceNegativeTtlMs } : {}),
          ...(Number.isFinite(options.workspaceEmptyTtlMs) ? { emptyWorkspaceTtlMs: options.workspaceEmptyTtlMs } : {}),
        })
      : null;
  const workspaceResolver = makeWorkspaceResolver({
    explicitWorkspace: options.workspaceDir || "",
    ...(options.workspaceFetcher ? { fetcher: options.workspaceFetcher } : {}),
    ...(metadataResolver ? { metadataResolver } : {}),
    ...(Number.isFinite(options.workspaceWaitBudgetMs)
      ? { waitBudgetMs: options.workspaceWaitBudgetMs, hasExplicitWaitBudget: true }
      : {}),
    ...(Number.isFinite(options.workspaceNegativeTtlMs) ? { negativeTtlMs: options.workspaceNegativeTtlMs } : {}),
    ...(Number.isFinite(options.workspaceEmptyTtlMs) ? { emptyWorkspaceTtlMs: options.workspaceEmptyTtlMs } : {}),
  });
  const prStatusResolver =
    options.prStatusResolver ||
    makePrStatusResolver({
      enabled: options.enableGhLookup ?? !allowFixtureIds,
      ...(options.prStatusFetcher ? { fetcher: options.prStatusFetcher } : {}),
    });
  const dataDir = options.dataDir ? path.resolve(options.dataDir) : null;
  const respondTimeline = createTimelineResponder({
    brainDir,
    defaultConversationId,
    allowFixtureIds,
    workspaceResolver,
    prStatusResolver,
    dataDir,
  });
  const respondTrustSettings = createTrustSettingsResponder({
    defaultConversationId,
    allowFixtureIds,
    workspaceResolver,
    dataDir,
    onMutation: () => respondTimeline.invalidate(),
  });
  const respondArtifact = createArtifactResponder({
    brainDir,
    defaultConversationId,
    allowFixtureIds,
  });
  const respondDossier = createDossierResponder({
    brainDir,
    defaultConversationId,
    allowFixtureIds,
    workspaceResolver,
  });
  const respondArchAudit = createArchAuditResponder({
    defaultConversationId,
    allowFixtureIds,
    workspaceResolver,
  });
  return {
    allowFixtureIds,
    defaultConversationId,
    metadataResolver,
    respondTimeline,
    respondTrustSettings,
    respondArtifact,
    respondDossier,
    respondArchAudit,
  };
}

/**
 * Starts the standalone read-only HTTP server on `127.0.0.1` for browser tests and local preview.
 */
export async function createTimelineServer(options = {}) {
  const defaultConvId = String(options.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? "").trim();
  const token = options.token ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? "";
  const {
    respondTimeline,
    respondTrustSettings,
    respondArtifact,
    respondDossier,
    respondArchAudit,
  } = createSidecarResponders(options, defaultConvId);

  const requestedPort = Number.isFinite(options.port) ? options.port : 0;

  const server = http.createServer(async (req, res) => {
    const isHead = req.method === "HEAD";
    const addr = server.address();
    const activePort = typeof addr === "object" && addr ? addr.port : requestedPort;
    if (!isLoopbackHostHeader(req.headers.host, activePort)) {
      writeJsonResponse(res, 403, { error: "Forbidden host" }, isHead);
      return;
    }

    let reqUrl;
    try {
      reqUrl = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      writeJsonResponse(res, 400, { error: "Bad request" }, isHead);
      return;
    }

    if (reqUrl.pathname === "/api/trust/settings") {
      if (req.method !== "POST") {
        writeJsonResponse(res, 405, { error: "Method not allowed" }, isHead);
        return;
      }
      if (
        String(req.headers["sec-fetch-site"] ?? "").trim().toLowerCase() === "cross-site" ||
        !isLoopbackOriginHeader(req.headers.origin, activePort)
      ) {
        writeJsonResponse(res, 403, { error: "Forbidden origin" }, false);
        return;
      }
      if (!token || !isTokenAuthorized(req, reqUrl, token)) {
        writeJsonResponse(res, 401, { error: "Unauthorized" }, false);
        return;
      }
      const contentType = String(req.headers["content-type"] ?? "").trim();
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
        writeJsonResponse(res, 415, { error: "Content-Type must be application/json" }, false);
        return;
      }
      try {
        const body = await readBoundedJsonBody(req);
        const result = await respondTrustSettings(body);
        writeJsonResponse(res, result.status, result.body, false);
      } catch (err) {
        writeJsonResponse(res, err?.statusCode || 400, { error: err?.message || "Bad request" }, false);
      }
      return;
    }

    if (req.method !== "GET" && !isHead) {
      writeJsonResponse(res, 405, { error: "Method not allowed" }, isHead);
      return;
    }

    const staticAsset = STATIC_ASSETS.get(reqUrl.pathname);
    if (staticAsset) {
      const body = readStaticAsset(staticAsset);
      res.writeHead(200, { "Content-Type": staticAsset.type, "Cache-Control": "no-store" });
      res.end(isHead ? "" : body);
      return;
    }

    if (reqUrl.pathname === "/preload.js") {
      const preload = buildStandalonePreloadScript(defaultConvId);
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(isHead ? "" : preload);
      return;
    }

    if (reqUrl.pathname === "/catalog.js") {
      const catalogJs = buildCatalogScript();
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(isHead ? "" : catalogJs);
      return;
    }

    if (reqUrl.pathname === "/api/timeline") {
      if (!isTokenAuthorized(req, reqUrl, token)) {
        writeJsonResponse(res, 401, { error: "Unauthorized" }, isHead);
        return;
      }
      const { status, body } = await respondTimeline({
        conversationId: reqUrl.searchParams.get("conversationId") ?? "",
        etag: reqUrl.searchParams.get("etag") ?? "",
        workspaceUri: reqUrl.searchParams.get("workspaceUri") ?? "",
      });
      writeJsonResponse(res, status, body, isHead);
      return;
    }

    if (reqUrl.pathname === "/api/artifact") {
      if (!isTokenAuthorized(req, reqUrl, token)) {
        writeJsonResponse(res, 401, { error: "Unauthorized" }, isHead);
        return;
      }
      const artRes = await respondArtifact({
        conversationId: reqUrl.searchParams.get("conversationId") ?? "",
        name: reqUrl.searchParams.get("name") ?? "",
        taskLog: reqUrl.searchParams.get("taskLog") ?? "",
        raw: reqUrl.searchParams.get("raw") === "1",
      });
      res.writeHead(artRes.status, { "Content-Type": artRes.contentType, ...artRes.headers });
      res.end(isHead ? "" : artRes.body);
      return;
    }

    if (reqUrl.pathname === "/api/dossier") {
      if (!isTokenAuthorized(req, reqUrl, token)) {
        writeJsonResponse(res, 401, { error: "Unauthorized" }, isHead);
        return;
      }
      const { status, body } = await respondDossier({
        conversationId: reqUrl.searchParams.get("conversationId") ?? "",
        workspaceUri: reqUrl.searchParams.get("workspaceUri") ?? "",
      });
      writeJsonResponse(res, status, body, isHead);
      return;
    }

    if (reqUrl.pathname === "/api/arch-audit") {
      if (!isTokenAuthorized(req, reqUrl, token)) {
        writeJsonResponse(res, 401, { error: "Unauthorized" }, isHead);
        return;
      }
      const { status, body } = await respondArchAudit({
        conversationId: reqUrl.searchParams.get("conversationId") ?? "",
        workspaceUri: reqUrl.searchParams.get("workspaceUri") ?? "",
      });
      writeJsonResponse(res, status, body, isHead);
      return;
    }

    writeJsonResponse(res, 404, { error: "Not found" }, isHead);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", resolve);
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : requestedPort;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/**
 * Boots the sidecar using `sidecar_sdk` inside Antigravity or falls back to standalone `127.0.0.1` HTTP.
 */
export async function startTimelineSidecar(options = {}) {
  if (!options.standalone) {
    try {
      const { SidecarApp, Response } = options.sdk || (await import("sidecar_sdk"));
      const app = new SidecarApp();
      const defaultConvOverride = String(app.config?.conversationId ?? options.conversationId ?? "");
      const {
        allowFixtureIds,
        metadataResolver,
        respondTimeline,
        respondTrustSettings,
        respondArtifact,
        respondDossier,
        respondArchAudit,
      } = createSidecarResponders(options, defaultConvOverride);

      const rootAsset = STATIC_ASSETS.get("/");
      app.page("/", () => readStaticAsset(rootAsset));
      for (const [assetPath, asset] of STATIC_ASSETS.entries()) {
        if (assetPath === "/") continue;
        app.api(assetPath, () => new Response(readStaticAsset(asset), { contentType: asset.type }), "GET");
      }
      app.api(
        "/catalog.js",
        () => new Response(buildCatalogScript(), { contentType: "application/javascript; charset=utf-8" }),
        "GET",
      );
      app.api("/api/timeline", async (data) => {
        const res = await respondTimeline({
          conversationId: data?.conversationId ?? "",
          etag: data?.etag ?? "",
          workspaceUri: data?.workspaceUri ?? "",
        });
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          contentType: "application/json; charset=utf-8",
        });
      }, "POST");
      app.api("/api/artifact", async (data) => {
        const artRes = await respondArtifact({
          conversationId: data?.conversationId ?? "",
          name: data?.name ?? "",
          taskLog: data?.taskLog ?? "",
          raw: data?.raw === "1" || data?.raw === true,
        });
        return new Response(artRes.body, {
          status: artRes.status,
          contentType: artRes.contentType,
          headers: artRes.headers,
        });
      }, "POST");

      app.api("/api/trust/settings", async (data) => {
        const res = await respondTrustSettings(data ?? {});
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          contentType: "application/json; charset=utf-8",
        });
      }, "POST");

      app.api("/api/dossier", async (data) => {
        const res = await respondDossier({
          conversationId: data?.conversationId ?? "",
          workspaceUri: data?.workspaceUri ?? "",
        });
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          contentType: "application/json; charset=utf-8",
        });
      }, "POST");

      app.api("/api/arch-audit", async (data) => {
        const res = await respondArchAudit({
          conversationId: data?.conversationId ?? "",
          workspaceUri: data?.workspaceUri ?? "",
        });
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          contentType: "application/json; charset=utf-8",
        });
      }, "POST");

      await app.run();
      if (metadataResolver) {
        app.api("/_sidecar/get-conversation-metadata", async (data) => {
          const convId = String(data?.conversationId ?? "").trim();
          if (!convId || !isValidConversationId(convId, allowFixtureIds)) {
            return new Response(JSON.stringify({ error: "Invalid conversationId" }), {
              status: 400,
              contentType: "application/json; charset=utf-8",
            });
          }
          const meta = await metadataResolver.getMetadata(convId);
          return new Response(JSON.stringify(meta.payload ?? {}), {
            status: 200,
            contentType: "application/json; charset=utf-8",
          });
        }, "POST");
      }
      return { mode: "sidecar_sdk", close: async () => {} };
    } catch (err) {
      if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    }
  }

  const envPort = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "", 10);
  const port = Number.isFinite(options.port) ? options.port : (Number.isFinite(envPort) ? envPort : 0);
  const srv = await createTimelineServer({ ...options, port });
  return { mode: "standalone", ...srv };
}

function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      workspace: { type: "string" },
      "brain-dir": { type: "string" },
      conversation: { type: "string" },
      standalone: { type: "boolean", default: false },
      "allow-fixture-ids": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const parsedPort = values.port !== undefined ? Number.parseInt(values.port, 10) : undefined;
  const cliToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || crypto.randomBytes(24).toString("hex");
  startTimelineSidecar({
    port: Number.isFinite(parsedPort) ? parsedPort : undefined,
    workspaceDir: values.workspace || "",
    brainDir: values["brain-dir"] || "",
    conversationId: values.conversation || "",
    token: cliToken,
    standalone: values.standalone,
    allowFixtureIds: values["allow-fixture-ids"],
  }).then((started) => {
    if (started.mode === "standalone") {
      process.stdout.write(`AStack Timeline listening at ${started.url}?token=${cliToken}\n`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
