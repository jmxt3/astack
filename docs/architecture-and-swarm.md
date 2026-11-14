# AStack Architecture & Antigravity Mode Integration

**Original `pstack` & Michelin Kitchen thesis:** **Lauren Tan (`@poteto`)** ([`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack), MIT License).  
**Native Antigravity port (`astack`):** **João Machete**.

AStack ports Lauren Tan's engineering environment — verification skills ("Control Glass"), materialized feature maps, engineering playbooks, and anti-slop discipline — into **Google Antigravity**, pairing it natively with `Subagents`, `/boost`, `/swarm`, `/teamwork`, `/goal`, `/schedule`, and opt-in lifecycle hooks.

## Core Thesis: Trust Through the Environment

High-throughput agentic engineering does not come from reviewing thousands of unverified diffs by hand. It comes from encoding verification and engineering constraints into the environment so agents can prove correctness themselves before asking for attention.

### The 5-Layer Enforcement Hierarchy

When agents repeat a mistake, push the fix as high up this hierarchy as possible:

| Layer | Strength | Mechanism in AStack / Antigravity |
|---|---|---|
| 1. Codebase & Architecture | Strongest | Data structures, module boundaries, single paved path (`principle-type-system-discipline`, `principle-model-the-domain`, `/correct`). Make the bad thing unrepresentable. |
| 2. Static Analysis & Tests | Strong | TypeScript strictness, linters, CI checks whose error names the fix, TLA+ models (`/statechart`, `/create-formal-verification-skill`), `/tdd`. |
| 3. Rules & Lifecycle Hooks | Medium | Always-on/triggered rules ([`rules/astack-orchestration.md`](../rules/astack-orchestration.md)) and opt-in [`hooks.json`](../hooks.json) (`PreToolUse` destructive command gate, `Stop` verify reminder). |
| 4. Skills & Playbooks | Situational | `/astack-mode` router, 23 playbooks, 24 named principles, `/how`, `/why`, `/architect`, `/arena`, `/interrogate`, `/deslop`, `/no-comments`. |
| 5. Human Review | Weakest | Reserved for design taste, product tradeoffs, and high-risk irreversible actions — assisted by `/teach`, `/ketchup`, and `/show-me-your-work`. |

## Control Glass & Verification Infrastructure

AStack bundles ready-to-use verification skills plus repo-specific generators:

- **Live UI Verification ([`control-ui`](../skills/control-ui/SKILL.md))**: Drives web, Electron, and browser apps through Antigravity's `browser` subagent and `chrome-devtools-mcp`, starts dev servers cleanly (`IsDaemon: true`), verifies console/network/DOM state, collects traces/screenshots, and tears down processes via `manage_task`.
- **CLI / TUI / Daemon Verification ([`control-cli`](../skills/control-cli/SKILL.md))**: Exercises commands against isolated temp directories and fixtures, checks exit codes and stdout/stderr contracts, and cleans up background processes.
- **Materialized Memory (`verify-<app>` + `features/`)**: [`/create-verification-skill`](../skills/create-verification-skill/SKILL.md) interviews the repository and generates `.agents/skills/verify-<app>/` with a `features/` sitemap so any future agent can map vague bug reports to exact user flows and proof checks. [`/maintain-verification-skill`](../skills/maintain-verification-skill/SKILL.md) keeps it accurate as the app evolves.
- **Post-Cleanup Hygiene ([`deslop`](../skills/deslop/SKILL.md) + [`no-comments`](../skills/no-comments/SKILL.md))**: Inlines single-caller indirection, removes narrating comments and unsupported defensive guards, runs adversarial comment review via `comment-sicko`, and re-verifies afterward.
- **Formal & Statechart Verification ([`statechart`](../skills/statechart/SKILL.md))**: Cross-platform Node 22+ TypeScript runner (`statechart.mjs`) converting TLA+ / TLC checks into Mermaid statecharts and bug-path traces.

## Antigravity 5-Mode Decision Matrix

`/astack-mode` routes each task along two axes: **what engineering workflow it needs** (the 23 playbooks + 24 principles) and **which Antigravity execution mode matches its shape**.

```mermaid
flowchart TD
    Req[User Request + /astack-mode] --> Shape{Task shape?}
    Shape -->|Focused side task or simple slice fan-out| Sub["Focused Subagents<br/>invoke_subagent / /fanout"]
    Shape -->|Hard, coupled debugging / perf / race| Boost["/boost<br/>Iterative challenge & verify"]
    Shape -->|Broad, cleanly divisible across files or suites| Swarm["/swarm<br/>Board + isolated workers + @verifier"]
    Shape -->|Multi-milestone, multi-hour or multi-day| Team["/teamwork<br/>Scoping interview + milestone gates"]
    Shape -->|Autonomous overnight loop with clear predicate| Goal["/goal + /schedule<br/>Decision log + morning audit"]
```

| Antigravity Mode | Use When | AStack Pairing | Workspace & Isolation |
|---|---|---|---|
| **Subagents** (`invoke_subagent` / `/fanout`) | Self-contained research, browser check, test slice, independent check matrix, or declared race arms | `/how`, `/why`, `/fanout`, `/arena`, `/interrogate`, `/reflect`, `/recall` | `Workspace: "inherit"` for readers; `"share"` or `"branch"` for writers |
| **`/boost`** | Problem is **hard rather than broad**: root-cause debugging, race conditions, algorithmic perf, tightly coupled refactors | `bug-fix`, `perf-issue`, `hillclimb`, `runtime-forensics`, `/tdd`, `/benchmark-checklist`, `/statechart` | Single focused thread with multi-round challenge/fix/verify |
| **`/swarm`** | Work is **broad and divides cleanly** across files, packages, test suites, or research lenses needing live coordination | `autopilot-full`, `autopilot-stack`, [`swarm-coordination.md`](../skills/astack-mode/references/swarm-coordination.md) | `workspace: "share"` for concurrent writers, `inherit` for `@verifier` (`control-ui`/`control-cli` + `deslop`) and optional `@monitor` |
| **`/teamwork`** | **Long-horizon, multi-milestone** migrations, rewrites, or simulations spanning hours/days | `orchestrate`, `multi-phase-plan`, `/interrogate`, `/architect`, `/show-me-your-work` | Dedicated project directory + milestone audit gates |
| **`/goal` (+ `/schedule`)** | Sustained autonomous iteration until a concrete checkable finish predicate holds | `autonomous-run`, `/figure-it-out`, `/show-me-your-work` (`decisions.tsv`), `/ketchup` | Isolated git worktree; pause safely on interruption (`pause-safely`) |

### Why `/fanout` Instead of `/swarm`?

In Antigravity's customization loading order, **built-in skills have higher precedence than plugin skills of the same name**. Wait — even more importantly, shadowing Antigravity's native multi-agent `/swarm` board skill would confuse both users and agents trying to invoke `/swarm`.

Therefore, AStack explicitly renames `pstack`'s upstream `skills/swarm` slice runner to **`skills/fanout`** (`/fanout`). This preserves Antigravity's built-in `/swarm` cleanly while letting `/fanout` handle lightweight `invoke_subagent` fan-out matrices and seamlessly escalate to native `/swarm` whenever workers need a shared message board or dedicated `@verifier`.

See [`skills/astack-mode/references/swarm-coordination.md`](../skills/astack-mode/references/swarm-coordination.md) for concrete `swarm` (`title`, `add`, `workspace`, `@verifier`, `@monitor`, cleanup) patterns.

## Opt-In Lifecycle Hooks (`hooks.json`)

[`hooks.json`](../hooks.json) ships two lightweight Node 22+ lifecycle hooks **disabled by default (`"enabled": false`)** so installing AStack introduces zero unexpected friction:

1. **`astack-irreversible-guard` (`PreToolUse` on `run_command`)**: Intercepts potentially irreversible commands (`git push --force`, `git reset --hard`, recursive root deletes, `DROP TABLE`/`DATABASE`, prod destroys/deploys) with `{"decision": "force_ask"}` so confirmation ignores cached "Always Allow" approvals. Implemented in [`scripts/hooks/irreversible-guard.mjs`](../scripts/hooks/irreversible-guard.mjs).
2. **`astack-verify-reminder` (`Stop`)**: When enabled and `ASTACK_REQUIRE_VERIFY=1` is set in the environment, nudges once (`{"decision": "continue"}`) if uncommitted non-markdown changes exist on a normal `NO_TOOL_CALL` stop, strictly honoring `continuationActive` to prevent loops. Implemented in [`scripts/hooks/verify-reminder.mjs`](../scripts/hooks/verify-reminder.mjs).

## Outer Loop Automations (`benny`)

AStack includes [`docs/automations/benny/`](./automations/benny/README.md) — a dormant two-stage automation pack (triage + reproduce-and-fix) adapted to `.agents/automations/benny/`, Antigravity `/schedule` / `agy -p` runners, `control-ui`/`control-cli`, and fail-closed Slack thread invariants.
