# Setup Onboarding & Banner CLI

AStack's `/setup-astack` skill inspects a project workspace via `setup-banner.mjs` and scaffolds verification skills and opt-in hooks while inheriting the user's active Antigravity UI model picker (including **Orchestrator (Carbon)** and **Orchestrator (Argon)**) with zero static model pinning.

## Sub-features

- Read-only workspace inspection banner CLI (`skills/setup-astack/scripts/setup-banner.mjs`, supporting `-h`/`--help`, `--cwd <dir>`, and `--json`; positional path arguments are rejected)
- Detection of existing `.agents/skills/verify-*/`, formal TLA+ verification skills or `*.tla` specs, plugin-root `hooks.json` status, and optional `astack-models.md` rules at `~/.gemini/config/rules/astack-models.md` and `<workspace>/.agents/rules/astack-models.md`
- Zero-config **Orchestrator** inheritance invariants enforced in [setup-astack/SKILL.md](../../../../skills/setup-astack/SKILL.md) (no `Reasoning budget & subagent tier preset` prompt)

## How to get to it (user POV)

- Run the banner script directly: `node skills/setup-astack/scripts/setup-banner.mjs [--cwd <workspace-dir>] [--json]`
- Print CLI usage: `node skills/setup-astack/scripts/setup-banner.mjs --help`
- Inside an Antigravity session, invoke `/setup-astack` at the root of any project repository.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; Node 22+ passed `Doctor`.

- **Help flag contract**: Run `node skills/setup-astack/scripts/setup-banner.mjs --help` and `-h`. Expect exit code `0`, usage banner on stdout, and zero stderr warnings.
- **Empty scratch workspace status**: Create `$ScratchDir/empty-project` and run `node skills/setup-astack/scripts/setup-banner.mjs --cwd "$ScratchDir/empty-project"`. Expect exit `0`, ASCII banner (`█████╗`), `verify skills : none`, `formal verify : none`, `safety hooks  : opt-in (0/2 enabled)`, and `model routing : native UI / Orchestrator (zero-config)`; save output to `$EvidenceDir/setup-banner-empty.txt`.
- **Live AStack workspace status**: Run `node skills/setup-astack/scripts/setup-banner.mjs --cwd .` (text) and `node skills/setup-astack/scripts/setup-banner.mjs --cwd . --json` from the repo root. Expect exit `0` for both; text mode prints `verify skills : verify-astack`, while JSON mode prints only structured JSON with `"verifySkills": ["verify-astack"]` and `"hooks": {"enabled": 0, "total": 2}` (no banner). Save outputs to `$EvidenceDir/setup-banner-live.txt` and `$EvidenceDir/setup-banner-live.json`.
- **Positional argument rejection**: Run `node skills/setup-astack/scripts/setup-banner.mjs "$ScratchDir/empty-project"` (no `--cwd`). Expect exit `1` with `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` on stderr.

## Gotchas

- `setup-astack` sets `disable-model-invocation: true` (listed in `manualOnlySkills` in [UPSTREAM.json](../../../../scripts/UPSTREAM.json)) so it runs only when explicitly invoked as `/setup-astack`.
- Never re-introduce a static model preset prompt (`Reasoning budget & subagent tier preset`); automated tests in `sync-and-validate.test.mjs` fail if `setup-astack/SKILL.md` drifts from UI/Orchestrator inheritance.
