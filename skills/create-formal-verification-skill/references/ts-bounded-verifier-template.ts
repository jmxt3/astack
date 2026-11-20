#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

export interface TransitionFinding<TState> {
  readonly property: string;
  readonly summary: string;
  readonly counterexample: {
    readonly stepCount: number;
    readonly trace: readonly string[];
    readonly state: TState;
  };
}

export interface BoundedCheckReport {
  readonly ok: boolean;
  readonly properties: Record<string, { readonly statesChecked: number; readonly status: "pass" | "fail" }>;
  readonly findings: readonly TransitionFinding<unknown>[];
}

interface DemoState {
  readonly phase: "draft" | "open" | "merged";
  readonly changesRequested: boolean;
  readonly allowMerge: boolean;
}

function checkFiniteTruthTable(): readonly TransitionFinding<DemoState>[] {
  const findings: TransitionFinding<DemoState>[] = [];
  const phases: readonly DemoState["phase"][] = ["draft", "open", "merged"];
  for (const phase of phases) {
    for (const changesRequested of [false, true]) {
      const allowMerge = phase === "open" && !changesRequested;
      if (changesRequested && allowMerge) {
        findings.push({
          property: "NoMergeWhenChangesRequested",
          summary: "allowMerge became true while changesRequested is true",
          counterexample: {
            stepCount: 0,
            trace: ["init"],
            state: { phase, changesRequested, allowMerge },
          },
        });
      }
    }
  }
  return findings;
}

export interface BoundedEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly violated: boolean;
}

export interface BoundedCheckResult {
  readonly visited: number;
  readonly findings: readonly TransitionFinding<DemoState>[];
  readonly mermaid: string;
}

function stateNodeId(s: DemoState): string {
  return `s_${s.phase}_${s.changesRequested ? "chg" : "ok"}_${s.allowMerge ? "merge" : "hold"}`;
}

function stateLabel(s: DemoState): string {
  const flags = [s.changesRequested ? "changes" : "clean", s.allowMerge ? "mergeable" : "gated"];
  return `${s.phase} (${flags.join(", ")})`;
}

function checkBoundedBfs(maxDepth = 4): BoundedCheckResult {
  const initial: DemoState = { phase: "draft", changesRequested: false, allowMerge: false };
  const encode = (s: DemoState) => `${s.phase}|${s.changesRequested}|${s.allowMerge}`;
  const seen = new Set<string>([encode(initial)]);
  const queue: Array<{ state: DemoState; trace: string[] }> = [{ state: initial, trace: ["init"] }];
  const findings: TransitionFinding<DemoState>[] = [];
  const nodeLabels = new Map<string, string>([[stateNodeId(initial), stateLabel(initial)]]);
  const edges = new Map<string, BoundedEdge>();
  const violatedIds = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.trace.length - 1 >= maxDepth) continue;

    const nextEdges: Array<{ label: string; next: DemoState }> = [];
    if (current.state.phase === "draft") {
      nextEdges.push({
        label: "ready-for-review",
        next: { ...current.state, phase: "open", allowMerge: !current.state.changesRequested },
      });
    }
    if (current.state.phase !== "merged") {
      nextEdges.push({
        label: "request-changes",
        next: { ...current.state, changesRequested: true, allowMerge: false },
      });
      nextEdges.push({
        label: "approve",
        next: { ...current.state, changesRequested: false, allowMerge: current.state.phase === "open" },
      });
    }
    if (current.state.allowMerge) {
      nextEdges.push({
        label: "merge",
        next: { ...current.state, phase: "merged", allowMerge: false },
      });
    }

    const fromId = stateNodeId(current.state);
    for (const edge of nextEdges) {
      const toId = stateNodeId(edge.next);
      nodeLabels.set(toId, stateLabel(edge.next));
      const violated = edge.next.phase === "merged" && edge.next.changesRequested;
      if (violated) {
        violatedIds.add(toId);
        findings.push({
          property: "NeverMergeWithOutstandingChanges",
          summary: "Reached merged phase while changesRequested remained true",
          counterexample: {
            stepCount: current.trace.length,
            trace: [...current.trace, edge.label],
            state: edge.next,
          },
        });
      }
      const edgeKey = `${fromId}|${toId}|${edge.label}`;
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, { from: fromId, to: toId, label: edge.label, violated });
      }
      const key = encode(edge.next);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ state: edge.next, trace: [...current.trace, edge.label] });
      }
    }
  }

  const lines = [
    "%% provenance: formal-ts",
    "stateDiagram-v2",
    "  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834",
    `  [*] --> ${stateNodeId(initial)}`,
  ];
  for (const [id, label] of nodeLabels.entries()) {
    lines.push(`  ${id}: ${label}`);
  }
  for (const e of edges.values()) {
    lines.push(`  ${e.from} --> ${e.to}: ${e.label}`);
  }
  for (const id of violatedIds) {
    lines.push(`  class ${id} breaks`);
  }

  return { visited: seen.size, findings, mermaid: `${lines.join("\n")}\n` };
}

export function runFormalVerification(): BoundedCheckReport & { readonly mermaid: string } {
  const truthFindings = checkFiniteTruthTable();
  const bfsResult = checkBoundedBfs();
  const findings = [...truthFindings, ...bfsResult.findings];
  return {
    ok: findings.length === 0,
    properties: {
      NoMergeWhenChangesRequested: {
        statesChecked: 6,
        status: truthFindings.length === 0 ? "pass" : "fail",
      },
      NeverMergeWithOutstandingChanges: {
        statesChecked: bfsResult.visited,
        status: bfsResult.findings.length === 0 ? "pass" : "fail",
      },
    },
    findings,
    mermaid: bfsResult.mermaid,
  };
}

const USAGE = `Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning ts-bounded-verifier-template.ts [options]

Options:
  --emit-mermaid <path>  Write explored stateDiagram-v2 chart for PR descriptions
  --json                 Emit machine-readable JSON verification report (default)
  -h, --help             Show this help text and exit 0`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "emit-mermaid": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const report = runFormalVerification();
  if (values["emit-mermaid"]) {
    const outFile = path.resolve(process.cwd(), values["emit-mermaid"]);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, report.mermaid, "utf8");
  }
  const { mermaid: _chart, ...jsonReport } = report;
  process.stdout.write(`${JSON.stringify(jsonReport, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}
