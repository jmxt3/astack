# Contributing to AStack

Thank you for contributing to AStack (`jmxt3/astack`). Pull requests, bug reports, verification improvements, and documentation updates are welcome, including AI-assisted PRs backed by real command output.

## Repository layout

- [`plugin.json`](./plugin.json): Antigravity plugin manifest, version, and suggested prompts.
- [`skills/`](./skills): 61 Antigravity skills (`SKILL.md` entrypoints, playbooks, references, and Node 22+ helper scripts).
- [`agents/`](./agents): Custom subagent definitions (`astack-agent` and `comment-sicko`).
- [`rules/`](./rules): Model-decision routing rules (`astack-orchestration.md`).
- [`hooks.json`](./hooks.json) and [`scripts/hooks/`](./scripts/hooks): Opt-in `PreToolUse` and `Stop` lifecycle hooks, shipped with `"enabled": false`.
- [`scripts/`](./scripts): Repository validator ([`validate-astack.mjs`](./scripts/validate-astack.mjs)), upstream `pstack` sync tool ([`sync-upstream.mjs`](./scripts/sync-upstream.mjs)), overlay manifest ([`UPSTREAM.json`](./scripts/UPSTREAM.json)), and unit tests.
- [`docs/`](./docs): User guide, 10-part tutorial, architecture guide, and dormant automation templates.
- [`.agents/skills/verify-astack/`](./.agents/skills/verify-astack/SKILL.md): Project-local runtime verification skill for driving AStack CLIs and hooks against isolated scratch fixtures.

## Antigravity plugin invariants

[`scripts/validate-astack.mjs`](./scripts/validate-astack.mjs) and `agy plugin validate --strict` enforce these rules on every change:

1. **Skill frontmatter**: Every `skills/<name>/SKILL.md` allows only official keys (`name`, `description`, boolean `disable-model-invocation`, `license`, `compatibility`), `name` must match the folder name, and the body must stay at or below 24,000 bytes. Manual-only skills (`33` total: `24` `principle-*` plus `9` explicit slash skills listed in `manualOnlySkills` in [`UPSTREAM.json`](./scripts/UPSTREAM.json)) set `disable-model-invocation: true`; the remaining `28` stay auto-invocable.
2. **Agent frontmatter**: Every `agents/<name>.md` allows only Antigravity agent keys (`name`, `description`, `mainAgent`, `subagent`, `model`, `tools`, `commandExecutionPolicy`, `skills`, `inheritMcp`, `inheritCustomizations`), with `name` matching the filename stem. Plugin subagents declare `mainAgent: false`, `subagent: true`, and `model: inherit`.
3. **Never shadow native commands or built-in skills**: Never add a skill whose folder matches any of the 16 native slash commands or 4 built-in skills (`RESERVED_SKILL_NAMES` in [`sync-upstream.mjs`](./scripts/sync-upstream.mjs)). Keep slice fan-out in [`skills/fanout/`](./skills/fanout/SKILL.md) and update [`native-commands.json`](./skills/astack-mode/references/native-commands.json) + `node scripts/validate-astack.mjs --write-native-commands` if Antigravity's command catalog changes.
4. **Cross-platform Node 22+ scripts**: All bundled CLIs and hooks run with `node` (`>= 22.6` for `--experimental-strip-types`) on Windows, macOS, and Linux with no Bun requirement.
5. **No broken links or Cursor leaks**: Every relative link across markdown files must resolve to an existing file, and markdown content must pass `CURSOR_LEAK_PATTERNS` in [`scripts/validate-astack.mjs`](./scripts/validate-astack.mjs).
6. **Plan-inclusive model guidance**: Do not hardcode paid-tier model IDs in default rules or skills. Keep subagent model selection inheriting the user's active Antigravity plan unless a skill (such as `/arena` or high-volume read sweeps) documents otherwise.

## Upstream `pstack` sync and overlays

AStack tracks Lauren Tan's (`@poteto`) upstream [`pstack`](https://github.com/cursor/plugins/tree/main/pstack) metadata in [`scripts/UPSTREAM.json`](./scripts/UPSTREAM.json). Paths listed under `overlayPaths` are Antigravity-specific customizations protected from overwrite during upstream syncs.

Preview planned changes from a local `pstack` checkout with `--dry-run`, inspect overlay/upstream diffs without mutating the repo using `--diff-dir`, or enforce the `manualOnlySkills` policy:

```bash
node scripts/sync-upstream.mjs --source <path-to-pstack> --dry-run
node scripts/sync-upstream.mjs --source <path-to-pstack> --diff-dir ./tmp-patches
node scripts/sync-upstream.mjs --apply-frontmatter-policy
```

If you add new Antigravity-only root files, assets, or skills, add their paths to `overlayPaths` in [`scripts/UPSTREAM.json`](./scripts/UPSTREAM.json).

## Verify your changes locally

Run the structural validator, strict Antigravity CLI check, and full Node 22+ suites (`test:plugin`, `test:helpers`, `test:watch-pr`, and `test:statechart`) via root [`package.json`](./package.json) before opening a PR:

```bash
node --run validate
node --run test
agy plugin validate --strict --json .
node scripts/validate-astack.mjs --write-native-commands
```

If `agy` is not installed in your shell environment, run `node scripts/validate-astack.mjs --no-agy` for structural, link, and leak checks.

## Pull request guidelines

- Open focused PRs with a short **Why**, **What changed**, and the **exact commands and results** you observed.
- Run `/deslop`, `/no-comments`, and `/unslop` on your diff before requesting review.
- Keep commits and changes scoped to the issue; see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for community expectations.
