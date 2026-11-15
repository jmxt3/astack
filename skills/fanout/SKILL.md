---
name: fanout
description: "Lightweight N-way parallel subagent execution via Antigravity invoke_subagent for fast read-only sweeps, parallel fixes across disjoint files, and multi-perspective checks. Use /fanout for focused concurrent subagents; graduate to native Antigravity /swarm when workers need a live shared board, peer coordination, or independent @verifier gates."
---

# Fanout

Run $N$ independent tasks concurrently using Antigravity's `invoke_subagent` without the overhead of spinning up a full message-board swarm.

> [!NOTE]
> AStack names this lightweight runner **`/fanout`** so it never shadows Antigravity's built-in **`/swarm`**. See [`swarm-coordination.md`](../astack-mode/references/swarm-coordination.md) for the full 4-tier matrix (`invoke_subagent`, `/boost`, native `/swarm`, `/teamwork`).

## When to Use `/fanout` vs Native `/swarm`

| Use `/fanout` (`invoke_subagent`) | Graduate to Native `/swarm` |
|---|---|
| 2–5 independent read-only investigations (`TypeName: "research"`, `/how`, `/why`, audit sweeps). | Broad multi-package or multi-PR changes that need named workers posting status to a shared board. |
| Disjoint quick edits that do not need peer-to-peer handoffs mid-flight. | Multi-worker delivery that needs an independent **`@verifier`** gating sign-off and a `@monitor` for long runs. |
| Exploratory design/fix trials (`Workspace: "branch"`) where you inspect and land results yourself. | You want real-time visibility and steering on the board while workers execute. |

If the problem is *hard and tightly coupled* rather than cleanly divisible (race conditions, deep algorithmic bugs, flaky failures across shared code), skip parallel fanout and use **`/boost`** instead.

## Workflow

1. **Partition cleanly before launching.** Every write worker MUST own disjoint files/modules (`Workspace: "share"`), OR run in an isolated clone (`Workspace: "branch"`) when exploring alternative edits to the same code. Never let two `Workspace: "inherit"` writers mutate overlapping files (`principle-separate-before-serializing-shared-state`).
2. **Model selection.** Inherit the active UI model / **Orchestrator** by default (honoring `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` only if present):
   - Engineering / code writing (`TypeName: "self"`): `Model: "inherit"` (or omit `Model`), directing each prompt to read `agents/astack-agent.md` and `skills/astack-mode/SKILL.md` first.
   - Read-only exploration/audit (`TypeName: "research"`): `Model: "flash"` (or `"inherit"`).
   - Live browser checks (`TypeName: "browser"`): `Model: "flash"`.
3. **Launch all independent slices in a single batch** via `invoke_subagent`. Give each child:
   - Exact scope (files/questions owned and what is out of bounds).
   - Exact return format + empirical proof command to run before finishing.
   - Explicit instruction never to fabricate results (`principle-verify-before-reporting`).
4. **Wait reactively — never poll.** Stop calling tools or work on unrelated local setup; Antigravity wakes you automatically as each `invoke_subagent` reports back.
5. **Reconcile, land, and verify empirically.**
   - Read every result skeptically (`principle-trust-requires-verification`). Never merge two unverified diffs blindly.
   - Cherry-pick/apply clean changes from `"share"` or `"branch"` workspaces **before** terminating branches (`manage_subagents` `kill` deletes branched workspaces).
   - Run full integration checks (`control-ui`, `control-cli`, `node --test`, build/typecheck) on the combined workspace state and report verified outputs.
