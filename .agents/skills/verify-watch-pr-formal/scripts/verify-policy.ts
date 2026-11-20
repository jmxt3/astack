import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  applyQueueSnapshot,
  assessGitHubMerge,
  classifyPr,
  createQueueState,
  evaluateQueue,
  planQueue,
  selectTierMajorStackDecision,
} from "../../../../skills/astack-mode/scripts/watch-pr/policy.ts";
import type {
  Check,
  CiState,
  MergeStateStatus,
  PollingOptions,
  PrContext,
  PrSnapshot,
  PullRequestFacts,
  ReviewDecision,
  ReviewThread,
  RollupState,
} from "../../../../skills/astack-mode/scripts/watch-pr/types.ts";
import { nonEmpty, parsePrNumber } from "../../../../skills/astack-mode/scripts/watch-pr/types.ts";

interface Finding {
  readonly property: string;
  readonly summary: string;
  readonly counterexample: unknown;
}

function ctx(n: number): PrContext {
  return { owner: "astack", repo: "verify", number: parsePrNumber(n) };
}

const PASS_CHECK: Check = {
  kind: "passed",
  name: "ci/test",
  reportedState: "SUCCESS",
  description: "passed",
  link: "",
  workflow: "ci",
};

const FAIL_CHECK: Check = {
  kind: "failed",
  name: "ci/test",
  reportedState: "FAILURE",
  description: "failed",
  link: "",
  workflow: "ci",
};

const PEND_CHECK: Check = {
  kind: "pending",
  name: "ci/test",
  reportedState: "PENDING",
  description: "pending",
  link: "",
  workflow: "ci",
};

const THREAD: ReviewThread = {
  id: "t-1",
  firstComment: null,
  isBugbot: false,
  bugbotReviewPasses: 0,
};

function makeCi(
  kind: CiState["kind"],
  mergeStateStatus: MergeStateStatus,
): CiState {
  const base = {
    source: "gh-pr-checks" as const,
    all: [PASS_CHECK] as const,
    hadPreviousPassingCi: false,
  };
  if (kind === "ci-failing") {
    return {
      ...base,
      kind: "ci-failing",
      all: [FAIL_CHECK],
      failed: [FAIL_CHECK],
      pending: [],
      github: assessGitHubMerge({ mergeStateStatus, headRollupState: "FAILURE" }),
    };
  }
  if (kind === "ci-github-rejected") {
    return {
      ...base,
      kind: "ci-github-rejected",
      failed: [],
      pending: [],
      github: {
        kind: "refused",
        mergeStateStatus: "BLOCKED",
        headRollupState: "FAILURE",
      },
    };
  }
  if (kind === "ci-pending") {
    return {
      ...base,
      kind: "ci-pending",
      all: [PEND_CHECK],
      failed: [],
      pending: [PEND_CHECK],
    };
  }
  const safeRollup: Exclude<RollupState, "ERROR" | "FAILURE"> = "SUCCESS";
  const github =
    mergeStateStatus === "BLOCKED"
      ? ({
          kind: "allowed",
          basis: "rollup",
          mergeStateStatus: "BLOCKED",
          headRollupState: safeRollup,
        } as const)
      : ({
          kind: "allowed",
          basis: "merge-state",
          mergeStateStatus,
          headRollupState: safeRollup,
        } as const);
  return {
    ...base,
    kind: "ci-clean",
    failed: [],
    pending: [],
    github,
  };
}

function makeFacts(
  prNum: number,
  overrides: Partial<PullRequestFacts>,
): PullRequestFacts {
  return {
    context: ctx(prNum),
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    headRefOid: "abc123",
    headRefName: `feat-${prNum}`,
    baseRefName: "main",
    state: "OPEN",
    mergedAt: null,
    isDraft: false,
    ...overrides,
  };
}

