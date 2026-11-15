# Set up astack

In this page you install the plugin, pick which models astack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

In your shell (or via the Antigravity Plugins Manager), install AStack directly from GitHub and confirm it is enabled:

```bash
agy plugin install https://github.com/jmxt3/astack
agy plugin list --json
```

(To install from a local clone instead, run `agy plugin install ./astack` or `agy plugin install .`. On Windows, if updating while Antigravity is running fails with `Access is denied`, run `agy plugin uninstall astack` before reinstalling.) For workspace-level customization, you can also copy individual skills into `.agents/skills/`. See [Architecture & Swarm](../architecture-and-swarm.md) for how plugin skills interact with Antigravity's built-in `/boost`, `/swarm`, `/teamwork`, and `/goal` commands.

## Works with any model & plan (zero config)

AStack works out of the box with **any model on any Antigravity plan** without pinning static model IDs upfront.

By defaulting to `inherit` (omitting explicit model overrides), `/astack-mode`, `invoke_subagent`, and `/swarm` follow whatever model you pick in Antigravity's UI selector with zero stale IDs and no chat restart. Broad read-only sweeps (`research` and `browser`) use `flash` automatically, `/arena` discovers live models and quota via `swarm{action: "models"}`, and optional tier aliases live in [Make it yours](./09-make-it-yours.md#optional-override-subagent-tiers-with-astack-modelsmd).

**Dynamic bidirectional model routing (`Orchestrator`).** Unlike traditional static model routers that guess task difficulty from the first prompt and lock into one model, **Orchestrator** coordinates cooperative role hand-offs inside a single session or trajectory between a frontier model like [Gemini 4 Carbon](https://antigravity.google/blog/gemini-4-carbon-in-google-antigravity) and [Gemini 4 Hydrogen](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/) ([Gemini 4 Hydrogen in Google Antigravity](https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity/)). Carbon starts in a read-only phase to explore dependencies, resolve ambiguities, and write an explicit plan with re-planning triggers. Hydrogen takes over to write edits, update packages, and run tests and verification checks. If Hydrogen hits friction, control hands back to Carbon automatically to inspect state, repair the plan, and resume execution.

## Onboard your repo with `/setup-astack`

Inside an application repository, run:

```text
/setup-astack
```

[`/setup-astack`](../../skills/setup-astack/SKILL.md) inspects what your repository already has and offers to set up empirical verification and safety guardrails:

1. **Runtime verification skill ([`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md))**: writes `.agents/skills/verify-<app>/` and a `features/` sitemap so agents drive and prove your app the way a user does—and verifies the skill once before handing it over. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth. If you're new to astack, say yes: an agent that can check its own work keeps going until the check passes, instead of handing every result back to you to check by hand.
2. **Formal verification skill ([`/create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md))**: checks a critical invariant with TLA+ when your code has concurrency, retries, a state machine, or a parser where tests rarely reach the breaking case. [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers it.
3. **Opt-in lifecycle hooks (`hooks.json`)**: review `astack-irreversible-guard` and `astack-verify-reminder`, which ship disabled (`"enabled": false`) by default.

No chat restart is needed after `/setup-astack`.

## Keep the cost in check

astack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Let AStack route high-volume read-only sweeps to `flash` automatically, select **Orchestrator** to shift edits and test loops onto Hydrogen while keeping frontier planning and friction recovery on Carbon, or set optional `flash` and `pro` role tiers in `astack-models.md`.
- Save `/astack-mode` for work that needs rigor. A small, obvious edit doesn't.
- Right-size `/arena` and `/fanout` candidate counts for the stakes of the decision.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/astack-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/astack-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. In Antigravity, start serious tasks with `/astack-mode` (and combine it with `/boost` for hard single-thread debugging/optimization, `/swarm` for broad parallel work with a shared message board, `/teamwork` for multi-milestone projects, or `/goal` for thorough autonomous completion). If you want project-wide engineering defaults active on every session without typing `/astack-mode`, pin a rule in `.agents/rules/` or install the bundled [`rules/astack-orchestration.md`](../../rules/astack-orchestration.md).

Next: [Route work through `/astack-mode`](./02-astack-mode.md).
