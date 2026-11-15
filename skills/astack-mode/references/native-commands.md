# Native Antigravity Slash Commands

Generated from [native-commands.json](./native-commands.json) (source catalog `https://antigravity.google/docs/commands/`). Do not edit manually; run `node scripts/validate-astack.mjs --write-native-commands` after updating the registry.

## Engagement Modes

- **run**: Call the native tool directly (after loading its built-in skill when present).
- **load**: Read the built-in Antigravity `SKILL.md` and follow its workflow.
- **contract**: Reproduce the command's documented protocol in the active turn (stop at reviewable artifacts when required).
- **recommend**: Harness-owned mode. Print a copy-ready command line for the user, explain what it adds, and use in-turn fallback only if they decline.

When a command is `app`-only (such as `/automation` or `/generative_ui`), CLI sessions route to `/schedule` or plain Markdown/Mermaid fallbacks cleanly.

## All 16 Native Commands

| Command | Category | Mode | Backing | Triggers | Surfaces | Tier | AStack Companion |
|---|---|---|---|---|---|---|---|
| `/swarm` | Reasoning | `run` | tool `swarm`, skill `swarm` | `parallel workers on a board`, `named workers and verifier`, `split across files with a verifier`, `multi-PR stack execution` | app, cli | Google AI Pro and Ultra | [swarm-coordination.md](../../../skills/astack-mode/references/swarm-coordination.md), [fanout](../../../skills/fanout/SKILL.md) |
| `/run-workflow` | Reasoning | `run` | tool `run_workflow`, skill `run-workflow` | `same task across many files`, `for each file or package`, `staged multi-agent pipeline`, `python workflow script` | app, cli | Google AI Pro and Ultra | [fanout](../../../skills/fanout/SKILL.md), [swarm-coordination.md](../../../skills/astack-mode/references/swarm-coordination.md) |
| `/schedule` | Automation | `run` | tool `schedule` | `in N minutes`, `one-time timer`, `poll every`, `recurring check in this chat` | app, cli | All plans | [autonomous-run.md](../../../skills/astack-mode/playbooks/autonomous-run.md), [babysit.md](../../../skills/astack-mode/playbooks/babysit.md) |
| `/browser` | Tools | `run` | tool `invoke_subagent`, TypeName `browser` | `open in browser`, `check localhost`, `take UI screenshot`, `test live web page` | app, cli | All plans | [control-ui](../../../skills/control-ui/SKILL.md) |
| `/automation` | Automation | `load` | built-in skill `automation` | `every morning`, `every Monday`, `persistent background automation`, `Automations tab` | app | All plans | [autonomous-run.md](../../../skills/astack-mode/playbooks/autonomous-run.md), [README.md](../../../docs/automations/benny/README.md) |
| `/plugin` | Customization | `load` | built-in skill `plugin` | `install plugin`, `manage plugins`, `package plugin`, `plugin marketplace` | app, cli | All plans | [setup-astack](../../../skills/setup-astack/SKILL.md) |
| `/agy-customizations` | Customization | `load` | built-in skill `agy-customizations` | `create a hook`, `configure MCP server`, `rule frontmatter`, `skill discovery precedence` | app, cli | All plans | [authoring-a-skill.md](../../../skills/astack-mode/playbooks/authoring-a-skill.md), [automate-me](../../../skills/automate-me/SKILL.md) |
| `/generative_ui` | Tools | `load` | built-in skill `generative_ui` | `interactive chart`, `interactive HTML widget`, `visual explainer`, `HTML diagram` | app | All plans | [ketchup](../../../skills/ketchup/SKILL.md), [teach](../../../skills/teach/SKILL.md) |
| `/antigravity-guide` | Tools | `load` | built-in skill `antigravity-guide` | `how do I use Antigravity`, `Antigravity CLI flags`, `headless CI`, `Antigravity official docs` | app, cli | All plans | [astack-help](../../../skills/astack-help/SKILL.md) |
| `/plan` | Planning | `contract` | [plan-contract.md](../../../skills/astack-mode/references/plan-contract.md) + `planning-and-task-breakdown` | `plan`, `write a plan`, `plan first`, `review before editing`, `before you change anything` | app, cli | All plans | [multi-phase-plan.md](../../../skills/astack-mode/playbooks/multi-phase-plan.md), [architect](../../../skills/architect/SKILL.md) |
| `/grill-me` | Planning | `contract` | [plan-contract.md](../../../skills/astack-mode/references/plan-contract.md) | `interview me`, `grill me`, `ask me one question at a time`, `clarify requirements first` | app, cli | All plans | [interrogate](../../../skills/interrogate/SKILL.md), [prototype.md](../../../skills/astack-mode/playbooks/prototype.md) |
| `/learn` | Customization | `contract` | [plan-contract.md](../../../skills/astack-mode/references/plan-contract.md) | `remember this rule`, `save this preference`, `turn this correction into a rule` | app, cli | All plans | [reflect](../../../skills/reflect/SKILL.md), [correct](../../../skills/correct/SKILL.md), [automate-me](../../../skills/automate-me/SKILL.md) |
| `/goal` | Reasoning | `recommend` | recommend `/goal <task>. Done when <checkable predicate>.` | `don't stop`, `overnight`, `run until done`, `fully autonomous` | app, cli | All plans | [autonomous-run.md](../../../skills/astack-mode/playbooks/autonomous-run.md), [show-me-your-work](../../../skills/show-me-your-work/SKILL.md) |
| `/boost` | Reasoning | `recommend` | recommend `/boost <hard bug, race condition, or algorithm optimization with benchmark>` | `gnarly race condition`, `deep algorithmic optimization`, `three-tier deep reasoning` | app, cli | Paid plans | [bug-fix.md](../../../skills/astack-mode/playbooks/bug-fix.md), [perf-issue.md](../../../skills/astack-mode/playbooks/perf-issue.md) |
| `/teamwork` | Reasoning | `recommend` | recommend `/teamwork <repo-scale migration or multi-day research campaign>` | `multi-day migration`, `subsystem rewrite`, `agent teams with Sentinel spec` | app, cli | Paid plans | [orchestrate.md](../../../skills/astack-mode/playbooks/orchestrate.md), [figure-it-out](../../../skills/figure-it-out/SKILL.md) |
| `/btw` | Tools | `recommend` | recommend `/btw <quick side question while the agent keeps working>` | User-initiated only | app, cli | All plans | [astack-help](../../../skills/astack-help/SKILL.md) |
