---
name: astack-help
description: Guides users through AStack setup, /astack-mode, Antigravity Subagents, /boost, /swarm, /teamwork, and picking the right skill, playbook, or principle. Invoke with /astack-help and a question.
---

# AStack Help

Answer the user's question about AStack (a verification-first engineering plugin for Google Antigravity), give them a copyable prompt, and link the local skill or guide file that backs it. For a help question, stop after answering instead of executing the task.

If the user asks a general Antigravity question (CLI flags, headless CI `agy -p`, App settings, Remote Agents, SDK, or MCP setup) rather than an AStack workflow question, load Antigravity's built-in `antigravity-guide` skill (`load` mode) directly.

A message asking for implementation work ("use astack to fix this bug") or planning ("plan this refactor") is not a help question: load [`astack-mode`](../astack-mode/SKILL.md) (and [`plan-contract.md`](../astack-mode/references/plan-contract.md) for planning intent).

This file maps questions to the skills and guide docs holding the details. Always read a file before quoting it.

## Find out what they need

Infer what the user needs from the conversation. If still unclear, call `ask_question` with unnumbered choices (no manual `"Other"` option), putting `(Recommended)` dynamically on the first option matching workspace state (for example `Get set up` when no `verify-*` skill exists), then answer only the picked area:

- `(Recommended)` option matching workspace state (or `Start a task with /astack-mode` when setup is complete)
- Remaining options from: `Get set up`, `Start a task with /astack-mode`, `Pick a skill or native Antigravity command (/plan, /run-workflow, /swarm, /boost, /teamwork, /automation)`, `Fix a run that went wrong`, `Make AStack my own`

Check workspace state that changes the answer:

