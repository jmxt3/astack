# Upstream PStack Synchronization

Maintainers synchronize AStack with upstream `pstack` sources through `scripts/sync-upstream.mjs` and `scripts/UPSTREAM.json`, allowing safe `--dry-run` inspection of pending updates while protecting AStack's customized overlay skills and files from accidental overwrite.

## Sub-features

- Upstream source resolution (`--source <dir>` local directory or `--fetch` upstream clone)
- Non-destructive preview mode (`--dry-run` with optional `--json` summary)
- Manifest-driven mapping and overlay protection (`scripts/UPSTREAM.json` `overlayPaths` vs upstream-synced targets), reporting `overlayChanged` paths when an overlay diverges from upstream (`--diff-overlays`)
- Explicit overlay override escape hatch (`--force-overlays`)

## How to get to it (user POV)

Run `node scripts/sync-upstream.mjs --source <upstream-dir> --dry-run --diff-overlays` (or add `--json`) from the repository root to inspect what an upstream sync would add, update, skip, or warn about as drifted overlays before touching tracked files.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; inspect [UPSTREAM.json](../../../scripts/UPSTREAM.json) or run the shipped regression suite in `scripts/test/sync-and-validate.test.mjs` alongside live dry-run checks.

- **Dry-run sync against synthetic upstream source (zero workspace mutation)**: Populate `$ScratchDir/mock-upstream/skills/example-new/SKILL.md` (with `name: example-new` and `description: "test"`) and run `node scripts/sync-upstream.mjs --source "$ScratchDir/mock-upstream" --dry-run --json`. Capture stdout into `$EvidenceDir/sync-dry-run.json`, expect exit code `0`, JSON keys `sourceDir`, `added`, `updated`, `unchanged`, `skippedOverlays`, `overlayChanged`, and `ignored` (listing `skills/example-new/SKILL.md` under `added`), and verify `git status --short` shows no newly synced or modified files in the workspace.
- **Missing `--source` failure handling**: Run `node scripts/sync-upstream.mjs --source "$ScratchDir/does-not-exist" --dry-run` and capture stderr plus `$LASTEXITCODE`. Expect non-zero exit code and explicit error naming the missing upstream directory; save log to `$EvidenceDir/sync-missing-source.txt`.
- **Isolated destination write + overlay-protection proof (programmatic `syncUpstream`)**: Copy `scripts/UPSTREAM.json` into `$ScratchDir/dest-repo/scripts/UPSTREAM.json`, seed an overlay entry from `scripts/UPSTREAM.json` (for example `skills/setup-astack/SKILL.md`) with differing contents in `$ScratchDir/mock-upstream` and `$ScratchDir/dest-repo`, and run `node --input-type=module -e` importing `syncUpstream` from `./scripts/sync-upstream.mjs` with `{ rootDir: "$ScratchDir/dest-repo", sourceDir: "$ScratchDir/mock-upstream", dryRun: false, forceOverlays: false }`. Expect exit code `0`, non-overlay targets written into `$ScratchDir/dest-repo`, overlay targets preserved unchanged unless `forceOverlays: true`, and `overlayChanged` listing the drifted overlay; save JSON result to `$EvidenceDir/sync-isolated-write.json`.

## Gotchas

- Running `scripts/sync-upstream.mjs` directly from the CLI always resolves `rootDir` to `DEFAULT_ROOT_DIR` (the live repo root). **Never** omit `--dry-run` when invoking the CLI directly during verification; test mutating syncs exclusively via exported `syncUpstream({ rootDir: ... })` targeting `$ScratchDir` (plus `node --test scripts/test/*.test.mjs`).
- Windows paths returned inside `--json` reports use OS-native separators or normalized relative paths depending on helper calls; compare normalized paths in assertions.
