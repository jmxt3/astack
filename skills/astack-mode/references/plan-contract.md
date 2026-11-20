# Native Planning and Learning Contracts

Antigravity documents `/plan`, `/grill-me`, and `/learn` as workflow contracts rather than standalone tools. When user intent matches one of these commands, follow its contract directly inside the active turn.

## `/plan` Contract

Follow this protocol whenever the user invokes `/plan`, stacks `/plan /astack-mode`, or asks to design or write a plan before changing code.

Match intent to plan work ("plan the auth refactor", "write a plan first", "review before you change anything"). Never trigger on incidental noun mentions such as "rename the `plan` column".

1. **Analysis and discovery.** Inspect the workspace read-only (`read_file`, search, read-only test or build observation, and `research` subagents for wide sweeps). Check constraints, callers, existing conventions, and base-branch `GLOSSARY.md` plus `REVIEW.md` (`git show <base>:GLOSSARY.md`). Honor `@` mentions (`@file`, `@rule`, `@conversation`) and any inline line comments attached to files or artifacts.
2. **Clarification.** Reserve `ask_question` for genuine product or preference forks (ask trivial yes/no checks in plain text). Keep options unnumbered, put `(Recommended)` on the first option when a default exists, and never add a manual `"Other"` option or `"select all that apply"` wording because Antigravity adds numbering, `"Other (write your answer)"`, Skip, and Cancel automatically. Reconcile domain terms against `GLOSSARY.md` during clarification. Settle empirical technical forks with [`prototype.md`](../playbooks/prototype.md) instead of asking. When stacked with `/grill-me`, run the `/grill-me` interview before drafting the plan.
3. **Task breakdown.** If `planning-and-task-breakdown` appears in `<skills>`, read its `SKILL.md` and follow it. Otherwise apply these portable rules so plans stay uniform across every machine.
   - Touch at most 5 files per task, sliced vertically end-to-end (schema or contract through caller and test, never horizontal-only layers) and scoped to one atomic commit or PR.
   - Include a clear description, checkable acceptance criteria, an executable verification command, explicit dependencies, file list (`[NEW]`, `[MODIFY]`, `[DELETE]`), and scope (`S`, `M`, or `L`) on every task.
   - Add a Mermaid dependency graph (`flowchart TD` or `flowchart LR`), explicit verification checkpoints between phases, and a risks table. Note the 6-stage deterministic pipeline rail (`humanGates.planApproval` and `humanGates.prReview` from `.agents/risk-policy.json`).
4. **Plan artifact (Direct vs Orchestrator Plan Mode).** Choose the path matching the active runtime:
   - **Direct session (no read-only planner hook):** Write `<artifact-dir>/implementation_plan.md` with `ArtifactMetadata` set to `RequestFeedback: true` and `UserFacing: true`.
   - **Orchestrator Plan Mode (`exit_plan_mode` active):** Under **Orchestrator** (`Carbon` or `Argon`), planner turns block `write_file` (even on `<artifact-dir>`). Clarify forks via `ask_question` first. When the user explicitly asked for `/plan` (or review before edits), pass a **stage-only artifact handoff** to `exit_plan_mode` instructing the execution turn to write `<artifact-dir>/implementation_plan.md` with `RequestFeedback: true` and `UserFacing: true`, make zero workspace edits, and stop so the user can leave inline line comments or click **Proceed**. On normal non-`/plan` Orchestrator runs, pass the full execution plan and `Re-plan if:` triggers straight to `exit_plan_mode`.
   - **Required sections in `implementation_plan.md`:** `Goal Description`, `User Review Required`, `Open Questions`, `Proposed Changes` (grouped by component, marked `[NEW]`, `[MODIFY]`, or `[DELETE]`), and `Verification Plan`. Embed three **Post-Approval Finish Gates** directly inside `Verification Plan` so clicking **Proceed** or an **Orchestrator** planner-to-executor handoff runs them automatically even if `/astack-mode` is not re-typed:
     - **Live verification:** prove behavior end-to-end on the real running app, CLI, or `.agents/skills/verify-<app>/` per `principle-prove-it-works`.
     - **Diff cleanup:** run [`/deslop`](../../deslop/SKILL.md) and [`/no-comments`](../../no-comments/SKILL.md) on code changes, recording `skip: docs or config only, zero code comments` visibly when no code files changed. Skip files vendored from a `code-derived` source listed in `scripts/upstream-watch.json` so upstream diffs stay minimal.
     - **Push boundary:** stage clean, ordered local commits and write `<artifact-dir>/walkthrough.md` (`UserFacing: true`, `RequestFeedback: false`), stopping before `git push` or PR creation unless the user explicitly asked to push or open a PR (for example `"approved, open the PR"`) or invoked an `autopilot-*` or `shipping` playbook.
     For multi-PR programs, embed the [`multi-phase-plan.md`](../playbooks/multi-phase-plan.md) skeleton in the artifact and validate it with [`check-plan.mjs`](../scripts/check-plan.mjs).