function expectedTier(row: PrSnapshot, allowDraft: boolean): number {
  if (row.kind === "merged") return 6;
  if (
    row.kind === "open" &&
    (row.facts.mergeable === "CONFLICTING" ||
      row.facts.mergeStateStatus === "DIRTY" ||
      row.facts.mergeStateStatus === "CONFLICTING")
  ) {
    return 0; // merge-conflicts
  }
  if (row.kind === "open" && row.threads.length > 0) {
    return 1; // review-threads
  }
  if (
    row.kind === "open" &&
    (row.ci.kind === "ci-failing" || row.ci.kind === "ci-github-rejected")
  ) {
    return 2; // failing-checks
  }
  const hasChangesRequested = row.facts.reviewDecision === "CHANGES_REQUESTED";
  const isDraftPendingOnly =
    row.kind === "open" &&
    row.facts.isDraft &&
    !allowDraft &&
    !hasChangesRequested &&
    row.ci.kind === "ci-pending";
  const hasGate =
    row.kind === "closed" ||
    hasChangesRequested ||
    (row.facts.isDraft && !allowDraft);
  if (hasGate && !isDraftPendingOnly) {
    return 3; // merge-gate
  }
  if (row.kind === "open" && row.ci.kind === "ci-pending") {
    return 4; // waiting
  }
  return 5; // ready
}

function verifyAssessGitHubMerge(): { checked: number; firstFinding: Finding | null } {
  const mergeStates: readonly MergeStateStatus[] = [
    "BEHIND",
    "BLOCKED",
    "CLEAN",
    "CONFLICTING",
    "DIRTY",
    "DRAFT",
    "HAS_HOOKS",
    "UNKNOWN",
    "UNSTABLE",
  ];
  const rollups: readonly RollupState[] = [
    "ERROR",
    "EXPECTED",
    "FAILURE",
    "PENDING",
    "SUCCESS",
    null,
  ];
  let checked = 0;
  let firstFinding: Finding | null = null;
  for (const mergeStateStatus of mergeStates) {
    for (const headRollupState of rollups) {
      checked++;
      const res = assessGitHubMerge({ mergeStateStatus, headRollupState });
      const shouldRefuse =
        mergeStateStatus === "BLOCKED" &&
        (headRollupState === "ERROR" || headRollupState === "FAILURE");
      const expected = shouldRefuse ? "refused" : "allowed";
      if (res.kind !== expected && !firstFinding) {
        firstFinding = {
          property: "AssessGitHubMergeTotal",
          summary: `assessGitHubMerge returned ${res.kind}, expected ${expected}`,
          counterexample: { mergeStateStatus, headRollupState, actual: res },
        };
      }
    }
  }
  return { checked, firstFinding };
}

function verifyClassifyPrExhaustive(): {
  checked: number;
  violations: number;
  firstFinding: Finding | null;
} {
  const mergeables: readonly PullRequestFacts["mergeable"][] = [
    "MERGEABLE",
    "CONFLICTING",
    "UNKNOWN",
  ];
  const mergeStates: readonly MergeStateStatus[] = [
    "CLEAN",
    "BLOCKED",
    "DIRTY",
    "CONFLICTING",
    "UNKNOWN",
  ];
  const reviews: readonly ReviewDecision[] = [
    "APPROVED",
    "CHANGES_REQUESTED",
    "REVIEW_REQUIRED",
    null,
  ];
  const ciKinds: readonly CiState["kind"][] = [
    "ci-clean",
    "ci-pending",
    "ci-failing",
    "ci-github-rejected",
  ];
  let checked = 0;
  let violations = 0;
  let firstFinding: Finding | null = null;

  for (const allowDraft of [false, true]) {
    for (const kind of ["merged", "closed"] as const) {
      checked++;
      const snap: PrSnapshot = {
        kind,
        context: ctx(1),
        facts: makeFacts(1, {
          state: kind === "merged" ? "MERGED" : "CLOSED",
          mergedAt: kind === "merged" ? "2026-01-01T00:00:00Z" : null,
        }),
      };
      const dec = classifyPr(snap, allowDraft);
      if (kind === "merged" && dec.kind !== "merged") {
        violations++;
        firstFinding ??= {
          property: "ClassifyPrSafetyAndPrecedence",
          summary: `Merged PR classified as ${dec.kind}`,
          counterexample: { kind, allowDraft, actual: dec },
        };
      }
      if (
        kind === "closed" &&
        !(
          dec.kind === "blocker" &&
          dec.blocker.kind === "merge-gate" &&
          dec.blocker.reason === "closed-without-merge"
        )
      ) {
        violations++;
        firstFinding ??= {
          property: "ClassifyPrSafetyAndPrecedence",
          summary: `Closed PR classified as ${dec.kind}`,
          counterexample: { kind, allowDraft, actual: dec },
        };
      }
    }

    for (const mergeable of mergeables) {
      for (const mergeStateStatus of mergeStates) {
        for (const reviewDecision of reviews) {
          for (const isDraft of [false, true]) {
            for (const hasThreads of [false, true]) {
              for (const ciKind of ciKinds) {
                checked++;
                const snap: PrSnapshot = {
                  kind: "open",
                  context: ctx(1),
                  facts: makeFacts(1, {
                    mergeable,
                    mergeStateStatus,
                    reviewDecision,
                    isDraft,
                  }),
                  threads: hasThreads ? [THREAD] : [],
                  ci: makeCi(ciKind, mergeStateStatus),
                  reviewAutomationRunning: false,
                };
                const dec = classifyPr(snap, allowDraft);
                const tier = expectedTier(snap, allowDraft);
                const actualTier =
                  dec.kind === "blocker"
                    ? dec.blocker.kind === "merge-conflicts"
                      ? 0
                      : dec.blocker.kind === "review-threads"
                        ? 1
                        : dec.blocker.kind === "failing-checks"
                          ? 2
                          : 3
                    : dec.kind === "waiting"
                      ? 4
                      : 5;

                const readyUnsound =
                  dec.kind === "ready" &&
                  (mergeable === "CONFLICTING" ||
                    mergeStateStatus === "DIRTY" ||
                    mergeStateStatus === "CONFLICTING" ||
                    hasThreads ||
                    ciKind !== "ci-clean" ||
                    reviewDecision === "CHANGES_REQUESTED" ||
                    (isDraft && !allowDraft));

                if (actualTier !== tier || readyUnsound) {
                  violations++;
                  firstFinding ??= {
                    property: "ClassifyPrSafetyAndPrecedence",
                    summary: readyUnsound
                      ? "Unsound ready classification on blocked/unready PR"
                      : `Precedence mismatch: got ${dec.kind} (tier ${actualTier}), expected tier ${tier}`,
                    counterexample: {
                      allowDraft,
                      mergeable,
                      mergeStateStatus,
                      reviewDecision,
                      isDraft,
                      hasThreads,
                      ciKind,
                      actual: dec.kind,
                    },
                  };
                }
              }
            }
          }
        }
      }
    }
  }
  return { checked, violations, firstFinding };
}

