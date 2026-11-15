# Opt-In Safety & Verification Lifecycle Hooks

Users can optionally enable AStack's two safety hooks in `hooks.json` (`astack-irreversible-guard` on `PreToolUse` `run_command` and `astack-verify-reminder` on `Stop`), prompting confirmation before destructive shell commands and reminding agents to run final verification when code files changed.

## Sub-features

- `PreToolUse` destructive-command guard (`scripts/hooks/irreversible-guard.mjs`, wired in `hooks.json` with `"enabled": false` by default)
- Multi-schema tool payload extraction (`toolCall.args.CommandLine`, `toolCall.args.command`, `tool_input.command`; a top-level `command` key is not read and fails open to `allow`)
- `Stop` verification reminder (`scripts/hooks/verify-reminder.mjs`, gated by `ASTACK_REQUIRE_VERIFY === "1"`)
- Opt-in diff filtering (ignores clean repos, `.md`-only changes, `continuationActive: true`, and non-`NO_TOOL_CALL` terminations)

## How to get to it (user POV)

By default both hooks in `hooks.json` ship disabled (`"enabled": false`). Maintainers verify the hook scripts by piping JSON hook payloads via stdin, and end users enable them selectively in `hooks.json` (plus `ASTACK_REQUIRE_VERIFY=1` for `verify-reminder`).

## Driving it with control-cli

Preconditions: `$ScratchDir` and `$EvidenceDir` exist from `Launch`. Pipe UTF-8 JSON without BOM into each script's stdin and inspect single-line JSON stdout plus exit code `0`.

- **`irreversible-guard.mjs` safe & read-only SQL search commands (`allow`)**: Pipe `'{"toolCall":{"args":{"CommandLine":"git status --short"}}}'`, `'{"toolCall":{"args":{"CommandLine":"rg \"DROP TABLE\" scripts/"}}}'`, and `'{"toolCall":{"args":{"CommandLine":"git push --force-with-lease origin feat/test"}}}'` into `node scripts/hooks/irreversible-guard.mjs` (with `CI=""`, `NON_INTERACTIVE=""`). Expect exit code `0` and stdout `{"decision":"allow"}`; save output to `$EvidenceDir/hooks-proof.txt`.
- **`irreversible-guard.mjs` destructive, wrapped subshell, piped SQL, and trunk refspec commands (`force_ask` vs headless `deny`)**: Test `git reset --hard HEAD~1`, `bash -c "rm -rf /"`, `echo "DROP TABLE users;" | psql`, and `git push origin +main` against `node scripts/hooks/irreversible-guard.mjs`. Expect exit code `0` and `force_ask` interactively (`CI=""`, `NON_INTERACTIVE=""`), or `{"decision":"deny",...}` when `CI="true"` or `NON_INTERACTIVE="1"`; append to `$EvidenceDir/hooks-proof.txt`.
- **`irreversible-guard.mjs` malformed JSON fallback**: Pipe `'not-valid-json'` into `node scripts/hooks/irreversible-guard.mjs`. Expect exit code `0` and `{"decision":"allow"}` (fail-open on hook parse error so benign sessions are not locked).
- **`verify-reminder.mjs` gating across clean, `.md`-only, and dirty code repos**: Create a temporary git repo under `$ScratchDir/hook-git`, commit a baseline file, then test `node scripts/hooks/verify-reminder.mjs` with `$env:ASTACK_REQUIRE_VERIFY = "1"` and stdin `'{"continuationActive":false,"terminationReason":"NO_TOOL_CALL","cwd":"<abs-hook-git>"}'`:
  1. Clean repo -> `{"decision":"allow"}`
  2. Dirty `README.md` only -> `{"decision":"allow"}`
  3. Dirty `index.js` -> `{"decision":"continue","reason":...}`
  4. Dirty `index.js` with `"continuationActive":true` -> `{"decision":"allow"}`
  Reset `$env:ASTACK_REQUIRE_VERIFY` afterward and save all outputs to `$EvidenceDir/verify-reminder-proof.txt`.

## Gotchas

- `verify-reminder.mjs` checks `ASTACK_REQUIRE_VERIFY === "1"` first; without that env var set, it always returns `{"decision":"allow"}` even on dirty code repositories.
- `irreversible-guard.mjs` fails open: payloads whose command sits outside the three supported paths (for example a bare top-level `{"command": ...}`) resolve to an empty command and return `{"decision":"allow"}`, so a mis-shaped fixture looks like a regex miss.
- Because `verify-reminder.mjs` runs `git status` against `cwd`, always point `"cwd"` in test payloads to an isolated git repo inside `$ScratchDir` so live repo state does not confound the assertion.
- Clear `$env:ASTACK_REQUIRE_VERIFY` in the same shell block or child process after the hook check so unrelated commands do not inherit it.
