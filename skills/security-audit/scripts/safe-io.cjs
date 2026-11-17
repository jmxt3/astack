const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const WINDOWS_DEVICE_PATH = /^\\\\[.?]\\/;
const WINDOWS_RESERVED_COMPONENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;

class SafeInputError extends Error {}

function hasSafePosixOpenConstants() {
  return (
    Number.isInteger(fs.constants.O_NOFOLLOW) &&
    fs.constants.O_NOFOLLOW !== 0 &&
    Number.isInteger(fs.constants.O_NONBLOCK) &&
    fs.constants.O_NONBLOCK !== 0
  );
}

function hasSafeInputProtection() {
  return hasSafePosixOpenConstants() || process.platform === "win32";
}

function readDescriptorWithinLimit(descriptor, maxBytes) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0;
  while (true) {
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
    if (count === 0) break;
    bytesRead += count;
    if (bytesRead > maxBytes) {
      throw new SafeInputError(`input exceeds ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return { raw: Buffer.concat(chunks, bytesRead), bytesRead };
}

function decodeStrictUtf8(raw) {
  try {
    return UTF8_DECODER.decode(raw);
  } catch {
    throw new SafeInputError("input is not valid UTF-8");
  }
}

function readPosixSafe(file, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error && (error.code === "ELOOP" || error.code === "EMLINK")) {
      throw new SafeInputError("input must not be a symlink");
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new SafeInputError("input must be a regular file");
    }
    if (stat.size > maxBytes) {
      throw new SafeInputError(`input exceeds ${maxBytes} byte limit`);
    }
    const { raw } = readDescriptorWithinLimit(descriptor, maxBytes);
    return decodeStrictUtf8(raw);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertWindowsRegularTarget(file, maxBytes) {
  if (
    typeof file !== "string" ||
    WINDOWS_DEVICE_PATH.test(file) ||
    WINDOWS_RESERVED_COMPONENT.test(path.win32.basename(file))
  ) {
    throw new SafeInputError("input must be a regular file");
  }
  const lstat = fs.lstatSync(file, { bigint: true });
  if (lstat.isSymbolicLink()) {
    throw new SafeInputError("input must not be a symlink");
  }
  if (!lstat.isFile()) {
    throw new SafeInputError("input must be a regular file");
  }
  if (lstat.size > BigInt(maxBytes)) {
    throw new SafeInputError(`input exceeds ${maxBytes} byte limit`);
  }
  return lstat;
}

function readWindowsSafe(file, maxBytes) {
  const lstat = assertWindowsRegularTarget(file, maxBytes);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const startStat = fs.fstatSync(descriptor, { bigint: true });
    if (!startStat.isFile()) {
      throw new SafeInputError("input must be a regular file");
    }
    if (
      (lstat.ino !== 0n && startStat.ino !== lstat.ino) ||
      startStat.size !== lstat.size ||
      startStat.mtimeNs !== lstat.mtimeNs
    ) {
      throw new SafeInputError("input changed before reading");
    }
    const { raw, bytesRead } = readDescriptorWithinLimit(descriptor, maxBytes);
    const endStat = fs.fstatSync(descriptor, { bigint: true });
    const endLstat = fs.lstatSync(file, { bigint: true });
    if (
      endLstat.isSymbolicLink() ||
      (lstat.ino !== 0n && (endStat.ino !== lstat.ino || endLstat.ino !== lstat.ino)) ||
      endStat.size !== BigInt(bytesRead) ||
      endLstat.mtimeNs !== lstat.mtimeNs
    ) {
      throw new SafeInputError("input changed while reading");
    }
    return decodeStrictUtf8(raw);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readFileWithinLimit(file, maxBytes) {
  if (hasSafePosixOpenConstants()) {
    return readPosixSafe(file, maxBytes);
  }
  if (process.platform === "win32") {
    return readWindowsSafe(file, maxBytes);
  }
  throw new SafeInputError("OS no-follow and nonblocking input protection is unavailable");
}

module.exports = {
  SafeInputError,
  WINDOWS_RESERVED_COMPONENT,
  hasSafeInputProtection,
  readFileWithinLimit,
};
