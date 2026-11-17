#!/usr/bin/env node
/**
 * 3-Tier Adaptive Sandbox Probe, Clean-Env Runner, and Race-Safe Artifact Promoter
 * for AStack's /security-audit skill.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { SafeInputError, WINDOWS_RESERVED_COMPONENT, hasSafePosixOpenConstants } = require("./safe-io.cjs");

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const SECRET_ENV_KEY_PATTERN = /(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|AUTH|COOKIE|CREDENTIAL|PRIVATE)/i;
const PATH_FORBIDDEN_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

export class SandboxError extends Error {
  constructor(message, code = "SANDBOX_ERROR") {
    super(message);
    this.code = code;
  }
}

function defaultHasCommand(cmd) {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const res = spawnSync(locator, [cmd], { encoding: "utf8", timeout: 2000, windowsHide: true });
  return res.status === 0;
}

function defaultConnectTcp(host, port, timeoutMs = 250) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish({ blocked: false, reason: "connected" }));
    socket.once("timeout", () => finish({ blocked: false, reason: "timeout" }));
    socket.once("error", (err) => {
      const blockedCodes = new Set(["EACCES", "EPERM", "ENETUNREACH", "EHOSTUNREACH", "ECONNREFUSED"]);
      finish({
        blocked: blockedCodes.has(err?.code),
        reason: err?.code ?? err?.message ?? "error",
      });
    });
  });
}

function checkSensitivePathAccess(homeDir, statSyncFn) {
  const sshDir = path.join(homeDir, ".ssh");
  try {
    const st = statSyncFn(sshDir);
    if (st) return { status: "readable", path: "~/.ssh" };
  } catch (err) {
    if (err && (err.code === "EACCES" || err.code === "EPERM" || err.code === "ENOENT")) {
      return { status: "blocked-or-hidden", code: err.code, path: "~/.ssh" };
    }
    return { status: "unknown", code: err?.code ?? "error", path: "~/.ssh" };
  }
  return { status: "unknown", path: "~/.ssh" };
}

function parseWindowsBuild(releaseStr) {
  const parts = String(releaseStr).split(".");
  const build = Number.parseInt(parts[2] ?? "", 10);
  return Number.isFinite(build) ? build : 0;
}

/**
 * Empirically probes active execution isolation:
 * - Tier 2: OpenSandbox (`osb` CLI configured or `OPENSANDBOX_MCP` / `OPENSANDBOX_DOMAIN` active)
 * - Tier 1: Antigravity Native Terminal Sandbox (empirical outbound network deny + blocked host profile)
 * - Tier 0: Unsandboxed host (fail-closed to `needs_validation`)
 */
export async function probeSandboxTier(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const osRelease = deps.osRelease ?? os.release();
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? os.homedir();
  const hasCommand = deps.hasCommand ?? defaultHasCommand;
  const connectTcp = deps.connectTcp ?? defaultConnectTcp;
  const statSyncFn = deps.statSync ?? fs.statSync;
  const existsSyncFn = deps.existsSync ?? fs.existsSync;

  const osbInstalled = Boolean(hasCommand("osb"));
  const osbConfigured = Boolean(
    env.OPENSANDBOX_MCP ||
      env.OPENSANDBOX_DOMAIN ||
      (osbInstalled && existsSyncFn(path.join(homeDir, ".opensandbox.toml"))),
  );

  if (osbConfigured) {
    return {
      tier: 2,
      mode: "opensandbox",
      canExecuteTargetCode: true,
      osbInstalled,
      osbConfigured,
      networkBlocked: true,
      sensitivePathAccess: "isolated",
      reason: "Tier 2 OpenSandbox runtime configured for container or microVM isolation.",
    };
  }

  const netProbe = await connectTcp("192.0.2.1", 443, 250);
  const sshProbe = checkSensitivePathAccess(homeDir, statSyncFn);
  const winBuild = platform === "win32" ? parseWindowsBuild(osRelease) : null;
  const winSupported = winBuild === null || winBuild >= 26100;

  const tier1Active =
    winSupported &&
    netProbe.blocked === true &&
    sshProbe.status === "blocked-or-hidden";

  if (tier1Active) {
    return {
      tier: 1,
      mode: "antigravity-terminal-sandbox",
      canExecuteTargetCode: true,
      osbInstalled,
      osbConfigured,
      networkBlocked: true,
      networkProbeReason: netProbe.reason,
      sensitivePathAccess: sshProbe.status,
      reason:
        "Tier 1 Antigravity Terminal Sandbox verified empirically (outbound network blocked and ~/.ssh hidden).",
    };
  }

  const blockers = [];
  if (!winSupported) {
    blockers.push(`Windows build ${winBuild} is below Windows 11 24H2 build 26100`);
  }
  if (!netProbe.blocked) {
    blockers.push(`outbound TCP probe was not blocked (${netProbe.reason})`);
  }
  if (sshProbe.status === "readable") {
    blockers.push("host ~/.ssh directory remains readable outside workspace");
  }
  if (osbInstalled && !osbConfigured) {
    blockers.push("osb binary found but no OpenSandbox endpoint or ~/.opensandbox.toml is configured");
  }

  return {
    tier: 0,
    mode: "unsandboxed-static-only",
    canExecuteTargetCode: false,
    osbInstalled,
    osbConfigured,
    networkBlocked: netProbe.blocked,
    networkProbeReason: netProbe.reason,
    sensitivePathAccess: sshProbe.status,
    blockers,
    reason: `Tier 0 fail-closed (${blockers.join("; ")}). Dynamic target execution disabled; retain needs_validation.`,
  };
}

