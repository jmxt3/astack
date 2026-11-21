#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { TOOL_DEFINITIONS, UI_RESOURCES, dispatchToolCall } from "./tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node scripts/mcp/server.mjs [options]

Options:
  --data-dir <dir>   Persistent plugin data directory (passed from \${PLUGIN_DATA})
  -h, --help         Show this help text and exit 0`;

function buildFallbackHtml(resource) {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${resource.name}</title>`,
    `<style>body{font-family:system-ui,sans-serif;margin:12px;background:#111;color:#e8e8ea;}</style>`,
    `</head><body><h3>${resource.name}</h3><p>${resource.description}</p>`,
    "</body></html>",
  ].join("");
}

function readUiHtml(resource) {
  const uiDir = process.env.ASTACK_MCP_UI_DIR
    ? path.resolve(process.env.ASTACK_MCP_UI_DIR)
    : path.join(__dirname, "ui");
  const candidate = path.join(uiDir, resource.fileName);
  if (fs.existsSync(candidate)) {
    return fs.readFileSync(candidate, "utf8");
  }
  return buildFallbackHtml(resource);
}

function writeJsonRpc(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendError(id, code, message) {
  writeJsonRpc({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function handleRequest(msg, context) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      if (isNotification) return;
      context.uiSupported = Boolean(params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"]);
      const clientVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      writeJsonRpc({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: clientVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: {
            name: "astack-trust",
            version: "0.4.0",
          },
        },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      if (!isNotification) writeJsonRpc({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      if (!isNotification) {
        writeJsonRpc({
          jsonrpc: "2.0",
          id,
          result: { tools: TOOL_DEFINITIONS },
        });
      }
      return;
    case "tools/call": {
      if (isNotification) return;
      const toolName = params?.name;
      if (typeof toolName !== "string" || !toolName) {
        sendError(id, -32602, "Missing required string parameter: name");
        return;
      }
      const result = dispatchToolCall(toolName, params?.arguments ?? {}, context);
      writeJsonRpc({ jsonrpc: "2.0", id, result });
      return;
    }
    case "resources/list":
      if (!isNotification) {
        writeJsonRpc({
          jsonrpc: "2.0",
          id,
          result: {
            resources: UI_RESOURCES.map(({ fileName: _file, ...rest }) => rest),
          },
        });
      }
      return;
    case "resources/read": {
      if (isNotification) return;
      const uri = params?.uri;
      const resource = UI_RESOURCES.find((r) => r.uri === uri);
      if (!resource) {
        sendError(id, -32002, `Resource not found: ${uri}`);
        return;
      }
      writeJsonRpc({
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType,
              text: readUiHtml(resource),
              _meta: resource._meta,
            },
          ],
        },
      });
      return;
    }
    default:
      if (!isNotification) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

function startStdioLoop(context) {
  let buffer = Buffer.alloc(0);

  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      sendError(null, -32700, "Parse error");
      return;
    }
    try {
      handleRequest(parsed, context);
    } catch (err) {
      if (parsed?.id !== undefined) {
        sendError(parsed.id, -32603, err.message);
      }
    }
  };

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    while (buffer.length > 0) {
      const asStr = buffer.toString("utf8");
      if (/^Content-Length:\s*\d+/i.test(asStr)) {
        const sepIdx = buffer.indexOf("\r\n\r\n");
        const altSepIdx = sepIdx === -1 ? buffer.indexOf("\n\n") : -1;
        const headerEnd = sepIdx !== -1 ? sepIdx : altSepIdx;
        const sepLen = sepIdx !== -1 ? 4 : 2;
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        const len = match ? Number.parseInt(match[1], 10) : 0;
        const total = headerEnd + sepLen + len;
        if (buffer.length < total) break;
        const body = buffer.subarray(headerEnd + sepLen, total).toString("utf8");
        buffer = buffer.subarray(total);
        processLine(body);
        continue;
      }

      const nlIdx = buffer.indexOf("\n");
      if (nlIdx === -1) break;
      const line = buffer.subarray(0, nlIdx).toString("utf8");
      buffer = buffer.subarray(nlIdx + 1);
      processLine(line);
    }
  });

  process.stdin.on("end", () => {
    if (buffer.length > 0) {
      processLine(buffer.toString("utf8"));
      buffer = Buffer.alloc(0);
    }
    process.exit(0);
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const context = {
    dataDir: values["data-dir"] ? path.resolve(values["data-dir"]) : null,
    uiSupported: false,
  };
  startStdioLoop(context);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
