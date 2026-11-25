# Bundled Workflow & Control Glass CLIs

AStack bundles standalone Node 22+ (`>=22.6.0`) workflow, trust, CLI statusline/title, MCP, and verification helper CLIs alongside its sidecar entrypoint. For `watch-pr.mjs`, `statechart.mjs`, and the zero-Java formal verifiers, see [Watch-PR & TLA+ Statechart TypeScript Suites](./watch-pr-and-statechart.md).

## Sub-features

- TSV decision logger (`skills/show-me-your-work/scripts/log.mjs`) with formula-injection escaping (`'=`, `'+`, `'-`, `'@`), `-h`/`--help`, and `--dry-run`
- Plan structural and prose linter (`skills/astack-mode/scripts/check-plan.mjs`) checking the `"schedule"` marker, headings, and prose hygiene, supporting `-h`/`--help` and `--json`
- Read-only git worktree table reporter (`skills/astack-mode/scripts/worktree-audit.mjs`) with `-h`/`--help` and `--json`
- PR dossier & proof-block compiler (`skills/review-pr/scripts/pr-dossier.mjs`) computing Risk Tiers `0`..`3`, Guided Reading clusters, verifier receipts (`--record-verifier`), and GitHub PR statechart/proof tables (`--format github`, `--check-pr-body`)
- Architecture boundary & workaround-comment auditor (`skills/audit-architecture/scripts/arch-audit.mjs`) checking `.agents/boundaries.json` import zones, banned patterns, and shallow modules (`--cwd`, `--strict`, `--json`, `-h`/`--help`)
- Repo trust policy scaffolder (`skills/setup-astack/scripts/init-repo-policy.mjs`) idempotently generating `.agents/risk-policy.json`, `.agents/boundaries.json`, `REVIEW.md`, `GLOSSARY.md`, and optional `pr-template` (`--cwd`, `--targets`, `--force`, `--dry-run`, `--json`, `-h`/`--help`)
- Out-of-band human Earned Trust CLI (`scripts/trust/cli.mjs`) supporting `status`, `beast <on|off>`, `promotion <manual|auto>`, `ceiling <cat> <1|2|3>`, `promote <cat>`, `undo`, and `record-outcome` (`--cwd`, `--data-dir`, `--base`, `--sha`, `--risk`, `--pr`, `--note`, `--json`, `-h`/`--help`)
- Antigravity CLI statusline & terminal title formatters (`scripts/cli/statusline.mjs`, `scripts/cli/title.mjs`) reading stdin session JSON to render width-adaptive ANSI pipeline/trust state or plain terminal titles (`-h`/`--help`)
- Stdio JSON-RPC `astack_trust` MCP server (`scripts/mcp/server.mjs`, backed by `scripts/mcp/tools.mjs`) exposing 9 tools (`compile_pr_dossier`, `audit_architecture`, `doctor_workspace`, `get_trust_status`, `record_proof_manifest`, `declare_intent`, `open_tla_viewer`, plus app-only `get_dossier_detail` and `scaffold_repo_policies`) and 3 `ui://astack/*.html` resources (`--data-dir`, `-h`/`--help`)
- AStack Timeline sidecar server (`sidecars/astack_timeline/main.mjs`) running via `sidecar_sdk` or standalone HTTP (`--standalone`, `--port`, `--workspace`, `--brain-dir`, `--conversation`, `--allow-fixture-ids`, `-h`/`--help`)
- Routing, contract, and risk-backtest eval runner (`scripts/eval/run-eval.mjs`) checking `classifyRoutingIntent`, `checkPlan` contracts, `risk-backtest` (`risk:*` cases + `riskMetrics`), plus `--replay [--live] [--stream]` (`-h`/`--help`, `--json`)
- Security-audit schema validators (`skills/security-audit/scripts/validate-findings.cjs`, `skills/security-audit/scripts/validate-coverage-ledger.cjs`) with `-h`/`--help` and zero-dependency JSON schema/ledger checks
- Zero-dependency Control Glass wrapper starter (`skills/create-verification-skill/references/control-cli-template.mjs`) implementing `doctor`, `launch`, `snapshot`, `cleanup`, `findFreePort()` via `net.createServer()`, `-h`/`--help`, `--json`, and `--dry-run`

