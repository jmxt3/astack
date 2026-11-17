---
name: design-audit
description: Empirical UX, accessibility, responsive layout, and interface state audit for new or updated web and Electron UIs using /browser and Chrome DevTools MCP. Use for /design-audit when there is no visual-parity baseline yet.
disable-model-invocation: true
---

# Design Audit

[`control-ui`](../control-ui/SKILL.md) proves functional user flows work. [`visual-parity.md`](../astack-mode/playbooks/visual-parity.md) checks pixel-exact diffs against an existing baseline. `/design-audit` fills the gap for new or redesigned screens that have no pixel baseline yet: drive the running interface as a real user, verify interactive usability and accessibility empirically, and cite concrete screenshots, DOM checks, and console/layout measurements (`principle-prove-it-works`).

## 1. Boot the real surface

Follow [`control-ui`](../control-ui/SKILL.md) and any `.agents/skills/verify-<app>/` recipe to launch an isolated instance (`IsDaemon: true`, free port, seeded local state) and confirm readiness before auditing. Keep `TaskId` for mandatory teardown.

## 2. Drive the checklist across viewports & states

Use Antigravity's `browser` subagent (`invoke_subagent` with `TypeName: "browser"`) and Chrome DevTools MCP (`a11y-debugging`, `chrome-devtools` when available) to exercise [`references/a11y-and-states-checklist.md`](./references/a11y-and-states-checklist.md):

1. **Desktop & mobile viewports (`1440x900` and `390x844`):** check horizontal overflow (`scrollWidth <= innerWidth`), clipped controls, overlapping labels, and minimum tap target sizes (`>= 44x44px` on mobile controls).
2. **Keyboard & focus navigation:** tab sequentially through primary actions, confirm visible focus indicators, verify `Escape` closes modals/popovers cleanly, and check for focus traps.
3. **Semantic HTML, ARIA & contrast:** verify headings hierarchy, form labels, accessible button names, `aria-live` status updates, and readable text/icon contrast against surface backgrounds.
4. **UI state coverage:** trigger and capture evidence for **empty**, **loading**, **error**, **validation failure**, and **populated** states (not only the happy path).
5. **Console & layout stability:** confirm zero uncaught console errors, hydration warnings, or unexpected layout shifts during interactions.

## 3. Report & fix boundary

- Report each finding with viewport, route/component, observed failure (screenshot or DOM metric), user impact, and smallest CSS/HTML/component fix.
- Tear down the started daemon via `manage_task(Action: "kill", TaskId)` while preserving captured screenshots/artifacts (`control-ui` Cleanup).
- When fixing issues, follow `/astack-mode` (`feature` / `bug-fix`), re-run the affected viewport checks after edits, and run `/deslop` + `/no-comments` before committing.