- AStack needs no model config file by default: subagents and `/swarm` workers inherit your active Antigravity UI model picker / **Orchestrator** automatically. Only flag `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` if one exists and pins stale model IDs that override the UI selector.
- No `.agents/skills/verify-<app>/SKILL.md` means agents lack an app-specific driver and fall back to AStack's built-in [`/control-ui`](../control-ui/SKILL.md) and [`/control-cli`](../control-cli/SKILL.md); mention [`/create-verification-skill`](../create-verification-skill/SKILL.md) (or [`/setup-astack`](../setup-astack/SKILL.md)) when verification is discussed.
- No formal verification spec means invariants and races are untested past unit tests; mention [`/create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md) (and [`/maintain-formal-verification-skill`](../maintain-formal-verification-skill/SKILL.md) if specs drifted).

## Get set up

1. Install AStack via Antigravity Plugins Manager or CLI: `agy plugin install <path-or-repo>`.
2. Pick your preferred model or **Orchestrator** directly in Antigravity's UI model picker (inherited automatically with zero config). Optionally run [`/setup-astack`](../setup-astack/SKILL.md) inside an app repo to bootstrap `.agents/skills/verify-<app>/`, formal TLA+ specs, and opt-in hooks (`hooks.json`), or run `node <plugin>/skills/setup-astack/scripts/setup-banner.mjs --doctor` for workspace diagnostics.
3. Run your first real task with `/astack-mode`, a concrete goal, and an observable done check.

See [README](../../README.md), [User Guide](../../docs/user-guide.md), [Architecture & Swarm Guide](../../docs/architecture-and-swarm.md), and [Guide 01: Setup](../../docs/guide/01-setup.md). For crafting your first prompt, follow [`references/prompting.md`](references/prompting.md).

**Cost control.** AStack uses subagents, panels (`/arena`, `/interrogate`), and `@verifier` workers intentionally. Selecting **Orchestrator (Carbon)** (Google AI Ultra) or **Orchestrator (Argon)** (Google AI Pro and Ultra) enables dynamic bidirectional routing between a read-only frontier planner and a fast executor with automatic hand-back on friction. Read-only search and browser sweeps use evergreen `flash` aliases, and manual-only principles/mode skills keep startup `<skills>` discovery compact (`disable-model-invocation: true`).

## Antigravity Multi-Agent Tiers

| Problem Shape | Recommended Mode | What Runs |
|---|---|---|
| Focused side task (research, UI check, test run) | `invoke_subagent` / `/fanout` | Built into `/astack-mode`: `astack-agent`, `research`, `browser`, `comment-sicko`, or 2-5 `/fanout` slices. |
| Same task across many files or staged pipeline | `/run-workflow` | Native `run_workflow` Python `parallel()` / `pipeline()` orchestration (`run` mode). |
| Hard, coupled bug, race, or optimization | `/boost` | Multi-round challenge -> fix -> verify alongside `astack-mode` playbooks. |
| Broad parallel sweep across files or PRs | Native `/swarm` | Live message board, `workspace: "share"`, and independent `@verifier` gates. |
| Multi-milestone project or overnight drive | `/teamwork` + `/goal` | Scoped milestones (`/grill-me`, `/architect`), audit gates, `show-me-your-work` logs, persistent drive. |

## Start a task with `/astack-mode`

`/astack-mode` selects one of 26 playbooks, opens a structured checklist matching its steps verbatim, routes subagents/Swarms, and requires empirical proof via `control-ui`, `control-cli`, or `.agents/skills/verify-<app>/` before reporting done. Read [Guide 02: AStack Mode](../../docs/guide/02-astack-mode.md) and [`references/prompting.md`](references/prompting.md).

## Pick a skill

Default to `/astack-mode`, which invokes supporting skills automatically. Pick a leaf skill directly for targeted requests:

| Need | Skill |
|---|---|
| End-to-end engineering playbook & principles | [`/astack-mode`](../astack-mode/SKILL.md) |
| Restate goal clearly before work | [`/in-your-own-words`](../in-your-own-words/SKILL.md) |
| Rewrite a prompt deeper before running | [`/sharpen`](../sharpen/SKILL.md) |
| Trace how code works now | [`/how`](../how/SKILL.md) |
| Trace why code or a number exists | [`/why`](../why/SKILL.md) |
| Explain a change or subsystem plainly | [`/teach`](../teach/SKILL.md) |
| Search prior conversation transcripts | [`/recall`](../recall/SKILL.md) |
| Catch up on this session + waiting calls | [`/ketchup`](../ketchup/SKILL.md) |
| Catch up as narrated slide video | [`/ketchup-video`](../ketchup-video/SKILL.md) |
| Prove what a diff can break externally | [`/blast-radius`](../blast-radius/SKILL.md) |
| Security audit, threat modeling & PR-diff boundary checks | [`/security-audit`](../security-audit/SKILL.md) |
| Explore parallel designs across boundaries | [`/architect`](../architect/SKILL.md) |
| Audit module boundaries and shallow modules | [`/audit-architecture`](../audit-architecture/SKILL.md) |
| Race K candidates & graft best design | [`/arena`](../arena/SKILL.md) |
| Lightweight N-way subagent fan-out | [`/fanout`](../fanout/SKILL.md) |
| Multi-model adversarial diff review | [`/interrogate`](../interrogate/SKILL.md) |
| Compile visual PR dossier and run isolated verifier | [`/review-pr`](../review-pr/SKILL.md) |
| Bug fix test-first on cheap local tests | [`/tdd`](../tdd/SKILL.md) |
| Strict TypeScript patterns & types | [`/typescript-best-practices`](../typescript-best-practices/SKILL.md) |
| Drive web/Electron UI via Chrome DevTools & `browser` | [`/control-ui`](../control-ui/SKILL.md) |
| UX, accessibility & responsive layout audit for new UIs | [`/design-audit`](../design-audit/SKILL.md) |
| Drive CLIs, APIs, and daemons empirically | [`/control-cli`](../control-cli/SKILL.md) |
| Strip speculative abstractions & bloat pre-commit | [`/deslop`](../deslop/SKILL.md) |
| Kill narration/workaround comments via `comment-sicko` | [`/no-comments`](../no-comments/SKILL.md) |
| Remove AI writing tells from prose | [`/unslop`](../unslop/SKILL.md) |
| Technical docs, READMEs, RFCs, PR bodies | [`/technical-writing`](../technical-writing/SKILL.md) |
| Plain-English restatement of last reply | [`/bro`](../bro/SKILL.md) |
| Generate `.agents/skills/verify-<app>/` + feature map | [`/create-verification-skill`](../create-verification-skill/SKILL.md) |
| Update project verification skill after UI changes | [`/maintain-verification-skill`](../maintain-verification-skill/SKILL.md) |
| Create TLA+ formal spec & invariant checks | [`/create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md) |
| Re-sync TLA+ spec after code changes | [`/maintain-formal-verification-skill`](../maintain-formal-verification-skill/SKILL.md) |
| Compile TLA+ traces into Mermaid statecharts | [`/statechart`](../statechart/SKILL.md) |
| Audit performance measurement validity | [`/benchmark-checklist`](../benchmark-checklist/SKILL.md) |
| Custom workflow for huge cross-cutting shifts | [`/figure-it-out`](../figure-it-out/SKILL.md) |
| Append-only TSV decision trail | [`/show-me-your-work`](../show-me-your-work/SKILL.md) |
| Onboard repo verification skills & guardrails | [`/setup-astack`](../setup-astack/SKILL.md) |
| Distill chat habits into a personal skill | [`/automate-me`](../automate-me/SKILL.md) |
| Turn completed session lessons into skill PRs | [`/reflect`](../reflect/SKILL.md) |
| Push fixes up the 5-tier ladder + `/learn` | [`/correct`](../correct/SKILL.md) |
| Build a button UI that triggers automations | [`/make-bot-ui`](../make-bot-ui/SKILL.md) |
| Configure earned autonomy inside policy Ceilings | [`/beast-mode`](../beast-mode/SKILL.md) |
| Navigate AStack skills & playbooks | `/astack-help` |

