---
name: verify-watch-pr-formal
description: "Formal bounded state-space and exhaustive truth-table verifier for the watch-pr PR merge-readiness and queued-stack policy engine (`skills/astack-mode/scripts/watch-pr/policy.ts`). Use when editing `watch-pr/policy.ts` or `watch-pr/types.ts` to verify safety, precedence, and queue state-machine invariants."
---

# Verify Watch-PR Policy (Formal)

Runs an exhaustive finite-domain and bounded-BFS state-space verifier directly against the TypeScript implementation in [`skills/astack-mode/scripts/watch-pr/policy.ts`](../../../skills/astack-mode/scripts/watch-pr/policy.ts).

## Why this tool

`watch-pr/policy.ts` is pure deterministic TypeScript, and Node 22+ is already required by `package.json` (`engines.node >= 22.6.0`). Running the verifier directly on the real exported functions avoids hand-model drift and requires zero external installs (no Java 11+ or `tla2tools.jar` needed).

## Coverage record & sync commit

- **Covered files:**
  - [`skills/astack-mode/scripts/watch-pr/policy.ts`](../../../skills/astack-mode/scripts/watch-pr/policy.ts) (`assessGitHubMerge`, `classifyPr`, `selectTierMajorStackDecision`, `createQueueState`, `planQueue`, `applyQueueSnapshot`, `evaluateQueue`)
  - [`skills/astack-mode/scripts/watch-pr/types.ts`](../../../skills/astack-mode/scripts/watch-pr/types.ts)
- **Sync commit:** `5944f8df2149f189934464938c56c5f87ae28ee0`

When a change touches either covered file after the sync commit, run the check below before accepting the change. Move the sync commit forward only after confirming every property and scope assumption still matches the code.

## Properties checked (and the harm each prevents)

1. **`AssessGitHubMergeTotal` (54 states):** Exhaustively checks every `(mergeStateStatus, headRollupState)` pair so GitHub merge refusal triggers if and only if `mergeStateStatus === "BLOCKED"` and `headRollupState` is `"ERROR"` or `"FAILURE"`. Prevents silently merging a PR that GitHub has already rejected on commit rollup.
2. **`ClassifyPrSafetyAndPrecedence` (1,924 states):** Exhaustively checks every combination of `mergeable`, `mergeStateStatus`, `reviewDecision`, `isDraft`, `allowDraft`, `threads`, `ciKind`, plus `merged`/`closed` snapshots so no unready or blocked PR is ever marked `ready` and blockers obey strict priority (`merge-conflicts` > `review-threads` > `failing-checks` > `merge-gate` > `waiting` > `ready`).
3. **`StackTierMajorSafety` (338 states):** Exhaustively checks 2-PR stacks across 13 canonical PR states (`allowDraft` false and true) so tier-major scanning reports the highest-severity blocker across the stack (and lowest-index PR on ties) instead of hiding an upstack conflict behind a frontier check.
4. **`QueuedStackStateMachineBFS` (bounded 2-PR queue BFS):** Explores reachable `(queue, work, nextSweepAt, frontier, snapshots, now)` states over `sweepInterval = 2`, `interval = 1`, `timeout = 4`, verifying no deadlocks (`planQueue` always schedules work while active), `COMPLETE` fires only when every PR is `merged`, `whole-stack-sweep` never re-includes already-merged PRs, and `frontier` always tracks the lowest-index unmerged PR.

## Scope & exclusions

- **Included:** Pure decision tables, tier-major stack precedence, and 2-PR queued-stack state transitions in `policy.ts`.
- **Excluded:** `gh` CLI subprocess execution and GraphQL pagination in `github.ts`, transient `WatcherQueryError` backoff timing in `pollUntilTerminal`, stacks of length 3+, and real wall-clock `setTimeout` scheduling.

## How to run

Run from the repository root (`c:\Users\jmach\dev\astack`):

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning .agents/skills/verify-watch-pr-formal/scripts/verify-policy.ts
```

- **Exit `0` (`ok: true`):** All 4 properties hold across all explored states.
- **Exit `1` (`ok: false`):** Prints JSON `findings` with the property name, plain-English summary, and exact `counterexample` input or step trace. Never weaken an invariant in `verify-policy.ts` to make a failing check pass; either fix the bug in `policy.ts` or confirm an intentional contract change and update the skill together.

## Verified baseline at sync commit `5944f8d`

At `5944f8df2149f189934464938c56c5f87ae28ee0` (after reordering `gateReason()` in `policy.ts` to check `CHANGES_REQUESTED` before `draft-pr`), all 4 properties pass with `0` findings (`AssessGitHubMergeTotal` 54 states, `ClassifyPrSafetyAndPrecedence` 1,924 states, `StackTierMajorSafety` 338 states, `QueuedStackStateMachineBFS` 57 states / 228 transitions).
