import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runArchitectureAudit } from "../../../scripts/trust/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "arch-audit.mjs");

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

test("runArchitectureAudit detects boundary violations, banned patterns, shallow wrappers, and gardening targets", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-arch-audit-"));
  try {
    writeFile(
      path.join(tmp, ".agents", "boundaries.json"),
      JSON.stringify({
        schemaVersion: 1,
        zones: {
          coreInternal: { include: ["src/core/internal/**"] },
          app: { include: ["src/app/**"] },
        },
        importRules: [
          {
            id: "no-core-internal",
            from: "app",
            forbidImportFrom: ["coreInternal"],
            reason: "Import from src/core/index.js instead",
          },
        ],
        bannedPatterns: [
          {
            id: "no-use-effect",
            regex: "\\buseEffect\\(",
            fileGlobs: ["src/app/**"],
            reason: "Use framework data hooks",
          },
        ],
        shallowModuleThresholds: {
          maxExportsPerShallowFile: 3,
          minImplLinesPerExport: 4,
        },
      }),
    );

    writeFile(path.join(tmp, "src", "core", "internal", "secret.js"), "export const secret = 1;\n");
    writeFile(
      path.join(tmp, "src", "app", "bad.js"),
      [
        'import { secret } from "../core/internal/secret.js";',
        "useEffect(() => {});",
        "// @ts-ignore legacy shim",
        "export const a = (x) => f(x);",
        "export const b = (x) => g(x);",
        "export const c = (x) => h(x);",
      ].join("\n"),
    );

    const report = runArchitectureAudit({ cwd: tmp });
    assert.equal(report.ok, false);
    assert.equal(report.boundaryViolations.length, 1);
    assert.equal(report.bannedHits.length, 1);
    assert.equal(report.shallowModules.length, 1);
    assert.equal(report.gardeningHits.length, 1);

    const strictRun = spawnSync(process.execPath, [cliPath, "--cwd", tmp, "--strict", "--json"], {
      encoding: "utf8",
    });
    assert.equal(strictRun.status, 1);
    const parsed = JSON.parse(strictRun.stdout);
    assert.equal(parsed.summary.boundaryViolations, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("arch-audit CLI exits 0 on clean repo with --strict", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "astack-arch-clean-"));
  try {
    writeFile(
      path.join(tmp, ".agents", "boundaries.json"),
      JSON.stringify({ schemaVersion: 1, zones: {}, importRules: [] }),
    );
    writeFile(
      path.join(tmp, "src", "domain.js"),
      "export function compute(x) {\n  const a = x + 1;\n  const b = a * 2;\n  const c = b - 3;\n  return c;\n}\n",
    );
    const res = spawnSync(process.execPath, [cliPath, "--cwd", tmp, "--strict", "--json"], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.ok, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
