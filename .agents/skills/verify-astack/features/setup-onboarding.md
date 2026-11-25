# Setup Onboarding & Banner CLI

AStack's `/setup-astack` skill inspects a project workspace via `setup-banner.mjs` and scaffolds verification skills and opt-in hooks while inheriting the user's active Antigravity UI model picker (including **Orchestrator (Carbon)** and **Orchestrator (Argon)**) with zero static model pinning.

## Sub-features

- Read-only workspace inspection & readiness CLI (`skills/setup-astack/scripts/setup-banner.mjs`, supporting `-h`/`--help`, `--cwd <dir>`, `--json`, and `--doctor`; positional path arguments are rejected)
- Detection of existing `.agents/skills/verify-*/`, formal TLA+ verification skills or `*.tla` specs, plugin-root `hooks.json` split counts (`3/10 enabled; passive 3/3, blocking 0/7`), repo policy files (`.agents/risk-policy.json`, `.agents/boundaries.json`, `REVIEW.md`, `GLOSSARY.md`), worktree bloat, Node >= 22.6.0, `trust-ledger` enrollment (`non_repo`, `git_unregistered`, `enrolled_repo`), and optional `astack-models.md` rules at `~/.gemini/config/rules/astack-models.md` and `<workspace>/.agents/rules/astack-models.md`
- Idempotent repo governance scaffolding (`skills/setup-astack/scripts/init-repo-policy.mjs`) creating `.agents/risk-policy.json`, `.agents/boundaries.json`, `REVIEW.md`, `GLOSSARY.md`, and optional `--targets pr-template` without overwriting existing files unless `--force` is passed
- Zero-config **Orchestrator** inheritance invariants enforced in [setup-astack/SKILL.md](../../../../skills/setup-astack/SKILL.md) (no `Reasoning budget & subagent tier preset` prompt)

## How to get to it (user POV)

- Run the banner or doctor check directly: `node skills/setup-astack/scripts/setup-banner.mjs [--cwd <workspace-dir>] [--doctor] [--json]`
- Scaffold repo trust policies idempotently: `node skills/setup-astack/scripts/init-repo-policy.mjs [--cwd <workspace-dir>] [--targets <list>] [--dry-run] [--json]`
- Print CLI usage: `node skills/setup-astack/scripts/setup-banner.mjs --help`
- Inside an Antigravity session, invoke `/setup-astack` at the root of any project repository.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; Node 22+ passed `Doctor`.

- **Help flag contract & regression suite**: Run `node skills/setup-astack/scripts/setup-banner.mjs --help` and `-h` (exit `0`) plus `node --test skills/setup-astack/scripts/setup-banner.test.mjs` (exit `0`).
- **Empty scratch workspace status & doctor**: Create `$ScratchDir/empty-project` and run `node skills/setup-astack/scripts/setup-banner.mjs --cwd "$ScratchDir/empty-project"` and `node skills/setup-astack/scripts/setup-banner.mjs --doctor --cwd "$ScratchDir/empty-project" --json`. Expect exit `0`, ASCII wordmark banner (`▀███▀██`), `verify skills : none`, `formal verify : none`, `safety hooks  : opt-in (3/10 enabled; passive 3/3, blocking 0/7)`, `repo policies : defaults (unconfigured)`, `model routing : native UI / Orchestrator (zero-config)`, and `trust-ledger` reporting `"Non-git workspace (trust ledger inactive)."` in doctor JSON; save outputs to `$EvidenceDir/setup-banner-empty.txt` and `$EvidenceDir/setup-doctor-empty.json`.
- **Live AStack workspace status & doctor check**: Run `node skills/setup-astack/scripts/setup-banner.mjs --cwd .` (text), `node skills/setup-astack/scripts/setup-banner.mjs --cwd . --json`, and `node skills/setup-astack/scripts/setup-banner.mjs --doctor --cwd . --json` from the repo root. Expect exit `0` across all three; text mode prints `verify skills : verify-astack`, while JSON modes print structured JSON with `"verifySkills": ["verify-astack"]`, `"hooks": {"enabled": 3, "total": 10}` (`"hookBreakdown": {"passiveEnabled": 3, "passiveTotal": 3, "blockingEnabled": 0, "blockingTotal": 7}`), `"policies"`, and all 7 doctor `"checks"` (`node-version`, `verify-freshness`, `safety-hooks`, `repo-policies`, `model-routing`, `worktrees`, `trust-ledger`). Save outputs to `$EvidenceDir/setup-banner-live.txt`, `$EvidenceDir/setup-banner-live.json`, and `$EvidenceDir/setup-doctor-live.json`.
- **Idempotent policy scaffolding (`init-repo-policy.mjs`)**: Run `node skills/setup-astack/scripts/init-repo-policy.mjs --cwd "$ScratchDir/empty-project" --dry-run --json` (no files written), then run without `--dry-run` (creates all 4 default governance files), then re-run (skips all 4); save to `$EvidenceDir/init-repo-policy.json`.
- **Positional argument rejection**: Run `node skills/setup-astack/scripts/setup-banner.mjs "$ScratchDir/empty-project"` (no `--cwd`). Expect exit `1` with `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` on stderr.

## Gotchas

- `setup-astack` sets `disable-model-invocation: true` (listed in `manualOnlySkills` in [catalog.json](../../../../scripts/catalog.json)) so it runs only when explicitly invoked as `/setup-astack`.
- Never re-introduce a static model preset prompt (`Reasoning budget & subagent tier preset`); automated tests in `scripts/test/validate.test.mjs` fail if `setup-astack/SKILL.md` drifts from UI/Orchestrator inheritance.