## How to get to it (user POV)

Invoke each script from the repository root with `node`:

- `node skills/show-me-your-work/scripts/log.mjs [--dry-run] <logfile> <phase> <decision> <why> <evidence> <result>`
- `node skills/astack-mode/scripts/check-plan.mjs [--json] <plan.md>`
- `node skills/astack-mode/scripts/worktree-audit.mjs [--json] [-b|--base <ref>] [repo-path]`
- `node skills/review-pr/scripts/pr-dossier.mjs [--cwd <dir>] [--base <ref>] [--artifact-dir <dir>] [--format antigravity|github] [--json]`
- `node skills/audit-architecture/scripts/arch-audit.mjs [--cwd <dir>] [--strict] [--json]`
- `node skills/setup-astack/scripts/init-repo-policy.mjs [--cwd <dir>] [--targets <list>] [--dry-run] [--force] [--json]`
- `node scripts/trust/cli.mjs <status|beast|promotion|ceiling|promote|undo|record-outcome> [--cwd <dir>] [--data-dir <dir>] [--json]`
- `node scripts/cli/statusline.mjs` / `node scripts/cli/title.mjs` (stdin JSON)
- `node scripts/mcp/server.mjs [--data-dir <dir>]` (stdio JSON-RPC)
- `node sidecars/astack_timeline/main.mjs --standalone [--port <n>] [--workspace <dir>]`
- `node scripts/eval/run-eval.mjs [--json] [--replay [--live] [--stream]] [-h|--help]`
- `node skills/security-audit/scripts/validate-findings.cjs <findings.json>` / `validate-coverage-ledger.cjs <ledger.json>`
- `node skills/create-verification-skill/references/control-cli-template.mjs <doctor|launch|snapshot|cleanup> [--json] [--dry-run] [--state-dir <dir>] [--evidence-dir <dir>] [--port <number>] [--cmd <shell-command>]`

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`; Node 22+ is available on `PATH`. Keep all written logs, scratch state, and synthetic repos inside `$ScratchDir`.

- **Zero module warnings and `--help` / `-h` smoke check across all 20 CLIs**: Run `--help` and `-h` across `validate-astack.mjs`, `upstream-watch.mjs`, `run-eval.mjs`, `scripts/trust/cli.mjs`, `scripts/cli/statusline.mjs`, `scripts/cli/title.mjs`, `scripts/mcp/server.mjs`, `sidecars/astack_timeline/main.mjs`, `setup-banner.mjs`, `init-repo-policy.mjs`, `pr-dossier.mjs`, `arch-audit.mjs`, `check-plan.mjs`, `worktree-audit.mjs`, `log.mjs`, `watch-pr.mjs`, `statechart.mjs`, `validate-findings.cjs`, `validate-coverage-ledger.cjs`, and `control-cli-template.mjs`. Expect exit `0`, usage output on stdout, and zero `MODULE_TYPELESS_PACKAGE_JSON` warnings on stderr; save summary to `$EvidenceDir/cli-help-smoke.txt`.
- **Policy scaffold, Trust CLI, Dossier, Audit, Statusline, Title, MCP, and Eval probes**:
  - Init a scratch git repo at `$ScratchDir/repo`, scaffold policies with `init-repo-policy.mjs --cwd "$ScratchDir/repo" --json`, commit them, and verify `node scripts/trust/cli.mjs status --cwd "$ScratchDir/repo" --data-dir "$ScratchDir/pdata" --json` reports `enrolled_repo`.
  - Run `node skills/audit-architecture/scripts/arch-audit.mjs --cwd . --strict --json`, `node skills/review-pr/scripts/pr-dossier.mjs --cwd . --artifact-dir "$ScratchDir/art" --json`, stdin probes for `statusline.mjs` / `title.mjs` / `scripts/mcp/server.mjs` (`tools/list`), and `node scripts/eval/run-eval.mjs --json` plus `--replay --json`; save outputs under `$EvidenceDir/`.
- **Security-audit validators**: Test valid and malformed `findings.json` / `coverage-ledger.json` fixtures inside `$ScratchDir` (`exit 0` vs `exit 1`); save outputs to `$EvidenceDir/security-audit-cli.txt`.
- **`log.mjs` dry-run + TSV write and formula escaping**: Run `node skills/show-me-your-work/scripts/log.mjs --dry-run "$ScratchDir/dry.decision.tsv" "build" "skip write" "dry run" "none" "pass"` and verify `$ScratchDir/dry.decision.tsv` was **not** created. Then run the 6-arg write call with `"=cmd()"` and inspect `header ts\tphase\tdecision\twhy\tevidence\tresult` and escaped `'=cmd()`, plus invalid arg count (`< 6` args) exiting `1`; save proof to `$EvidenceDir/cli-log-proof.txt`.
- **`check-plan.mjs` JSON diagnostics + `multi-phase-plan.md` skeleton regression**: Extract the skeleton from `skills/astack-mode/playbooks/multi-phase-plan.md`, fill its `<...>` placeholders into `$ScratchDir/skeleton.plan.md`, and run `node skills/astack-mode/scripts/check-plan.mjs --json "$ScratchDir/skeleton.plan.md"` expecting exit `0`, a bad plan (with em dash or missing `schedule` check) expecting exit `1`, and zero args expecting exit `2`; save to `$EvidenceDir/cli-check-plan.txt`.
- **`worktree-audit.mjs` TSV and `--json` table on isolated git repo**: Create a scratch git repo at `$ScratchDir/wt-repo` with one commit, and run both `node skills/astack-mode/scripts/worktree-audit.mjs "$ScratchDir/wt-repo"` and `node skills/astack-mode/scripts/worktree-audit.mjs --json "$ScratchDir/wt-repo"`. Expect exit `0`, valid JSON containing `base`, `warned`, and `rows`, and clean TSV columns; save to `$EvidenceDir/cli-worktree-audit.txt`.
- **`control-cli-template.mjs` full lifecycle (`doctor` -> `launch` -> `snapshot` -> `cleanup`)**: Run `node skills/create-verification-skill/references/control-cli-template.mjs doctor --json --dry-run --state-dir "$ScratchDir/tpl-state"` expecting exit `0` and valid JSON `{ ok: true, portAvailable: <port> }`. Then run `launch`, `snapshot`, and `cleanup` pointing `--state-dir "$ScratchDir/tpl-state"` and `--evidence-dir "$EvidenceDir/tpl-evidence"`; verify exit `0` at every step, `$ScratchDir/tpl-state/scratch` removed after cleanup, the launched PID gone, and `$EvidenceDir/tpl-evidence/snapshot.json` preserved intact.

## Gotchas

- `control-cli-template.mjs doctor` without `--state-dir` inspects `os.tmpdir()/astack-control-cli/scratch/state.json`, so stale temp state there can cause exit `1`; always pass `--state-dir "$ScratchDir/tpl-state"` during isolated runs.
- `control-cli-template.mjs launch` binds an ephemeral free port with `net.createServer()` on `127.0.0.1` unless `--port` is supplied, and `cleanup` terminates only the child PID saved in `<state-dir>/scratch/state.json` (`taskkill /PID <pid> /T /F` on Windows, process group `SIGTERM` on POSIX).
- `*.decision.tsv` is gitignored repo-wide, but still write test `.decision.tsv` files into `$ScratchDir` so Cleanup removes them deterministically.
- Automated suites in `package.json` covering these CLIs and servers: `test:helpers`, `test:trust`, `test:security-audit`, `test:eval`, `test:mcp`, `test:cli`, and `test:sidecar`.
