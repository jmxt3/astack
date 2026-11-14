# AStack (`astack`)

A native **Google Antigravity** engineering plugin delivering disciplined planning, empiricism, verification ("Control Glass"), architecture principles, and multi-agent coordination.

> **Credits & Attribution**  
> **Original Plugin (`pstack`):** Created by **Lauren Tan (`@poteto`)** in [`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack) (MIT License, baseline `v0.15.36`), grounded in her SpaceX AI / Cursor workflow architecture.  
> **Antigravity Port (`astack`):** Adapted and engineered for Google Antigravity by **João Machete** ([`jmxt3/astack`](https://github.com/jmxt3/astack)), integrating AStack natively with Antigravity's `Subagents`, `/boost`, `/swarm`, `/teamwork`, `/goal`, `/schedule`, and lifecycle hooks.

---

## Install & Quickstart

Install directly from GitHub in one command and verify registration:

```bash
agy plugin install https://github.com/jmxt3/astack
agy plugin list --json
```

To install from a local clone instead, run `agy plugin install ./astack` (or `agy plugin install .` from inside the repository).

Inside Antigravity:

1. Run `/setup-astack` once to configure model routing (`astack-models.md`) and optionally scaffold project verification (`verify-<app>`) and formal verification skills.
2. Start serious tasks with `/astack-mode <goal + how to prove it's done>`.
3. Ask `/astack-help <question>` anytime for tailored skill recommendations and ready-to-send prompts without starting execution.

## Antigravity Execution Modes

AStack pairs its 23 playbooks and 24 engineering principles with Antigravity's native execution modes (detailed in [`docs/architecture-and-swarm.md`](./docs/architecture-and-swarm.md)):

| Mode | Choose When | Key AStack Integration |
|---|---|---|
| **Subagents** (`invoke_subagent`, [`/fanout`](./skills/fanout/SKILL.md)) | Self-contained research, browser validation, test runs, slice checks, or declared races | [`/how`](./skills/how/SKILL.md), [`/why`](./skills/why/SKILL.md), [`/fanout`](./skills/fanout/SKILL.md), [`/arena`](./skills/arena/SKILL.md), [`/interrogate`](./skills/interrogate/SKILL.md) |
| **`/boost`** | Problem is **hard rather than broad** (races, coupled refactors, deep root-cause perf/bugs) | `bug-fix`, `perf-issue`, `hillclimb`, [`/tdd`](./skills/tdd/SKILL.md), [`/statechart`](./skills/statechart/SKILL.md) |
| **`/swarm`** | Work is **broad and divides cleanly** across files, packages, or test suites | Shared board, isolated `workspace: "share"`/`"branch"` writers, `@verifier` + `@monitor` |
| **`/teamwork`** | **Long-horizon, multi-milestone** migrations, simulations, or formal efforts | Scoping interview + milestone gates paired with [`/architect`](./skills/architect/SKILL.md) & [`/show-me-your-work`](./skills/show-me-your-work/SKILL.md) |
| **`/goal`** (+ **`/schedule`**) | Overnight/autonomous iteration toward a checkable finish predicate | `autonomous-run`, [`/figure-it-out`](./skills/figure-it-out/SKILL.md), `decisions.tsv` audit, [`/ketchup`](./skills/ketchup/SKILL.md) |

> AStack uses `/fanout` instead of `skills/swarm` so Antigravity's built-in `/swarm` command is never shadowed.

## What's Inside

- **61 Skills** (`skills/`):
  - **Orchestration & Discovery**: [`/astack-mode`](./skills/astack-mode/SKILL.md) (23 playbooks), [`/astack-help`](./skills/astack-help/SKILL.md), [`/setup-astack`](./skills/setup-astack/SKILL.md)
  - **Control Glass & Verification**: [`/control-ui`](./skills/control-ui/SKILL.md), [`/control-cli`](./skills/control-cli/SKILL.md), [`/create-verification-skill`](./skills/create-verification-skill/SKILL.md), [`/maintain-verification-skill`](./skills/maintain-verification-skill/SKILL.md), [`/create-formal-verification-skill`](./skills/create-formal-verification-skill/SKILL.md), [`/maintain-formal-verification-skill`](./skills/maintain-formal-verification-skill/SKILL.md), [`/statechart`](./skills/statechart/SKILL.md), [`/benchmark-checklist`](./skills/benchmark-checklist/SKILL.md), [`/blast-radius`](./skills/blast-radius/SKILL.md), [`/tdd`](./skills/tdd/SKILL.md)
  - **Understanding, Design & Hygiene**: [`/how`](./skills/how/SKILL.md), [`/why`](./skills/why/SKILL.md), [`/teach`](./skills/teach/SKILL.md), [`/recall`](./skills/recall/SKILL.md), [`/architect`](./skills/architect/SKILL.md), [`/arena`](./skills/arena/SKILL.md), [`/fanout`](./skills/fanout/SKILL.md), [`/interrogate`](./skills/interrogate/SKILL.md), [`/deslop`](./skills/deslop/SKILL.md), [`/no-comments`](./skills/no-comments/SKILL.md), [`/unslop`](./skills/unslop/SKILL.md), [`/correct`](./skills/correct/SKILL.md), [`/reflect`](./skills/reflect/SKILL.md)
  - **24 Engineering Principle Skills** (`skills/principle-*/`): decision-shaping rules automatically surfaced and cited by `/astack-mode`
- **2 Custom Agents** (`agents/`): [`astack-agent`](./agents/astack-agent.md) (verifier-first builder/reviewer) and [`comment-sicko`](./agents/comment-sicko.md) (skeptical comment & suppressor auditor)
- **1 Orchestration Rule** ([`rules/astack-orchestration.md`](./rules/astack-orchestration.md)): model-decision routing across Antigravity execution modes and `astack-models.md`
- **Opt-In Lifecycle Hooks** ([`hooks.json`](./hooks.json)): `astack-irreversible-guard` (`PreToolUse`) and `astack-verify-reminder` (`Stop`), both shipped with `"enabled": false`
- **User Guide & Automations**: Full walkthrough in [`docs/guide/README.md`](./docs/guide/README.md) and dormant Slack triage/repro pack in [`docs/automations/benny/README.md`](./docs/automations/benny/README.md)

## Requirements & Scripts

- **Cross-platform Node.js 22+** (`v22.6+` recommended for `--experimental-strip-types`, or Node `22.18+` / `23.6+` unflagged): all bundled CLIs (`statechart.mjs`, `watch-pr`, `worktree-audit`, `show-me-your-work/scripts/log.mjs`, hooks, sync/validation) run natively on Windows, macOS, and Linux with zero Bun requirement.

Verify integrity locally:

```bash
node scripts/validate-astack.mjs
agy plugin validate --strict .
node --test scripts/test/*.test.mjs
```

Sync against upstream `pstack` while protecting Antigravity overlays:

```bash
node scripts/sync-upstream.mjs --source <path-to-pstack> --dry-run
```

## License

MIT — Original copyright (c) Lauren Tan (`@poteto`); Antigravity port copyright (c) 2026 João Machete. See [LICENSE](./LICENSE).
