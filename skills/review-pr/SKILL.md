---
name: review-pr
description: "Compile a visual Markdown, Mermaid, and carousel PR review dossier with Blast-Radius Risk Tiers (0-3), commentable screenshot artifacts, and an isolated read-only pr-verifier pass capped at 3 rounds. Use for /review-pr."
disable-model-invocation: true
---

# Visual PR Review Workbench (`/review-pr`)

Compile a deterministic visual review dossier in Markdown, Mermaid, and screenshot carousels paired with Antigravity's native Review pane and an isolated fresh-context `pr-verifier`. Never generate HTML dashboards or sidecar servers.

## 1. Compile Evidence and Visual Dossier

Run [`scripts/pr-dossier.mjs`](./scripts/pr-dossier.mjs) against the target branch and base ref (pass `--screenshots` for any UI images captured during `control-ui` or `design-audit`):

```bash
node "<skill-dir>/scripts/pr-dossier.mjs" \
  --base origin/main \
  --artifact-dir "<artifact-dir>" \
  --out "<artifact-dir>/pr-review.md" \
  --json
```

If UI screenshots were captured outside `<artifact-dir>`, copy them into `<artifact-dir>` with `write_file` (`UserFacing: true`, `RequestFeedback: false`) so the user can drag-select regions and leave visual image comments directly inside Antigravity (`screenshots.md`).

## 2. Run Fresh-Context `pr-verifier`

1. Read `REVIEW.md` and `GLOSSARY.md` strictly from the base ref (`git show <base>:REVIEW.md`).
2. Spawn `pr-verifier` (`agents/pr-verifier.md`) with `Workspace: "branch"` (or via cross-family `/swarm` when distinct model families have quota). Pass the base ref, `evidence.json` path, and `skills/review-pr/scripts/findings-schema.json`.
3. Validate the emitted JSON against `findings-schema.json` and save it to `<artifact-dir>/astack-trust/findings.json`. Confirm `git status --short` in the parent workspace remains clean of verifier edits.
4. Re-run `pr-dossier.mjs` with `--findings "<artifact-dir>/astack-trust/findings.json"` so `<artifact-dir>/pr-review.md` embeds the `Important`, `Nit`, `Pre-existing`, and `Dropped` sections alongside the Mermaid blast-radius graph, ````carousel```` strip, and clickable `file:///` links into Antigravity's Review pane.

## 3. Remediation Loop (3-Round Cap)

- If `verdict` is `FAIL`, fix verified `important` findings, rerun verification, and re-run `/review-pr` up to `maxReviewRounds` (default `3`).
- At round 3 failure, stop autonomous retries (`roundState: "escalated"`) and escalate to the human reviewer with `<artifact-dir>/pr-review.md`.

## 4. Human Review Gate

Present the Risk Tier (`Tier 0..3`), `Freshness`, `Auto-Merge Eligible` flag, and a direct link to `<artifact-dir>/pr-review.md` (`UserFacing: true`, `RequestFeedback: false`). Tier 1 through Tier 3 PRs always wait for human review; Tier 0 skips manual merge review only when `.agents/risk-policy.json` explicitly sets `allowTier0AutoMerge: true` and `humanGates.prReview: "tier0-auto"` with all proof checks green.