function buildCanonicalBasis(prNum: number): PrSnapshot[] {
  return [
    {
      kind: "merged",
      context: ctx(prNum),
      facts: makeFacts(prNum, { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }),
    },
    {
      kind: "closed",
      context: ctx(prNum),
      facts: makeFacts(prNum, { state: "CLOSED" }),
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { mergeable: "CONFLICTING" }),
      threads: [],
      ci: makeCi("ci-clean", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { mergeStateStatus: "DIRTY" }),
      threads: [],
      ci: makeCi("ci-clean", "DIRTY"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum),
      threads: [THREAD],
      ci: makeCi("ci-clean", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum),
      threads: [],
      ci: makeCi("ci-failing", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { mergeStateStatus: "BLOCKED" }),
      threads: [],
      ci: makeCi("ci-github-rejected", "BLOCKED"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { reviewDecision: "CHANGES_REQUESTED" }),
      threads: [],
      ci: makeCi("ci-clean", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { isDraft: true }),
      threads: [],
      ci: makeCi("ci-pending", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { isDraft: true, reviewDecision: "CHANGES_REQUESTED" }),
      threads: [],
      ci: makeCi("ci-pending", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { isDraft: true }),
      threads: [],
      ci: makeCi("ci-clean", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum),
      threads: [],
      ci: makeCi("ci-pending", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum),
      threads: [],
      ci: makeCi("ci-clean", "CLEAN"),
      reviewAutomationRunning: false,
    },
  ];
}

