# DevTools & Browser Evidence Checklist

Use this checklist alongside [`../SKILL.md`](../SKILL.md) to verify claims with concrete artifacts rather than "looks good".

## A. Behavioral UI Fix / Feature Proof
- [ ] **Doctor state confirmed**: target URL, commit/build served, isolated data dir / seed user verified.
- [ ] **Repro before fix (when fixing a bug)**: concrete action sequence and observed failure (screenshot, console/network error, or wrong DOM state).
- [ ] **End-to-end drive after final edit**: exercised via real UI controls (click, type, shortcut, navigation).
- [ ] **Console & runtime errors**: checked and clean (zero uncaught page errors or unexpected stderr in server daemon).
- [ ] **Network check**: expected HTTP/WebSocket calls succeeded; no silent 4xx/5xx or dropped mutations.
- [ ] **Persistence check**: state survives hard reload when durability is expected.

## B. Visual Parity & Layout Check
- [ ] Viewport tested at intended desktop and narrow/responsive widths.
- [ ] Real content & edge lengths (empty state, long strings, loading/error states) exercised.
- [ ] Zero overlapping text, broken images, clipped interactive buttons, or unintended horizontal scrollbars.
- [ ] Light/dark mode or design token parity verified if applicable.

## C. Frontend Performance / Memory Evidence
- [ ] Baseline vs after measurements run with identical data volume and production/comparable build flags (`benchmark-checklist`).
- [ ] DevTools trace / React profiler / memory heap snapshot confirms what limited throughput (layout thrash, main-thread long tasks, allocation churn, listener leak).
- [ ] Heap comparison across repeated open/close cycles shows retained size returning to baseline if hunting leaks.

## D. Teardown Check
- [ ] Every `IsDaemon: true` server started for verification stopped via `manage_task(Action: "kill", TaskId)`.
- [ ] Proof artifacts verified present on disk after teardown.
