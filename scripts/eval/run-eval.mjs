#!/usr/bin/env node
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROOT_DIR, RESERVED_SKILL_NAMES } from "../catalog.mjs";
import { runIncidentReplay } from "./incident-replay.mjs";
import { runRiskFixtureCases } from "./risk-backtest.mjs";
import { checkPlan } from "../../skills/astack-mode/scripts/check-plan.mjs";

const require = createRequire(import.meta.url);
const findingsValidator = require("../../skills/security-audit/scripts/validate-findings.cjs");
const ledgerValidator = require("../../skills/security-audit/scripts/validate-coverage-ledger.cjs");
const findingsSchema = require("../../skills/security-audit/scripts/report-schema.json");

const PLAN_NOUN_CONTEXT = /\b(?:the|a|an|this|that)\s+plan\s+(?:column|field|row|table|id|name|tier|record)\b/i;

export function classifySecurityMode(prompt) {
  const lower = prompt.toLowerCase();
  if (/\b(?:security|audit|pen[- ]?test|vulnerabilit|threat model)\b/i.test(lower)) {
    if (
      /\b(?:full|comprehensive|end-to-end|entire codebase|report\.md|findings\.json|pen[- ]?test this codebase|audit this codebase)\b/i.test(
        lower,
      )
    ) {
      return "full-audit";
    }
    return "guidance";
  }
  return null;
}

