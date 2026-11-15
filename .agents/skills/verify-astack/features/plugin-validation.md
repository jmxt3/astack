# Plugin & Strict Antigravity Validation

Maintainers and contributors validate the entire AStack plugin repository before committing or packaging by running `scripts/validate-astack.mjs`, ensuring `plugin.json`, every skill, subagent, rule, markdown relative link, and strict Antigravity schema rule passes with zero errors and zero warnings.

## Sub-features

- Full-repo and custom-root validation (`node scripts/validate-astack.mjs [--no-agy] [--json] [rootDir]`)
- `plugin.json` and `LICENSE` presence and JSON validity checks
- Skill contract enforcement (`skills/*/SKILL.md` frontmatter restricted to `name` and `description`, body byte size `<= 24000`, and forbidden `skills/swarm` path guard)
- Agent (`agents/*.md`) and rule (`rules/*.md`) validation
- Cross-repo markdown relative-link verification, Cursor-leak detection (`CURSOR_LEAK_PATTERNS` including invalid global skill paths and wrong `ask_question` keys), and `principle-*` skill resolution checks
- Live Antigravity CLI strict validation (`agy plugin validate --strict --json <rootDir>`)

## How to get to it (user POV)

Run `node scripts/validate-astack.mjs` from the workspace root to validate the live plugin tree, add `--json` for machine-readable counts and diagnostics, or pass `--no-agy <rootDir>` to test an isolated plugin fixture directory offline.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; `node` and `agy` passed `Doctor`.

- **Live repository baseline pass**: Run `node scripts/validate-astack.mjs` and `node scripts/validate-astack.mjs --json`, redirecting output to `$EvidenceDir/validate-live.txt` and `$EvidenceDir/validate-live.json`. Expect exit code `0`, `errors=0`, `warnings=0`, and summary line `[validate-astack] skills=... agents=... rules=... md=... errors=0 warnings=0`.
- **Negative fixture rejection (broken link + forbidden `skills/swarm` + extra frontmatter + unknown principle + wrong global path/schema)**: Create a minimal plugin directory under `$ScratchDir/broken-plugin` with a valid root `plugin.json` (`"name": "astack"`, `"author": { "name": "João Machete" }`) and `LICENSE` crediting `"Lauren Tan"` and `"João Machete"`, plus a forbidden `skills/swarm/SKILL.md` and a `skills/sample/SKILL.md` containing an extra frontmatter key, a broken relative link `./missing.md`, an unknown `principle-nonexistent` reference, a wrong global skills path, and Cursor's multi-select flag name. Run `node scripts/validate-astack.mjs --no-agy --json "$ScratchDir/broken-plugin"`. Expect non-zero exit code `1` and JSON diagnostics explicitly flagging the `skills/swarm` restriction, extra frontmatter field, missing relative link, unknown principle skill reference, and Cursor leak patterns; save JSON output to `$EvidenceDir/broken-fixture.json`.
- **Standalone `--no-agy` structural check on live repo**: Run `node scripts/validate-astack.mjs --no-agy --json` to verify Node-side structural, link, and leak checks independently of `agy`. Expect exit `0` and save stdout to `$EvidenceDir/validate-no-agy.json`.

## Gotchas

- `validate-astack.mjs` treats **any warning as failure**: exit code is `1` whenever `errors.length > 0 || warnings.length > 0`.
- Markdown relative links (`[text](relative-path)`) across **all** `.md` files in the repo are checked on disk; illustrative or non-existent paths in docs or skills must stay inside backticks rather than markdown link syntax.
- `agy plugin validate --strict` validates against Antigravity's installed CLI rules (`agy --version`), so always verify both `--no-agy` logic and live `agy` execution when `agy` is available.
