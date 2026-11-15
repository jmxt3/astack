# Read-Only Upstream Watch

Maintainers inspect new commits and file diffs across watched upstream sources (`pstack` and `gstack`) through `scripts/upstream-watch.mjs` and `scripts/upstream-watch.json`, using OS temp caches, mapped AStack counterparts, `--fail-on-updates` CI checks, and strict read-only `--out` containment guarantees so the AStack repository is never modified.

## Sub-features

- CLI help and option handling (`-h`, `--help`, `--source-id pstack|gstack|all`, `--source <git-dir>`, `--fetch`, `--since <ref>`, `--json`, `--out <external-file>`, `--fail-on-updates`)
- Multi-source manifest (`scripts/upstream-watch.json`) separating `code-derived (MIT)` (`pstack` with `skillRenames`, `agentRenames`, `ignoredPaths`) from `inspiration (MIT, no code copied)` (`gstack`)
- Hard read-only containment check (`assertExternalOutPath`) rejecting any `--out` path inside `rootDir` with exit code `2` before any network or file write
- Automated SHA-256 repository byte-identity proof in `scripts/test/upstream-watch.test.mjs`

## How to get to it (user POV)

Run `node scripts/upstream-watch.mjs --source-id pstack --fetch` (or `--source <local-git-dir>`) from the repository root to list commits and mapped counterpart paths since `lastReviewed`, add `--json` for structured output, or add `--out <external-path>` outside the repo.

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; `git` and `node` passed `Doctor`.

- **Help flag contract**: Run `node scripts/upstream-watch.mjs --help` and `node scripts/upstream-watch.mjs -h`. Expect exit code `0`, usage text covering `--source-id`, `--out`, and `--fail-on-updates`, and zero stderr warnings.
- **Internal `--out` write refusal (exit `2`)**: Run `node scripts/upstream-watch.mjs --out ./README.md` and `node scripts/upstream-watch.mjs --out "$ScratchDir/blocked.json"`. Expect exit code `2`, stderr `Refusing --out inside rootDir`, and neither file created or modified.
- **Mock upstream inspection & external report export**: Create a mock git repo at `$ScratchDir/mock-pstack` with baseline commit `C0` and follow-up commits adding a skill and modifying `pstack/skills/poteto-mode/SKILL.md`. Run `node scripts/upstream-watch.mjs --source-id pstack --source "$ScratchDir/mock-pstack" --since <C0> --json --out "$env:TEMP/astack-watch-proof.json"`. Expect exit code `0`, `hasUpdates: true`, `has-counterpart` mapped to `skills/astack-mode/SKILL.md`, and `git status --short` confirming zero repo mutations. Save captured stdout to `$EvidenceDir/upstream-watch-mock.json`.
- **Fail-on-updates & clean SHA-256 suite**: Run `node --test scripts/test/upstream-watch.test.mjs` and confirm `--fail-on-updates` exits `1` when ahead, `0` when `--since HEAD`, and `rootDir` SHA-256 hashes remain byte-identical.

## Gotchas

- Always normalize Windows paths case-insensitively before containment checks (`normalizeForContainment`); relative `--out` targets inside `.tmp/` still sit inside `rootDir` and must exit `2`.
- Passing `--source <git-dir>` together with `--source-id all` exits `2` because one local checkout cannot represent multiple unrelated upstream repos.
- On Windows or restricted runners without GitHub access, `--fetch` failures exit `1` cleanly without touching `rootDir`; report live `--fetch` as `verified-unreachable` if offline and test full behavior against a local scratch git repo.
