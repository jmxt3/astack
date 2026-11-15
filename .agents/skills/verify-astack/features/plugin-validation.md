# Plugin & Strict Antigravity Validation

Maintainers and contributors validate the entire AStack plugin repository before committing or packaging by running `scripts/validate-astack.mjs` (or `node --run validate`), ensuring `plugin.json`, every skill, subagent, rule, native command table, markdown relative link, and strict Antigravity schema rule passes with zero errors and zero warnings.

## Sub-features

- Full-repo and custom-root validation (`node scripts/validate-astack.mjs [--no-agy] [--json] [--write-native-commands] [-h|--help] [rootDir]`)
- `plugin.json` and `LICENSE` presence and JSON validity checks
- Skill contract enforcement (`skills/*/SKILL.md` frontmatter allowing only `name`, `description`, boolean `disable-model-invocation`, `license`, and `compatibility`; `33` manual-only vs `28` auto-invocable `manualOnlySkills` partition; body byte size `<= 24000`; `RESERVED_SKILL_NAMES` collision guard across all 16 native slash commands and 4 built-in skills)
- Official agent (`agents/*.md`) frontmatter enforcement (`name`, `description`, boolean `mainAgent`/`subagent`/`inheritMcp`/`inheritCustomizations`, `model`, `tools`, `commandExecutionPolicy`, `skills`) and rule (`rules/*.md`) validation
- Native command registry (`native-commands.json` / `native-commands.md`) 16-command completeness, valid engagement modes, resolving companion paths, and zero table drift (`--write-native-commands`)
- Cross-repo markdown relative-link verification, Cursor-leak detection (`CURSOR_LEAK_PATTERNS` including invalid global skill paths and wrong `ask_question` keys), and `principle-*` skill resolution checks
- Live Antigravity CLI strict validation (`agy plugin validate --strict --json <rootDir>`)

## How to get to it (user POV)

Run `node --run validate` (or `node scripts/validate-astack.mjs`) from the workspace root to validate the live plugin tree, add `--json` for machine-readable counts and diagnostics, pass `--write-native-commands` to regenerate `native-commands.md` from `native-commands.json`, or pass `--no-agy <rootDir>` to test an isolated plugin fixture directory offline.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; `node` and `agy` passed `Doctor`.

- **Help flag contract**: Run `node scripts/validate-astack.mjs --help` and `node scripts/validate-astack.mjs -h`. Expect exit code `0`, usage banner on stdout, and zero stderr warnings.
- **Live repository baseline pass & byte-identical native registry**: Run `node scripts/validate-astack.mjs --write-native-commands`, verify `git diff --exit-code skills/astack-mode/references/native-commands.md` exits `0`, and run `node scripts/validate-astack.mjs --json`, redirecting output to `$EvidenceDir/validate-live.json`. Expect exit code `0`, `errors=0`, `warnings=0`, `skills=61`, `agents=2`, `rules=1`, and zero findings from `agy plugin validate --strict --json .`.
- **Negative fixture rejection (reserved native names + invalid frontmatter + drifted registry + broken link + Cursor leak)**: Under `$ScratchDir/broken-plugin`, seed valid `plugin.json` and `LICENSE`, then add `skills/swarm/SKILL.md`, `skills/plan/SKILL.md`, `skills/learn/SKILL.md`, `skills/antigravity_guide/SKILL.md`, a `skills/sample/SKILL.md` with non-boolean `disable-model-invocation: yes`, unsupported key `icon: rocket`, broken link `./missing.md`, unknown `principle-nonexistent`, wrong global path, and `TodoWrite`, plus an agent with `is_background: true`. Run `node scripts/validate-astack.mjs --no-agy --json "$ScratchDir/broken-plugin"`. Expect exit code `1` and JSON diagnostics catching every violation; save JSON output to `$EvidenceDir/broken-fixture.json`.
- **Standalone `--no-agy` structural check on live repo**: Run `node scripts/validate-astack.mjs --no-agy --json` to verify Node-side structural, link, and leak checks independently of `agy`. Expect exit `0` and save stdout to `$EvidenceDir/validate-no-agy.json`.

## Gotchas

- `validate-astack.mjs` treats **any warning as failure**: exit code is `1` whenever `errors.length > 0 || warnings.length > 0`.
- `skills/astack-mode/references/native-commands.md` is generated; editing only the Markdown table without updating `native-commands.json` fails validation until regenerated with `--write-native-commands`.
- Markdown relative links (`[text](relative-path)`) across **all** `.md` files in the repo are checked on disk; illustrative or non-existent paths in docs or skills must stay inside backticks rather than markdown link syntax.
- `agy plugin validate --strict` validates against Antigravity's installed CLI rules (`agy --version`), so always verify both `--no-agy` logic and live `agy` execution when `agy` is available.
