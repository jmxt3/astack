# Bundled Workflow CLIs (Decision Log, Plan Lint, Worktree Audit, Watch-PR, Statechart)

AStack bundles five standalone Node 22+ workflow CLIs across its skills so engineers and agents can append structured decision logs, lint plans against writing/format slop, audit git worktrees, watch GitHub PR stacks, and invoke TLA+ statechart checks.

## Sub-features

- TSV decision logger (`skills/show-me-your-work/scripts/log.mjs`) with formula-injection escaping (`'=`, `'+`, `'-`, `'@`)
- Plan structural and prose linter (`skills/astack-mode/scripts/check-plan.mjs`)
- Read-only git worktree table reporter (`skills/astack-mode/scripts/worktree-audit.mjs`)
- TypeScript-via-Node-22 PR stack watcher (`skills/astack-mode/scripts/watch-pr/watch-pr.mjs`)
- TLA+ / TLC statechart runner (`skills/statechart/scripts/statechart.mjs`)

## How to get to it (user POV)

Invoke each script from the repository root with `node`:

- `node skills/show-me-your-work/scripts/log.mjs <logfile> <phase> <decision> <why> <evidence> <result>`
- `node skills/astack-mode/scripts/check-plan.mjs <plan.md>`
- `node skills/astack-mode/scripts/worktree-audit.mjs [-b|--base <ref>] [repo-path]`
- `node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --help` (or `--pr <n> --status-only`)
- `node skills/statechart/scripts/statechart.mjs SPEC.tla [--config FILE] [--view FILE] [--out DIR]`

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; Node 22+ is available on `PATH`. Keep all written logs and synthetic repos inside `$ScratchDir`.

- **`log.mjs` TSV header creation, whitespace flattening, and formula prefix escaping**: Run `node skills/show-me-your-work/scripts/log.mjs "$ScratchDir/test.decision.tsv" "build" "=cmd()" "keep it safe" "exit 0" "pass"` and a second call missing arguments (`< 6` args). Expect exit `0` on the 6-arg call, TSV file with header `ts\tphase\tdecision\twhy\tevidence\tresult` and escaped `'=cmd()`, and exit `1` on invalid arg count; copy the TSV and exit proof to `$EvidenceDir/cli-log-proof.txt`.
- **`check-plan.mjs` pass vs violation detection**: Build `$ScratchDir/good.plan.md` matching the `check-plan.mjs` multi-PR program structure (`# Title`, `< 10` intro lines, `## How to read this` with required markers, `## Program checklist` with the 5 ordered `###` sections and markers, a PR section between `## Program checklist` and `## Close the program` with all 9 `**...**` sub-blocks, `Ten lanes on \`inherit\` at the PR head` with checked/unchecked `Lane 1.`..`Lane 10.` boxes naming screenshots and `Pass when`, `Metric.`/`Probe.`/`Baseline.`/`Rule.` perf boxes, and `## Appendix Prototype evidence`, with no em/en dashes, curly quotes, or mid-sentence `: \S`), and `$ScratchDir/bad.plan.md` containing an em-dash and missing sections. Run `node skills/astack-mode/scripts/check-plan.mjs` on each plus with zero args. Expect exit `0` on `good.plan.md`, exit `1` on `bad.plan.md`, and exit `2` with no argument; save outputs to `$EvidenceDir/cli-check-plan.txt`.
- **`worktree-audit.mjs` help and isolated repo TSV table**: Run `node skills/astack-mode/scripts/worktree-audit.mjs --help` (expect exit `0`), create a scratch git repo at `$ScratchDir/wt-repo` with one commit, and run `node skills/astack-mode/scripts/worktree-audit.mjs "$ScratchDir/wt-repo"`. Expect exit `0`, `# base: ...` line, and TSV columns `SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE`; save to `$EvidenceDir/cli-worktree-audit.txt`.
- **`watch-pr.mjs` Node 22 TypeScript wrapper help**: Run `node skills/astack-mode/scripts/watch-pr/watch-pr.mjs --help`. Expect exit `0` and `Usage: watch-pr [options]` listing `--owner`, `--repo`, `--pr`, `--stack`, `--status-only`, `--pretty`, `-h`, `--help`; save stdout to `$EvidenceDir/cli-watch-pr-help.txt`. (Report live `--pr` network polling `verified-unreachable` if offline or `gh` is unauthenticated.)
- **`statechart.mjs` option usage check and prerequisite gate**: Run `node skills/statechart/scripts/statechart.mjs --help` (no TLA+ model required) and capture stdout/stderr plus `$LASTEXITCODE`. Expect exit `2` with `Unknown option '--help'` and `Usage: statechart SPEC.tla [--config FILE] [--view FILE] [--out DIR]`. Only run live TLC model checks if `java` is installed; otherwise report live TLC runs as `verified-unreachable` citing missing `java`. Save output to `$EvidenceDir/cli-statechart.txt`.

## Gotchas

- `statechart.mjs` does **not** implement `-h` or `--help`; passing `--help` intentionally prints `Unknown option '--help'` plus the usage banner and exits `2`.
- `watch-pr.mjs` and `statechart.mjs` spawn `node --experimental-strip-types` internally on `.ts` targets; Node versions older than 22 fail to execute those wrappers.
- `*.decision.tsv` is gitignored repo-wide, but still write test `.decision.tsv` files into `$ScratchDir` so Cleanup removes them deterministically.
