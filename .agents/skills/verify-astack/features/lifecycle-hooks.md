# Opt-In Safety & Verification Lifecycle Hooks

AStack wires **10 lifecycle hooks** in `hooks.json` with split defaults: **3 passive/context hooks** (`astack-receipt-ledger`, `astack-session-context`, `astack-pr-intent`) ship `"enabled": true` to record receipts and inject base-branch governance context, while **7 blocking/gating hooks** ship `"enabled": false` until opted in (`astack-irreversible-guard`, `astack-secret-guard`, `astack-verify-reminder`, `astack-evidence-gate`, `astack-boundary-guard`, `astack-round-limiter`, `astack-trust-gate`).

## Sub-features

- **Passive observe/context hooks (`"enabled": true` by default)**:
  - `astack-receipt-ledger` (`PostToolUse` on file writes, `run_command`, `invoke_subagent`, `run_workflow`, `call_mcp_tool`, `mcp_.*`): records single-actor receipts to `<trustDir>/receipts.<conversationId>.jsonl` and returns `{}`. Skips `non_repo` workspaces, non-engineering MCP servers, and non-workspace `.gemini`/`artifactDir`/brain writes.
  - `astack-session-context` (`SessionStart`): reads base-branch `REVIEW.md` and `GLOSSARY.md`, warns if the working branch edits `REVIEW.md` or `.agents/risk-policy.json`, adds AStack Timeline pill guidance when enabled, and returns `{ injectSteps: [{ systemMessage: { systemMessage } }] }` (or `{}` on `non_repo`).
  - `astack-pr-intent` (`PreInvocation`): injects `{ injectSteps: [{ ephemeralMessage }] }` once per `(headSha, prompt)` hash on PR-intent prompts and appends Beast Mode stage/trust/mitigation context (`evaluateStageContext`) when Beast Mode is active on an `enrolled_repo`. Returns `{}` on `non_repo`.
- **Opt-in blocking/gating hooks (`"enabled": false` by default)**:
  - `astack-irreversible-guard` (`PreToolUse` on `run_command`, active everywhere including `non_repo`): flags destructive shell commands, force/trunk `git push`, and DB-client SQL `DROP`/`TRUNCATE` (`force_ask` interactively; `deny` when `CI="true"|"1"` or `NON_INTERACTIVE="1"`).
  - `astack-secret-guard` (`PreToolUse` on `write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|run_command`, active everywhere): flags `.env` writes (except `.example`), sensitive dotfile shell commands, and credential patterns, skipping test paths and `astack-secret-guard: allow-fixture`.
  - `astack-verify-reminder` (`Stop`): active by default when enabled (`ASTACK_REQUIRE_VERIFY === "0"` suppresses it); checks dirty non-`.md` files and receipt freshness (`missing_receipts`, `dirty_after_verify`, `stale_sha`) when `continuationActive !== true`, `fullyIdle !== false`, `terminationReason` is `"model_stop"` or `"NO_TOOL_CALL"`, and `executionNum <= 2`, then chains `evaluateStageHandoff` for Beast Mode stage transitions.
  - `astack-evidence-gate` (`PreToolUse` on `run_command|call_mcp_tool|mcp_.*`): gates `git push`, `gh pr create/new/edit --body/merge`, and GitHub MCP `create_pull_request`/`update_pull_request`/`merge_pull_request` on fresh HEAD verification, assertion-delta/escalation checks, merge verifier PASS + rollback, and base-branch `prDescriptionContract` (denies unverified merges; `force_ask`/`deny` for push/PR; silent `allow` on `non_repo`).
  - `astack-boundary-guard` (`PreToolUse` on file writes): enforces `.agents/boundaries.json` `importRules` and `bannedPatterns`; silent `allow` on `non_repo`.
  - `astack-round-limiter` (`PreToolUse` on file writes): blocks edits once `evidence.json` enters escalated remediation state (`3/3` rounds or `ESCALATE_HUMAN`); silent `allow` on `non_repo`.
  - `astack-trust-gate` (`PreToolUse` on writes, `run_command`, `call_mcp_tool`, `mcp_.*`): unconditionally denies agent writes or shell commands mutating `${PLUGIN_DATA}/trust/**` or mutating `scripts/trust/cli.mjs` everywhere; on `enrolled_repo`, evaluates Intent Card presence and `evaluateDecisionTable` (`allow`, `auto_approve`, `force_ask`, `deny`).
- Multi-schema tool payload extraction in `scripts/trust/internal/envelope.mjs` (`toolCall.args.CommandLine`, `toolCall.args.command`, `tool_input.command`, `payload.args`, `commandLine`, `TargetFile`/`targetFile`, `CodeContent`, `ReplacementContent`, `ReplacementChunks`; bare top-level `command` fails open to `allow`).

