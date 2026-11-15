### Autonomous run

**You own the exit condition. Define done, then drive to it without stopping.**

1. State the exit condition as a checkable predicate before the first iteration (tests green, repro fixed, all N PRs merged, pixel-diff zero).
2. Pick the right native autonomy mechanism from [`../references/native-commands.md`](../references/native-commands.md):
   - **`/goal`** (`recommend` mode, App + CLI, harness-owned): Recommend `/goal <task>. Done when <predicate>.` when the harness should intercept normal stops across multi-turn execution until the predicate passes.
   - **`/schedule`** (`run` mode, App + CLI, `schedule` tool): Call `schedule` directly (`DurationSeconds` one-shot timer or `CronExpression` recurring check) for background waits or periodic monitoring inside the active conversation.
   - **`/automation`** (`load` mode, App only, `automation` skill): When the user asks for a persistent scheduled background job across restarts ("every Monday at 9am", "daily triage"), load Antigravity's built-in `automation` skill to write `~/.gemini/config/sidecars/<id>/sidecar.json` with `CRON_TZ=<zone>`, disabled until turned on in the App **Automations** tab after a permission-scoping test run. On CLI sessions, explain that `/automation` is App-only and offer `/schedule` for active sessions or `agy -p` for OS/CI triggers.
   - **`/boost`** (`recommend` mode): Recommend when iterative hypothesis testing across coupled code is needed.
   An event to watch in-session (CI, a merge, a ref advancing) gets a watcher subagent via `invoke_subagent` (or `watch-pr.mjs`) with reactive wakeup, backed by a fallback `schedule` heartbeat. Never use a shell sleep loop. Default watcher/helper subagents to `Model: "inherit"` (or `"flash"` for lightweight watchers; honoring optional `astack-models.md` if present) per `../references/swarm-coordination.md`.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help. Belt-and-suspenders that "might help" gets reverted, not left to ride.
   Sequence the work via the **sequence-verifiable-units** principle skill, verifying each unit before the next instead of batching checks at the end.
4. Mid-run discoveries that support the goal are yours. Address broken skills, related bugs, flaky verifiers, review noise, tooling failures, orphaned follow-ups, and fixable drift yourself via astack-mode. Put out-of-band fixes in their own PR. Do not park reversible work for the human or use `ask_question`. Surface only irreversible actions, genuine product or preference calls no experiment can settle, or a real dead end. Keep the predicate as the main drive, and return to it after each side fix.
5. Checkpoint every iteration via the **show-me-your-work** skill, a row for what changed and whether the predicate moved.
6. Stop when the predicate is met. A plateau is not a stop, so keep going and pivot your approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory.

**Reply:** the exit condition, iterations run, what landed, what was discarded, final predicate state.
