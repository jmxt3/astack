# Design, Accessibility & State Audit Checklist

Use alongside [`control-ui`](../../control-ui/SKILL.md) when driving a live screen during `/design-audit`.

## 1. Layout & Responsive Geometry
- Check desktop (`1440x900`) and mobile (`390x844`) viewports.
- Confirm `document.documentElement.scrollWidth <= window.innerWidth` (zero unintended horizontal scroll).
- Check interactive buttons, links, and toggles for truncation, text wrapping collisions, and `>= 44x44px` touch targets on mobile.
- Confirm sticky headers/footers do not obscure focused inputs or primary CTAs when scrolling.

## 2. Keyboard & Focus Mechanics
- Tab from top of page through every interactive element in logical reading order.
- Confirm every focusable element renders a visible focus ring (`outline` / `box-shadow` contrast, never `outline: none` without replacement).
- Open drawers, dialogs, and dropdowns via keyboard (`Enter` / `Space`), confirm focus moves inside, and verify `Escape` closes and restores focus to the trigger.

## 3. Semantics, Labels & Contrast
- Verify one clear `<h1>` and non-skipping heading levels (`h1` -> `h2` -> `h3`).
- Verify every form field has an associated `<label>` or `aria-label`, and icon-only buttons expose accessible names.
- Inspect text and muted-label contrast against rendered backgrounds (target WCAG AA `>= 4.5:1` body text, `>= 3:1` large text and UI controls).

## 4. Non-Happy-Path Interface States
- **Empty state:** helpful next action rather than blank whitespace.
- **Loading state:** disables duplicate submits (`double-click` safety) and indicates progress clearly.
- **Error / network failure state:** actionable plain-language message without leaking stack traces or locking the user out of recovery.
- **Validation state:** inline field errors bound via `aria-describedby` and visible above the fold.