## How to get to it (user POV)

By default, `hooks.json` enables all 3 passive/context hooks and disables all 7 blocking gates (`"enabled": false`). Maintainers verify the hook scripts by piping JSON hook payloads via stdin or running `node --test scripts/test/hooks.test.mjs`, and end users opt into blocking gates in `hooks.json` (using `ASTACK_REQUIRE_VERIFY=0` to silence `verify-reminder` temporarily).

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`. Pipe UTF-8 JSON without BOM into each script's stdin and inspect single-line JSON stdout plus exit code `0`.

- **Automated hook contract & `WorkspaceScope` suite**: Run `node --test scripts/test/hooks.test.mjs` and save summary to `$EvidenceDir/hooks-unit.txt`. Covers all 10 hooks, `hooks.json` `TOOL_MATCHERS` sync, `non_repo` silence with zero disk writes, and engineering MCP filtering.
- **`non_repo` silence vs workstation guards**: Create `$ScratchDir/non-git` (not a git repo). Pipe a `run_command` receipt payload with `"workspacePaths":["<abs-non-git>"]` into `node scripts/hooks/receipt-ledger.mjs` -> expect `{}` and zero trust files created. Pipe `'{"workspacePaths":["<abs-non-git>"],"toolCall":{"name":"run_command","args":{"CommandLine":"rm -rf /"}}}'` into `node scripts/hooks/irreversible-guard.mjs` with `CI="true"` -> expect `{"decision":"deny",...}`.
- **`irreversible-guard.mjs` safe, destructive, and malformed JSON**: Test safe/read-only `rg "DROP TABLE" scripts/` and `git push --force-with-lease origin feat/test` (`{"decision":"allow"}`), destructive `git reset --hard HEAD~1` / `bash -c "rm -rf /"` / `echo "DROP TABLE users;" | psql` / `git push origin +main` (`force_ask` interactively vs `deny` with `CI="true"`), and `'not-valid-json'` (`{"decision":"allow"}`); save to `$EvidenceDir/hooks-proof.txt`.
- **`secret-guard.mjs` `allow`, `force_ask`, and headless `deny`**: Pipe a safe write payload (`{"decision":"allow"}`), then a synthetic token-pattern payload built in memory with `CI=""` vs `CI="true"` (`force_ask` vs `deny`); save to `$EvidenceDir/secret-guard-proof.txt`.
- **`verify-reminder.mjs` default-on gating & `ASTACK_REQUIRE_VERIFY=0` opt-out**: Create an isolated git repo at `$ScratchDir/hook-git` with one baseline commit, then test `node scripts/hooks/verify-reminder.mjs` with stdin `'{"conversationId":"c1","continuationActive":false,"terminationReason":"model_stop","fullyIdle":true,"workspacePaths":["<abs-hook-git>"],"artifactDirectoryPath":"<abs-scratch-art>"}'`:
  1. Clean repo -> `{"decision":"allow"}`
  2. Dirty `README.md` only -> `{"decision":"allow"}`
  3. Dirty `index.js` (no env var required) -> `{"decision":"continue","reason":...}`
  4. Dirty `index.js` with `"continuationActive":true` -> `{"decision":"allow"}`
  5. Dirty `index.js` with `$env:ASTACK_REQUIRE_VERIFY = "0"` -> `{"decision":"allow"}`
  Reset `$env:ASTACK_REQUIRE_VERIFY` afterward and save all outputs to `$EvidenceDir/verify-reminder-proof.txt`.
- **`trust-gate.mjs` protected trust-store deny**: Pipe a `run_command` payload running `node scripts/trust/cli.mjs beast on` with `"workspacePaths":["<abs-non-git>"]` into `node scripts/hooks/trust-gate.mjs` -> expect `{"decision":"deny",...}`; append to `$EvidenceDir/hooks-proof.txt`.

## Gotchas

- `verify-reminder.mjs` is active by default once enabled in `hooks.json` and skips only when `ASTACK_REQUIRE_VERIFY === "0"`; always clear `$env:ASTACK_REQUIRE_VERIFY` after testing so subsequent commands do not inherit it.
- Because `verify-reminder.mjs` runs `git status` against `workspacePaths` / `cwd`, always point test payloads to an isolated git repo inside `$ScratchDir` so live repo state does not confound the assertion.
- `irreversible-guard.mjs` fails open on malformed payloads or bare top-level `{"command": ...}` keys outside the supported payload schemas.
