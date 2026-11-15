---
name: fanout
description: "Lightweight N-way parallel subagent execution via Antigravity invoke_subagent for fast read-only sweeps, parallel fixes across disjoint files, and multi-perspective checks. Use /fanout for focused concurrent subagents; graduate to native Antigravity /swarm when workers need a live shared board, peer coordination, or independent @verifier gates."
---

# Fanout

Run $N$ independent tasks concurrently using Antigravity `invoke_subagent` without spinning up a full message-board swarm.

> [!NOTE]
> AStack names this lightweight runner **`/fanout`** so it never shadows Antigravity's built-in **`/swarm`**. See [`swarm-coordination.md`](../astack-mode/references/swarm-coordination.md) for the full tier matrix (`invoke_subagent`, `/boost`, native `/swarm`, `/teamwork`).

## When to Use `/fanout` vs Native `/swarm`

| Use `/fanout` (`invoke_subagent`) | Graduate to Native `/swarm` |
|---|---|
| 2 to 5 independent read-only investigations (`TypeName: "research"`, `/how`, `/why`, audit sweeps). | Broad multi-package or multi-PR changes needing named workers posting progress to a shared board. |
| Disjoint quick edits or declared race arms with no mid-flight peer coordination. | Multi-worker delivery needing an independent **`@verifier`** sign-off gate and `@monitor`. |
| Coverage matrices where one parent collects and aggregates results directly. | Complex multi-step coordination requiring real-time steering on the board. |

If the problem is *hard and tightly coupled* rather than cleanly divisible (race conditions, deep algorithmic defects, coupled refactors), use **`/boost`** instead of parallel fan-out.

## 1. Frame

Declare the shape, selection contract, isolation, and pinned inputs before spawning any worker:

- **Shape.** Declare whether the run is a `partition` (disjoint slices covering one whole), a `race` (competing independent arms solving one goal), or `mixed`.
- **Selection rule (for races).** Declare upfront before spawning: `first pass` (take earliest verified winner and cancel the rest), `rank all` (run all arms to completion and compare), or `best-of` (synthesize and land winner via `arena` criteria). Never pick a selection criterion after seeing outputs.
- **Isolation** (`principle-separate-before-serializing-shared-state`). Keep `Workspace: "inherit"` for read-only sweeps, `Workspace: "share"` for disjoint file writers, and `Workspace: "branch"` for competing `race` arms.
- **Pinned baseline and method.** Record exact `git rev-parse HEAD` SHA (`sha`) and explicit **measurement method** (exact command, sample count, unit, warm-up or interleaving order) whenever comparing timings, counts, or pass rates across workers.

## 2. Fan out

Launch all independent workers in one turn via `invoke_subagent`. Default model inheritance preserves your UI model and **Orchestrator** routing (honoring `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` only if present):

- Code or verification slices (`TypeName: "self"`): omit `Model` (`"inherit"`), directing each worker to read `agents/astack-agent.md` plus `skills/astack-mode/SKILL.md`.
- Broad read-only sweeps (`TypeName: "research"`) or live browser checks (`TypeName: "browser"`): `Model: "flash"` (or `"inherit"`).

Give every worker:

1. Its exact slice, out-of-bounds files, pinned `git rev-parse HEAD` SHA, and measurement method.
2. The strict worker return contract:
   - Verdict: `PASS`, `ISSUES`, or `BLOCKED`.
   - Echoed commit SHA and measurement method actually executed.
   - Observed command outputs (`principle-prove-it-works`).
   - An `ISSUES` worker MUST report **every** provable defect found in its slice rather than stopping at the first failure.

Wait reactively without polling (`invoke_subagent` wakes automatically).

## 3. Aggregate

1. **Audit protocol compliance first.** Verify each worker echoed the pinned commit SHA, followed the measurement method, and included real command output.
2. **Respawn once on missing metadata or skipped checks.** If a worker omitted its SHA or measurement method or skipped running checks, respawn that slice **once** with a corrective brief. If the respawn still omits required proof or returns `BLOCKED`, record an explicit coverage gap rather than guessing or silently shrinking scope.
3. **Apply declared selection and land safely.** Apply `first pass`, `rank all`, or `best-of` as framed in Step 1. Land chosen edits into the parent working tree **before** killing branch workers (`manage_subagents` `kill` deletes branched workspaces), then re-run full verification (`principle-prove-it-works`) on the merged workspace state.

## 4. Report

Return one compact report containing:

- **Frame.** Declared shape, selection rule (when racing), pinned SHA, and measurement method.
- **Slice verdicts.** Each slice's `PASS`, `ISSUES`, or `BLOCKED` status with echoed SHA and measured output.
- **Verified findings or winning arm.** Reproduced failures (with exact files and commands) or landed winning change plus post-merge proof.
- **Gaps and dropouts.** Any respawned slices, remaining unverified slices, or `BLOCKED` coverage holes.
- **Subagent inspection.** Point the user to clickable inline subagent rows or **Overview > Subagents** (App) / `/agents` (CLI) to open individual slice transcripts.
