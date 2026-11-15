# Verify AStack Feature Map

Each file under `features/` documents one verification surface of the AStack repository (`astack`), how an engineer invokes it from the workspace root, and how to prove both happy paths and failure paths under `control-cli` isolation without mutating tracked repository state.

## Baseline preconditions

- Repository root `c:\Users\jmach\dev\astack` is checked out and clean relative to intended work.
- Node 22+ (`node -v`, minimum `>= 22.6.0`) is on `PATH` (supports `--experimental-strip-types` and `node --run`).
- `git` and Antigravity CLI (`agy --version`) are on `PATH` unless testing offline structural fallback with `--no-agy`.
- Per-run directories `$ScratchDir` (`.tmp/verify-astack-scratch/<run-id>`) and `$EvidenceDir` (`.tmp/verify-astack-evidence/<run-id>`) exist; `.tmp/` is listed in `.gitignore`.

## Driving conventions

- Run commands from the repository root (`c:\Users\jmach\dev\astack`).
- Write temporary fixtures, synthetic repos, mock upstream trees, and generated `.tsv`/`.plan.md` artifacts only inside `$ScratchDir`.
- Write captured stdout/stderr, `$LASTEXITCODE` records, and serialized JSON/TSV outputs directly into `$EvidenceDir` so Cleanup never erases proof.
- Pipe JSON payloads cleanly in `pwsh` without BOM issues (`[System.Text.UTF8Encoding]::new($false)` or plain PowerShell pipeline `'...' | node ...`).
- Never point `upstream-watch.mjs --out` inside the repository or `$ScratchDir` (it must exit `2`); pass a path under `$env:TEMP` outside `rootDir` when testing report export.

## Proof and skip reporting

Report every driven scenario against observed results rather than assuming pass from exit code `0` alone:

- Report **verified** with exact command, exit code, stdout/stderr snippet, and preserved file path in `$EvidenceDir`.
- Report **verified-fail** if the real artifact rejects valid input or silently skips expected failures, attaching raw diagnostics.
- Report **verified-unreachable** only when an external prerequisite is genuinely absent (for example `java` + `TLA2TOOLS` for live TLC execution in `statechart.mjs`, `gh` auth/network for live GitHub queries in `watch-pr.mjs`, or interactive App surfaces for App-only `/automation` and `/generative_ui`), stating what prerequisite was missing.

## Feature entry contract

Every feature file in this directory stays user-observable and concise:

1. Title plus 1-paragraph summary of what the feature does for an AStack user or maintainer.
2. `## Sub-features`: bulleted capabilities covered.
3. `## How to get to it (user POV)`: exact CLI commands, hooks, or flags the user invokes.
4. `## Driving it with control-cli`: `Preconditions:` line followed by labeled test recipes pairing exact command, fixture input, and observable stdout/stderr/exit-code proof.
5. `## Gotchas`: edge cases, Windows/PowerShell quirks, CLI limitations, or non-obvious failure modes observed in real scripts.

## Features

- [Plugin & Strict Antigravity Validation](./plugin-validation.md): `validate-astack.mjs` structural lints, `--apply-frontmatter-policy` against `catalog.json`, official skill/agent frontmatter schemas, `RESERVED_SKILL_NAMES` collision guard, `native-commands.md` sync check, `--json` telemetry, and `agy plugin validate --strict`.
- [Read-Only Upstream Watch](./upstream-watch.md): `upstream-watch.mjs` read-only inspection of `pstack` and `gstack`, counterpart classification, `--fail-on-updates`, internal `--out` refusal (`exit 2`), and SHA-256 repository invariance.
- [Opt-In Safety & Verification Lifecycle Hooks](./lifecycle-hooks.md): `hooks.json` entrypoints `irreversible-guard.mjs` (`PreToolUse`) and `verify-reminder.mjs` (`Stop`) across allow/block/skip cases.
- [Bundled Workflow & Control Glass CLIs](./workflow-clis.md): `log.mjs`, `check-plan.mjs`, `worktree-audit.mjs`, and `control-cli-template.mjs` real CLI execution, `-h`/`--help`, `--json`, `--dry-run`, exit codes, and preserved proof artifacts.
- [Watch-PR & TLA+ Statechart TypeScript Suites](./watch-pr-and-statechart.md): `watch-pr.mjs`, `statechart.mjs` (`--help`/`-h`, `67` non-TLC tests, `74` Mermaid/Pele `render.test.ts` checks), and `verified-unreachable` boundaries.
- [Setup Onboarding & Banner CLI](./setup-onboarding.md): `setup-banner.mjs` workspace inspection and `setup-astack` Orchestrator inheritance and verification scaffolding contracts.
- [Native Antigravity Command Registry & Behavioral Routing](./native-routing.md): 16-command registry consistency checks plus `R1` to `R12` and negative twin `R1-neg` transcript-graded routing evaluations.
