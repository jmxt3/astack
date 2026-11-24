---
name: verify-astack
description: "Project verification skill for the AStack repository (astack): drives plugin validation, read-only upstream watch, lifecycle hooks, and bundled Node 22+ workflow CLIs against isolated fixtures and captures stdio/exit-code proof. Use when verifying changes in the astack repo."
---

# Verify AStack

Drives the AStack plugin repository's real Node 22+ CLI entrypoints, Antigravity manifest validator, read-only upstream watch tooling, lifecycle hooks, and workflow helper scripts under isolated scratch and evidence directories so changes are proved against live execution before landing.

## Launch

This repository has no persistent server daemon; every entrypoint is a short-lived Node 22+ CLI or hook script invoked with `node` from the repository root. Isolate every verification run under gitignored `.tmp/` directories using distinct scratch and evidence paths:

```pwsh
$RunId = "run-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$ScratchDir = ".tmp/verify-astack-scratch/$RunId"
$EvidenceDir = ".tmp/verify-astack-evidence/$RunId"
New-Item -ItemType Directory -Force -Path $ScratchDir, $EvidenceDir | Out-Null
```

Never place evidence inside `$ScratchDir`; cleanup deletes `$ScratchDir` while preserving `$EvidenceDir` for inspection and reporting.

## Doctor

Check the runtime prerequisites, Antigravity CLI availability, workspace cleanliness, and baseline repo validity before driving feature paths:

```pwsh
node -v | Out-File -FilePath "$EvidenceDir/doctor-env.txt" -Encoding utf8
git --version | Out-File -FilePath "$EvidenceDir/doctor-env.txt" -Append -Encoding utf8
agy --version | Out-File -FilePath "$EvidenceDir/doctor-env.txt" -Append -Encoding utf8
git status --short | Out-File -FilePath "$EvidenceDir/doctor-git-status.txt" -Encoding utf8
node scripts/validate-astack.mjs --json | Out-File -FilePath "$EvidenceDir/doctor-validate.json" -Encoding utf8
```

- `node -v` must be Node 22+ (required by `--experimental-strip-types` wrappers such as `watch-pr.mjs` and `statechart.mjs`).
- `agy --version` must succeed for full `--strict` Antigravity plugin checks; if `agy` is missing on a host, mark strict `agy` assertions `verified-unreachable` and use `--no-agy` only for structural/link checks.
- Optional Java (`java -version`): required only when driving live TLC model checking via `statechart.mjs`; if `java` is missing, report TLC execution checks as `verified-unreachable`.
- Baseline `node scripts/validate-astack.mjs --json` exits `0` with `errors=0` and `warnings=0`.
- Run `node .agents/skills/sync-astack-surfaces/scripts/audit-surfaces.mjs --json` before shipping changes that touch skills, native commands, playbooks, agents, hooks, timeline UI, or docs (see [Sync AStack Surfaces](../sync-astack-surfaces/SKILL.md)).

## Drive

Read the feature map first: [features/README.md](./features/README.md).

Drive only the feature files affected by your change (or walk all seven for a full repository check):

