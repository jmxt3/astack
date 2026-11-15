---
name: control-ui
description: "Antigravity UI Control Glass: drive live web and desktop/Electron interfaces like a real user via /browser (built-in browser on App v2.30.0+ or Chrome DevTools MCP v144+), collect DOM/network/trace evidence, and clean up started daemons cleanly. Use for UI bug reproduction, visual/behavioral verification, and perf hillclimbing."
---

# Control UI ("Control Glass" for Interfaces)

Never inspect code and guess that the UI works (`principle-prove-it-works`). Boot the real application, drive the actual user journey end-to-end, collect empirical runtime evidence, verify side effects, and leave zero stranded processes behind.

See [`references/devtools-evidence-checklist.md`](references/devtools-evidence-checklist.md) for what proof artifacts and metrics to capture per task type.

## 1. Check Project Verification Skill First

1. Look for a project-local verification skill under `.agents/skills/verify-*/SKILL.md` and its `features/` map.
2. If one exists, follow its **Launch**, **Doctor**, **Drive**, **Evidence**, and **Cleanup** sections verbatim instead of improvising selectors or startup flags.
3. If the project has a real user-facing UI and lacks a `verify-*` skill, consider creating one first with `/create-verification-skill` (or flag it to the user after finishing).

## 2. Launch & Doctor (Isolated Instance)

- Start the dev/preview server via `run_command` with `IsDaemon: true` using the repo's documented command and an isolated port/data directory (see [`control-cli-template.mjs`](../create-verification-skill/references/control-cli-template.mjs) for `findFreePort()` and PID-owned teardown) whenever possible so you never collide with the user's running instance.
- Record the `TaskId` returned for cleanup.
- **Doctor check before driving**: confirm not only that the port responds, but that the right build/commit is served, auth/seed data is valid, and initialization finished. Check daemon logs via `manage_task(Action: "status", TaskId)`.

## 3. Drive Like a User (Antigravity `/browser` & DevTools)

- **Default interactive driver (`/browser` in `run` mode)**: Delegate visual/interactive browser flows to Antigravity's `browser` subagent (`invoke_subagent` with `TypeName: "browser"`). On personal App accounts (`v2.30.0+`), Antigravity drives the built-in browser; on CLI or older environments, it connects via Chrome DevTools MCP (`v144+`). Give the subagent clear step-by-step user actions, stable accessibility/DOM cues from the feature map (ARIA labels, visible text, routes; never brittle coordinates), and exact evidence to capture.
- **Scripted / DevTools / trace workflows**: When you need deterministic scripted assertions (Playwright/Cypress) or deep runtime telemetry (Chrome DevTools console/network logs, CPU/frame traces, memory heap snapshots), use the project's existing harness or Antigravity's Chrome DevTools MCP (`chrome-devtools` / `browser-testing-with-devtools` / `memory-leak-debugging` / `a11y-debugging`).
- **Real user path only**: Trigger real clicks, keyboard shortcuts, and form submissions; never call internal test hooks, React/store setters, or backdoor endpoints unless explicitly proving an internal unit contract.

## 4. Collect Complete Evidence

Capture and verify:

- **Action + resulting state**: Not just a final screenshot; confirm the action fired the expected network request / state transition and landed cleanly without layout breakage, clipped controls, or horizontal overflow.
- **Clean console & network**: Zero uncaught exceptions, React/hydration errors, or unexpected 4xx/5xx responses during the verified path.
- **Durable side effects**: Confirm created records, files, or server state persisted cleanly (e.g., survive a page reload).
- **Performance evidence (for `perf-issue` / `trace-forensics`)**: Take traces/heap snapshots before and after with isolated warmup vs measured runs, pairing findings with `benchmark-checklist`.

## 5. Mandatory Cleanup (Preserve Evidence)

- Terminate every server or background daemon **you started** using `manage_task(Action: "kill", TaskId)` — even if verification failed.
- Never kill processes blindly by generic process name (`pkill node`, `taskkill /IM chrome.exe`) because you will destroy the user's own session or Antigravity processes.
- Verify that proof artifacts (screenshots, trace summaries, logs saved in scratch/artifact locations) still exist **after** teardown and did not get wiped by cleanup.
