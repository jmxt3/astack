# Antigravity Multi-Agent Orchestration & Swarm Coordination

AStack adapts Lauren Tan's (`@poteto`) high-trust `pstack` workflows natively to Google Antigravity's orchestration tiers and native slash commands ([native-commands.md](./native-commands.md)).

## 1. Choose the Right Execution Tier

| Problem Topology | Antigravity Mechanism | When to Choose It |
|---|---|---|
| Focused, self-contained side task or 2-5 lightweight slices | `invoke_subagent` (`TypeName: "astack-agent" \| "comment-sicko" \| "research" \| "browser"`) or `/fanout` | Exploration, live UI check, comment audit, targeted test slice, or `/how`, `/why`, `/arena`. Parent aggregates and keeps main context clean (**principle-guard-the-context-window**). |
| Same task across many files, or staged phases with structured outputs | `/run-workflow` (`run` mode: `run-workflow` skill + `run_workflow`) | Programmatic Python orchestration using `parallel()` and `pipeline()` across N items or sequential phases (Pro & Ultra). |
| Hard, coupled problem across shared code | `/boost` (`recommend` mode) | Race conditions, flaky tests, perf optimization, algorithmic work, or coupled refactors where hypotheses are challenged, fixed, and re-verified across rounds (Paid plans). |
| Broad, cleanly divisible work across files, packages, PRs, or test suites | Native Antigravity `/swarm` (`run` mode: `swarm` skill + `swarm`, `post_message`, `read_board`, `swarm_wait`) | Parallel implementation across separate modules, N-lane verification gauntlets, PR autopilot queues, and multi-worker audits with an independent `@verifier` on a live message board (Pro & Ultra). |
| Long-horizon, multi-milestone program (hours to days) | `/teamwork` + `/goal` (`recommend` mode) | Repository-wide migrations, formal proofs, or multi-PR programs needing upfront `/grill-me` scoping, `/architect` type sketches, milestone audit gates, and persistent `show-me-your-work` decision logs until completion. |

## 2. Subagent Contract (`invoke_subagent`)

- **Role & persona**: For code-writing or engineering delegates, pass `TypeName: "astack-agent"` (falling back to `"self"` reading `agents/astack-agent.md` plus `skills/astack-mode/SKILL.md` only if plugin agents are unavailable). For comment/workaround sweeps, spawn `TypeName: "comment-sicko"`. For read-only exploration, prefer `TypeName: "research"`. For live web UI flows, engage `/browser` (`run` mode: `TypeName: "browser"`, built-in zero-focus-theft parallel browser on App `v2.30.0+` personal accounts, or Chrome `v144+` DevTools MCP on CLI/Enterprise; see [`control-ui`](../../control-ui/SKILL.md)).
- **Workspace isolation**: Keep `Workspace: "inherit"` for read-only explorers/verifiers. Use `Workspace: "share"` for parallel authors editing separate files, or `Workspace: "branch"` for speculative `/arena` candidates.
- **No polling**: `invoke_subagent` notifies automatically on completion. Continue unrelated work or stop calling tools cleanly.
- **Fresh delegates by default**: Start a fresh `invoke_subagent` per discrete task with consolidated scope. Use `send_message(Recipient, Message)` only when resuming a delegate that owns live uncommitted state, a running dev server/simulator, or an active browser tab.
- **Dedicated UI handoff**: When `invoke_subagent` runs behind the scenes (`/fanout`, `/arena`, `/interrogate`, `/no-comments`, `/how`, `/why`, or `browser`), point the user to clickable inline subagent rows or **Overview > Subagents** (`Ctrl+Alt+O` / `Cmd+Option+O`) in the App, and **`/agents`** (`Enter` detail view, `K` kill, `Alt+J` approval jump, `Ctrl+K` fast-path approval, `@<agent>` follow-ups) in the CLI.

## 3. Native `/swarm` Coordinator Contract

AStack deliberately renames `pstack`'s lightweight parallel runner to [`/fanout`](../../fanout/SKILL.md) (`skills/fanout/`) so Antigravity's built-in `/swarm` is never shadowed. When running a native Swarm:

1. **Load skills, name & structure the board**:
   - Read Antigravity's built-in `swarm` skill before calling `swarm`. When `swarm_pane` appears in `<skills>`, load `swarm_pane` too and maintain `<appDataDir>/brain/<conversation-id>/.system_generated/swarm/plan.json` (`goal`, `tasks`, `threads`) so the Swarm UI **Overview** tab renders live task progress (omit `narrator` when `swarm_pane` is active unless requested; for UI tasks, instruct workers taking screenshots to include `Screenshot: <abs-path-under-worker-brain-dir> | <what changed, <=10 words>` for the Swarm UI visual timeline).
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
   - When `swarm_monitor` appears in `<skills>`, add a dedicated `monitor` worker on multi-step or long-running swarms to detect stalls and wake the coordinator cleanly. When the whole job finishes, post `[done] <summary>` on the board with **no `@` mention** so `@monitor` cancels its timer and stands down.
5. **Land before `kill`**:
   - Calling `swarm{action: "kill", name}` permanently terminates the worker and **deletes its `share` or `branch` workspace**.
   - Always cherry-pick, merge, or push verified worker changes before killing author workers.
6. **Surface the Swarm UI at kickoff and completion (mandatory)**:
   - `swarm{action: "add"}` and `swarm{action: "status"}` return an `open_board` string (App **Open the Swarm UI** sidecar link, or CLI `/swarm board` hint).
   - End your kickoff reply with the exact `open_board` value on its own line.
   - When AStack finishes a task that used `/swarm` behind the scenes, post `[done] <summary>` (with no `@`), call `swarm{action: "status"}` if `open_board` is not already visible from the current turn, emit `open_board` verbatim on its own line at the end of the final report (omit only if empty; never forge or hand-write a board link), and invite the user to inspect the **Swarm** UI (**Overview**, **Board** `#seq` post feed, **Members** worker conversations, and **Graph** `@mention` replay in App, or `/swarm board` / `Alt+S` 3-pane viewer in CLI).

## 4. Model Routing (UI Picker & Orchestrator First)

- **Default inheritance (`inherit`).** Omit `Model` on `invoke_subagent` and omit `model` on `swarm{action: "add"}` so workers follow your Antigravity UI model selector (**Orchestrator (Carbon)** on Google AI Ultra, **Orchestrator (Argon)** on Pro & Ultra, effort levels, and newly released models). Unlike static prompt-time routers that lock a session onto one model, **Orchestrator** hands control cooperatively inside one trajectory from a read-only frontier planner (writing an explicit plan and re-planning triggers) to a fast executor (applying edits, updating packages, and running tests and Control Glass checks), handing back to the planner automatically when friction or broken premises occur. Keeping `Model` and `model` unset ensures subagents and `/swarm` workers never override this loop with static slugs or forced `Model: "pro"` defaults.
- **Evergreen fast sweeps.** Parallel read-only exploration (`TypeName: "research"`) and `TypeName: "browser"` may pass `Model: "flash"` (an evergreen capability alias, never a versioned model slug).
- **Live runtime discovery for `/arena` and cross-family gates.** Call `swarm{action: "models", all: true}` at invocation time while checking `quota_remaining` when pitting or judging across distinct model families (e.g., Gemini, Claude, GPT). Honor `.agents/rules/astack-models.md` or `~/.gemini/config/rules/astack-models.md` only when explicitly present as a power-user override.
- **CLI `/effort`, `/context`, and `/usage` controls.** In the Antigravity CLI, `/effort` opens the interactive **Set Effort** timeline gauge (`low`, `medium`, `high`, `xhigh`, `max` depending on model; `/effort <level>` direct switch; `agy -p "/effort" --output-format json` read-only check; `agy --effort <level>` per-session override), while fixed-budget **Orchestrator** reports effort as non-adjustable because it manages reasoning effort dynamically across planner and executor turns. Pair with `/usage` (`/quota`) for live model quota checks and `/context` for token and checkpoint breakdown.