export function classifyInvestigationMode(prompt) {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  if (/^\/investigate\b/i.test(text)) {
    return /\b(?:and\s+fix|then\s+fix|fix\s+it|patch\s+it)\b/i.test(lower) ? "combined_gate" : "investigate_only";
  }
  const hasInvestigateCue = /\b(?:investigate|root cause|diagnose|why did .* fail|find out why|what broke)\b/i.test(lower);
  if (!hasInvestigateCue) return null;
  if (/\b(?:don'?t stop|run until done|\/goal)\b/i.test(lower)) return null;
  if (/\b(?:and\s+fix|then\s+fix|then\s+plan(?:\s+the)?\s+fix|and\s+plan(?:\s+the)?\s+fix|fix\s+it|fix\s+the\s+bug|mitigate|patch\s+it)\b/i.test(lower)) {
    return "combined_gate";
  }
  return "investigate_only";
}

export function classifyRoutingIntent(prompt, registry) {
  const text = prompt.trim();
  const explicit = text.match(/^\/(swarm|run-workflow|schedule|browser|automation|plugin|agy-customizations|generative_ui|antigravity-guide|plan|grill-me|learn|goal|boost|teamwork|btw)\b/i);
  if (explicit) {
    const cmd = `/${explicit[1].toLowerCase()}`;
    const entry = registry.commands.find((c) => c.command === cmd);
    return {
      command: cmd,
      mode: entry?.mode ?? "run",
      securityMode: classifySecurityMode(text),
      investigationMode: classifyInvestigationMode(text),
    };
  }

  const lower = text.toLowerCase();
  const securityMode = classifySecurityMode(text);
  const investigationMode = classifyInvestigationMode(text);

  if (/\b(interview me|grill me|ask me one question at a time|clarify requirements first)\b/.test(lower)) {
    return { command: "/grill-me", mode: "contract", securityMode, investigationMode };
  }
  if (/\b(remember to|remember this rule|save this preference|turn this correction into a rule)\b/.test(lower)) {
    return { command: "/learn", mode: "contract", securityMode, investigationMode };
  }
  if (/\b(every monday|every morning|automations tab|persistent background automation)\b/.test(lower)) {
    return { command: "/automation", mode: "load", securityMode, investigationMode };
  }
  if (/\b(in \d+ minutes|one-time timer|poll every|recurring check in this chat)\b/.test(lower)) {
    return { command: "/schedule", mode: "run", securityMode, investigationMode };
  }
  if (/\b(keep going overnight|don't stop|overnight|run until done|fully autonomous)\b/.test(lower)) {
    return { command: "/goal", mode: "recommend", securityMode, investigationMode };
  }
  if (/\b(localhost:\d+|open in browser|check localhost|take ui screenshot|test live web page|renders at)\b/.test(lower)) {
    return { command: "/browser", mode: "run", securityMode, investigationMode };
  }
  if (/\b(pretooluse|posttooluse|hook|create a hook|configure mcp server|rule frontmatter)\b/.test(lower)) {
    return { command: "/agy-customizations", mode: "load", securityMode, investigationMode };
  }
  if (/\b(cli headless|antigravity cli flags|how do i use antigravity|antigravity official docs)\b/.test(lower)) {
    return { command: "/antigravity-guide", mode: "load", securityMode, investigationMode };
  }
  if (/\b(every changed file|for each file|same task across many files|staged multi-agent pipeline)\b/.test(lower)) {
    return { command: "/run-workflow", mode: "run", securityMode, investigationMode };
  }
  if (!PLAN_NOUN_CONTEXT.test(text) && /\b(plan the|write a plan|plan first|plan this|plan a \d|then plan|review before editing)\b/.test(lower)) {
    return { command: "/plan", mode: "contract", securityMode, investigationMode };
  }

  return { command: null, mode: "playbook", securityMode, investigationMode };
}

export function runEvalSuite({ rootDir = DEFAULT_ROOT_DIR } = {}) {
  const registryPath = path.join(rootDir, "skills", "astack-mode", "references", "native-commands.json");
  const fixturesPath = path.join(rootDir, "scripts", "eval", "fixtures", "routing-cases.json");
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

  const results = [];

  for (const tc of fixtures.routingCases) {
    const actual = classifyRoutingIntent(tc.prompt, registry);
    const expectedInvestigationMode = tc.expectedInvestigationMode ?? null;
    const pass =
      actual.command === tc.expectedCommand &&
      actual.mode === tc.expectedMode &&
      actual.securityMode === tc.expectedSecurityMode &&
      actual.investigationMode === expectedInvestigationMode;
    results.push({
      id: `routing:${tc.id}`,
      pass,
      expected: {
        command: tc.expectedCommand,
        mode: tc.expectedMode,
        securityMode: tc.expectedSecurityMode,
        investigationMode: expectedInvestigationMode,
      },
      actual,
    });
  }

  const skillsDir = path.join(rootDir, "skills");
  const shadowed = fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && RESERVED_SKILL_NAMES.has(d.name))
    .map((d) => d.name);
  results.push({
    id: "invariant:no-reserved-shadowing",
    pass: shadowed.length === 0,
    actual: shadowed,
  });

  const badNeedsValidation = {
    verdict: "needs_validation",
    fingerprint: "auth-missing-check",
    title: "Unresolved boundary check",
    description: "Deployment header check cannot be observed locally.",
    claimed_root_cause: "Proxy header trust is unverified.",
    trace: [{ kind: "entrypoint", file: "src/auth.ts", line: 12, scope: "auth", description: "Reads header." }],
    evidence: [{ file: "src/auth.ts", line: 12, description: "Header read without local proxy config." }],
    blockers: ["Reverse proxy configuration is outside repo."],
    validation_plan: { deployment: "Inspect edge proxy header stripping policy." },
    severity: {
      likelihood: { score: "high", reason: "Guess" },
      impact: { score: "high", reason: "Guess" },
      overall_severity: "high",
    },
  };
  const findingsRejectErrors = findingsValidator.validateDocument([badNeedsValidation], findingsSchema);
  results.push({
    id: "contract:needs-validation-forbids-severity",
    pass: findingsRejectErrors.length > 0,
    actualCount: findingsRejectErrors.length,
  });

  const refs = {
    surface: "src/app.ts#GET /admin",
    boundary: "src/auth.ts#requireAdmin",
    subsystem: "api",
    attack_class: "ATTACK-CLASSES.md#Access control",
  };
  const validLedgerUnit = {
    coverage_id: ledgerValidator.canonicalCoverageId(refs),
    canonical_refs: refs,
    surface: "Admin route",
    boundary: "Admin authz",
    subsystem: "API",
    attack_class: "Access control",
    starting_paths: ["src/app.ts", "src/auth.ts"],
    ordinary_attack_class_block: "ATTACK-CLASSES.md#Access control",
    selected_companion_blocks: [],
    excluded_blocks: [],
    prior_status: "none",
    attempts: [],
    wave: 1,
    status: "planned",
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [],
  };
  const ledgerPassErrors = ledgerValidator.validateDocument([validLedgerUnit]);
  results.push({
    id: "contract:valid-coverage-ledger-unit",
    pass: ledgerPassErrors.length === 0,
    actualErrors: ledgerPassErrors,
  });

  const badPlanResult = checkPlan("# Plan\n\nLong dash \u2014 fail.\n", "eval-plan.md");
  results.push({
    id: "contract:check-plan-rejects-prose-violations",
    pass: !badPlanResult.ok && badPlanResult.problems.some((p) => p.includes("long dash")),
    actualProblems: badPlanResult.problems.length,
  });

  const riskFixturesPath = path.join(rootDir, "scripts", "eval", "fixtures", "risk-cases.json");
  const riskReport = runRiskFixtureCases(riskFixturesPath);
  for (const rc of riskReport.results) {
    results.push({
      id: `risk:${rc.id}`,
      pass: rc.pass,
      expected: { category: rc.expectedCategory, residual: rc.expectedResidual },
      actual: { category: rc.category, residual: rc.residual, score: rc.score, signals: rc.signals },
      reasons: rc.reasons,
    });
  }
  results.push({
    id: "invariant:risk-high-blocked-precision",
    pass:
      riskReport.total > 0 &&
      riskReport.highBlockedPrecision === 1 &&
      riskReport.falsePositives.length === 0 &&
      riskReport.falseNegatives.length === 0,
    precision: riskReport.highBlockedPrecision,
    recall: riskReport.highBlockedRecall,
    falsePositives: riskReport.falsePositives,
    falseNegatives: riskReport.falseNegatives,
  });

  const passed = results.filter((r) => r.pass).length;
  return {
    ok: passed === results.length,
    suiteKind: "routing-fixture-and-contract-lint",
    total: results.length,
    passed,
    failed: results.length - passed,
    riskMetrics: {
      total: riskReport.total,
      passed: riskReport.passed,
      highBlockedPrecision: riskReport.highBlockedPrecision,
      highBlockedRecall: riskReport.highBlockedRecall,
      falsePositives: riskReport.falsePositives,
      falseNegatives: riskReport.falseNegatives,
    },
    results,
  };
}

const USAGE = `Usage: node scripts/eval/run-eval.mjs [options]

Options:
  --replay     Run incident-replay reviewer evaluation suite (offline contract grading by default)
  --live       With --replay, invoke live headless agy -p --json-schema --sandbox --agent pr-verifier
  --stream     With --replay --live, stream all incidents inside one agy --input-format stream-json session
  --json       Emit machine-readable JSON report
  -h, --help   Show this help text and exit 0`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      replay: { type: "boolean", default: false },
      live: { type: "boolean", default: false },
      stream: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const report = values.replay
    ? runIncidentReplay({ live: values.live, stream: values.stream })
    : runEvalSuite();
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const label = values.replay ? report.suiteKind : "eval:fixture-lint";
    process.stdout.write(
      `[${label}] passed=${report.passed}/${report.total} failed=${report.failed}\n`,
    );
    for (const item of report.results.filter((r) => !r.pass)) {
      console.error(`FAIL ${item.id}: ${JSON.stringify(item)}`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}