1. [Plugin & Strict Antigravity Validation](./features/plugin-validation.md): valid repo pass, `--json` telemetry, `--write-native-commands`, `--apply-frontmatter-policy`, official frontmatter schema, `36/29` manual-only split, `maxAutoInvokeSkills` / `maxAutoInvokeDescriptionBytes` context-budget guard, `comment-sicko` `inheritCustomizations: false`, command-surface sync, and negative fixture rejection.
2. [Read-Only Upstream Watch](./features/upstream-watch.md): `upstream-watch.mjs --source-id pstack|gstack|security-audit-skill|all`, external `--out`, `--out` inside-repo refusal (`exit 2`), `--fail-on-updates`, and SHA-256 byte-identity proof.
3. [Opt-In Safety & Verification Lifecycle Hooks](./features/lifecycle-hooks.md): stdin/stdout JSON contract checks across split hooks (`receipt-ledger.mjs`, `session-context.mjs`, `irreversible-guard.mjs`, `secret-guard.mjs`, `verify-reminder.mjs`, `evidence-gate.mjs`, `boundary-guard.mjs`, `round-limiter.mjs`).
4. [Bundled Workflow & Control Glass CLIs](./features/workflow-clis.md): `log.mjs`, `check-plan.mjs`, `worktree-audit.mjs`, `pr-dossier.mjs`, `arch-audit.mjs`, `init-repo-policy.mjs`, `run-eval.mjs` (plus `--replay --json`), `validate-findings.cjs`, `validate-coverage-ledger.cjs`, `control-cli-template.mjs`, and `sidecars/astack_timeline/main.mjs` real stdio, `--help`/`-h`, `--json`, `--dry-run`, exit codes, and preserved evidence in `$ScratchDir`.
5. [Watch-PR & TLA+ Statechart TypeScript Suites](./features/watch-pr-and-statechart.md): `watch-pr.mjs` (`56` TS tests plus `verify-watch-pr-formal`), `statechart.mjs` (`--help`/`-h` exit `0`, `67` non-TLC tests, `74` `render.test.ts` checks), and offline/Java `verified-unreachable` reporting.
6. [Setup Onboarding & Banner CLI](./features/setup-onboarding.md): `setup-banner.mjs` `--help`/`-h`, `--doctor --json`, and live vs empty-repo detection plus `setup-astack` UI-inheritance invariants.
7. [Native Antigravity Command Registry & Behavioral Routing](./features/native-routing.md): `native-commands.json` / `native-commands.md` sync checks plus transcript-graded prompts `R1` to `R12` and negative twin `R1-neg`.

## Evidence

Record exact exit codes, captured stdout/stderr logs, and generated artifact contents into `$EvidenceDir` as each command finishes:

```pwsh
# Pattern for capturing stdout+stderr and exit code into $EvidenceDir
$out = & node scripts/validate-astack.mjs 2>&1
$code = $LASTEXITCODE
"EXIT=$code`n$($out -join "`n")" | Out-File -FilePath "$EvidenceDir/validate-live.txt" -Encoding utf8
```

Always copy or write proof artifacts (JSON outputs, TSV decision logs, hook responses, and exit-code summaries) directly into `$EvidenceDir`. Verify every evidence file exists and is non-empty after Cleanup completes.

## Cleanup

Delete only `$ScratchDir` after all runs finish, leaving `$EvidenceDir` intact on disk, and verify no untracked scratch leftovers leaked outside `.tmp/`:

```pwsh
Remove-Item -Recurse -Force $ScratchDir -ErrorAction SilentlyContinue
if (Test-Path $ScratchDir) { throw "Scratch dir still exists: $ScratchDir" }
Get-ChildItem $EvidenceDir | Select-Object Name, Length
```

If any test modified a tracked repository file (never do so unless strictly necessary), restore it immediately with `git checkout -- <path>` and re-run `node scripts/validate-astack.mjs`.

## Helpers

Existing repository verification scripts defined in [`package.json`](../../../package.json) that complement runtime driving:

- Full automated suite (`validate` + `test:plugin` + `test:sidecar` + `test:trust` + `test:helpers` + `test:watch-pr` + `test:statechart` + `test:security-audit` + `test:eval`): `node --run test`
- Sidecar timeline engine & HTTP server suite (`sidecars/astack_timeline/`): `node --run test:sidecar`
- Trust core, PR dossier & architecture audit checks: `node --run test:trust` and `node skills/audit-architecture/scripts/arch-audit.mjs --cwd . --strict --json`
- Incident-replay reviewer contract eval: `node scripts/eval/run-eval.mjs --replay --json`
- Baseline repo validator: `node --run validate` (or `node scripts/validate-astack.mjs --write-native-commands` to regenerate `native-commands.md`)
- Strict Antigravity CLI check: `agy plugin validate --strict --json .`
- Plugin & hook suite: `node --run test:plugin`
- Helper CLI suite (`check-plan`, `worktree-audit`, `log`, `setup-banner`): `node --run test:helpers`
- Security-audit & routing eval suites: `node --run test:security-audit` and `node --run test:eval`
- TypeScript `watch-pr` (`56` tests) & `statechart` (`67` non-TLC tests): `node --run test:watch-pr` and `node --run test:statechart`
- Statechart Mermaid/Pele corpus (`74` tests, Windows-safe `npm.cmd`): `node --experimental-strip-types --disable-warning=ExperimentalWarning --test skills/statechart/scripts/test/render.test.ts`
