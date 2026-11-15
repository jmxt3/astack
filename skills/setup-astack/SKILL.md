---
name: setup-astack
description: "Onboard a repository to AStack: scaffold runtime verification skills (verify-<app>), optional formal TLA+ specs, and opt-in safety hooks while respecting Antigravity's native UI model picker and Orchestrator. Use for /setup-astack or initial workspace setup."
---

# Setup AStack

Interactive workspace onboarding for AStack (`astack`), Lauren Tan's (`@poteto`) `pstack` workflows adapted for Google Antigravity (`invoke_subagent`, `/boost`, `/swarm`, `/teamwork`, `/goal`, and `/schedule`), maintained by João Machete.

AStack is zero-config for models by default: subagents (`invoke_subagent`) and `/swarm` workers omit model overrides so they inherit whatever model you picked in Antigravity's UI selector—including **Orchestrator**, effort controls, and newly launched weekly models—and `/arena` discovers cross-family models live at runtime via `swarm{action: "models", all: true}`. Setup focuses on giving agents empirical verification and safety guardrails for this repository.

## 1. Inspect Current Environment

Before asking questions, inspect the workspace quickly:

1. Check whether the active repository already has `.agents/skills/verify-*/SKILL.md` (runtime Control Glass verification) and/or formal TLA+ verification skills or specs (`*.tla`).
2. Check [`hooks.json`](../../hooks.json) at the plugin root (ships `"enabled": false` by default).
3. Check whether an existing `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` rule is already present on this machine or repo.

## 2. Explain Zero-Config Model Routing & Collect Repo Choices

Briefly tell the user (1–2 sentences—do **not** ask model-pinning questions by default) that AStack inherits their Antigravity UI model picker automatically (including **Orchestrator**, which pairs a frontier planner model with a fast implementation model inside one session) and resolves cross-family models live during `/arena` bakeoffs, so new weekly Antigravity models work immediately with zero config and no chat restart.

Then ask concisely with `ask_question`:

1. **Project verification & guardrails** (multi-select, tailored to what Step 1 found):
   - `(Recommended) Generate runtime verification skill (/create-verification-skill)` — scaffolds `.agents/skills/verify-<app>/` and a `features/` map so agents can drive and prove your app end-to-end (or offer `/maintain-verification-skill` if a `verify-*/SKILL.md` already exists).
   - `Generate formal TLA+ / invariant verification skill (/create-formal-verification-skill)` — powered by `/statechart`, ideal for state machines, retries, concurrency, or parsers.
   - `Review opt-in safety & verification hooks (hooks.json)` — review `astack-irreversible-guard` (`PreToolUse`) and `astack-verify-reminder` (`Stop`).
2. **Conditional — ONLY ask if Step 1 found an existing `astack-models.md` OR the user explicitly asked to customize subagent tiers**:
   - `(Recommended) Remove/reset astack-models.md` — clear static overrides so all subagents and `/swarm` workers inherit your active Antigravity UI model picker / **Orchestrator**.
   - `Keep lightweight evergreen invoke_subagent tier aliases` — write only capability aliases (`inherit`, `flash`, `flash_lite`, `pro`) into `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` (with `trigger: model_decision` frontmatter, under 60 lines), never pinning versioned model slugs.

## 3. Run Selected Follow-Up Steps & Report

- If the user selected `/create-verification-skill`, `/maintain-verification-skill`, or `/create-formal-verification-skill`, invoke that skill immediately (no chat restart required).
- If the user selected `Review opt-in safety & verification hooks`, explain that [`hooks.json`](../../hooks.json) ships `"enabled": false` by default and show how to opt in to `"enabled": true` for `astack-irreversible-guard` and `astack-verify-reminder`.
- If the user chose to remove/reset an existing `astack-models.md` (and confirmed the change), remove or update it cleanly as requested.
- Close with quick next-step commands:
  - `/astack-mode <task>` — classify task into a playbook and orchestrate rigor end-to-end
  - `/astack-help` — browse playbooks, verification skills, and recipes
  - `/swarm` / `/boost` / `/teamwork` / `/goal` — Antigravity's native multi-worker, iterative challenge-and-fix, long-horizon, and completion-driven modes
