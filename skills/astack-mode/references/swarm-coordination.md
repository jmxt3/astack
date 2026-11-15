# Antigravity Multi-Agent Orchestration & Swarm Coordination

AStack adapts Lauren Tan's (`@poteto`) high-trust `pstack` workflows natively to Google Antigravity's four orchestration tiers.

## 1. Choose the Right Execution Tier

| Problem Topology | Antigravity Mechanism | When to Choose It |
|---|---|---|
| Focused, self-contained side task (seconds to minutes) | `invoke_subagent` (`TypeName: "research" \| "browser" \| "self"`) | Codebase exploration, UI flow check, targeted test run, `/how`, `/why`, `/no-comments` (`comment-sicko`). Keeps main context clean (**principle-guard-the-context-window**). |
| Hard, coupled problem across shared code | `/boost` | Race conditions, flaky tests, perf optimization, algorithmic work, or coupled refactors where an initial hypothesis should be challenged, fixed, and re-verified across rounds. |
| Broad, cleanly divisible work across files, packages, PRs, or test suites | Native Antigravity `/swarm` (`swarm`, `post_message`, `read_board`, `swarm_wait`) | Parallel implementation across separate modules, N-lane verification gauntlets, PR autopilot queues, and multi-worker audits with an independent `@verifier` on a live message board. |
| Long-horizon, multi-milestone program (hours to days) | `/teamwork` + `/goal` | Repository-wide migrations, formal proofs, or multi-PR programs needing upfront `/grill-me` scoping, `/architect` type sketches, milestone audit gates, and persistent `show-me-your-work` decision logs until completion. |

## 2. Subagent Contract (`invoke_subagent`)

- **Role & persona**: For code-writing or engineering delegates, pass `TypeName: "self"` and direct the prompt to read `agents/astack-agent.md` plus the absolute path of `skills/astack-mode/SKILL.md` in full before any work. For comment/workaround sweeps, cite `agents/comment-sicko.md`. For read-only exploration, prefer `TypeName: "research"`. For live web UI flows, prefer `TypeName: "browser"` (or `chrome-devtools-mcp` via `control-ui`).
- **Workspace isolation**: Keep `Workspace: "inherit"` for read-only explorers/verifiers. Use `Workspace: "share"` for parallel authors editing separate files, or `Workspace: "branch"` for speculative `/arena` candidates.
- **No polling**: `invoke_subagent` notifies automatically on completion. Continue unrelated work or stop calling tools cleanly.
- **Fresh delegates by default**: Start a fresh `invoke_subagent` per discrete task with consolidated scope. Use `send_message(Recipient, Message)` only when resuming a delegate that owns live uncommitted state, a running dev server/simulator, or an active browser tab.

## 3. Native `/swarm` Coordinator Contract

AStack deliberately renames `pstack`'s lightweight parallel runner to [`/fanout`](../../fanout/SKILL.md) (`skills/fanout/`) so Antigravity's built-in `/swarm` is never shadowed. When running a native Swarm:

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

## 4. Model Routing (UI Picker & Orchestrator First)

- **Default inheritance (`inherit`).** Omit `Model` on `invoke_subagent` and omit `model` on `swarm{action: "add"}` so workers follow your Antigravity UI model selector (**Orchestrator**, effort levels, and newly released models). Unlike static prompt-time routers that lock a session onto one model, **Orchestrator** hands control cooperatively inside one trajectory from a read-only frontier planner (such as Gemini 4 Carbon, writing an explicit plan and re-planning triggers) to a fast executor (Gemini 4 Hydrogen, applying edits, updating packages, and running tests and Control Glass checks), handing back to the planner automatically when friction or broken premises occur. Keeping `Model` and `model` unset ensures subagents and `/swarm` workers never override this loop with static slugs or forced `Model: "pro"` defaults.
- **Evergreen fast sweeps.** Parallel read-only exploration (`TypeName: "research"`) and `TypeName: "browser"` may pass `Model: "flash"` (an evergreen capability alias, never a versioned model slug).
- **Live runtime discovery for `/arena` and cross-family gates.** Call `swarm{action: "models", all: true}` at invocation time while checking `quota_remaining` when pitting or judging across distinct model families (e.g., Gemini, Claude, GPT). Honor `.agents/rules/astack-models.md` or `~/.gemini/config/rules/astack-models.md` only when explicitly present as a power-user override.
