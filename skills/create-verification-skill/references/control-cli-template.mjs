#!/usr/bin/env node
/**
 * control-cli-template.mjs
 *
 * Starter Node 22+ zero-dependency Control Glass wrapper for `verify-<app>` skills.
 * Copy into `.agents/skills/verify-<app>/scripts/control-<app>.mjs` and customize
 * `DEFAULT_HEALTH_PATH`, `DEFAULT_CMD`, and `captureAppSnapshot()`.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const MIN_NODE_MAJOR = 22;

const HELP_TEXT = `Usage: control-cli-template.mjs <command> [options]

Commands:
  doctor     Verify Node runtime, ephemeral port binding, and managed state health
  launch     Start an isolated app/service instance and write PID metadata
  snapshot   Probe the managed instance and save a proof artifact (preserving evidence)
  cleanup    Stop only the PID recorded by launch and delete scratch state (keeps evidence)

Options:
  --state-dir <path>      Isolated scratch directory (defaults to os.tmpdir()/verify-control)
  --evidence-dir <path>   Directory for retained proof artifacts (defaults to <state-dir>/evidence)
  --port <number>         Explicit local port (defaults to ephemeral findFreePort())
  --cmd <shell-command>   Command to launch (receives PORT and VERIFY_STATE_DIR env vars)
  --dry-run               Report planned checks or mutations without spawning or writing state
  --json                  Emit machine-readable JSON on stdout
  -h, --help              Show this help message and exit 0
`;

export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 0) {
    return { help: true, command: null, flags: {} };
  }
  const flags = {
    json: false,
    dryRun: false,
    help: false,
    stateDir: "",
    evidenceDir: "",
    port: null,
    cmd: "",
  };
  let command = null;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "-h" || token === "--help") {
      flags.help = true;
    } else if (token === "--json") {
      flags.json = true;
    } else if (token === "--dry-run") {
      flags.dryRun = true;
    } else if (token === "--state-dir" && i + 1 < args.length) {
      flags.stateDir = args[++i];
    } else if (token === "--evidence-dir" && i + 1 < args.length) {
      flags.evidenceDir = args[++i];
    } else if (token === "--port" && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i], 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid --port value: must be 1..65535`);
      }
      flags.port = parsed;
    } else if (token === "--cmd" && i + 1 < args.length) {
      flags.cmd = args[++i];
    } else if (token.startsWith("-")) {
      throw new Error(`Unknown option: ${token}`);
    } else if (!command) {
      command = token;
    } else {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
  }

  return { help: flags.help, command, flags };
}

export function findFreePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not resolve bound ephemeral port")));
        return;
      }
      const { port } = address;
      server.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function killManagedPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!isPidAlive(pid)) return false;
  if (process.platform === "win32") {
    const res = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return res.status === 0 || !isPidAlive(pid);
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  return true;
}

function resolvePaths(flags) {
  const stateDir = flags.stateDir
    ? path.resolve(flags.stateDir)
    : path.join(os.tmpdir(), "astack-control-cli");
  const evidenceDir = flags.evidenceDir
    ? path.resolve(flags.evidenceDir)
    : path.join(stateDir, "evidence");
  return {
    stateDir,
    scratchDir: path.join(stateDir, "scratch"),
    stateFile: path.join(stateDir, "scratch", "state.json"),
    evidenceDir,
  };
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export async function runDoctor(flags) {
  const paths = resolvePaths(flags);
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  const probePort = flags.port ?? (await findFreePort());
  const existing = readState(paths.stateFile);
  const managedPidAlive = existing ? isPidAlive(existing.pid) : false;
  const staleState = Boolean(existing && !managedPidAlive);

  return {
    command: "doctor",
    ok: major >= MIN_NODE_MAJOR && !staleState,
    dryRun: flags.dryRun,
    nodeVersion: process.versions.node,
    portAvailable: probePort,
    stateDir: paths.stateDir,
    evidenceDir: paths.evidenceDir,
    managedInstance: existing
      ? { pid: existing.pid, port: existing.port, alive: managedPidAlive }
      : null,
    staleState,
  };
}

export async function runLaunch(flags) {
  const paths = resolvePaths(flags);
  const existing = readState(paths.stateFile);
  if (existing && isPidAlive(existing.pid)) {
    throw new Error(
      `Managed instance already running (pid=${existing.pid}, port=${existing.port}). Run cleanup first.`,
    );
  }

  const port = flags.port ?? (await findFreePort());
  if (flags.dryRun) {
    return {
      command: "launch",
      ok: true,
      dryRun: true,
      port,
      host: DEFAULT_HOST,
      stateFile: paths.stateFile,
      evidenceDir: paths.evidenceDir,
      cmd: flags.cmd || null,
      spawned: false,
    };
  }

  fs.mkdirSync(paths.scratchDir, { recursive: true });
  fs.mkdirSync(paths.evidenceDir, { recursive: true });

  let pid = process.pid;
  let launchedCmd = flags.cmd || "(placeholder dry daemon; pass --cmd '<cmd>' for real server)";
  if (flags.cmd) {
    const child = spawn(flags.cmd, {
      shell: true,
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        PORT: String(port),
        VERIFY_PORT: String(port),
        VERIFY_STATE_DIR: paths.stateDir,
        VERIFY_EVIDENCE_DIR: paths.evidenceDir,
      },
    });
    child.unref();
    pid = child.pid ?? 0;
  }

  const record = {
    pid,
    port,
    host: DEFAULT_HOST,
    cmd: launchedCmd,
    stateDir: paths.stateDir,
    evidenceDir: paths.evidenceDir,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return {
    command: "launch",
    ok: true,
    dryRun: false,
    ...record,
  };
}

export async function runSnapshot(flags) {
  const paths = resolvePaths(flags);
  const existing = readState(paths.stateFile);
  const artifactPath = path.join(paths.evidenceDir, "snapshot.json");
  const payload = {
    capturedAt: new Date().toISOString(),
    instance: existing,
    alive: existing ? isPidAlive(existing.pid) : false,
  };

  if (flags.dryRun) {
    return {
      command: "snapshot",
      ok: true,
      dryRun: true,
      artifactPath,
      written: false,
      payload,
    };
  }

  fs.mkdirSync(paths.evidenceDir, { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return {
    command: "snapshot",
    ok: true,
    dryRun: false,
    artifactPath,
    written: true,
    payload,
  };
}

export async function runCleanup(flags) {
  const paths = resolvePaths(flags);
  const existing = readState(paths.stateFile);
  if (flags.dryRun) {
    return {
      command: "cleanup",
      ok: true,
      dryRun: true,
      wouldKillPid: existing?.pid ?? null,
      wouldRemoveDir: paths.scratchDir,
      evidencePreservedDir: paths.evidenceDir,
    };
  }

  let stopped = false;
  if (existing && existing.pid && existing.pid !== process.pid) {
    stopped = killManagedPid(existing.pid);
  }
  fs.rmSync(paths.scratchDir, { recursive: true, force: true });

  return {
    command: "cleanup",
    ok: true,
    dryRun: false,
    stoppedPid: stopped ? existing.pid : null,
    removedDir: paths.scratchDir,
    evidencePreservedDir: paths.evidenceDir,
    evidenceExists: fs.existsSync(paths.evidenceDir),
  };
}

function formatResult(result, asJson) {
  if (asJson) {
    return JSON.stringify(result, null, 2);
  }
  const lines = [`[${result.command}] ok=${result.ok} dryRun=${result.dryRun}`];
  for (const [key, value] of Object.entries(result)) {
    if (key === "command" || key === "ok" || key === "dryRun") continue;
    lines.push(`  ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}\n`);
    console.error(HELP_TEXT.trimEnd());
    return 2;
  }

  if (parsed.help || !parsed.command) {
    console.log(HELP_TEXT.trimEnd());
    return 0;
  }

  const handlers = {
    doctor: runDoctor,
    launch: runLaunch,
    snapshot: runSnapshot,
    cleanup: runCleanup,
  };
  const handler = handlers[parsed.command];
  if (!handler) {
    console.error(`Unknown command: ${parsed.command}\n`);
    console.error(HELP_TEXT.trimEnd());
    return 2;
  }

  try {
    const result = await handler(parsed.flags);
    console.log(formatResult(result, parsed.flags.json));
    return result.ok ? 0 : 1;
  } catch (err) {
    if (parsed.flags.json) {
      console.log(JSON.stringify({ command: parsed.command, ok: false, error: err.message }));
    } else {
      console.error(`Error: ${err.message}`);
    }
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.exitCode = await main();
}
