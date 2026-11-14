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

1. Load and follow `skills/astack-mode/SKILL.md` (or ask the user to invoke `/astack-mode` explicitly for full playbook enforcement, since `astack-mode` sets `disable-model-invocation: true`).
2. Never shadow or replace Antigravity's built-in `/swarm` command. For lightweight N-way `invoke_subagent` fan-out, use `/fanout`; for broad multi-file or multi-PR coordination with live board visibility and `@verifier` sign-off, use Antigravity's native `swarm` board tools or recommend `/swarm`.
3. Match orchestration mode to task shape:
   - **Subagents (`invoke_subagent`)**: Focused background delegation (`astack-agent`, `comment-sicko`, `research`, `browser`). Use `Workspace: "share"` when parallel workers edit files.
   - **`/boost`**: Hard, tightly coupled root-cause debugging, race conditions, algorithmic optimization, or iterative challenge-and-fix loops.
   - **`/swarm`**: Broad tasks that divide cleanly across separate files, packages, PRs, or research tracks using named workers, isolated workspaces, and `@verifier` gates.
   - **`/teamwork`**: Long-horizon, multi-milestone migrations, simulations, or formal proofs needing an upfront scoping interview and milestone audit gates.
   - **`/goal`**: Overnight or unattended execution driven to an explicit completion predicate.
4. Load `.agents/rules/astack-models.md` or `~/.gemini/config/rules/astack-models.md` if present before selecting subagent or swarm models.
