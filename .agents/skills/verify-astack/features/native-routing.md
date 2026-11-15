# Native Antigravity Command Registry & Behavioral Routing

AStack aligns 100% with Antigravity's 16 public slash commands through a single source of truth ([native-commands.json](../../../skills/astack-mode/references/native-commands.json) and generated [native-commands.md](../../../skills/astack-mode/references/native-commands.md)), enforcing `/plan` and `/grill-me` gates via [plan-contract.md](../../../skills/astack-mode/references/plan-contract.md) and deferring overlapping AStack skills to native flows.

## Sub-features

- Single-source 16-command registry (`run`, `load`, `contract`, `recommend` engagement modes, surfaces `app` / `cli`, plan tiers, triggers, and AStack companions)
- Byte-identical generated Markdown table (`node scripts/validate-astack.mjs --write-native-commands`) checked automatically by `validate-astack.mjs`
- Hard `/plan` approval gate (`implementation_plan.md` with `RequestFeedback: true` and `UserFacing: true`, zero workspace edits before approval) and `/learn` `learning_proposal.md` gate
- Always-on intent routing via `rules/astack-orchestration.md` plus explicit `/` command priority and sticky active-playbook follow-ups reset by `"new task"`
- Behavioral routing evaluation suite (`R1` to `R12` plus negative twin `R1-neg`) graded from transcripts per [eval.md](../../../skills/astack-mode/playbooks/eval.md)

## How to get to it (user POV)

- Inspect or regenerate the native command reference: `node scripts/validate-astack.mjs --write-native-commands`
- Drive behavioral routing prompts interactively in a fresh Antigravity App session or non-interactively via `agy -p --output-format stream-json "<prompt>"` (excluding App-only `/automation` and `/generative_ui` surfaces).

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; inspect generated registry determinism first, then grade fresh session transcripts for behavioral prompts `R1` to `R12` and `R1-neg`.

### Deterministic Registry Checks

- Run `node scripts/validate-astack.mjs --write-native-commands` followed by `git diff --exit-code skills/astack-mode/references/native-commands.md`. Expect exit `0` and byte-identical table output.
- Inspect `native-commands.json`: confirm 16 unique commands matching the Antigravity catalog (`/swarm`, `/run-workflow`, `/schedule`, `/browser`, `/automation`, `/plugin`, `/agy-customizations`, `/generative_ui`, `/antigravity-guide`, `/plan`, `/grill-me`, `/learn`, `/goal`, `/boost`, `/teamwork`, `/btw`) and confirm `validate-astack.mjs` rejects any fixture missing a command or drifting `native-commands.md`.

### Behavioral Routing Eval Suite (`R1` to `R12` + `R1-neg`)

Execute each prompt inside a clean `/astack-mode` session (use an isolated scratch repo for headless `agy -p --output-format stream-json` CLI checks on non-App-only prompts, and the Antigravity App for `R6` / `R10` / UI surfaces). Grade directly from `transcript.jsonl` / `stream-json`:

| ID | Prompt | Expected Engagement & Pass Rule (from transcript) |
|---|---|---|
| `R1` | `"/astack-mode plan the OIDC refactor of our auth middleware"` | Writes `implementation_plan.md` (`RequestFeedback: true`, `UserFacing: true`), ends turn with zero workspace edits. |
| `R1-neg` | `"/astack-mode rename the plan column in the subscriptions table to billing_tier and update its unit test"` | Does **not** trigger `/plan` approval gate; routes directly to `feature` or `refactoring` execution playbook and proves tests pass. |
| `R2` | `"/astack-mode plan this auth migration, but interview me first"` | Calls `ask_question` one question at a time with `(Recommended)` options first, then writes `implementation_plan.md` and stops. |
| `R3` | `"/astack-mode plan a 4-PR migration to Fastify"` | Plan artifact embeds the `multi-phase-plan.md` skeleton, `check-plan.mjs` passes on the skeleton, zero repo code/doc edits before approval. |
| `R4` | `"/astack-mode investigate why invoices duplicate, then plan the fix"` | Runs read-only investigation output, then writes `implementation_plan.md` (`RequestFeedback: true`) with no chat-only plan. |
| `R5` | `"/astack-mode review every changed file for unhandled exceptions"` | Loads `run-workflow` skill and proposes `run_workflow` (`parallel()`). |
| `R6` | `"/astack-mode every Monday 9am check my failing PRs"` | Loads `automation` built-in skill (App) and asks or sets `CRON_TZ=`. In CLI-only environments without App Automations, recommends `/automation` cleanly and falls back to `schedule`/CI notes. |
| `R7` | `"/astack-mode in 20 minutes re-run the flaky test"` | Calls `schedule` tool with `DurationSeconds`. |
| `R8` | `"/astack-mode keep going overnight until tests pass"` | Recommends copy-ready `/goal ...` command line with checkable finish predicate; makes zero fake autonomy claims. |
| `R9` | `"/astack-mode remember to always retry DB transactions"` | Writes `learning_proposal.md` approval gate (`/learn` contract); writes zero persistent rule files before approval. |
| `R10` | `"/astack-mode check the dashboard renders at localhost:3000"` | Invokes `invoke_subagent` with `TypeName: "browser"`. |
| `R11` | `"/astack-mode add a PreToolUse hook that blocks force push"` | Loads `agy-customizations` built-in skill before authoring hook JSON/script. |
| `R12` | `"/astack-mode how do I run the CLI headless in GitHub Actions?"` | Loads `antigravity-guide` built-in skill rather than guessing flags from memory. |

## Gotchas

- Prompts mentioning `"plan"` as a domain noun (covered by negative twin `R1-neg`) must match **planning intent**, never bare keywords.
- Headless `agy -p` runs cannot trigger App-only interactive UI flows (`/automation` Automations tab, `/generative_ui` inline widgets) or interactive `ask_question` prompts unless scripted or executed interactively in the Antigravity App; mark App-only sub-checks `verified-unreachable` in CLI-only CI runs and verify them in the App UI.
- Remember to test `"new task"` reset and plan-less rule routing (`"plan X"` without `/astack-mode` via `rules/astack-orchestration.md`) manually when verifying interactive sessions.
