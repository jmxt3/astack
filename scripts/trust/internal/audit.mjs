import fs from "node:fs";
import path from "node:path";
import { evaluateBoundaryViolations, loadBoundaries } from "./policy.mjs";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".tmp",
  "dist",
  "build",
  "coverage",
  "vendor",
  "target",
]);

const CODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".py"]);
const TEST_FILE_REGEX =
  /(?:^|\/)(?:tests?|fixtures?|__tests__|mocks?)(?:\/|$)|\.(?:test|spec|compile)\.[jtcm]?[jt]sx?$/i;

function collectCodeFiles(dir, rootDir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectCodeFiles(path.join(dir, entry.name), rootDir, out);
    } else if (entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).split(path.sep).join("/");
      out.push({ full, rel });
    }
  }
  return out;
}

function analyzeShallowModule(rel, content, thresholds) {
  const base = path.posix.basename(rel);
  if (/^index\.|^types\./i.test(base) || TEST_FILE_REGEX.test(rel)) return null;

  const lines = content.split(/\r?\n/);
  let exportCount = 0;
  let implLines = 0;
  let passthroughWrappers = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    if (!trimmed.startsWith("import ") && !trimmed.startsWith("export ")) {
      implLines++;
    }
    if (/^export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class)\b/.test(trimmed)) {
      exportCount++;
    } else if (/^export\s*\{/.test(trimmed) && !/^export\s+type\s*\{/.test(trimmed)) {
      const inner = trimmed.match(/^export\s*\{([^}]+)\}/);
      if (inner) {
        exportCount += inner[1].split(",").filter((s) => s.trim()).length;
      }
    }
    if (/^export\s+(?:const|function)\s+\w+[^=]*=>\s*[a-zA-Z0-9_$.]+\([^)]*\)\s*;?$/.test(trimmed)) {
      passthroughWrappers++;
    }
  }

  const maxExports = thresholds?.maxExportsPerShallowFile ?? 8;
  const minRatio = thresholds?.minImplLinesPerExport ?? 6;
  if (exportCount >= maxExports && implLines / Math.max(1, exportCount) < minRatio) {
    return {
      file: rel,
      exportCount,
      implLines,
      reason: `High export surface (${exportCount} exports for ${implLines} implementation lines)`,
    };
  }
  if (passthroughWrappers >= 3) {
    return {
      file: rel,
      exportCount,
      implLines,
      reason: `Contains ${passthroughWrappers} single-expression pass-through wrapper exports`,
    };
  }
  return null;
}

const GARDENING_PATTERNS = [
  {
    id: "suppression",
    commentOnly: true,
    regex: /(?:\beslint-disable\b|@ts-ignore\b|@ts-expect-error\b|#\s*type:\s*ignore\b)/,
  },
  {
    id: "workaround-todo",
    commentOnly: true,
    regex: /\b(?:TODO\((?:hack|temp|workaround)\)|FIXME\b|XXX\b)/i,
  },
  {
    id: "zero-delay-timer",
    commentOnly: false,
    regex: /\bsetTimeout\s*\([^,]+,\s*0\s*\)/,
  },
];

function isCommentLine(trimmedLine) {
  return (
    trimmedLine.startsWith("//") ||
    trimmedLine.startsWith("/*") ||
    trimmedLine.startsWith("*") ||
    trimmedLine.startsWith("#")
  );
}

/**
 * Scans a repository for `.agents/boundaries.json` violations, shallow modules, and stale workarounds.
 */
export function runArchitectureAudit({ cwd = process.cwd() } = {}) {
  const rootDir = path.resolve(cwd);
  const { present: boundariesPresent, boundaries } = loadBoundaries(rootDir);
  const files = collectCodeFiles(rootDir, rootDir);
  const thresholds = boundaries?.shallowModuleThresholds ?? {
    maxExportsPerShallowFile: 8,
    minImplLinesPerExport: 6,
  };

  const boundaryViolations = [];
  const bannedHits = [];
  const shallowModules = [];
  const gardeningHits = [];

  for (const { full, rel } of files) {
    const content = fs.readFileSync(full, "utf8");
    const isTest = TEST_FILE_REGEX.test(rel);

    if (boundaries) {
      for (const hit of evaluateBoundaryViolations({ relPath: rel, content, boundaries })) {
        if (hit.kind === "banned") {
          bannedHits.push({ file: rel, detail: hit.detail });
        } else {
          boundaryViolations.push({ file: rel, detail: hit.detail });
        }
      }
    }

    const shallow = analyzeShallowModule(rel, content, thresholds);
    if (shallow) {
      shallowModules.push(shallow);
    }

    if (!isTest) {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const trimmedLine = lines[i].trim();
        const isComment = isCommentLine(trimmedLine);
        for (const gp of GARDENING_PATTERNS) {
          if (gp.commentOnly && !isComment) continue;
          if (gp.regex.test(lines[i])) {
            gardeningHits.push({
              id: gp.id,
              file: rel,
              line: i + 1,
              snippet: trimmedLine.slice(0, 120),
            });
            break;
          }
        }
      }
    }
  }

  return {
    ok: boundaryViolations.length === 0 && bannedHits.length === 0,
    cwd: rootDir,
    boundariesPresent,
    boundaryViolations,
    bannedHits,
    shallowModules,
    gardeningHits,
    summary: {
      filesScanned: files.length,
      boundaryViolations: boundaryViolations.length,
      bannedHits: bannedHits.length,
      shallowModules: shallowModules.length,
      gardeningHits: gardeningHits.length,
    },
  };
}
