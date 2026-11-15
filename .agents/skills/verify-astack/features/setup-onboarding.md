# Setup Onboarding & Banner CLI

AStack's `/setup-astack` skill inspects a project workspace via `setup-banner.mjs` and scaffolds verification skills and opt-in hooks while inheriting the user's active Antigravity UI model picker (including **Orchestrator (Carbon)** and **Orchestrator (Argon)**) with zero static model pinning.

## Sub-features

- Read-only workspace inspection banner CLI (`skills/setup-astack/scripts/setup-banner.mjs`, supporting `-h`/`--help` and target workspace path argument)
- Detection of existing `.agents/skills/verify-*/`, formal TLA+ verification skills, `hooks.json` status, and optional `astack-models.md` rules
- Zero-config **Orchestrator** inheritance invariants enforced in [setup-astack/SKILL.md](../../../skills/setup-astack/SKILL.md) (no `Reasoning budget & subagent tier preset` prompt)

## How to get to it (user POV)

- Run the banner script directly: `node skills/setup-astack/scripts/setup-banner.mjs [--cwd <workspace-dir>] [--json]`
- Print CLI usage: `node skills/setup-astack/scripts/setup-banner.mjs --help`
- Inside an Antigravity session, invoke `/setup-astack` at the root of any project repository.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; Node 22+ passed `Doctor`.

- **Help flag contract**: Run `node skills/setup-astack/scripts/setup-banner.mjs --help` and `-h`. Expect exit code `0`, usage banner on stdout, and zero stderr warnings.
- **Empty scratch workspace status**: Create `$ScratchDir/empty-project` and run `node skills/setup-astack/scripts/setup-banner.mjs --cwd "$ScratchDir/empty-project"`. Expect exit `0`, ASCII banner (`█████╗`), `verify skills : none`, `formal verify : none`, and `model routing : native UI / Orchestrator (zero-config)`; save output to `$EvidenceDir/setup-banner-empty.txt`.
- **Live AStack workspace status**: Run `node skills/setup-astack/scripts/setup-banner.mjs --cwd .` and `--json` from the repo root. Expect exit `0` and `verify skills` reporting `verify-astack`; save output to `$EvidenceDir/setup-banner-live.txt`.

## Gotchas

- `setup-astack` sets `disable-model-invocation: true` (listed in `manualOnlySkills` in [UPSTREAM.json](../../../scripts/UPSTREAM.json)) so it runs only when explicitly invoked as `/setup-astack`.
- Never re-introduce a static model preset prompt (`Reasoning budget & subagent tier preset`); automated tests in `sync-and-validate.test.mjs` fail if `setup-astack/SKILL.md` drifts from UI/Orchestrator inheritance.
