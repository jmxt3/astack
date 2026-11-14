# Set up astack

In this page you install the plugin, pick which models astack uses, and run your first task. Setup is one command plus a short conversation.

## Install the plugin

In your shell (or via the Antigravity Plugins Manager), install AStack directly from GitHub and confirm it is enabled:

```bash
agy plugin install https://github.com/jmxt3/astack
agy plugin list --json
```

(To install from a local clone instead, run `agy plugin install ./astack` or `agy plugin install .`.) For workspace-level customization, you can also copy individual skills into `.agents/skills/`. See [Architecture & Swarm](../architecture-and-swarm.md) for how plugin skills interact with Antigravity's built-in `/boost`, `/swarm`, `/teamwork`, and `/goal` commands.

## Pick your models

Run:

```text
/setup-astack
```

[`/setup-astack`](../../skills/setup-astack/SKILL.md) inspects the models available in your Antigravity session (via `swarm{action: "models", all: true}`), asks for a reasoning/cost budget, shows you each role (code delegates, judgment, verification, review panels), and asks what you want. Answer the questions. It writes `~/.gemini/config/rules/astack-models.md` (or project-scoped `.agents/rules/astack-models.md`), a small `trigger: model_decision` rule every astack skill reads.

For `invoke_subagent`, astack maps roles onto Antigravity's model tiers (`pro`, `inherit`, `flash`, `flash_lite`). For native `/swarm` workers (`swarm{action: "add"}`), astack passes explicit Antigravity model IDs or inherits your active coordinator model when unset. The `large`/`unlimited` budgets route judgment, review panels, and adversarial verification to `pro` (or top reasoning models), while `medium` and `small` shift explorer, log-mining, and worker slice roles toward `flash`/`flash_lite` to control token cost.

You only override what you care about. A role with no line in the rule keeps the skill's default. To restore a default, delete that role's line. A rerun of `/setup-astack` preserves any customized roles.

Set a role to `auto`, `inherit`, or `inherit-parent` and astack omits any subagent/worker model override so it inherits your parent chat model. For a panel role the value is a list, and one subagent runs per entry, so the list length sets the panel size. Setup also configures `swarm workers`, the default model for parallel `/fanout` and `/swarm` worker slices unless a specific task overrides it.

## Accept the verification offers, or don't

At the end of setup, `/setup-astack` looks for a way to prove app behavior in your project, either a `verify-*` skill or an existing harness. If it finds neither, it offers once to generate one with [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md).

Say yes and it writes `.agents/skills/verify-<app>/`, a project-local skill that teaches agents to drive your app the way a user does. It proves the skill works once before handing it over. Say no and setup moves on. You can run `/create-verification-skill` yourself any time. [Verify and ship](./06-verify-and-ship.md#create-a-project-verification-skill) covers it in depth.

If you're new to astack, say yes. An agent that can check its own work keeps going until the check passes. An agent that can't hands every result back to you to check by hand. Of everything in this guide, the verification skill pays off the most.

Then setup offers once to generate a formal verification skill with [`/create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md), unless the project already has one. Tests check the cases someone thought to write. A formal verification skill checks one key property of your code, such as "a job never runs twice at once", in every case within a stated scope. Say yes when your code has concurrency, retries, a state machine, or a parser, where a bug is costly and tests rarely reach the case that breaks. Otherwise say no, and run it later if that changes. [Verify and ship](./06-verify-and-ship.md#prove-a-property-with-a-formal-verification-skill) covers it.

After setup, start a new chat. The model rule applies to new sessions.

## Keep the cost in check

astack spends extra tokens on subagents and review panels. That's the price of the rigor. To spend fewer:

- Rerun `/setup-astack` and pick a smaller reasoning budget or cheaper models. A strong model in the main chat with cheaper, faster models in the code roles is a good split.
- Set a role to `auto` or `inherit-parent` so it runs on the chat's own model.
- Shorten a panel list. Each entry runs one subagent.
- Save `/astack-mode` for work that needs rigor. A small, obvious edit doesn't.

## Run your first task

Pick something real but small, and describe it the way you'd describe it to a colleague:

```text
/astack-mode add a --json flag to this command. text output stays byte-identical. verify both.
```

Watch the todo list. Its first items are the matched playbook's steps copied in, the Feature playbook for this prompt. If `/astack-mode` skips a step, the step stays in the list with `skip: <reason>`, so you can see what it chose not to do.

From here you can type normal follow-ups. In Antigravity, start serious tasks with `/astack-mode` (and combine it with `/boost` for hard single-thread debugging/optimization, `/swarm` for broad parallel work with a shared message board, `/teamwork` for multi-milestone projects, or `/goal` for thorough autonomous completion). If you want project-wide engineering defaults active on every session without typing `/astack-mode`, pin a rule in `.agents/rules/` or install the bundled [`rules/astack-orchestration.md`](../../rules/astack-orchestration.md).

Next: [Route work through `/astack-mode`](./02-astack-mode.md).
