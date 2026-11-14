---
name: setup-astack
description: "Configure AStack model tiers, Antigravity Swarm/Subagent routing, project verification skills, and safety preferences. Use for /setup-astack or initial workspace onboarding."
---

# Setup AStack

Interactive setup for AStack (`astack`), Lauren Tan's (`@poteto`) `pstack` workflows adapted for Google Antigravity (`invoke_subagent`, `/boost`, `/swarm`, `/teamwork`, and `/goal`), maintained by João Machete.

Walk the user through setup using `ask_question` and live tool inspection — never guess model IDs when `swarm` can report what is active in this session.

## 1. Inspect Current Environment

Before asking questions:

1. Check if `~/.gemini/config/rules/astack-models.md` (user-global) or `.agents/rules/astack-models.md` (workspace-local) already exists so you can offer to keep, update, or relocate it.
2. Call `swarm{action: "models", all: true}` to inspect the **live Antigravity model IDs** available in the user's current account and plan. Group them mentally by family (e.g., Gemini, Claude, GPT/OpenAI if available) so you can recommend genuinely diverse families for `/arena` bakeoffs and `@verifier` gates.
3. Quickly note whether the active workspace already has `.agents/skills/verify-*/SKILL.md` (`control-ui` / `control-cli` verification) or formal TLA+ verification skills.

## 2. Collect Preferences with `ask_question`

Ask concisely (batch 2–3 focused questions via `ask_question`):

1. **Rule scope**:
   - `(Recommended) User-global (~/.gemini/config/rules/astack-models.md)` — applies across all repositories without committing personal model choices.
   - `Workspace-local (.agents/rules/astack-models.md)` — shares team routing conventions with this repo.
2. **Reasoning budget & subagent tier preset**:
   - `(Recommended) Balanced High-Trust` — `Model: "pro"` for architecture, `/arena` judging, `/architect` candidates, and hard debugging; `Model: "inherit"` for feature authoring & fixes; `Model: "flash"` for parallel read-only exploration (`/how`, `/why`, `research`); `Model: "flash_lite"` for trivial formatting/mechanical checks.
   - `Max Quality` — `Model: "pro"` for architecture, authoring, judging, and verification; `Model: "inherit"` for fast searches.
   - `Fast & Economical` — `Model: "inherit"` for design & code; `Model: "flash"` for exploration & audits; reserve `Model: "pro"` only for explicit `/arena` tie-breaks or `/boost`.
3. **Cross-family `/swarm` & `@verifier` routing** (present real model choices discovered from `swarm{action: "models", all: true}`):
   - Let the user pick which live model IDs to pair for **author workers** vs independent **`@verifier` / `/arena` judge workers** (or choose `Follow active session model (no explicit override)`).
4. **Optional project hardening** (multi-select):
   - Generate runtime verification skill (`/create-verification-skill` — `.agents/skills/verify-<app>/` + feature map).
   - Generate formal TLA+ / invariant verification skill (`/create-formal-verification-skill` — powered by `/statechart`).
   - Review opt-in safety & verification hooks (`hooks.json` at the plugin root ships `"enabled": false` by default).

## 3. Write the Antigravity Rule File

Write the chosen rule file (`~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md`) using valid **Antigravity rule frontmatter** (use `trigger: model_decision` so it loads only when delegating/routing rather than bloating every idle turn's global rules budget):

```markdown
---
trigger: model_decision
description: >-
  Model and execution-tier routing for AStack subagents, /fanout, /arena,
  /architect, and native Antigravity /swarm @verifier gates.
---

# AStack Model & Tier Routing

Preset: <selected preset>

## `invoke_subagent` Tiers
- Judgment, architecture, `/arena` judging, hard debugging: `Model: "<pro|inherit>"`
- Feature authoring, bug fixes, PR preparation: `Model: "<inherit|pro>"`
- Read-only exploration (`/how`, `/why`, `TypeName: "research"`): `Model: "<flash|inherit>"`
- Mechanical sweeps & formatting: `Model: "<flash_lite|flash>"`

## Native `/swarm` Models (verified via `swarm{action: "models", all: true}`)
- Author workers (`workspace: "share"` | `"branch"`): `<selected live model or inherit>`
- Independent `@verifier` & `/arena` cross-judge: `<distinct live model family or pro>`
```

Keep the rule concise (under ~60 lines) so it never pressures Antigravity's global 20,000-token rule budget.

## 4. Run Any Selected Follow-Up Steps & Report

- If the user selected `/create-verification-skill` or `/create-formal-verification-skill`, invoke that skill now (or kick off the first interview step).
- If the user asked about hooks, point to `hooks.json` in the AStack plugin directory and explain that `"enabled": false` keeps `hooks.json` inactive until they explicitly opt in to `"enabled": true`.
- Close with quick next-step commands:
  - `/astack-mode <task>` — classify task into a playbook and orchestrate rigor end-to-end
  - `/astack-help` — browse playbooks, verification skills, and recipes
  - `/swarm` / `/boost` / `/teamwork` / `/goal` — Antigravity's native multi-worker, iterative challenge-and-fix, long-horizon, and completion-driven modes
