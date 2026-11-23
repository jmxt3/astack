# Antigravity Multi-Agent Orchestration & Swarm Coordination

AStack integrates its verification-first workflows natively with Google Antigravity's orchestration tiers and native slash commands ([native-commands.md](./native-commands.md)).

## 1. Choose the Right Execution Tier

| Problem Topology | Antigravity Mechanism | When to Choose It |
|---|---|---|
| Focused, self-contained side task or 2-5 lightweight slices | `invoke_subagent` (`TypeName: "astack-agent" \| "comment-sicko" \| "research" \| "browser"`) or `/fanout` | Exploration, live UI check, comment audit, targeted test slice, or `/how`, `/why`, `/arena`. Parent aggregates and keeps main context clean (**principle-guard-the-context-window**). |
| Same task across many files, or staged phases with structured outputs | `/run-workflow` (`run` mode: `run-workflow` skill + `run_workflow`) | Programmatic Python orchestration using `parallel()` and `pipeline()` across N items or sequential phases (All plans). |
| Hard, coupled problem across shared code | `/boost` (`recommend` mode) | Race conditions, flaky tests, perf optimization, algorithmic work, or coupled refactors where hypotheses are challenged, fixed, and re-verified across rounds (Paid plans). |
| Broad, cleanly divisible work across files, packages, PRs, or test suites | Native Antigravity `/swarm` (`run` mode: `swarm` skill + `swarm`, `post_message`, `read_board`, `swarm_wait`) | Parallel implementation across separate modules, N-lane verification gauntlets, PR autopilot queues, and multi-worker audits with an independent `@verifier` on a live message board (All plans). |
| Long-horizon, multi-milestone program (hours to days) | `/teamwork` + `/goal` (`recommend` mode) | Repository-wide migrations, formal proofs, or multi-PR programs needing upfront `/grill-me` scoping, `/architect` type sketches, milestone audit gates, and persistent `show-me-your-work` decision logs until completion. |

## 2. Subagent Contract (`invoke_subagent`)

- **Role & persona**: For code-writing or engineering delegates, pass `TypeName: "astack-agent"` (falling back to `"self"` reading `agents/astack-agent.md` plus `skills/astack-mode/SKILL.md` only if plugin agents are unavailable). For comment/workaround sweeps, spawn `TypeName: "comment-sicko"`. For read-only exploration, prefer `TypeName: "research"`. For live web UI flows, engage `/browser` (`run` mode: `TypeName: "browser"`, built-in zero-focus-theft parallel browser on App `v2.30.0+` personal accounts, or Chrome `v144+` DevTools MCP on CLI/Enterprise; see [`control-ui`](../../control-ui/SKILL.md)).
- **Workspace isolation**: Keep `Workspace: "inherit"` for read-only explorers/verifiers. Use `Workspace: "share"` for parallel authors editing separate files, or `Workspace: "branch"` for speculative `/arena` candidates.
- **No polling**: `invoke_subagent` notifies automatically on completion. Continue unrelated work or stop calling tools cleanly.
- **Fresh delegates by default**: Start a fresh `invoke_subagent` per discrete task with consolidated scope. Use `send_message(Recipient, Message)` only when resuming a delegate that owns live uncommitted state, a running dev server/simulator, or an active browser tab.

## 3. Native `/swarm` Coordinator Contract

AStack names its lightweight parallel subagent runner [`/fanout`](../../fanout/SKILL.md) (`skills/fanout/`) so Antigravity's built-in `/swarm` is never shadowed. When running a native Swarm:

1. **Name & structure the board**:
   - Call `swarm{action: "title", title: "<short descriptive title>"}`.
   - Choose clear role names (`worker-1`, `frontend-ui`, `api-fix`, `verifier`, `monitor`).
   - Add concurrent writers with `workspace: "share"` (or `"branch"` for independent PR clones) so authors never overwrite each other (**principle-separate-before-serializing-shared-state**).
   - Keep readers, reviewers, and `@verifier` workers on `workspace: "inherit"` unless they need an isolated checkout of a worker's branch.