## Playbooks, principles & built-in commands

- **Playbooks** are step checklists inside `skills/astack-mode/playbooks/` ("babysit this PR", "land the stack", "take over this branch", "pause safely", "full autopilot").
- **24 Principles** (`principle-*`) encode AStack's core engineering bar (`principle-prove-it-works`, `principle-laziness-protocol`, `principle-fix-root-causes`, etc.). See [Guide 08: Principles](../../docs/guide/08-principles.md).
- **All 18 Native Antigravity Commands:** Complete mapping across `run`, `load`, `contract`, and `recommend` modes lives in [`native-commands.md`](../astack-mode/references/native-commands.md) and [`plan-contract.md`](../astack-mode/references/plan-contract.md). None of `/swarm`, `/run-workflow`, `/boost`, `/teamwork`, `/goal`, `/plan`, `/grill-me`, `/learn`, `/agy-customizations`, `/plugin`, `/automation`, `/schedule`, `/browser`, `/btw`, `/generative_ui`, `/antigravity-guide`, `/mcp-app-development`, or `/compact` are shadowed.

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| Workers used an unexpected/old model or hit quota on a pinned ID | Delete or reset stale overrides in `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` so workers inherit your active Antigravity UI model / **Orchestrator**. |
| Parallel workers overwrote files | Use `/swarm` with `workspace: "share"` / `"branch"` or `invoke_subagent` `Workspace: "share"`. |
| Autonomous loop moved but solved nothing | Use `/goal` with a checkable predicate (failing -> passing command/test) rather than vague timing. See [Guide 07](../../docs/guide/07-overnight.md). |
| Reply claims done from compile/lint only | Demand [`/control-ui`](../control-ui/SKILL.md) or [`/control-cli`](../control-cli/SKILL.md) runtime proof (`principle-prove-it-works`). |
| Mistake keeps recurring across PRs | Run [`/correct`](../correct/SKILL.md) to push the fix into types, lint, `.agents/rules/`, hooks, or `/learn`. |

See [`references/prompting.md`](references/prompting.md) and [Guide 10: Recipes & Pitfalls](../../docs/guide/10-recipes-and-pitfalls.md).

## Make AStack my own

- [`/automate-me`](../automate-me/SKILL.md): extract your working style from `<appDataDir>/brain/*/transcript.jsonl`.
- [`/reflect`](../reflect/SKILL.md): convert finished session friction into targeted skill improvements.
- [`/correct`](../correct/SKILL.md): encode fixes into structure, CI, rules, opt-in `hooks.json`, or Antigravity `/learn`.
- See [Guide 09: Make It Yours](../../docs/guide/09-make-it-yours.md).

## Reply

Lead with the direct answer, include one adapted prompt from [`references/recipes.md`](references/recipes.md), and link the backing file.
