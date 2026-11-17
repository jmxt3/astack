#!/usr/bin/env node
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

function checkBoundedBfs(maxDepth = 4): { visited: number; findings: readonly TransitionFinding<DemoState>[] } {
  const initial: DemoState = { phase: "draft", changesRequested: false, allowMerge: false };
  const encode = (s: DemoState) => `${s.phase}|${s.changesRequested}|${s.allowMerge}`;
  const seen = new Set<string>([encode(initial)]);
  const queue: Array<{ state: DemoState; trace: string[] }> = [{ state: initial, trace: ["init"] }];
  const findings: TransitionFinding<DemoState>[] = [];

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

    for (const edge of nextEdges) {
      if (edge.next.phase === "merged" && edge.next.changesRequested) {
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
      const key = encode(edge.next);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push({ state: edge.next, trace: [...current.trace, edge.label] });
      }
    }
  }

  return { visited: seen.size, findings };
}

export function runFormalVerification(): BoundedCheckReport {
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
  };
}

const USAGE = `Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning ts-bounded-verifier-template.ts [options]

Options:
  --json       Emit machine-readable JSON verification report (default)
  -h, --help   Show this help text and exit 0`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const report = runFormalVerification();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}
