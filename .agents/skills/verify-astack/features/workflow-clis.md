# Bundled Workflow & Control Glass CLIs

AStack bundles standalone Node 22+ workflow and verification helper CLIs across its skills so engineers and agents can append formula-safe TSV decision logs, lint multi-phase plans, audit git worktrees, and scaffold isolated daemon/port wrappers via `control-cli-template.mjs`. For `watch-pr.mjs` and `statechart.mjs`, see [Watch-PR & TLA+ Statechart TypeScript Suites](./watch-pr-and-statechart.md).

## Sub-features

- TSV decision logger (`skills/show-me-your-work/scripts/log.mjs`) with formula-injection escaping (`'=`, `'+`, `'-`, `'@`), `-h`/`--help`, and `--dry-run`
- Plan structural and prose linter (`skills/astack-mode/scripts/check-plan.mjs`) checking the `"schedule"` marker, headings, and prose hygiene, supporting `-h`/`--help` and `--json`
- Read-only git worktree table reporter (`skills/astack-mode/scripts/worktree-audit.mjs`) with `-h`/`--help` and `--json`
- Zero-dependency Control Glass wrapper starter (`skills/create-verification-skill/references/control-cli-template.mjs`) implementing `doctor`, `launch`, `snapshot`, `cleanup`, `findFreePort()` via `net.createServer()`, `-h`/`--help`, `--json`, and `--dry-run`

## How to get to it (user POV)

Invoke each script from the repository root with `node`:

- `node skills/show-me-your-work/scripts/log.mjs [--dry-run] <logfile> <phase> <decision> <why> <evidence> <result>`
- `node skills/astack-mode/scripts/check-plan.mjs [--json] <plan.md>`
- `node skills/astack-mode/scripts/worktree-audit.mjs [--json] [-b|--base <ref>] [repo-path]`
- `node skills/create-verification-skill/references/control-cli-template.mjs <doctor|launch|snapshot|cleanup> [--json] [--dry-run] [--state-dir <dir>]`

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; Node 22+ is available on `PATH`. Keep all written logs, scratch state, and synthetic repos inside `$ScratchDir`.

- **Zero module warnings and `--help` / `-h` smoke check**: Run `--help` and `-h` across `log.mjs`, `check-plan.mjs`, `worktree-audit.mjs`, and `control-cli-template.mjs` (plus `validate-astack.mjs`, `sync-upstream.mjs`, `setup-banner.mjs`, `watch-pr.mjs`, and `statechart.mjs`). Expect exit `0`, usage output on stdout, and zero `MODULE_TYPELESS_PACKAGE_JSON` warnings on stderr; save summary to `$EvidenceDir/cli-help-smoke.txt`.
- **`log.mjs` dry-run + TSV write and formula escaping**: Run `node skills/show-me-your-work/scripts/log.mjs --dry-run "$ScratchDir/dry.decision.tsv" "build" "skip write" "dry run" "none" "pass"` and verify `$ScratchDir/dry.decision.tsv` was **not** created. Then run the 6-arg write call with `"=cmd()"` and inspect `header ts\tphase\tdecision\twhy\tevidence\tresult` and escaped `'=cmd()`, plus invalid arg count (`< 6` args) exiting `1`; save proof to `$EvidenceDir/cli-log-proof.txt`.
- **`check-plan.mjs` JSON diagnostics + `multi-phase-plan.md` skeleton regression**: Extract the skeleton from `skills/astack-mode/playbooks/multi-phase-plan.md` into `$ScratchDir/skeleton.plan.md` and run `node skills/astack-mode/scripts/check-plan.mjs --json "$ScratchDir/skeleton.plan.md"`, a bad plan (with em dash or missing `schedule` check) expecting exit `1`, and zero args expecting exit `2`; save to `$EvidenceDir/cli-check-plan.txt`.
- **`worktree-audit.mjs` TSV and `--json` table on isolated git repo**: Create a scratch git repo at `$ScratchDir/wt-repo` with one commit, and run both `node skills/astack-mode/scripts/worktree-audit.mjs "$ScratchDir/wt-repo"` and `node skills/astack-mode/scripts/worktree-audit.mjs --json "$ScratchDir/wt-repo"`. Expect exit `0`, valid JSON containing `base`, `warned`, and `rows`, and clean TSV columns; save to `$EvidenceDir/cli-worktree-audit.txt`.
- **`control-cli-template.mjs` full lifecycle (`doctor` -> `launch` -> `snapshot` -> `cleanup`)**: Run `node skills/create-verification-skill/references/control-cli-template.mjs doctor --json --dry-run` expecting exit `0` and valid JSON `{ ok: true, portAvailable: <port> }`. Then run `launch`, `snapshot`, and `cleanup` pointing `--state-dir "$ScratchDir/tpl-state"` and `--evidence-dir "$EvidenceDir/tpl-evidence"`; verify exit `0` at every step, scratch state directory removed after cleanup, and `$EvidenceDir/tpl-evidence/snapshot.json` preserved intact.

## Gotchas

- `control-cli-template.mjs launch` binds an ephemeral free port with `net.createServer()` on `127.0.0.1` unless `--port` is supplied, and `cleanup` terminates only the child PID saved in `<state-dir>/scratch/state.json` (`taskkill /PID <pid> /T /F` on Windows, process group `SIGTERM` on POSIX).
- `*.decision.tsv` is gitignored repo-wide, but still write test `.decision.tsv` files into `$ScratchDir` so Cleanup removes them deterministically.
- Run `node --run test:helpers` to execute the bundled automated unit suite covering `check-plan`, `worktree-audit`, `log`, and `setup-banner` together.
