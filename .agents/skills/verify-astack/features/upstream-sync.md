# Upstream PStack Synchronization

Maintainers synchronize AStack with upstream `pstack` sources through `scripts/sync-upstream.mjs` and `scripts/UPSTREAM.json`, allowing safe `--dry-run` previews, non-mutating `--diff-dir` unified patch export, `--apply-frontmatter-policy` enforcement (`33` manual-only `disable-model-invocation: true` skills), and reserved native collision checks while protecting AStack overlays from accidental overwrite.

## Sub-features

- CLI help and option handling (`-h`, `--help`, `--source <dir>`, `--fetch`, `--dry-run`, `--diff-dir <dir>`, `--force-overlays`, `--apply-frontmatter-policy`, `--json`; `--diff-overlays` is also parsed but not listed in `--help` output)
- Preservation of Antigravity `disable-model-invocation` frontmatter key during upstream markdown transformation (`transformPortedMarkdown`)
- Manifest-driven mapping (`skillRenames`, `agentRenames`, `ignoredUpstreamPaths`, `overlayPaths`, `manualOnlySkills`) in `scripts/UPSTREAM.json`
- Native command collision guard rejecting upstream skill targets matching `RESERVED_SKILL_NAMES`
- Non-mutating unified `.patch` export via `--diff-dir <dir>` using `git diff --no-index`
- Automated frontmatter policy synchronization (`--apply-frontmatter-policy`) aligning every skill against `manualOnlySkills`

## How to get to it (user POV)

Run `node scripts/sync-upstream.mjs --source <upstream-dir> --dry-run --diff-overlays` (or add `--json`) from the repository root to preview sync actions, pass `--diff-dir ./tmp-patches` to emit `.patch` files for changed targets without modifying any repo files, or run `node scripts/sync-upstream.mjs --apply-frontmatter-policy` after updating `manualOnlySkills`.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; `git` and `node` passed `Doctor`.

- **Help flag contract**: Run `node scripts/sync-upstream.mjs --help` and `node scripts/sync-upstream.mjs -h`. Expect exit code `0`, usage text covering `--diff-dir` and `--apply-frontmatter-policy`, and zero stderr warnings.
- **Dry-run sync + `--diff-dir` non-mutating patch export against synthetic upstream source**: Populate `$ScratchDir/mock-upstream/skills/tdd/SKILL.md` (`name: tdd`, updated body) and `$ScratchDir/mock-upstream/skills/example-new/SKILL.md`, then run `node scripts/sync-upstream.mjs --source "$ScratchDir/mock-upstream" --diff-dir "$ScratchDir/patches" --json`. Capture stdout into `$EvidenceDir/sync-diff-dir.json`, expect exit code `0`, JSON `"patches": ["skills/tdd/SKILL.md.patch"]`, the patch written at `$ScratchDir/patches/skills/tdd/SKILL.md.patch` (the `skills/` prefix is preserved), and `git status --short` confirming zero mutations in the workspace.
- **Reserved Antigravity collision rejection**: Add `$ScratchDir/mock-upstream/skills/plan/SKILL.md` (`name: plan`) and run `node scripts/sync-upstream.mjs --source "$ScratchDir/mock-upstream" --dry-run`. Expect non-zero exit code with error naming reserved Antigravity skill `skills/plan`; save stderr to `$EvidenceDir/sync-reserved-collision.txt`.
- **Missing `--source` failure handling**: Run `node scripts/sync-upstream.mjs --source "$ScratchDir/does-not-exist" --dry-run` and capture stderr plus `$LASTEXITCODE`. Expect non-zero exit code and explicit error naming the missing upstream directory; save log to `$EvidenceDir/sync-missing-source.txt`.
- **Isolated destination write + overlay-protection + `--apply-frontmatter-policy` proof**: Run `node --test scripts/test/sync-and-validate.test.mjs` and inspect test output confirming `syncUpstream` protects overlays, preserves `disable-model-invocation: true`, writes `--diff-dir` patches untouched, and matches the `33/28` live partition.

## Gotchas

- Running `scripts/sync-upstream.mjs` directly from the CLI resolves `rootDir` to `DEFAULT_ROOT_DIR`. **Never** omit `--dry-run` or `--diff-dir` when testing sync inputs from the CLI against the live repo; test mutating syncs exclusively via exported `syncUpstream({ rootDir: ... })` inside `$ScratchDir`.
- `--diff-dir` shells out to `git diff --no-index` (which returns exit code `1` whenever files differ); `sync-upstream.mjs` treats exit code `1` as a valid patch and raises only on exit status `> 1`.
- Fatal input errors (reserved-name collision, missing `--source`) surface as uncaught `Error` throws: exit code `1` with a Node stack trace on stderr. Match on the `Error: ...` line, not on clean single-line output.