/**
 * Builds a minimal empty-by-default environment rooted in `scratchDir` while
 * rejecting secret-like keys.
 */
export function buildSafeEnv(scratchDir, allowEnv = {}, baseEnv = process.env) {
  const safe = {
    HOME: scratchDir,
    USERPROFILE: scratchDir,
    TMPDIR: scratchDir,
    TEMP: scratchDir,
    TMP: scratchDir,
    LANG: "C.UTF-8",
  };

  if (baseEnv.PATH) safe.PATH = baseEnv.PATH;
  if (baseEnv.Path) safe.Path = baseEnv.Path;
  if (process.platform === "win32") {
    if (baseEnv.SystemRoot) safe.SystemRoot = baseEnv.SystemRoot;
    if (baseEnv.ComSpec) safe.ComSpec = baseEnv.ComSpec;
    if (baseEnv.PATHEXT) safe.PATHEXT = baseEnv.PATHEXT;
  }

  for (const [key, val] of Object.entries(allowEnv)) {
    if (SECRET_ENV_KEY_PATTERN.test(key)) {
      throw new SandboxError(`Refusing secret-like allowEnv key "${key}"`, "UNSAFE_ENV_KEY");
    }
    if (typeof val !== "string") {
      throw new SandboxError(`allowEnv value for "${key}" must be a string`, "INVALID_ENV_VALUE");
    }
    safe[key] = val;
  }
  return safe;
}

function validateDeclaredRelativePath(relPath) {
  if (
    typeof relPath !== "string" ||
    relPath.length === 0 ||
    relPath.trim() !== relPath ||
    PATH_FORBIDDEN_CHAR.test(relPath) ||
    relPath.includes("\\") ||
    relPath.includes(":") ||
    relPath.startsWith("/") ||
    relPath.startsWith("~")
  ) {
    throw new SafeInputError("Declared artifact relative path is unsafe");
  }
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (
      seg === "" ||
      seg === "." ||
      seg === ".." ||
      /[ .]$/u.test(seg) ||
      WINDOWS_RESERVED_COMPONENT.test(seg)
    ) {
      throw new SafeInputError("Declared artifact relative path contains forbidden segments");
    }
  }
  return segments;
}

function assertRealDirectory(dirPath, label) {
  let lst;
  try {
    lst = fs.lstatSync(dirPath);
  } catch {
    throw new SandboxError(`${label} directory does not exist: ${dirPath}`, "MISSING_ROOT");
  }
  if (lst.isSymbolicLink() || !lst.isDirectory()) {
    throw new SandboxError(`${label} must be a real non-symlink directory`, "SYMLINK_ROOT");
  }
  return fs.realpathSync(dirPath);
}

function walkAndCheckExistingParents(rootDir, segments, { createMissing = false } = {}) {
  let current = rootDir;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]);
    if (!fs.existsSync(current)) {
      if (!createMissing) {
        throw new SafeInputError(`Missing scratch subdirectory: ${segments.slice(0, i + 1).join("/")}`);
      }
      fs.mkdirSync(current);
    }
    const lst = fs.lstatSync(current);
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      throw new SafeInputError(`Directory component must not be a symlink: ${segments[i]}`);
    }
  }
  return path.join(current, segments[segments.length - 1]);
}

function directoryByteTotal(rootDir) {
  let total = 0;
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const lst = fs.lstatSync(full);
      if (lst.isSymbolicLink()) {
        throw new SafeInputError("artifacts root contains an unexpected symlink");
      }
      if (lst.isDirectory()) {
        stack.push(full);
      } else if (lst.isFile()) {
        total += lst.size;
      }
    }
  }
  return total;
}

/**
 * Race-safe promotion of a single predeclared scratch-relative artifact into
 * parent-owned `artifactsRoot`.
 */
