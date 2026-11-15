---
trigger: model_decision
description: >-
  Routing guidance when the user asks for rigorous engineering workflows,
  AStack/PStack playbooks, empirical verification harnesses ("Control Glass"),
  or choosing between Subagents, /boost, /swarm, and /teamwork.
---

# AStack Orchestration Guidance

AStack is João Machete's verification-first engineering plugin for Google Antigravity, built on Lauren Tan's (`@poteto`) `pstack` and inspired by Garry Tan's (`@garrytan`) `gstack`.

When the user asks for engineering rigor, debugging with evidence, performance hillclimbing, multi-agent code bakeoffs, verification skills, planning before coding, or invokes `/astack-mode`:

1. **Native commands first.** Match user intent against `skills/astack-mode/references/native-commands.md` (16 public Antigravity slash commands) across `run`, `load`, `contract`, and `recommend` modes. Never shadow native commands.
   - Planning intent (`"plan this"`, `"write a plan first"`, `"review before editing"`, `/plan`, `/grill-me`, `/learn`): follow `skills/astack-mode/references/plan-contract.md`, writing `<artifact-dir>/implementation_plan.md` (`RequestFeedback: true`, `UserFacing: true`) and stopping with zero workspace edits until approved.
2. **Load `/astack-mode`.** Follow `skills/astack-mode/SKILL.md` for playbook selection and principle rigor (short follow-ups stay sticky on the active playbook until `"new task"` resets classification).
3. Match orchestration mode to task shape:
   - **Subagents (`invoke_subagent`) & `/fanout`**: Focused background delegation (`astack-agent`, `comment-sicko`, `research`, `browser`) or 2-5 lightweight parallel slices. Use `Workspace: "share"` when parallel workers edit files.
   - **`/run-workflow` (`run_workflow` tool + `run-workflow` skill)**: Python `parallel()` and `pipeline()` orchestration across many files, items, or staged phases with structured results.
   - **`/boost`**: Hard, tightly coupled root-cause debugging, race conditions, algorithmic optimization, or iterative challenge-and-fix loops.
   - **`/swarm`**: Broad tasks dividing cleanly across separate files, packages, PRs, or research tracks using named workers, isolated workspaces, and `@verifier` gates.
   - **`/teamwork`**: Long-horizon, multi-milestone migrations, simulations, or formal proofs needing an upfront scoping interview and milestone audit gates.
   - **`/goal`, `/schedule`, and `/automation`**: `/goal` for uninterrupted completion loops, `/schedule` for in-session timers/crons, and `/automation` (App only, `CRON_TZ=`) for persistent background triggers.
4. Default subagents and `/swarm` workers to inherit your active Antigravity session model (**Orchestrator (Carbon)** on Google AI Ultra, **Orchestrator (Argon)** on Google AI Pro and Ultra, or manual picker + CLI `/effort` / `--effort` controls; fixed-budget **Orchestrator** manages reasoning effort dynamically across planner and executor turns) by omitting explicit model overrides. Keeping overrides unset preserves Orchestrator's dynamic bidirectional model routing (read-only frontier planning with explicit re-planning triggers, fast Hydrogen execution and testing, and automatic hand-back to the planner when execution hits friction). Discover distinct model families live via `swarm{action: "models"}` only when running cross-family `/arena` bakeoffs or explicit multi-family verification, and honor an optional `astack-models.md` rule only if present.
5. **Surface dedicated Antigravity UIs.** Whenever AStack runs a native capability behind the scenes, surface its dedicated UI entrypoint so the user sees what ran and where to inspect it:
   - **`/swarm`**: Load `swarm` (plus `swarm_pane` when in `<skills>` to maintain `.system_generated/swarm/plan.json`). Emit the exact `open_board` value from `swarm{action: "add"}` or `swarm{action: "status"}` verbatim on its own line at kickoff AND at completion (after posting `[done] <summary>` with no `@`), noting the **Swarm** UI (**Overview**, **Board**, **Members**, **Graph**) in App or `/swarm board` (`Alt+S`) in CLI. Never hand-write `open_board`.
   - **`/generative_ui` (App only)**: Write `<artifact-dir>/<name>.html` via `write_file` (`UserFacing: true`, `RequestFeedback: false`), embed compact widgets (`<= 450px`) inline with `<agent-embed src="file:///<artifact_path>/<name>.html"></agent-embed>`, and point to the **Artifact card** (**Overview > Artifacts**) for **Side Panel** viewing (fall back to Mermaid in CLI).
   - **Other native surfaces**: Point to the **Workflow step card** (`phase()` and clickable `role` cards) for `run_workflow`, `[Open Automations Dashboard](sidecar://dashboard)` for `/automation`, **Overview > Subagents** or CLI `/agents` (`Alt+J` / `Ctrl+K`) for subagents and `/browser`, **Overview > Background Tasks** or CLI `/tasks` for `/schedule`, `customization://<install-dir>` / `sidecar://` pills for plugins/sidecars, and **Overview > Review** or CLI `/diff` when stopping for review.
