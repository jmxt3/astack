import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateAStack } from "../validate-astack.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "../..");
const serverPath = path.join(rootDir, "scripts", "mcp", "server.mjs");

function startMcpClient(extraEnv = {}, dataDir = null) {
  const args = [serverPath];
  if (dataDir) args.push("--data-dir", dataDir);
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  const pending = new Map();
  let nextId = 1;

  child.stderr.on("data", (d) => {
    stderrBuf += d.toString("utf8");
  });

  child.stdout.on("data", (d) => {
    stdoutBuf += d.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        entry.resolve(msg);
      }
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timeout waiting for MCP response to ${method}`));
      }, 10000);
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async function close() {
    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  }

  return { request, notify, close, getStderr: () => stderrBuf };
}

test("server.mjs supports --help and -h cleanly", () => {
  for (const flag of ["--help", "-h"]) {
    const res = spawnSync(process.execPath, [serverPath, flag], { encoding: "utf8" });
    assert.equal(res.status, 0);
    assert.doesNotMatch(res.stderr, /MODULE_TYPELESS_PACKAGE_JSON/);
    assert.match(res.stdout, /Usage: node scripts\/mcp\/server\.mjs/);
  }
});

test("MCP stdio server handles initialize, tools, resources, dossier/audit/doctor/trust/tla, and manifest recording", async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "astack-mcp-repo-"));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-mcp-art-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "astack-mcp-data-"));

  execFileSync("git", ["init", "-b", "main"], { cwd: tmpRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: tmpRepo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: tmpRepo, stdio: "ignore" });
  fs.writeFileSync(path.join(tmpRepo, "index.js"), "export const v = 1;\n", "utf8");
  execFileSync("git", ["add", "index.js"], { cwd: tmpRepo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: tmpRepo, stdio: "ignore" });
  fs.writeFileSync(path.join(tmpRepo, "index.js"), "export const v = 2;\n", "utf8");

  const client = startMcpClient({}, dataDir);
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: { extensions: { "io.modelcontextprotocol/ui": {} } },
    });
    assert.equal(init.result.serverInfo.name, "astack-trust");
    assert.ok(init.result.capabilities.tools);
    assert.ok(init.result.capabilities.resources);
    client.notify("notifications/initialized");

    const pingRes = await client.request("ping");
    assert.deepEqual(pingRes.result, {});

    const listTools = await client.request("tools/list");
    const toolNames = listTools.result.tools.map((t) => t.name);
    for (const expected of [
      "compile_pr_dossier",
      "audit_architecture",
      "doctor_workspace",
      "get_trust_status",
      "record_proof_manifest",
      "open_tla_viewer",
      "get_dossier_detail",
      "scaffold_repo_policies",
    ]) {
      assert.ok(toolNames.includes(expected), `Missing tool: ${expected}`);
    }
    const tlaTool = listTools.result.tools.find((t) => t.name === "open_tla_viewer");
    assert.deepEqual(tlaTool._meta["com.google.antigravity/ui"].entrypoints[0].extensions, [".tla"]);

    const listResources = await client.request("resources/list");
    const uris = listResources.result.resources.map((r) => r.uri);
    assert.deepEqual(uris.sort(), [
      "ui://astack/arch-audit.html",
      "ui://astack/pr-dossier.html",
      "ui://astack/tla-viewer.html",
    ]);

    for (const uri of uris) {
      const res = await client.request("resources/read", { uri });
      const content = res.result.contents[0];
      assert.equal(content.mimeType, "text/html;profile=mcp-app");
      assert.ok(content.text.length > 5000 && Buffer.byteLength(content.text, "utf8") < 10 * 1024 * 1024);
      assert.match(content.text, /ui\/initialize/);
      assert.doesNotMatch(content.text, /<script[^>]+src=["']https?:/i);
      assert.doesNotMatch(content.text, /<link[^>]+href=["']https?:/i);
    }

    const dossier = await client.request("tools/call", {
      name: "compile_pr_dossier",
      arguments: { cwd: tmpRepo, artifactDir },
    });
    assert.equal(dossier.result.isError, undefined);
    assert.equal(dossier.result.structuredContent.workspaceDir, tmpRepo);
    assert.match(dossier.result.content[0].text, /Visual PR Review Dossier/);

    const audit = await client.request("tools/call", {
      name: "audit_architecture",
      arguments: { cwd: tmpRepo },
    });
    assert.equal(audit.result.structuredContent.ok, true);

    const doctor = await client.request("tools/call", {
      name: "doctor_workspace",
      arguments: { cwd: tmpRepo },
    });
    assert.ok(Array.isArray(doctor.result.structuredContent.checks));

    const trust = await client.request("tools/call", {
      name: "get_trust_status",
      arguments: { cwd: tmpRepo, artifactDir },
    });
    assert.equal(trust.result.structuredContent.freshness, "missing_receipts");

    const tlaEmpty = await client.request("tools/call", {
      name: "open_tla_viewer",
      arguments: {},
    });
    assert.equal(tlaEmpty.result.structuredContent.file.name, "Specification.tla");

    const tlaOpen = await client.request("tools/call", {
      name: "open_tla_viewer",
      arguments: { file: { name: "Spec.tla", resourceUri: "antigravity-file://abc/Spec.tla" } },
    });
    assert.equal(tlaOpen.result.structuredContent.file.resourceUri, "antigravity-file://abc/Spec.tla");

    const manifest = {
      schemaVersion: 1,
      headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmpRepo, encoding: "utf8" }).trim(),
      checks: [
        {
          id: "chk-core",
          name: "Core unit suite",
          surface: "cli",
          status: "PASS",
          commandOrAction: "node --test",
          observed: "All core assertions passed.",
        },
      ],
    };
    const recRes = await client.request("tools/call", {
      name: "record_proof_manifest",
      arguments: { cwd: tmpRepo, artifactDir, manifest },
    });
    assert.equal(recRes.result.isError, undefined);
    assert.equal(recRes.result.structuredContent.ok, true);
    assert.equal(fs.existsSync(path.join(artifactDir, "astack-trust", "proof-manifest.json")), true);

    const badManifestRes = await client.request("tools/call", {
      name: "record_proof_manifest",
      arguments: { cwd: tmpRepo, artifactDir, manifest: { schemaVersion: 1, checks: [{ id: "bad" }] } },
    });
    assert.equal(badManifestRes.result.isError, true);
    assert.match(badManifestRes.result.content[0].text, /Invalid proof-manifest\.json/);

    assert.equal(client.getStderr(), "");
  } finally {
    await client.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("validateAStack rejects remote serverUrl or missing scripts in mcp_config.json", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-mcp-val-"));
  try {
    fs.writeFileSync(path.join(tmp, "plugin.json"), JSON.stringify({ name: "astack", author: { name: "João Machete" } }));
    fs.writeFileSync(path.join(tmp, "LICENSE"), "Lauren Tan\nJoão Machete\n");
    fs.writeFileSync(
      path.join(tmp, "mcp_config.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            command: "node",
            serverUrl: "https://example.com/mcp",
            args: ["${PLUGIN_ROOT}/scripts/mcp/missing.mjs"],
          },
        },
      }),
    );
    const report = validateAStack(tmp, { withAgy: false });
    const msgs = report.errors.map((e) => e.message).join("\n");
    assert.match(msgs, /must use local stdio command, never remote serverUrl\/url/);
    assert.match(msgs, /references missing plugin script: scripts\/mcp\/missing\.mjs/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
