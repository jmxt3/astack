import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ROOT_DIR } from "../catalog.mjs";
import { validateFindingsDocument } from "../trust/index.mjs";

/**
 * Grades a single reviewer JSON output against a seeded incident's recall and false-positive expectations.
 */
export function gradeReplayOutput(incident, outputDoc) {
  const schemaErrors = validateFindingsDocument(outputDoc);
  const reasons = [...schemaErrors];

  const important = Array.isArray(outputDoc?.findings)
    ? outputDoc.findings.filter((f) => f?.severity === "important")
    : [];

  if (!incident.expectedVerdict.includes(outputDoc?.verdict)) {
    reasons.push(`Expected verdict in [${incident.expectedVerdict.join(", ")}], got ${outputDoc?.verdict}`);
  }
  if (important.length < incident.expectImportantMin) {
    reasons.push(`Expected >= ${incident.expectImportantMin} important finding(s), got ${important.length}`);
  }
  if (important.length > incident.expectImportantMax) {
    reasons.push(`False positive: expected <= ${incident.expectImportantMax} important finding(s), got ${important.length}`);
  }

  const foundCategories = new Set(important.map((f) => f.category));
  for (const reqCat of incident.expectedCategories ?? []) {
    if (!foundCategories.has(reqCat)) {
      reasons.push(`Missing expected important category: ${reqCat}`);
    }
  }

  return {
    id: incident.id,
    pass: reasons.length === 0,
    verdict: outputDoc?.verdict ?? null,
    importantCount: important.length,
    isBugCase: incident.expectImportantMin > 0,
    schemaErrors,
    reasons,
  };
}

function invokeLiveHeadlessVerifier({ diff, schemaPath, agent, cwd }) {
  const prompt = [
    "Review the unified git diff below as the read-only PR verifier.",
    "Return JSON matching the supplied findings schema.",
    "Only report verified important bugs in findings; keep clean diffs empty.",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");

  const stdout = execFileSync(
    "agy",
    [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      schemaPath,
      "--sandbox",
      "--agent",
      agent,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const parsed = JSON.parse(stdout.trim());
  const candidate = parsed?.structuredOutput ?? parsed?.result ?? parsed;
  if (typeof candidate === "string") {
    return JSON.parse(candidate);
  }
  return candidate;
}

/**
 * Runs incident-replay reviewer evaluation either offline against seed contracts or live via headless `agy -p`.
 */
export function runIncidentReplay({
  rootDir = DEFAULT_ROOT_DIR,
  fixturesPath = path.join(rootDir, "scripts", "eval", "fixtures", "incidents", "seed-incidents.json"),
  schemaPath = path.join(rootDir, "skills", "review-pr", "scripts", "findings-schema.json"),
  live = false,
  agent = "pr-verifier",
} = {}) {
  const corpus = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  const incidents = Array.isArray(corpus.incidents) ? corpus.incidents : [];
  const results = [];

  for (const incident of incidents) {
    let outputDoc = incident.referenceOutput;
    if (live) {
      try {
        outputDoc = invokeLiveHeadlessVerifier({
          diff: incident.diff,
          schemaPath,
          agent,
          cwd: rootDir,
        });
      } catch (err) {
        results.push({
          id: incident.id,
          pass: false,
          verdict: null,
          importantCount: 0,
          isBugCase: incident.expectImportantMin > 0,
          schemaErrors: [err.message],
          reasons: [`Live agy -p invocation failed: ${err.message}`],
        });
        continue;
      }
    }
    results.push(gradeReplayOutput(incident, outputDoc));
  }

  const bugCases = results.filter((r) => r.isBugCase);
  const cleanCases = results.filter((r) => !r.isBugCase);
  const recallHits = bugCases.filter((r) => r.pass).length;
  const falsePositives = cleanCases.filter((r) => !r.pass).length;
  const passed = results.filter((r) => r.pass).length;

  return {
    ok: passed === results.length && incidents.length > 0,
    suiteKind: live ? "live-agy-incident-replay" : "offline-incident-replay-contract",
    total: results.length,
    passed,
    failed: results.length - passed,
    bugRecall: bugCases.length > 0 ? Number((recallHits / bugCases.length).toFixed(3)) : 1,
    falsePositives,
    results,
  };
}