function verifyStackTierMajorExhaustive(): {
  checked: number;
  violations: number;
  firstFinding: Finding | null;
} {
  const bottomBasis = buildCanonicalBasis(10);
  const upstackBasis = buildCanonicalBasis(11);
  let checked = 0;
  let violations = 0;
  let firstFinding: Finding | null = null;

  for (const allowDraft of [false, true]) {
    for (const b of bottomBasis) {
      for (const u of upstackBasis) {
        checked++;
        const rows = [b, u] as const;
        const dec = selectTierMajorStackDecision(rows, allowDraft);
        const tB = expectedTier(b, allowDraft);
        const tU = expectedTier(u, allowDraft);
        const winTier = Math.min(tB, tU);
        const expectedWinnerPr = tB <= tU ? 10 : 11;

        if (winTier <= 3) {
          if (dec.kind !== "blocker" || dec.blocker.pr.number !== expectedWinnerPr) {
            violations++;
            firstFinding ??= {
              property: "StackTierMajorSafety",
              summary: `Expected blocker on PR #${expectedWinnerPr} (tier ${winTier}), got ${dec.kind}`,
              counterexample: {
                allowDraft,
                bottomTier: tB,
                upstackTier: tU,
                actual: dec,
              },
            };
          }
        } else if (winTier === 4) {
          if (dec.kind !== "waiting" || dec.frontier.number !== expectedWinnerPr) {
            violations++;
            firstFinding ??= {
              property: "StackTierMajorSafety",
              summary: `Expected waiting on PR #${expectedWinnerPr}, got ${dec.kind}`,
              counterexample: { allowDraft, bottomTier: tB, upstackTier: tU, actual: dec },
            };
          }
        } else {
          const ok =
            dec.kind === "clear" &&
            dec.prs.length === 2 &&
            dec.prs.every((item) => item.kind === "ready-pr" || item.kind === "merged-pr");
          if (!ok) {
            violations++;
            firstFinding ??= {
              property: "StackTierMajorSafety",
              summary: `Expected clear stack decision, got ${dec.kind}`,
              counterexample: { allowDraft, bottomTier: tB, upstackTier: tU, actual: dec },
            };
          }
        }
      }
    }
  }
  return { checked, violations, firstFinding };
}