2. **Write self-contained `@mention` briefs**:
   - Workers start fresh with zero view of the coordinator's conversation history (unless `fork: "<member>"` is explicitly set).
   - Every brief MUST state: (a) user goal & problem (**Why**), (b) exact owned files/directories and out-of-bounds files, (c) required read of `agents/astack-agent.md` and `skills/astack-mode/SKILL.md`, (d) concrete empirical done predicate (`control-ui`, `control-cli`, `node --test`, build/lint command), and (e) instruction to report back `@coordinator` on the board with `#seq` evidence.
3. **Independent `@verifier` gate (mandatory before landing)**:
   - Spawn at least one `@verifier` for every 2 to 4 author workers with `workspace: "inherit"`, leaving `model` unset by default so it inherits the session's active model / **Orchestrator** (or selecting a distinct live model family with available `quota_remaining` via `swarm{action: "models"}` when cross-family verification is wanted or configured).
   - Authors self-check; `@verifier` proves behavior end-to-end on the real surface without trusting author summaries (**principle-prove-it-works**).
   - On `@verifier` FAIL, post exact `#seq` reproduction evidence and assign the fix wave to a clean worker or owner before re-verifying.
4. **Long-running swarms (`@monitor` & reactive wakeups)**:
   - Wait for worker updates via `swarm_wait` (or end your turn cleanly after posting kickoff messages; never sleep-poll in a shell loop).
   - For multi-hour swarms, spawn a dedicated `monitor` worker using the `swarm_monitor` discipline to detect stalls and wake the coordinator.
5. **Land before `kill`**:
   - Calling `swarm{action: "kill", name}` permanently terminates the worker and **deletes its `share` or `branch` workspace**.
   - Always cherry-pick, merge, or push verified worker changes before killing author workers.

### Swarm Overview Panel (`swarm_pane`)

Load Antigravity's built-in `swarm_pane` skill whenever coordinating a `/swarm` so Antigravity's Swarm Overview UI displays structured progress without spawning a narrator worker:

1. Immediately after adding workers, write `<appData>/brain/<your conversation id>/.system_generated/swarm/plan.json` containing:
   - `goal`: `{ "title": "<4-8 words>", "line": "<at most 12 words>" }`
   - `tasks`: map from each worker name to a short summary of its owned slice
   - `threads`: 1 to 6 outcome-grouped threads (`{ "id", "title", "goal", "tasks": [...] }`) covering every worker
2. Rewrite `plan.json` only when workers are added, moved, or the swarm goal changes (live status comes from board posts).
3. For visible UI or layout work, instruct each UI-verifying worker in its brief to save full-window consistent-theme screenshots inside its own `<appData>/brain/<worker-conv-id>/` folder and report each milestone step on its own post line:
   `Screenshot: <absolute path> | <what changed in at most 10 words>`

## 4. Model Routing (UI Picker & Orchestrator First)

- **Default inheritance (`inherit`).** Omit `Model` on `invoke_subagent` and omit `model` on `swarm{action: "add"}` so workers follow your Antigravity UI model selector (**Orchestrator (Neon)**, **Orchestrator (Carbon)**, **Orchestrator (Argon)**, effort levels, and newly released models). Unlike static prompt-time routers that lock a session onto one model, **Orchestrator** hands control cooperatively inside one trajectory from a read-only frontier planner (writing an explicit plan and re-planning triggers) to a fast executor (applying edits, updating packages, and running tests and Control Glass checks), handing back to the planner automatically when friction or broken premises occur. Keeping `Model` and `model` unset ensures subagents and `/swarm` workers never override this loop with static slugs or forced `Model: "pro"` defaults.
- **Evergreen fast sweeps.** Parallel read-only exploration (`TypeName: "research"`) and `TypeName: "browser"` may pass `Model: "flash"` (an evergreen capability alias, never a versioned model slug).
- **Live runtime discovery for `/arena` and cross-family gates.** Call `swarm{action: "models", all: true}` at invocation time while checking `quota_remaining` when pitting or judging across distinct model families (e.g., Gemini, Claude, GPT). Honor `.agents/rules/astack-models.md` or `~/.gemini/config/rules/astack-models.md` only when explicitly present as a power-user override.
