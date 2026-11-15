---
trigger: model_decision
description: >-
  Routing guidance when the user asks for rigorous engineering workflows,
  AStack/PStack playbooks, empirical verification harnesses ("Control Glass"),
  or choosing between Subagents, /boost, /swarm, and /teamwork.
---

# AStack Orchestration Guidance

AStack is the Google Antigravity port of Lauren Tan's (`@poteto`) `pstack`, maintained by João Machete.

When the user asks for engineering rigor, debugging with evidence, performance hillclimbing, multi-agent code bakeoffs, verification skills, or invokes `/astack-mode`:

1. Load and follow `skills/astack-mode/SKILL.md` (or suggest `/astack-mode` explicitly when the user wants full playbook enforcement).
2. Never shadow or replace Antigravity's built-in `/swarm` command. For lightweight N-way `invoke_subagent` fan-out, use `/fanout`; for broad multi-file or multi-PR coordination with live board visibility and `@verifier` sign-off, use Antigravity's native `swarm` board tools or recommend `/swarm`.
3. Match orchestration mode to task shape:
   - **Subagents (`invoke_subagent`)**: Focused background delegation (`astack-agent`, `comment-sicko`, `research`, `browser`). Use `Workspace: "share"` when parallel workers edit files.
   - **`/boost`**: Hard, tightly coupled root-cause debugging, race conditions, algorithmic optimization, or iterative challenge-and-fix loops.
   - **`/swarm`**: Broad tasks that divide cleanly across separate files, packages, PRs, or research tracks using named workers, isolated workspaces, and `@verifier` gates.
   - **`/teamwork`**: Long-horizon, multi-milestone migrations, simulations, or formal proofs needing an upfront scoping interview and milestone audit gates.
   - **`/goal`**: Overnight or unattended execution driven to an explicit completion predicate.
4. Default subagents and `/swarm` workers to inherit your active Antigravity session model (including **Orchestrator** and effort settings) by omitting explicit model overrides. Keeping overrides unset preserves Orchestrator's dynamic bidirectional model routing (read-only frontier planning with explicit re-planning triggers, fast Hydrogen execution and testing, and automatic hand-back to the planner when execution hits friction). Discover distinct model families live via `swarm{action: "models"}` only when running cross-family `/arena` bakeoffs or explicit multi-family verification, and honor an optional `astack-models.md` rule only if present.