export function promoteArtifact({
  scratchRoot,
  artifactsRoot,
  relativePath,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
}) {
  const segments = validateDeclaredRelativePath(relativePath);
  const realScratch = assertRealDirectory(scratchRoot, "scratchRoot");
  const realArtifacts = assertRealDirectory(artifactsRoot, "artifactsRoot");
  if (
    realScratch === realArtifacts ||
    realArtifacts.startsWith(`${realScratch}${path.sep}`) ||
    realScratch.startsWith(`${realArtifacts}${path.sep}`)
  ) {
    throw new SandboxError("scratchRoot and artifactsRoot must be disjoint directories", "OVERLAPPING_ROOTS");
  }

  const srcPath = walkAndCheckExistingParents(realScratch, segments, { createMissing: false });
  const posixSafe = hasSafePosixOpenConstants();

  let srcFd;
  let preLstat = null;
  if (posixSafe) {
    try {
      srcFd = fs.openSync(
        srcPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (err) {
      if (err && (err.code === "ELOOP" || err.code === "EMLINK")) {
        throw new SafeInputError("scratch artifact must not be a symlink");
      }
      throw err;
    }
  } else if (process.platform === "win32") {
    preLstat = fs.lstatSync(srcPath, { bigint: true });
    if (preLstat.isSymbolicLink()) {
      throw new SafeInputError("scratch artifact must not be a symlink");
    }
    if (!preLstat.isFile()) {
      throw new SafeInputError("scratch artifact must be a regular file");
    }
    srcFd = fs.openSync(srcPath, fs.constants.O_RDONLY);
  } else {
    throw new SafeInputError("OS no-follow protection is unavailable");
  }

  let verifiedBuffer;
  try {
    const startStat = fs.fstatSync(srcFd, { bigint: true });
    if (!startStat.isFile()) {
      throw new SafeInputError("scratch artifact must be a regular file");
    }
    if (startStat.nlink !== 1n) {
      throw new SafeInputError("scratch artifact must have link count exactly 1");
    }
    if (startStat.size > BigInt(maxFileBytes)) {
      throw new SafeInputError(`scratch artifact exceeds ${maxFileBytes} byte limit`);
    }
    if (
      preLstat &&
      ((preLstat.ino !== 0n && startStat.ino !== preLstat.ino) ||
        startStat.size !== preLstat.size ||
        startStat.mtimeNs !== preLstat.mtimeNs)
    ) {
      throw new SafeInputError("scratch artifact changed before promotion");
    }

    const existingTotal = directoryByteTotal(realArtifacts);
    if (existingTotal + Number(startStat.size) > maxTotalBytes) {
      throw new SafeInputError(`artifacts directory would exceed ${maxTotalBytes} cumulative byte limit`);
    }

    const expectedBytes = Number(startStat.size);
    const buf = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      const read = fs.readSync(srcFd, buf, offset, expectedBytes - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const probeByte = Buffer.allocUnsafe(1);
    const trailing = fs.readSync(srcFd, probeByte, 0, 1, null);
    if (offset !== expectedBytes || trailing !== 0) {
      throw new SafeInputError("scratch artifact size changed during read");
    }

    const endStat = fs.fstatSync(srcFd, { bigint: true });
    if (
      !endStat.isFile() ||
      endStat.nlink !== 1n ||
      endStat.ino !== startStat.ino ||
      endStat.size !== startStat.size ||
      endStat.mtimeNs !== startStat.mtimeNs
    ) {
      throw new SafeInputError("scratch artifact changed identity during promotion");
    }
    if (preLstat) {
      const endLstat = fs.lstatSync(srcPath, { bigint: true });
      if (endLstat.isSymbolicLink() || endLstat.ino !== preLstat.ino || endLstat.mtimeNs !== preLstat.mtimeNs) {
        throw new SafeInputError("scratch artifact path changed during promotion");
      }
    }
    verifiedBuffer = buf;
  } finally {
    fs.closeSync(srcFd);
  }

  const destPath = walkAndCheckExistingParents(realArtifacts, segments, { createMissing: true });
  const destFlags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (posixSafe ? fs.constants.O_NOFOLLOW : 0);

  const destFd = fs.openSync(destPath, destFlags, 0o600);
  try {
    const destStat = fs.fstatSync(destFd, { bigint: true });
    if (!destStat.isFile() || destStat.nlink !== 1n) {
      throw new SafeInputError("destination artifact must be a unique regular file");
    }
    let written = 0;
    while (written < verifiedBuffer.length) {
      written += fs.writeSync(destFd, verifiedBuffer, written, verifiedBuffer.length - written);
    }
    fs.fsyncSync(destFd);
  } finally {
    fs.closeSync(destFd);
  }

  return {
    promoted: true,
    relativePath,
    destination: destPath,
    bytes: verifiedBuffer.length,
  };
}

/**
 * Runs a bounded local command inside `scratchDir` only when Tier >= 1 is active.
 */
export async function runInSandbox({
  command,
  args = [],
  scratchDir,
  allowEnv = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  probe = null,
}) {
  const activeProbe = probe ?? (await probeSandboxTier());
  if (!activeProbe.canExecuteTargetCode || activeProbe.tier === 0) {
    return {
      status: "needs_validation",
      tier: activeProbe.tier,
      mode: activeProbe.mode,
      reason: activeProbe.reason,
      exitCode: null,
      stdout: "",
      stderr: "",
    };
  }

  const realScratch = assertRealDirectory(scratchDir, "scratchDir");
  const safeEnv = buildSafeEnv(realScratch, allowEnv);
  const started = Date.now();
  const res = spawnSync(command, args, {
    cwd: realScratch,
    env: safeEnv,
    timeout: timeoutMs,
    maxBuffer: maxOutputBytes,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
  });

  return {
    status: res.error?.code === "ETIMEDOUT" ? "timed_out" : res.status === 0 ? "ok" : "nonzero_exit",
    tier: activeProbe.tier,
    mode: activeProbe.mode,
    exitCode: res.status,
    signal: res.signal ?? null,
    error: res.error?.message ?? null,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    durationMs: Date.now() - started,
  };
}

const USAGE = `Usage: node sandbox-runner.mjs [options] [-- <command> [args...]]

Options:
  --probe                  Empirically probe active sandbox tier (0, 1, or 2)
  --promote                Promote one scratch-relative file to parent artifacts dir
  --exec                   Run a bounded command inside --scratch when tier >= 1
  --scratch <dir>          Scratch directory path
  --artifacts <dir>        Parent-owned artifacts directory path (for --promote)
  --file <rel-path>        Scratch-relative file path to promote
  --max-bytes <n>          Maximum promoted file bytes (default: ${DEFAULT_MAX_FILE_BYTES})
  --timeout-ms <n>         Execution timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --json                   Emit machine-readable JSON output
  -h, --help               Show this help text and exit 0`;

async function main() {
  const argv = process.argv.slice(2);
  const dashDash = argv.indexOf("--");
  const optionArgs = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const execCmd = dashDash === -1 ? [] : argv.slice(dashDash + 1);

  let values;
  try {
    ({ values } = parseArgs({
      args: optionArgs,
      options: {
        probe: { type: "boolean", default: false },
        promote: { type: "boolean", default: false },
        exec: { type: "boolean", default: false },
        scratch: { type: "string" },
        artifacts: { type: "string" },
        file: { type: "string" },
        "max-bytes": { type: "string" },
        "timeout-ms": { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(2);
  }

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }

  const modeCount = Number(values.probe) + Number(values.promote) + Number(values.exec);
  if (modeCount !== 1) {
    console.error(USAGE);
    process.exit(2);
  }

  try {
    if (values.probe) {
      const report = await probeSandboxTier();
      if (values.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(`[sandbox-probe] tier=${report.tier} mode=${report.mode} execute=${report.canExecuteTargetCode}\n${report.reason}\n`);
      }
      process.exit(0);
    }

    if (values.promote) {
      if (!values.scratch || !values.artifacts || !values.file) {
        console.error("--promote requires --scratch, --artifacts, and --file");
        process.exit(2);
      }
      const maxFileBytes = values["max-bytes"] ? Number.parseInt(values["max-bytes"], 10) : DEFAULT_MAX_FILE_BYTES;
      const result = promoteArtifact({
        scratchRoot: values.scratch,
        artifactsRoot: values.artifacts,
        relativePath: values.file,
        maxFileBytes,
      });
      process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `PROMOTED ${result.relativePath} (${result.bytes} bytes)\n`);
      process.exit(0);
    }

    if (!values.scratch || execCmd.length === 0) {
      console.error("--exec requires --scratch and -- <command> [args...]");
      process.exit(2);
    }
    const timeoutMs = values["timeout-ms"] ? Number.parseInt(values["timeout-ms"], 10) : DEFAULT_TIMEOUT_MS;
    const result = await runInSandbox({
      command: execCmd[0],
      args: execCmd.slice(1),
      scratchDir: values.scratch,
      timeoutMs,
    });
    process.stdout.write(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${result.status}: ${result.stdout}${result.stderr}`);
    if (result.status === "needs_validation") process.exit(3);
    process.exit(result.exitCode ?? 1);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
