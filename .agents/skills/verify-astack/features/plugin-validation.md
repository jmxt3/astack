# Plugin & Strict Antigravity Validation

Maintainers and contributors validate the entire AStack plugin repository before committing or packaging by running `scripts/validate-astack.mjs` (or `node --run validate`), ensuring `plugin.json`, every skill, subagent, rule, native command table, markdown relative link, and strict Antigravity schema rule passes with zero errors and zero warnings.

## Sub-features

- Full-repo and custom-root validation (`node scripts/validate-astack.mjs [--no-agy] [--json] [--write-native-commands] [--apply-frontmatter-policy] [-h|--help] [rootDir]`)
- `plugin.json`, `CREDITS.md` relative link scan, and `LICENSE` presence and JSON validity checks
- Skill contract enforcement (`skills/*/SKILL.md` frontmatter allowing only `name`, `description`, boolean `disable-model-invocation`, `license`, and `compatibility`; `33` manual-only vs `28` auto-invocable `manualOnlySkills` partition in `scripts/catalog.json`; body byte size `<= 24000`; `RESERVED_SKILL_NAMES` collision guard across the 16 `EXPECTED_NATIVE_COMMANDS` plus 16 `BUILTIN_RESERVED_SKILL_NAMES` including `swarm_pane`, 26 unique reserved names after overlap)
- Official agent (`agents/*.md`) frontmatter enforcement (`name`, `description`, boolean `mainAgent`/`subagent`/`inheritMcp`/`inheritCustomizations`, `model`, `tools`, `commandExecutionPolicy`, `skills`) and rule (`rules/*.md`) validation, including `comment-sicko.md` setting `inheritCustomizations: false`
- Native command registry (`native-commands.json` / `native-commands.md`) 16-command completeness, `uiSurface.{app,cli,handoff}` and `companionSurfaces` presence, valid engagement modes, resolving companion paths, and zero table drift (`--write-native-commands`)
- Cross-repo markdown relative-link verification, Cursor-leak detection (`CURSOR_LEAK_PATTERNS` including invalid global skill paths and wrong `ask_question` keys), and `principle-*` skill resolution checks
- Live Antigravity CLI strict validation (`agy plugin validate --strict --json <rootDir>`)

## How to get to it (user POV)

Run `node --run validate` (or `node scripts/validate-astack.mjs`) from the workspace root to validate the live plugin tree, add `--json` for machine-readable counts and diagnostics, pass `--write-native-commands` to regenerate `native-commands.md` from `native-commands.json`, or pass `--no-agy <rootDir>` to test an isolated plugin fixture directory offline.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; `node` and `agy` passed `Doctor`.

- **Help flag contract**: Run `node scripts/validate-astack.mjs --help` and `node scripts/validate-astack.mjs -h`. Expect exit code `0`, usage banner on stdout, and zero stderr warnings.
- **Live repository baseline pass & byte-identical native registry**: Run `node scripts/validate-astack.mjs --write-native-commands`, verify `git diff --exit-code skills/astack-mode/references/native-commands.md` exits `0`, and run `node scripts/validate-astack.mjs --json`, redirecting output to `$EvidenceDir/validate-live.json`. Expect exit code `0`, `errors=0`, `warnings=0`, `skills=61`, `agents=2`, `rules=1`, and zero findings from `agy plugin validate --strict --json .`.
- **Negative fixture rejection (reserved native names + invalid frontmatter + broken link + Cursor leak)**: Under `$ScratchDir/broken-plugin`, seed valid `plugin.json` and `LICENSE`, then add `skills/swarm/SKILL.md`, `skills/plan/SKILL.md`, `skills/learn/SKILL.md`, `skills/antigravity_guide/SKILL.md`, a `skills/sample/SKILL.md` with non-boolean `disable-model-invocation: yes`, unsupported key `icon: rocket`, broken link `./missing.md`, unknown `principle-nonexistent`, wrong global path, and `TodoWrite`, plus an agent with `is_background: true`. Run `node scripts/validate-astack.mjs --no-agy --json "$ScratchDir/broken-plugin"`. Expect exit code `1` and JSON diagnostics catching every violation; save JSON output to `$EvidenceDir/broken-fixture.json`.
- **Drifted native registry rejection**: Registry checks run only when `skills/astack-mode` exists in the target root, so the `broken-plugin` fixture above never exercises them. Copy the repo (excluding `.git` and `.tmp`) to `$ScratchDir/drift-repo`, append a bogus row to `skills/astack-mode/references/native-commands.md`, and run `node scripts/validate-astack.mjs --no-agy --json "$ScratchDir/drift-repo"`. Expect exit `1` with a `native-commands.md drifted from native-commands.json` diagnostic; save to `$EvidenceDir/registry-drift.json`.
- **Standalone `--no-agy` structural check on live repo**: Run `node scripts/validate-astack.mjs --no-agy --json` to verify Node-side structural, link, and leak checks independently of `agy`. Expect exit `0` and save stdout to `$EvidenceDir/validate-no-agy.json`.

## Gotchas

- `validate-astack.mjs` treats **any warning as failure**: exit code is `1` whenever `errors.length > 0 || warnings.length > 0`.
- `skills/astack-mode/references/native-commands.md` is generated; editing only the Markdown table without updating `native-commands.json` fails validation until regenerated with `--write-native-commands`.
- Markdown relative links (`[text](relative-path)`) are checked on disk for root `README.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, and every `.md` under `rules/`, `agents/`, `skills/`, and `docs/` (`stats.markdownFilesChecked`); illustrative or non-existent paths there must stay inside backticks. Other trees, including `.agents/skills/` (this verification skill), are not scanned, so broken links there pass validation silently.
- `agy plugin validate --strict` validates against Antigravity's installed CLI rules (`agy --version`), so always verify both `--no-agy` logic and live `agy` execution when `agy` is available.
