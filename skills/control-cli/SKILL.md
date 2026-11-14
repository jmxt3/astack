---
name: control-cli
description: "Antigravity CLI, TUI & Service Control Glass: verify CLIs, scripts, workers, daemons, and HTTP/RPC APIs against real processes, temp workspaces, exit codes, stdio transcripts, and persisted side effects — with isolated ports and strict daemon cleanup."
---

# Control CLI ("Control Glass" for Commands & Services)

Prove non-browser software against **real executions**, not code-reading guesses or mocked unit assertions alone (`principle-prove-it-works`, `principle-verify-before-reporting`).

## 1. Check Project Verification Skill First

1. Inspect `.agents/skills/verify-*/SKILL.md` and `features/` if present. Follow its **Launch**, **Doctor**, **Drive**, and **Cleanup** steps directly.
2. Otherwise use the project's documented build/CLI/service commands in isolated temp environments.

## 2. Isolate State, Ports & Platform Assumptions

- **Scratch state only**: Pass temporary `--dir`, `--config`, `HOME` / `USERPROFILE` overrides, or ephemeral ports (`0` or free high ports) inside a dedicated temp folder so repeated verification runs are reproducible and never touch user state (`~/.config`, `~/.gemini`, production DBs).
- **Cross-platform rigor**: Run commands cleanly on the active shell (Windows PowerShell `pwsh` or POSIX `sh`). Never assume `/tmp`, Unix sockets, or POSIX signals exist on Windows unless testing a POSIX-only feature.

## 3. Drive Real Commands & Services

### Short-lived CLIs & Build Tools
- Build or invoke the exact entrypoint (`node ...`, compiled binary, `cargo run`, `python -m ...`).
- Verify **exact exit code**, **stdout**, **stderr** (confirm warnings/debug noise don't pollute machine-readable `--json` output), and **side effects on disk / git / DB**.
- Test the failure paths too: bad flags (usage exit code), missing files, invalid input, `--dry-run` (observe files/network/refs afterward to confirm `--dry-run` truly skipped mutations), and repeat execution (idempotency check).

### Long-running Daemons, Workers & APIs
- Launch via `run_command(..., IsDaemon: true)` and keep the `TaskId`.
- **Doctor check first**: query health endpoint + readiness condition (migrations/seeds complete, expected version/build active), and inspect live daemon output with `manage_task(Action: "status", TaskId)`.
- Exercise real requests/jobs end-to-end (`curl` / `Invoke-RestMethod` / CLI client / WebSocket client), verify error responses AND persisted state, and inspect daemon stderr/stdout for unhandled exceptions.

## 4. Mandatory Cleanup

- Kill every daemon/background `TaskId` you started with `manage_task(Action: "kill", TaskId)` when done — including on failure paths.
- Remove temporary scratch directories only **after** copying/confirming proof logs if evidence is needed later. Never nuke files still needed for inspection in a final handoff unless recreated cleanly inside the artifact dir.
- Never extrapolate unprinted exit codes, row counts, or timings; quote observed command outputs verbatim.
