### Orchestrate

**You run the program, never the code. Decide which Swarm worker or subagent owns each unit, then verify what each one produces.** For a standing project handed to one coordinator chat: multi-day, many stacked PRs, dozens to hundreds of tasks, few human turns. One task driven to a predicate is Autonomous run (`/goal`). One ambitious run needing upfront scoping and milestone audit gates pairs cleanly with `/teamwork`. Work one agent can finish inside the session's budget is not a coordinator program.

Drive execution natively via Antigravity's `/swarm` (`swarm`, `post_message`, `read_board`, `swarm_wait`) and `invoke_subagent`. Name the swarm with `swarm{action: "title"}`, load `swarm_pane` to maintain `<appData>/brain/<conv-id>/.system_generated/swarm/plan.json` (plus `Screenshot: <abs-path> | <caption <=10 words>` posts for UI streams) alongside `task.md` and `show-me-your-work`, and use `schedule` (or `watch-pr.mjs`) only when waiting on external PR/CI transitions. Call no shell sleep loops and never relay raw noise between workers manually.

#### Topology

- **One owner per PR.** Add each PR owner as a dedicated worker (`swarm{action: "add", workspace: "branch", ...}` or `"share"` for same-branch independent files). Only the owner pushes, rebases, or retargets its branch. Conflicted merges and chain rebases go back to the owning worker, never fixed directly by the coordinator.
- **Self-contained `@mention` briefs.** Workers start fresh and see nothing of your conversation unless `fork` is explicitly passed. Each kickoff MUST paste the full user goal, owned paths, required reading of `agents/astack-agent.md` + `skills/astack-mode/SKILL.md`, and empirical proof requirements (`control-ui`, `control-cli`, `node --test`, or check command).
- **Sub-coordinators when an area fans wide.** Stop at three levels (coordinator, area sub-coordinator, workers) and keep 5–10 active workers per coordinator.
- **Follow-ups on built state.** Message an existing worker on the board (`post_message` `@worker`) only when it holds live running servers or uncommitted state that is costly to rebuild; otherwise spawn a fresh worker with consolidated scope. Land or push every verified branch BEFORE calling `swarm{action: "kill"}` (because `kill` deletes the worker's `share`/`branch` workspace).
- **Independent `@verifier` gate (1 per 2–4 authors).** Spawn `@verifier` workers with `workspace: "inherit"`, inheriting the active session model by default (or selecting a live distinct model family with available quota via `swarm{action: "models", all: true}` when cross-family verification is wanted). Authors only self-check; `@verifier` posts `PASS` / `FAIL` on the board citing `#seq` receipts.
- **Arm `@monitor` on long programs.** Add a lightweight `monitor` worker (following `swarm_monitor`) on long runs to catch stalled workers cleanly.
- **Start with one unit.** Validate kickoff -> author -> `@verifier` -> merge on one vertical slice before fanning out across fifty units.

#### Supervision

- **Each kickoff names the evidence that proves the work is done,** such as a command and its expected output, a control-skill check, or an artifact. It also names the goal, the paths the worker may and may not write, and the actions it must not take. If you can't name the evidence, the unit isn't scoped yet.
- **Read the diff or the artifact, not only the worker's summary.** Green CI is an input to a verdict, not a verdict. Behavioral work needs more than a type check. A verdict covers one head SHA, so a new push needs a new verdict. Read a sample of each sub-coordinator's kickoffs while its workers run, and fix its instructions when one fails.
- **Send back work that drifts from scope or grows past what was asked.** Keep only the fixes that block the program, and park the rest as follow-ups.
- **Check a PR's live state before you report on it,** with `gh pr view` and `gh pr checks` or your forge's equivalents, not the worker's last report. Account for every worker you spawned as done, replaced, or absorbed into another worker's scope.
- **Stop or replace a worker that stalls or loops.** Judge it by its pushes and PR activity, not its status text. Retry by cause: a smaller scope after a context or memory limit, the same kickoff after a dropped connection, and a different model after a tool error. After two retries, drop the unit and replan around it. When a stopped worker returns late, check its result against the PR's current state, and hand any unique findings to a fresh worker.
- **Ask the user only for a real decision or a blocker,** such as an irreversible action, a product or preference call that no experiment settles, or a dead end that survived a replan. Rebase mechanics, retries, CI flakes, review triage, and "should I keep going" never reach the user.

**Reply:** what landed against the goal, each PR's live state and verdict with its link, what was dropped and why, and the decisions waiting on the user.
