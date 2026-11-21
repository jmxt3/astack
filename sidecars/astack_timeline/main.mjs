#!/usr/bin/env node
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { COMMAND_DOCS, DELEGATE_GUIDE_DATA } from "./command-catalog.mjs";
import { evaluateTimelineSnapshot, resolveSafeArtifactUri } from "./timeline-engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STRICT_ID_RE = /^[0-9a-f-]{8,}$/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
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
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ["/vendor/three.min.js", { file: "vendor/three.min.js", type: "application/javascript; charset=utf-8" }],
  ["/scene-3d.js", { file: "scene-3d.js", type: "application/javascript; charset=utf-8" }],
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

function fetchWorkspaceFromAgentApi(convId) {
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const cmd = exe || "agentapi";
  const args = [...(exe ? ["agentapi"] : []), "get-conversation-metadata", convId];
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 4000 }, (err, stdout) => {
      if (err) return resolve("");
      try {
        const parsed = JSON.parse(stdout || "{}");
        const meta = parsed?.response?.conversationMetadata?.metadata ?? parsed?.metadata ?? {};
        const uri = meta?.workspaces?.[0]?.workspaceFolderAbsoluteUri ?? meta?.workspaceUris?.[0] ?? "";
        if (!uri || typeof uri !== "string") return resolve("");
        resolve(uri.startsWith("file://") ? fileURLToPath(uri) : uri);
      } catch {
        resolve("");
      }
    });
  });
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

function makeWorkspaceResolver({ explicitWorkspace = "" } = {}) {
  const cache = new Map();
  return async (convId, workspaceUri = "") => {
    if (explicitWorkspace) return path.resolve(explicitWorkspace);
    if (convId) {
      let pending = cache.get(convId);
      if (!pending) {
        pending = fetchWorkspaceFromAgentApi(convId).then((dir) => {
          if (!dir) cache.delete(convId);
          return dir;
        });
        cache.set(convId, pending);
      }
      const dir = await pending;
      if (dir) return dir;
    }
    return resolveWorkspaceUriInput(workspaceUri) || process.env.ANTIGRAVITY_WORKSPACE_DIR || "";
  };
}

function readStaticAsset(asset) {
  return fs.readFileSync(path.join(__dirname, ...asset.file.split("/")), "utf8");
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
  return `window.ASTACK_CATALOG = ${JSON.stringify({ delegateGuide: DELEGATE_GUIDE_DATA, commandDocs: COMMAND_DOCS })};\n`;
}

function createTimelineResponder({
  brainDir,
  defaultConversationId = "",
  allowFixtureIds = false,
  workspaceResolver,
}) {
  return async ({ conversationId = "", etag = "", workspaceUri = "" } = {}) => {
    const rawConv = String(conversationId || defaultConversationId || "").trim();
    if (rawConv && !isValidConversationId(rawConv, allowFixtureIds)) {
      return { status: 400, body: { error: "Invalid conversationId" } };
    }

    const workspaceDir = await workspaceResolver(rawConv, workspaceUri);
    const snap = evaluateTimelineSnapshot({ conversationId: rawConv, brainDir, workspaceDir });
    if (etag && etag === snap.etag) {
      return { status: 200, body: { conversationId: rawConv || null, unchanged: true, etag: snap.etag } };
    }
    return { status: 200, body: snap };
  };
}

function artifactJson(status, payload) {
  return {
    status,
    contentType: "application/json; charset=utf-8",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(payload),
  };
}

function createArtifactResponder({
  brainDir,
  defaultConversationId = "",
  allowFixtureIds = false,
}) {
  return async ({ conversationId = "", name = "", raw = false } = {}) => {
    const rawConv = String(conversationId || defaultConversationId || "").trim();
    const rawName = String(name || "").trim();
    if (!rawConv || !isValidConversationId(rawConv, allowFixtureIds)) {
      return artifactJson(400, { error: "Invalid conversationId" });
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

function writeJsonResponse(res, status, payload, isHead = false) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(isHead ? "" : JSON.stringify(payload));
}

/**
 * Starts the standalone read-only HTTP server on `127.0.0.1` for browser tests and local preview.
 */
export async function createTimelineServer(options = {}) {
  const brainDir = resolveBrainDir(options.brainDir);
  const allowFixtureIds = Boolean(options.allowFixtureIds);
  const defaultConvId = String(options.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID ?? "").trim();
  const token = options.token ?? process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ?? "";
  const workspaceResolver = makeWorkspaceResolver({
    explicitWorkspace: options.workspaceDir || "",
  });
  const respondTimeline = createTimelineResponder({
    brainDir,
    defaultConversationId: defaultConvId,
    allowFixtureIds,
    workspaceResolver,
  });
  const respondArtifact = createArtifactResponder({
    brainDir,
    defaultConversationId: defaultConvId,
    allowFixtureIds,
  });

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
        raw: reqUrl.searchParams.get("raw") === "1",
      });
      res.writeHead(artRes.status, { "Content-Type": artRes.contentType, ...artRes.headers });
      res.end(isHead ? "" : artRes.body);
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
      const brainDir = resolveBrainDir(options.brainDir);
      const workspaceResolver = makeWorkspaceResolver({ explicitWorkspace: options.workspaceDir || "" });
      const defaultConversationId = String(app.config?.conversationId ?? options.conversationId ?? "");
      const allowFixtureIds = Boolean(options.allowFixtureIds);
      const respondTimeline = createTimelineResponder({
        brainDir,
        defaultConversationId,
        allowFixtureIds,
        workspaceResolver,
      });
      const respondArtifact = createArtifactResponder({
        brainDir,
        defaultConversationId,
        allowFixtureIds,
      });

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
          raw: data?.raw === "1" || data?.raw === true,
        });
        return new Response(artRes.body, {
          status: artRes.status,
          contentType: artRes.contentType,
          headers: artRes.headers,
        });
      }, "POST");

      await app.run();
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
