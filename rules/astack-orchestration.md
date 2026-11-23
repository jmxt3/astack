---
trigger: model_decision
description: >-
  Routing guidance when the user asks for rigorous engineering workflows,
  opening or updating pull requests with statecharts and verification proof,
  AStack playbooks, empirical verification harnesses ("Control Glass"),
  or choosing between Subagents, /boost, /swarm, and /teamwork.
---

# AStack Orchestration Guidance

AStack is a verification-first engineering plugin for Google Antigravity.

When the user asks for engineering rigor, opening or updating a pull request, debugging with evidence, performance hillclimbing, multi-agent code bakeoffs, verification skills, planning before coding, or invokes `/astack-mode`:

1. **Native commands first.** Match user intent against `skills/astack-mode/references/native-commands.md` (18 public Antigravity slash commands) across `run`, `load`, `contract`, and `recommend` modes. Never shadow native commands. Use `agy --agent astack-engineer` (or select `astack-engineer` in the Antigravity App) to boot sessions directly into AStack rigor without `/astack-mode` prefixing.
   - Planning intent (`"plan this"`, `"write a plan first"`, `"review before editing"`, `/plan`, `/grill-me`, `/learn`): follow `skills/astack-mode/references/plan-contract.md`, writing `<artifact-dir>/implementation_plan.md` (`RequestFeedback: true`, `UserFacing: true`) and stopping with zero workspace edits until approved. When the user clicks **Proceed** on `implementation_plan.md` or replies with short approval (`"approved"`, `"do it"`) after a `/plan`, `/grill-me`, or `/architect` checkpoint, load `skills/astack-mode/SKILL.md` and run Step 6 of `plan-contract.md` automatically: incorporate inline comments, prove behavior live, run `/deslop` and `/no-comments` on code diffs, write `walkthrough.md`, and stop at local commits before `git push` unless pushing or opening a PR was explicitly requested.
   - Pull request intent (`"open a PR"`, `"create a pull request"`, `"update PR description"`): follow `skills/astack-mode/playbooks/opening-a-pr.md`, run `node skills/review-pr/scripts/pr-dossier.mjs --format github --out <body-file>`, and pass `--body-file <body-file>` to `gh pr create` (or `github-mcp-server`).
2. **Load `/astack-mode`.** Follow `skills/astack-mode/SKILL.md` for the deterministic 6-stage flight rail (`[AUTO]` stages 1, 3, 4, 5 and `[HUMAN GATE]` stages 2 Plan Approval and 6 Visual PR Review via `/review-pr`), playbook selection, zero-dependency `.agents/risk-policy.json` / `.agents/boundaries.json` governance, principle rigor (short follow-ups stay sticky on the active playbook until `"new task"` resets classification), and emitting `[AStack Timeline](sidecar://astack/astack_timeline/)` once per Antigravity App session when the sidecar is enabled.
3. Match orchestration mode to task shape:
   - **Subagents (`invoke_subagent`) & `/fanout`**: Focused background delegation (`astack-agent`, `comment-sicko`, `research`, `browser`) or 2-5 lightweight parallel slices. Use `Workspace: "share"` when parallel workers edit files.
   - **`/run-workflow` (`run_workflow` tool + `run-workflow` skill)**: Python `parallel()` and `pipeline()` orchestration across many files, items, or staged phases with structured results.
   - **`/boost`**: Hard, tightly coupled root-cause debugging, race conditions, algorithmic optimization, or iterative challenge-and-fix loops.
   - **`/swarm`**: Broad tasks dividing cleanly across separate files, packages, PRs, or research tracks using named workers, isolated workspaces, and `@verifier` gates.
   - **`/teamwork`**: Long-horizon, multi-milestone migrations, simulations, or formal proofs needing an upfront scoping interview and milestone audit gates.
   - **`/goal`, `/schedule`, and `/automation`**: `/goal` for uninterrupted completion loops, `/schedule` for in-session timers/crons, and `/automation` (App only, `CRON_TZ=`) for persistent background triggers.
4. Default subagents and `/swarm` workers to inherit your active Antigravity session model (**Orchestrator (Neon)**, **Orchestrator (Carbon)**, **Orchestrator (Argon)**, or manual picker + effort settings) by omitting explicit model overrides. Keeping overrides unset preserves Orchestrator's dynamic bidirectional model routing (read-only frontier planning with explicit re-planning triggers, fast Hydrogen execution and testing, and automatic hand-back to the planner when execution hits friction). Discover distinct model families live via `swarm{action: "models"}` only when running cross-family `/arena` bakeoffs or explicit multi-family verification, and honor an optional `astack-models.md` rule only if present.
