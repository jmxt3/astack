---
name: setup-astack
description: "Onboard a repository to AStack: scaffold runtime verification skills (verify-<app>), optional formal TLA+ specs, and opt-in safety hooks while respecting Antigravity's native UI model picker and Orchestrator. Use for /setup-astack or initial workspace setup."
disable-model-invocation: true
---

# Setup AStack

Interactive workspace onboarding for AStack (`astack`), João Machete's verification-first Google Antigravity engineering stack built on Lauren Tan's (`@poteto`) `pstack` and inspired by Garry Tan's (`@garrytan`) `gstack`, integrated natively with `invoke_subagent`, `/boost`, `/swarm`, `/teamwork`, `/goal`, and `/schedule`.

AStack is zero-config for models by default. Subagents (`invoke_subagent`) and `/swarm` workers omit model overrides so they inherit whatever model you picked in Antigravity's UI selector, including **Orchestrator**, effort controls, and newly launched weekly models, while `/arena` discovers cross-family models live at runtime via `swarm{action: "models", all: true}`. Setup focuses on giving agents empirical verification and safety guardrails for this repository.

## 1. Initiate Setup & Inspect Environment

First, run [`scripts/setup-banner.mjs`](./scripts/setup-banner.mjs) from the active workspace root (where `<skill-dir>` is the directory containing this `SKILL.md`):

```bash
node "<skill-dir>/scripts/setup-banner.mjs"
```

Pass `--doctor` (and optionally `--json`) anytime to inspect Node version, `verify-*` skill freshness, `hooks.json` status, `astack-models.md` overrides, and worktrees read-only.

This prints the `ASTACK` ASCII initiation banner and inspects the workspace read-only for:

1. `.agents/skills/verify-*/SKILL.md` (runtime Control Glass verification) and formal TLA+ verification skills or `*.tla` specs.
2. [`hooks.json`](../../hooks.json) at the plugin root (ships `"enabled": false` by default).
3. Any existing `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` rule on this machine or repo.

## 2. Display the ASCII Banner & Collect Repo Choices

Always open your first visible chat message to the user with the `ASTACK` initiation banner inside a fenced ```` ```text ```` code block (verbatim from `setup-banner.mjs` stdout; if Node cannot run, render the same layout below):

```text
 █████╗ ███████╗████████╗ █████╗  ██████╗██╗  ██╗
██╔══██╗██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
███████║███████╗   ██║   ███████║██║     █████╔╝
██╔══██║╚════██║   ██║   ██╔══██║██║     ██╔═██╗
██║  ██║███████║   ██║   ██║  ██║╚██████╗██║  ██╗
╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
GOOGLE ANTIGRAVITY · PLAN · BUILD · PROVE IT WORKS
> /setup-astack initiated · workspace: <name>
  verify skills : <detected or none>
  formal verify : <detected or none>
  safety hooks  : <detected status>
  model routing : <detected status>
```

Right below the banner, briefly tell the user (one or two sentences, and do **not** ask model-pinning questions by default) that AStack inherits their Antigravity UI model picker automatically, including **Orchestrator**'s dynamic bidirectional model routing (a frontier model such as Gemini 4 Carbon plans read-only with re-planning triggers, Gemini 4 Hydrogen handles fast edits and tests, and friction hands control back to Carbon automatically), and resolves cross-family models live during `/arena` bakeoffs so new weekly Antigravity models work immediately with zero config and no chat restart.

Then ask concisely with `ask_question` (pass unnumbered options without adding a manual `"Other"` option or `"select all that apply"` wording because Antigravity adds them automatically):

1. **Project verification & guardrails** (`is_multi_select: true`, tailored to what Step 1 found):
   - `(Recommended) Generate runtime verification skill (/create-verification-skill)`: scaffolds `.agents/skills/verify-<app>/` and a `features/` map so agents can drive and prove your app end-to-end (or offer `/maintain-verification-skill` if a `verify-*/SKILL.md` already exists).
   - `(Recommended) Scaffold repo trust policies (init-repo-policy.mjs)`: creates `.agents/risk-policy.json`, `.agents/boundaries.json`, `REVIEW.md`, and `GLOSSARY.md` idempotently without overwriting existing files.
   - `Generate formal TLA+ / invariant verification skill (/create-formal-verification-skill)`: powered by `/statechart`, ideal for state machines, retries, concurrency, or parsers.
   - `Review split lifecycle hooks (hooks.json)`: inspect passive observe-only hooks (`astack-receipt-ledger`, `astack-session-context` enabled by default) and opt-in blocking gates (`astack-irreversible-guard`, `astack-secret-guard`, `astack-verify-reminder`, `astack-evidence-gate`, `astack-boundary-guard`, `astack-round-limiter`).
2. **Conditional (ONLY ask if Step 1 found an existing `astack-models.md` OR the user explicitly asked to customize subagent tiers)**:
   - `(Recommended) Remove/reset astack-models.md`: clear static overrides so all subagents and `/swarm` workers inherit your active Antigravity UI model picker / **Orchestrator**.
   - `Keep lightweight evergreen invoke_subagent tier aliases`: write only capability aliases (`inherit`, `flash`, `flash_lite`, `pro`) into `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` (with `trigger: model_decision` frontmatter, under 60 lines), never pinning versioned model slugs.

## 3. Run Selected Follow-Up Steps & Report

- If the user selected `/create-verification-skill`, `/maintain-verification-skill`, or `/create-formal-verification-skill`, invoke that skill immediately (no chat restart required).
- If the user selected `Scaffold repo trust policies`, run `node "<skill-dir>/scripts/init-repo-policy.mjs" --cwd . --json` and summarize created vs skipped files.
- If the user selected `Review split lifecycle hooks`, explain that [`hooks.json`](../../hooks.json) enables the two passive observe-only hooks by default while keeping all six blocking gates `"enabled": false` until opted in via `hooks.json` or `/hooks`. Open plugin details anytime in the Antigravity App via [astack](customization://astack).
- If the user chose to remove/reset an existing `astack-models.md` (and confirmed the change), remove or update it cleanly as requested.
- Close with quick next-step commands:
  - `/astack-mode <task>`: classify task into a playbook and orchestrate rigor end-to-end
  - `/plan /astack-mode <task>`: investigate and pause at an approval-gated `implementation_plan.md` before editing files
  - `/astack-help`: browse playbooks, verification skills, and recipes
  - `/swarm` / `/run-workflow` / `/boost` / `/teamwork` / `/goal`: Antigravity's native multi-worker board, Python workflow runner, iterative challenge-and-fix, long-horizon, and completion-driven modes
  - Open the **AStack** side-pane panel anytime from **Extensions** in the top-right panel menu (or via `[AStack](sidecar://astack/astack_panel/ui.html)`). If AStack was just installed via CLI while Antigravity was open and does not appear in **Extensions** yet, reload or restart the Antigravity window once.