function verifyQueuedBfsBounded(): {
  visitedStates: number;
  transitions: number;
  firstFinding: Finding | null;
  mermaid: string;
} {
  const opts: PollingOptions = {
    interval: 1,
    sweepInterval: 2,
    timeout: 4,
    maxQueryErrors: 5,
    allowDraft: false,
  };
  const queue = nonEmpty([ctx(101), ctx(102)])!;
  const outcomesForPr = (prNum: number): PrSnapshot[] => [
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum),
      threads: [],
      ci: makeCi("ci-clean", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum),
      threads: [],
      ci: makeCi("ci-pending", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "open",
      context: ctx(prNum),
      facts: makeFacts(prNum, { mergeable: "CONFLICTING" }),
      threads: [],
      ci: makeCi("ci-clean", "CLEAN"),
      reviewAutomationRunning: false,
    },
    {
      kind: "merged",
      context: ctx(prNum),
      facts: makeFacts(prNum, { state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }),
    },
  ];

  type Node = {
    state: ReturnType<typeof createQueueState>;
    now: number;
    trace: string[];
  };

  const snapTag = (s: PrSnapshot | undefined): string => {
    if (!s) return "none";
    if (s.kind === "merged") return "merged";
    if (s.kind === "closed") return "closed";
    if (s.facts.mergeable === "CONFLICTING") return "conflict";
    return s.ci.kind;
  };

  const stateKey = (s: ReturnType<typeof createQueueState>, now: number): string => {
    const work =
      s.work === null
        ? "null"
        : s.work.kind === "whole-stack-sweep"
          ? `sweep:${s.work.remaining.map((p) => p.number).join(",")}`
          : `poll:${s.work.frontier.number}`;
    return `${now}|${work}|${s.nextSweepAt}|${s.frontier?.number ?? "none"}|${snapTag(s.snapshots.get(parsePrNumber(101)))}|${snapTag(s.snapshots.get(parsePrNumber(102)))}`;
  };

  const toAbstractNode = (
    mode: string,
    s: ReturnType<typeof createQueueState>,
  ): { id: string; label: string } => {
    const t101 = snapTag(s.snapshots.get(parsePrNumber(101)));
    const t102 = snapTag(s.snapshots.get(parsePrNumber(102)));
    const rawId = `${mode}_${t101}_${t102}`.replace(/[^A-Za-z0-9_]/g, "_");
    const label = `${mode} (101=${t101}, 102=${t102})`;
    return { id: rawId, label };
  };

  const init = createQueueState(queue, 0);
  const initPlanned = planQueue(init, 0);
  const initNode = toAbstractNode(
    initPlanned.work?.kind === "whole-stack-sweep" ? "sweep" : `poll_${initPlanned.work?.frontier.number ?? 101}`,
    initPlanned,
  );
  const nodeLabels = new Map<string, string>([[initNode.id, initNode.label]]);
  const abstractEdges = new Map<string, { from: string; to: string; label: string }>();
  const brokenNodes = new Set<string>();
  const passNodes = new Set<string>();
  const timeoutNodes = new Set<string>();

  const seen = new Set<string>([stateKey(init, 0)]);
  const bfs: Node[] = [{ state: init, now: 0, trace: [] }];
  let transitions = 0;
  let firstFinding: Finding | null = null;

  while (bfs.length > 0) {
    const cur = bfs.shift()!;
    const planned = planQueue(cur.state, cur.now);
    if (planned.work === null) {
      firstFinding ??= {
        property: "QueuedStackStateMachineBFS",
        summary: "Deadlock: planQueue returned null work",
        counterexample: { trace: cur.trace },
      };
      continue;
    }

    const fromMode =
      planned.work.kind === "whole-stack-sweep" ? "sweep" : `poll_${planned.work.frontier.number}`;
    const fromNode = toAbstractNode(fromMode, planned);
    nodeLabels.set(fromNode.id, fromNode.label);

    if (planned.work.kind === "whole-stack-sweep") {
      for (const p of planned.work.remaining) {
        if (planned.snapshots.get(p.number)?.kind === "merged") {
          firstFinding ??= {
            property: "QueuedStackStateMachineBFS",
            summary: `Sweep re-included already-merged PR #${p.number}`,
            counterexample: { trace: cur.trace },
          };
          brokenNodes.add(fromNode.id);
        }
      }
    }

    const targetPr =
      planned.work.kind === "whole-stack-sweep"
        ? planned.work.remaining[0].number
        : planned.work.frontier.number;

    for (const snap of outcomesForPr(targetPr)) {
      transitions++;
      const applied = applyQueueSnapshot(planned, snap, cur.now, opts);
      const nextTrace = [...cur.trace, `${planned.work.kind}(#${targetPr}->${snapTag(snap)}@t=${cur.now})`];
      const actionVerb = planned.work.kind === "whole-stack-sweep" ? "sweep" : "poll";
      const edgeLabel = `${actionVerb} #${targetPr} ${snapTag(snap)}`;

      if (applied.state.work !== null) {
        const nextMode =
          applied.state.work.kind === "whole-stack-sweep"
            ? "sweep"
            : `poll_${applied.state.work.frontier.number}`;
        const toNode = toAbstractNode(nextMode, applied.state);
        nodeLabels.set(toNode.id, toNode.label);
        const edgeKey = `${fromNode.id}|${toNode.id}|${edgeLabel}`;
        if (!abstractEdges.has(edgeKey)) {
          abstractEdges.set(edgeKey, { from: fromNode.id, to: toNode.id, label: edgeLabel });
        }

        const key = stateKey(applied.state, cur.now);
        if (!seen.has(key)) {
          seen.add(key);
          bfs.push({ state: applied.state, now: cur.now, trace: nextTrace });
        }
        continue;
      }

      const ev = evaluateQueue(applied.state, cur.now, opts);
      let toMode = ev.kind;
      let toState = ev.state;
      if (ev.kind === "advance" || ev.kind === "waiting") {
        toMode = `poll_${ev.frontier.number}`;
      }
      const toNode = toAbstractNode(toMode, toState);
      nodeLabels.set(toNode.id, toNode.label);
      const edgeKey = `${fromNode.id}|${toNode.id}|${edgeLabel}`;
      if (!abstractEdges.has(edgeKey)) {
        abstractEdges.set(edgeKey, { from: fromNode.id, to: toNode.id, label: edgeLabel });
      }
      if (ev.kind === "complete") passNodes.add(toNode.id);
      if (ev.kind === "timeout") timeoutNodes.add(toNode.id);

      if (ev.kind === "complete") {
        for (const p of queue) {
          if (ev.state.snapshots.get(p.number)?.kind !== "merged") {
            brokenNodes.add(toNode.id);
            firstFinding ??= {
              property: "QueuedStackStateMachineBFS",
              summary: `Premature COMPLETE with non-merged PR #${p.number}`,
              counterexample: { trace: nextTrace },
            };
          }
        }
      } else if (ev.kind === "timeout") {
        if (cur.now < opts.timeout) {
          brokenNodes.add(toNode.id);
          firstFinding ??= {
            property: "QueuedStackStateMachineBFS",
            summary: `Premature timeout at t=${cur.now}`,
            counterexample: { trace: nextTrace },
          };
        }
      } else if (ev.kind === "advance") {
        if (
          ev.frontier.number !== 102 ||
          ev.state.snapshots.get(parsePrNumber(101))?.kind !== "merged"
        ) {
          brokenNodes.add(toNode.id);
          firstFinding ??= {
            property: "QueuedStackStateMachineBFS",
            summary: "Invalid frontier advance",
            counterexample: { trace: nextTrace, frontier: ev.frontier.number },
          };
        } else {
          const key = stateKey(ev.state, cur.now);
          if (!seen.has(key)) {
            seen.add(key);
            bfs.push({ state: ev.state, now: cur.now, trace: nextTrace });
          }
        }
      } else if (ev.kind === "waiting") {
        const expectedFrontier =
          ev.state.snapshots.get(parsePrNumber(101))?.kind === "merged" ? 102 : 101;
        if (ev.frontier.number !== expectedFrontier) {
          brokenNodes.add(toNode.id);
          firstFinding ??= {
            property: "QueuedStackStateMachineBFS",
            summary: `Frontier mismatch: got #${ev.frontier.number}, expected #${expectedFrontier}`,
            counterexample: { trace: nextTrace },
          };
        }
        const nextNow = cur.now + opts.interval;
        if (nextNow <= opts.timeout + 1) {
          const key = stateKey(ev.state, nextNow);
          if (!seen.has(key)) {
            seen.add(key);
            bfs.push({ state: ev.state, now: nextNow, trace: nextTrace });
          }
        }
      }
    }
  }

  const lines = [
    "%% provenance: formal-ts",
    "stateDiagram-v2",
    "  classDef breaks fill:#ffecee,stroke:#e72e3b,stroke-width:2.5px,color:#cd2834",
    "  classDef pass fill:#e6f6ec,stroke:#1a7f37,color:#116329",
    "  classDef skip fill:#fff8c5,stroke:#9a6700,color:#4d2d00",
    `  [*] --> ${initNode.id}`,
  ];
  for (const [id, label] of nodeLabels.entries()) {
    lines.push(`  ${id}: ${label}`);
  }
  for (const e of abstractEdges.values()) {
    lines.push(`  ${e.from} --> ${e.to}: ${e.label}`);
  }
  for (const id of passNodes) lines.push(`  class ${id} pass`);
  for (const id of timeoutNodes) lines.push(`  class ${id} skip`);
  for (const id of brokenNodes) lines.push(`  class ${id} breaks`);

  return { visitedStates: seen.size, transitions, firstFinding, mermaid: `${lines.join("\n")}\n` };
}

