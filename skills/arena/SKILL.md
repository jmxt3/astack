---
name: arena
description: "Competitive multi-approach / multi-model bakeoff: spin up independent candidate implementations or architectures in isolated workspaces, pit them against the same empirical proof and red-flag screen, pick one winner, graft concrete strengths, and land verified code."
---

# Arena

When ambiguity is architectural, algorithmic, or high-leverage enough that picking the wrong abstraction costs 10x later, run independent candidates in isolation against one shared brief and private rubric, score empirically, pick one base, graft localized wins cleanly, and verify on the landed copy.

## Phase A. Frame

1. **Shared candidate brief.** Write one brief naming the goal, hard constraints, invariants, and exact empirical pass command (`control-ui`, `control-cli`, benchmark, or test suite). Pass the identical brief to every candidate.
2. **Private rubric.** Write 3 to 6 gradeable criteria covering interface depth, correctness on edge cases, and operational simplicity. Keep the rubric in the parent and **do not** share it with candidates so they solve the problem rather than gaming grading criteria.
3. **Isolation and model harness** (`principle-separate-before-serializing-shared-state`):
   - **Subagent Branch Arena (2 to 3 candidates).** Launch concurrent `invoke_subagent` calls (`TypeName: "self"`, `Workspace: "branch"` for code candidates; `Workspace: "inherit"` with disjoint `<scratch>/candidate-<x>/` output dirs for pure design sketches). Leave `Model` unset (`"inherit"`) to follow your active Antigravity UI model or **Orchestrator** (honoring `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` only if present), differentiating candidates via distinct architectural constraints or lenses.
   - **Native `/swarm` Cross-Family Arena.** Call `swarm{action: "models", all: true}` live at invocation time, filter to models with healthy `quota_remaining`, and spawn candidates (`workspace: "branch"`) across distinct model families when available. Fall back to `inherit` plus distinct lenses if only one model family has quota.
   - When paired with [`architect`](../architect/SKILL.md), also include [`skills/architect/references/runner-prompt.md`](../architect/references/runner-prompt.md) and Phase A grounding notes in the candidate brief.

## Phase B. Fan out

Launch all $N$ candidates ($2$ or $3$ by default, or user-requested $N$) in one batch. Instruct every candidate to:

- Read `agents/astack-agent.md` plus `skills/astack-mode/SKILL.md` first.
- Build its solution without hedging toward a generic middle ground (divergence is the signal).
- Run the shared empirical proof command and capture observed output (`principle-prove-it-works`).
- Deliver a short rationale naming the alternatives it considered and rejected.

Wait reactively without sleep-polling.

**Dropout handling.** If one candidate fails, errors out, or hits quota while at least 2 valid candidates finish, proceed with $N - 1$ and note the dropout in the report. If fewer than 2 candidates complete, respawn failed slots once; if still under 2, report degraded bakeoff coverage rather than presenting a solo run as a bakeoff.

## Phase C. Cross-judge

Spawn a read-only judge **only after Phase B completes**, running in parallel while the parent reads every candidate's full diff, types, and rationale end to end.

- **Distinct-family rule.** Under cross-family `/swarm`, check `swarm{action: "models", all: true}` for a healthy model family that authored **none** of the Phase B candidates and run `@judge` on that family. If no distinct family has quota (or in single-family subagent mode), skip spawning `@judge`, note why, and perform judging directly in the parent instead of spinning a redundant same-model judge.
- Pass `@judge` all surviving candidate artifacts or diffs, the Phase A private rubric, and [`skills/architect/references/design-red-flags.md`](../architect/references/design-red-flags.md). Never ask a judge to pick purely on prose summaries.

## Phase D. Pick a base

1. **Disqualify first.** Reject any candidate failing the empirical pass command (`principle-prove-it-works`), leaking transport types, repeating copy-paste shims, or retaining suppressions and fake fallbacks. Screen design red flags (`shallow module`, `information leakage`, `temporal decomposition`, `pass-through method`, `split ownership`, `two ways to do one task`, `importable internals`, `hand-synced list`).
2. **Score criterion by criterion.** Evaluate each surviving candidate against the private Phase A rubric. Compare your reading against `@judge`'s report to surface blind spots, especially when your preference disagrees with the judge.
3. **Select one cleanest base** (`principle-laziness-protocol`). Pick the single strongest foundation rather than blending incompatible architectures.

## Phase E. Graft

- Fold at most 1 to 2 discrete improvements (a sharper type boundary, edge-case guard, or clearer test) from non-winning candidates into the winning base **by hand** (`principle-redesign-from-first-principles`) so the final code reads cleanly from one mental model.
- Record rejected grafts and why in `Synthesis decision` when writing a rationale artifact.
- **Convergence vs wild divergence.** Independent convergence of multiple candidates on the same core structure is a positive signal. If candidates diverge wildly with no clear winner, check whether the Phase A brief hid an unsettled premise; stop and reframe the problem rather than forcing a brittle hybrid.

## Phase F. Verify

1. Apply or merge the chosen base plus manual grafts into the parent working tree **before** killing any branch subagents or `/swarm` workers (`manage_subagents` `kill` and `swarm{action: "kill"}` permanently delete branched workspaces).
2. Re-run the full empirical verification suite (`control-ui`, `control-cli`, builds, tests, static checks) on the final landed working copy (`principle-prove-it-works`). Judging a branch before grafting never proves the landed code.
3. Clean up temporary branch workspaces once the landed copy passes.
