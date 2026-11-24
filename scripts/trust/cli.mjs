#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  OUTCOME_SCORES,
  TRUST_CATEGORIES,
  applyTrustSettingsAction,
  evaluateRepoTrust,
  loadRiskPolicy,
  readHeadShaFast,
  recordOutcomeWithTrustSync,
  resolveWorkspaceScope,
} from "./index.mjs";

const USAGE = `Usage: node scripts/trust/cli.mjs <command> [args] [options]

Human out-of-band CLI for Earned Trust settings and outcome ledger inside \${PLUGIN_DATA}.

Commands:
  status                                    Show WorkspaceScope, settings, and per-category trust levels
  beast <on|off>                            Toggle Beast Mode (run up to earned level)
  promotion <manual|auto>                   Set promotion mode (Manual default or Auto up to Ceiling)
  ceiling <category> <1|2|3>                Set human ceiling for one category (governance max L2)
  promote <category>                        Confirm an eligible Manual promotion
  undo                                      Undo the last Auto promotion and switch to Manual
  record-outcome <category> <outcome>       Append a git-anchored outcome (requires --sha or HEAD)

Options:
  --cwd <dir>          Target git repository (defaults to current working directory)
  --data-dir <dir>     Explicit plugin data directory override (defaults to \${PLUGIN_DATA})
  --base <ref>         Optional base ref override for enrollment policy lookup
  --sha <40-hex>       Commit or merge SHA for record-outcome (defaults to current HEAD)
  --risk <0..1>        Predicted risk score R for record-outcome (default: 0)
  --pr <number>        Optional PR number for record-outcome
  --note <text>        Optional note for record-outcome
  --json               Emit machine-readable JSON output
  -h, --help           Show this help text and exit 0`;

function formatStatusReport({ scope, trust }) {
  if (scope.kind === "non_repo") {
    return "WorkspaceScope: non_repo (AStack Earned Trust inactive outside git repositories)";
  }
  if (scope.kind === "git_unregistered") {
    return `WorkspaceScope: git_unregistered (repoId=${scope.repoId})\nTrust: Off (commit .agents/risk-policy.json on base branch to enroll)`;
  }
  const lines = [
    `WorkspaceScope: enrolled_repo (repoId=${scope.repoId}, base=${scope.baseRef})`,
    `Beast: ${trust.beastOn ? "On" : "Off"} | Promotion: ${trust.promotionMode}${trust.promotionLockedByPolicy ? " (locked by base policy)" : ""} | Ledger: ${trust.chainValid ? "valid" : `BROKEN at line ${trust.brokenAtLine}`} (${trust.totalOutcomes} outcomes)`,
    "",
    "| Category | Level | Ceiling | T | Brier | Clean/Edit/Rev | Status |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const c of trust.categoryList) {
    const status = c.frozen
      ? "frozen"
      : c.promoReady
        ? `ready -> L${c.eligibleNextLevel}`
        : "ok";
    lines.push(
      `| ${c.id} | L${c.level} | L${c.ceiling}/${c.maxCeiling} | ${c.score.toFixed(2)} | ${c.brier.toFixed(2)} | ${c.clean}/${c.edited}/${c.reverted} | ${status} |`,
    );
  }
  return lines.join("\n");
}

/**
 * Executes a single trust CLI command programmatically and returns `{ ok, exitCode, payload, text }`.
 */
