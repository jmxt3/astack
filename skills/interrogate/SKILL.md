---
name: interrogate
description: "Pre-flight stress-test and ambiguity discovery before building: inspect real code empirically, challenge unexamined assumptions, smoke out failure/concurrency/UX edge cases, and align with the user before writing code. Use for /interrogate or vague high-stakes asks."
---

# Interrogate

Ambiguous assumptions written into code become 1,000-line rewrites later. Spend 5 minutes aggressively verifying reality and cornering every underspecified decision before committing to implementation (`principle-interrogate-the-premises`).

## 1. Interrogate the Codebase First (Never Ask What Code Can Answer)

Run parallel read-only checks (`invoke_subagent` with `TypeName: "self"` when MCP/command probes are needed or `"research"` for wide read-only sweeps; default `Model: "inherit"` to follow your active UI model / **Orchestrator**, or `"flash"` for wide `research` sweeps, honoring optional `astack-models.md` if present; escalate to `/swarm` with live `swarm{action: "models"}` discovery when cross-family adversarial review is requested) to uncover:

- **Existing truth vs comments/docs**: Trace real callers, schemas, configs, and entry points (`principle-evidence-over-inference`).
- **Concurrency & failure modes**: What happens when two actors run simultaneously, a step retries halfway, or an upstream dependency fails (`principle-make-operations-idempotent`, `principle-separate-before-serializing-shared-state`)?
- **Verification gaps**: Does this project already have `.agents/skills/verify-*/` or tests covering this flow, or will you need to prove it manually with `control-ui` / `control-cli` / `/create-verification-skill`?

> [!TIP]
> If the task spans a multi-milestone migration or repository-wide system simulation needing structured milestone gates, pair `/interrogate` with Antigravity **`/teamwork`** (or recommend `/grill-me` when a deep interactive alignment interview is warranted before committing to a long run). If the unknown is a narrow coupled runtime mystery, pair with **`/boost`**.

## 2. Interrogate the Spec & Assumptions

List every hidden premise where two engineers could reasonably do different things:

- Scope boundaries & non-goals ("what do we explicitly break or leave untouched?").
- Source of truth when state lives in two places.
- UX / CLI failure ergonomics (silent skip vs hard error vs retry; backward-compatibility contract).
- Performance targets & realistic scale bounds (and whether [`benchmark-checklist`](../benchmark-checklist/SKILL.md) applies).

## 3. Ask Sharp Questions — Only What Code Could Not Decide

- Present crisp, opinionated options using `ask_question` (for structured multi-choice architectural forks, putting the recommended option first) or concise numbered questions when open-ended input is needed.
- Never ask generic filler ("what language is this?", "what tests do you want?") that you can see in the repo.
- Once answers land, feed the locked decisions directly into [`/architect`](../architect/SKILL.md), `/astack-mode` implementation, or a `/swarm` coordinator brief.