const USAGE = `Usage: node --experimental-strip-types --disable-warning=ExperimentalWarning .agents/skills/verify-watch-pr-formal/scripts/verify-policy.ts [options]

Options:
  --emit-mermaid <path>  Write explored stateDiagram-v2 chart for PR descriptions
  --json                 Emit machine-readable JSON verification report (default)
  -h, --help             Show this help text and exit 0`;

const { values } = parseArgs({
  options: {
    "emit-mermaid": { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const r1 = verifyAssessGitHubMerge();
const r2 = verifyClassifyPrExhaustive();
const r3 = verifyStackTierMajorExhaustive();
const r4 = verifyQueuedBfsBounded();

const findings = [
  r1.firstFinding,
  r2.firstFinding,
  r3.firstFinding,
  r4.firstFinding,
].filter((f): f is Finding => f !== null);

if (values["emit-mermaid"]) {
  const outFile = path.resolve(process.cwd(), values["emit-mermaid"]);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, r4.mermaid, "utf8");
}

const report = {
  ok: findings.length === 0,
  properties: {
    AssessGitHubMergeTotal: { statesChecked: r1.checked, status: r1.firstFinding ? "fail" : "pass" },
    ClassifyPrSafetyAndPrecedence: {
      statesChecked: r2.checked,
      violations: r2.violations,
      status: r2.firstFinding ? "fail" : "pass",
    },
    StackTierMajorSafety: {
      statesChecked: r3.checked,
      violations: r3.violations,
      status: r3.firstFinding ? "fail" : "pass",
    },
    QueuedStackStateMachineBFS: {
      visitedStates: r4.visitedStates,
      transitions: r4.transitions,
      status: r4.firstFinding ? "fail" : "pass",
    },
  },
  findings,
};

console.log(JSON.stringify(report, null, 2));
if (findings.length > 0) {
  process.exit(1);
}