export function runTrustCli(argv = []) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      "data-dir": { type: "string" },
      base: { type: "string" },
      sha: { type: "string" },
      risk: { type: "string" },
      pr: { type: "string" },
      note: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    return { ok: true, exitCode: 0, payload: null, text: USAGE };
  }

  const cmd = String(positionals[0] || "").toLowerCase();
  const workspaceDir = path.resolve(values.cwd || process.cwd());
  const dataDir = values["data-dir"] ? path.resolve(values["data-dir"]) : null;
  const scope = resolveWorkspaceScope(workspaceDir, { baseRef: values.base });

  if (cmd === "status") {
    if (scope.kind === "non_repo") {
      const payload = { ok: true, scope, trust: null };
      return {
        ok: true,
        exitCode: 0,
        payload,
        text: values.json ? JSON.stringify(payload, null, 2) : formatStatusReport(payload),
      };
    }
    const baseRef = scope.kind === "enrolled_repo" ? scope.baseRef : values.base;
    const { policy } = loadRiskPolicy(scope.repoRoot, { baseRef });
    const trust = evaluateRepoTrust({ repoId: scope.repoId, policy, dataDir });
    const payload = { ok: true, scope, trust };
    return {
      ok: true,
      exitCode: 0,
      payload,
      text: values.json ? JSON.stringify(payload, null, 2) : formatStatusReport(payload),
    };
  }

  if (scope.kind !== "enrolled_repo") {
    const msg =
      scope.kind === "non_repo"
        ? "Command requires an enrolled git repository (current directory is non_repo)."
        : "Repository is git_unregistered. Commit .agents/risk-policy.json on the base branch to enroll.";
    return {
      ok: false,
      exitCode: 2,
      payload: { ok: false, error: msg, scope },
      text: values.json ? JSON.stringify({ ok: false, error: msg, scope }, null, 2) : `Error: ${msg}`,
    };
  }

  const { policy } = loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });

  try {
    if (cmd === "beast") {
      const arg = String(positionals[1] || "").toLowerCase();
      if (arg !== "on" && arg !== "off") {
        throw new Error("Usage: beast <on|off>");
      }
      const res = applyTrustSettingsAction({
        repoId: scope.repoId,
        policy,
        dataDir,
        action: { beastOn: arg === "on" },
      });
      const payload = { ok: true, scope, settingsPath: res.settingsPath, trust: res.trust };
      return {
        ok: true,
        exitCode: 0,
        payload,
        text: values.json ? JSON.stringify(payload, null, 2) : `Beast Mode set to ${res.trust.beastOn ? "On" : "Off"}.`,
      };
    }

    if (cmd === "promotion") {
      const arg = String(positionals[1] || "").toLowerCase();
      if (arg !== "manual" && arg !== "auto") {
        throw new Error("Usage: promotion <manual|auto>");
      }
      const res = applyTrustSettingsAction({
        repoId: scope.repoId,
        policy,
        dataDir,
        action: { promotionMode: arg },
      });
      const payload = { ok: true, scope, settingsPath: res.settingsPath, trust: res.trust };
      return {
        ok: true,
        exitCode: 0,
        payload,
        text: values.json
          ? JSON.stringify(payload, null, 2)
          : `Promotion mode set to ${res.trust.promotionMode}.`,
      };
    }

    if (cmd === "ceiling") {
      const cat = String(positionals[1] || "").toLowerCase();
      const rawLvl = String(positionals[2] || "").replace(/^l/i, "");
      if (!TRUST_CATEGORIES.includes(cat)) {
        throw new Error(`Invalid category "${cat}". Expected one of: ${TRUST_CATEGORIES.join(", ")}`);
      }
      const res = applyTrustSettingsAction({
        repoId: scope.repoId,
        policy,
        dataDir,
        action: { setCeiling: { category: cat, ceiling: Number.parseInt(rawLvl, 10) } },
      });
      const payload = { ok: true, scope, settingsPath: res.settingsPath, trust: res.trust };
      return {
        ok: true,
        exitCode: 0,
        payload,
        text: values.json
          ? JSON.stringify(payload, null, 2)
          : `Ceiling for ${cat} set to L${res.trust.categories[cat].ceiling}.`,
      };
    }

    if (cmd === "promote") {
      const cat = String(positionals[1] || "").toLowerCase();
      const res = applyTrustSettingsAction({
        repoId: scope.repoId,
        policy,
        dataDir,
        action: { promoteCategory: cat },
      });
      const payload = { ok: true, scope, settingsPath: res.settingsPath, trust: res.trust };
      return {
        ok: true,
        exitCode: 0,
        payload,
        text: values.json
          ? JSON.stringify(payload, null, 2)
          : `Promoted ${cat} to L${res.trust.categories[cat].level}.`,
      };
    }

    if (cmd === "undo") {
      const res = applyTrustSettingsAction({
        repoId: scope.repoId,
        policy,
        dataDir,
        action: { undoAutoPromo: true },
      });
      const payload = { ok: true, scope, settingsPath: res.settingsPath, trust: res.trust };
      return {
        ok: true,
        exitCode: 0,
        payload,
        text: values.json
          ? JSON.stringify(payload, null, 2)
          : "Reverted last Auto promotion and switched Promotion mode to Manual.",
      };
    }

    if (cmd === "record-outcome") {
      const cat = String(positionals[1] || "").toLowerCase();
      const outcome = String(positionals[2] || "").toLowerCase();
      if (!Object.hasOwn(OUTCOME_SCORES, outcome)) {
        throw new Error(`Invalid outcome "${outcome}". Expected one of: ${Object.keys(OUTCOME_SCORES).join(", ")}`);
      }
      const sha = values.sha || readHeadShaFast(scope.repoRoot);
      const predictedR = values.risk !== undefined ? Number.parseFloat(values.risk) : 0;
      const prNumber = values.pr !== undefined ? Number.parseInt(values.pr, 10) : null;
      const res = recordOutcomeWithTrustSync({
        workspaceDir: scope.repoRoot,
        scope,
        policy,
        category: cat,
        outcome,
        headSha: sha,
        predictedR,
        prNumber,
        source: "cli",
        note: values.note || "",
        dataDir,
      });
      const payload = { ok: true, scope, entry: res.entry, ledgerPath: res.ledgerPath, trust: res.trust };
      const cState = res.trust.categories[cat];
      return {
        ok: true,
        exitCode: 0,
        payload,
        text: values.json
          ? JSON.stringify(payload, null, 2)
          : `Recorded ${outcome} (y=${res.entry.y}) for ${cat}: L${cState.level}, T ${cState.score.toFixed(2)}, Brier ${cState.brier.toFixed(2)}.`,
      };
    }

    throw new Error(`Unknown command "${cmd}". Run with --help for usage.`);
  } catch (err) {
    const payload = { ok: false, error: err.message, scope };
    return {
      ok: false,
      exitCode: 1,
      payload,
      text: values.json ? JSON.stringify(payload, null, 2) : `Error: ${err.message}`,
    };
  }
}

function main() {
  const res = runTrustCli(process.argv.slice(2));
  if (res.ok) {
    process.stdout.write(`${res.text}\n`);
  } else {
    process.stderr.write(`${res.text}\n`);
  }
  process.exit(res.exitCode);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