5. **Hard stop & autonomous artifact rule.** During `/plan`, make zero workspace file edits and run zero mutating commands until the user clicks **Proceed** or replies with approval (incorporate inline artifact or file line comments into revisions before executing). Write any repo copy under `docs/` only after user approval (or when running headless CLI without an artifact directory). Do not repeat the artifact body in chat; summarize only open questions requiring decisions. When the AStack Timeline sidecar is enabled in an Antigravity App session and the pill has not been shown yet in this conversation, close the gate message with `[AStack Timeline](sidecar://astack/astack_timeline/)` on its own line. Conversely, during unattended `/goal` or `hillclimb` runs, always set `RequestFeedback: false` on progress or summary artifacts so execution never stalls on an approval button.
6. **After approval.** Clicking Antigravity's **Proceed** button or sending a short approval (`"approved"`, `"do it"`, `"proceed"`) runs this entire sequence automatically without requiring the user to repeat `/astack-mode` or list cleanup and push rules:
   - Incorporate any inline line comments attached to `implementation_plan.md` or workspace files first.
   - Activate [`astack-mode`](../SKILL.md), execute tasks in dependency order, and verify empirically at every checkpoint.
   - Run [`/deslop`](../../deslop/SKILL.md) and [`/no-comments`](../../no-comments/SKILL.md) on code diffs (or mark `skip: docs or config only, zero code comments` visibly when no code files changed), skipping files vendored from a `code-derived` source listed in `scripts/upstream-watch.json`.
   - Commit clean local commits, write `<artifact-dir>/walkthrough.md` (`UserFacing: true`, `RequestFeedback: false`), and stop before `git push` or `gh pr create` by default. Push and open the PR via [`opening-a-pr.md`](../playbooks/opening-a-pr.md) only when the user explicitly asked to push or open a PR (such as `"approved, open the PR"`), or under `autopilot-stack`, `autopilot-full`, or `shipping`.

## `/grill-me` Contract

Use for vague requirements or contested product tradeoffs before planning or coding (`"interview me"`, `"grill me"`, `"clarify requirements first"`).

1. Read relevant repository files first; never ask the user a question that the codebase or git history already answers.
2. Walk down the decision tree sequentially (`questions.length === 1` per `ask_question` turn) so each answer branches the next question. Keep options unnumbered, omit manual `"Other"` options, and place `(Recommended)` on the first option when a sane default exists.
3. When stacked as `/plan /grill-me <task>`, finish the interview, then transition straight into step 3 of the `/plan` contract above and stop on `implementation_plan.md` (`RequestFeedback: true`).
4. Use [`/interrogate`](../../interrogate/SKILL.md) (not `/grill-me`) for post-edit adversarial code review.

## `/learn` Contract

Use when distilling session feedback or recurring team conventions into durable rules or skills (`"remember this rule"`, `"save this preference"`, `"capture what we learned"`), and from the persistence steps of [`/reflect`](../../reflect/SKILL.md) and [`/correct`](../../correct/SKILL.md).

1. Load the built-in `agy-customizations` skill first whenever authoring rules, skills, or hooks so schema and precedence stay accurate.
2. Draft the change in `<artifact-dir>/learning_proposal.md` (`RequestFeedback: true`, `UserFacing: true`) naming the exact target path (`.agents/rules/`, `AGENTS.md`, `GEMINI.md`, or `.agents/skills/`), rule trigger (`always_on`, `model_decision`, `glob`, or `manual`), and exact proposed text.
3. Write nothing to workspace or user config directories until the user approves the proposal.
4. For [`/correct`](../../correct/SKILL.md), exhaust architecture, types, lints, and tests before proposing a doc or rule.
