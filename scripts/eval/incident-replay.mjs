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

export function extractStructuredReplayPayload(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return parsed;
  }
  const envelope =
    parsed.event === "result" && parsed.result && typeof parsed.result === "object"
      ? parsed.result
      : parsed;
  const candidate =
    envelope.structured_output ??
    envelope.structuredOutput ??
    envelope.result ??
    envelope;
  if (typeof candidate === "string") {
    return JSON.parse(candidate);
  }
  return candidate;
}

export function extractReplayUsage(parsed) {
  const usage =
    parsed?.event === "result" ? parsed?.result?.usage : (parsed?.usage ?? parsed?.result?.usage);
  if (!usage || typeof usage !== "object") return null;
  return {
    input_tokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0,
    output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0,
    thinking_tokens: Number(usage.thinking_tokens ?? usage.thinkingTokens ?? 0) || 0,
    total_tokens: Number(usage.total_tokens ?? usage.totalTokens ?? 0) || 0,
  };
}

function buildVerifierPrompt(diff) {
  return [
    "Review the unified git diff below as the read-only PR verifier.",
    "Return JSON matching the supplied findings schema.",
    "Only report verified important bugs in findings; keep clean diffs empty.",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function invokeLiveHeadlessVerifier({ diff, schemaPath, agent, cwd }) {
  const stdout = execFileSync(
    "agy",
    [
      "-p",
      buildVerifierPrompt(diff),
      "--output-format",
      "json",
      "--json-schema",
      schemaPath,
      "--print-timeout",
      "10m",
      "--sandbox",
      "--agent",
      agent,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 600000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const parsed = JSON.parse(stdout.trim());
  return {
    doc: extractStructuredReplayPayload(parsed),
    usage: extractReplayUsage(parsed),
  };
}

function invokeLiveStreamVerifierBatch({ incidents, schemaPath, agent, cwd }) {
  const ndjsonInput = incidents
    .map((inc) =>
      JSON.stringify({
        event: "user",
        message: { content: buildVerifierPrompt(inc.diff) },
      }),
    )
    .join("\n")
    .concat("\n");

  const stdout = execFileSync(
    "agy",
    [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--json-schema",
      schemaPath,
      "--print-timeout",
      "10m",
      "--sandbox",
      "--agent",
      agent,
    ],
    {
      cwd,
      input: ndjsonInput,
      encoding: "utf8",
      timeout: 600000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const turnResults = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt?.event === "result") {
        turnResults.push({
          doc: extractStructuredReplayPayload(evt),
          usage: extractReplayUsage(evt),
        });
      }
    } catch {
    }
  }
  return turnResults;
}

/**
 * Runs incident-replay reviewer evaluation either offline against seed contracts or live via headless `agy -p`.
 */
export function runIncidentReplay({
  rootDir = DEFAULT_ROOT_DIR,
  fixturesPath = path.join(rootDir, "scripts", "eval", "fixtures", "incidents", "seed-incidents.json"),
  schemaPath = path.join(rootDir, "skills", "pre-pr", "scripts", "findings-schema.json"),
  live = false,
  stream = false,
  agent = "pr-verifier",
} = {}) {
  const corpus = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));
  const incidents = Array.isArray(corpus.incidents) ? corpus.incidents : [];
  const results = [];
  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    total_tokens: 0,
  };
  let hasUsage = false;

  const addUsage = (usage) => {
    if (!usage) return;
    hasUsage = true;
    totalUsage.input_tokens += usage.input_tokens;
    totalUsage.output_tokens += usage.output_tokens;
    totalUsage.thinking_tokens += usage.thinking_tokens;
    totalUsage.total_tokens += usage.total_tokens;
  };

  let streamBatch = null;
  if (live && stream && incidents.length > 0) {
    try {
      streamBatch = invokeLiveStreamVerifierBatch({ incidents, schemaPath, agent, cwd: rootDir });
    } catch (err) {
      streamBatch = err;
    }
  }

  for (let i = 0; i < incidents.length; i++) {
    const incident = incidents[i];
    let outputDoc = incident.referenceOutput;
    let usage = null;
    if (live) {
      try {
        if (stream) {
          if (streamBatch instanceof Error) throw streamBatch;
          const turn = streamBatch?.[i];
          if (!turn) throw new Error(`Missing stream-json result event for incident ${incident.id}`);
          outputDoc = turn.doc;
          usage = turn.usage;
        } else {
          const single = invokeLiveHeadlessVerifier({
            diff: incident.diff,
            schemaPath,
            agent,
            cwd: rootDir,
          });
          outputDoc = single.doc;
          usage = single.usage;
        }
        addUsage(usage);
      } catch (err) {
        results.push({
          id: incident.id,
          pass: false,
          verdict: null,
          importantCount: 0,
          isBugCase: incident.expectImportantMin > 0,
          usage: null,
          schemaErrors: [err.message],
          reasons: [`Live agy -p invocation failed: ${err.message}`],
        });
        continue;
      }
    }
    const graded = gradeReplayOutput(incident, outputDoc);
    if (usage) graded.usage = usage;
    results.push(graded);
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
    ...(hasUsage ? { totalUsage } : {}),
    results,
  };
}
