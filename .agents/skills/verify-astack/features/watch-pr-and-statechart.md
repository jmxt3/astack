# Watch-PR & TLA+ Statechart TypeScript Suites

AStack runs its TypeScript helper CLIs (`watch-pr` and `statechart`) directly on Node 22+ via native type stripping (`watch-pr.mjs` always passes `--experimental-strip-types`; `statechart.mjs` passes it only on Node `22.6`–`22.17` and relies on default stripping from `22.18`) with zero Bun runtime dependency, backed by automated cross-platform CI suites on Linux, Windows, and macOS.

## Sub-features

- GitHub PR stack watcher (`skills/astack-mode/scripts/watch-pr/watch-pr.mjs` wrapping `cli-main.ts`, zero `@types/bun` / `bun-types` dependency)
- TLA+ / TLC statechart converter (`skills/statechart/scripts/statechart.mjs` wrapping `statechart.ts` with `-h`/`--help` exit `0` and unknown option exit `2`)
- TypeScript ESM module test loader in `skills/statechart/scripts/test/pipeline.test.ts` using `node:module` `register()` + `MessageChannel` (compatible with Node `22.6` through `22.18+`)
- Windows `npm.cmd` invocation support in `skills/statechart/scripts/test/render.test.ts` testing 74 Mermaid and Pele 1.9.0 chart rendering cases

## How to get to it (user POV)

- Help and usage:
  - `node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --help`
  - `node skills/statechart/scripts/statechart.mjs --help`
- Automated suites via root `package.json`:
  - `node --run test:watch-pr`
  - `node --run test:statechart`
- Render corpus (no `package.json` script; run directly):
  - `node --experimental-strip-types --disable-warning=ExperimentalWarning --test skills/statechart/scripts/test/render.test.ts`

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; Node `>= 22.6.0` passed `Doctor`.

- **`watch-pr.mjs` help & TypeScript unit suite (`56` tests + formal policy check)**: Run `node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --help`, `node --run test:watch-pr`, and `node --experimental-strip-types --disable-warning=ExperimentalWarning .agents/skills/verify-watch-pr-formal/scripts/verify-policy.ts`. Expect exit `0` on `--help` (`Usage: watch-pr [options]`), all `56` subtests passing (`fail=0`), and `ok: true` with `0` invariant violations from `verify-policy.ts`; save outputs to `$EvidenceDir/watch-pr-proof.txt`. (Report live `--pr <num>` GitHub API polling `verified-unreachable` when offline or unauthenticated.)
- **`statechart.mjs` help, unknown-option exit `2`, and TypeScript test suite (`67` non-TLC tests)**:
  1. Run `node skills/statechart/scripts/statechart.mjs --help` and `-h` (expect exit `0` and `Usage: statechart SPEC.tla ...`).
  2. Run `node skills/statechart/scripts/statechart.mjs --bogus` (expect exit `2` and `Unknown option '--bogus'`).
  3. Run `node --run test:statechart`. Expect exit `0` (`67` passing tests; `live TLC` test skips cleanly unless `TLA2TOOLS` + Java are configured). Save output to `$EvidenceDir/statechart-proof.txt`.
- **Statechart Mermaid/Pele corpus rendering (`render.test.ts`, `74` tests)**: Run `node --experimental-strip-types --disable-warning=ExperimentalWarning --test skills/statechart/scripts/test/render.test.ts` (creates/uses `~/.cache/statechart` Pele/Mermaid jsdom harnesses, invoking `cmd.exe /d /s /c npm.cmd` on Windows). Expect `74` passing tests (`fail=0`, `skipped=0`); save output to `$EvidenceDir/statechart-render-proof.txt`.

## Gotchas

- `pipeline.test.ts` uses async `module.register(...)` with `MessageChannel` / `receiveMessageOnPort` instead of `registerHooks()` (which requires Node `22.15+`) so Node `22.12.0` and CI Node `22.6+` run identically.
- First-time `render.test.ts` execution downloads Pele and Mermaid into `~/.cache/statechart` and can take ~25-40 seconds; report offline npm installs as `verified-unreachable` if network registry access is unavailable.
- Live TLC model checking requires `java` plus `TLA2TOOLS` (or `tla2tools.jar`); without them, `node --run test:statechart` skips 1 live TLC test intentionally (`verified-unreachable` for live JVM TLC proof).
