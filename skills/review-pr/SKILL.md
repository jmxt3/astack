---
name: review-pr
description: "Compile a visual Markdown, Mermaid, and carousel PR review dossier with Blast-Radius Risk Tiers (0-3), commentable screenshot artifacts, and an isolated read-only pr-verifier pass capped at 3 rounds. Use for /review-pr."
disable-model-invocation: true
---

# Visual PR Review Workbench (`/review-pr`)

Compile a deterministic visual review dossier in Markdown, Mermaid, and screenshot carousels paired with Antigravity's native Review pane and an isolated fresh-context `pr-verifier`. Never generate HTML dashboards or sidecar servers.

## 1. Compile Evidence and Visual Dossier

When the bundled `astack_trust` MCP server is connected, the **parent** conversation (never `pr-verifier`) calls `compile_pr_dossier` directly, which renders the interactive PR Dossier card inline in Antigravity App (while the `AStack` sidecar panel's Dossier view lets reviewers inspect clusters and findings anytime) and returns plain Markdown in CLI. Otherwise, or when producing GitHub PR bodies, run [`scripts/pr-dossier.mjs`](./scripts/pr-dossier.mjs) against the target branch and base ref (pass `--screenshots` for any UI images captured during `control-ui` or `design-audit`):

```bash
node "<skill-dir>/scripts/pr-dossier.mjs" \
  --base origin/main \
  --artifact-dir "<artifact-dir>" \
  --out "<artifact-dir>/pr-review.md" \
  --json
```

For GitHub PR descriptions, pass `--format github` (with optional `--proof-manifest`, `--statechart`, `--feature-map`, `--repo-url`, and `--merge-body`) to emit a GitHub-safe `stateDiagram-v2` statechart, a `PASS`/`FAIL`/`SKIP`/`UNREACHABLE` verification table, and a single-line bot metadata comment inside `<!-- astack:pr-proof:start/end -->` markers. Validate any PR body file or stdin stream with `--check-pr-body <file|->`.

If UI screenshots were captured outside `<artifact-dir>`, copy them into `<artifact-dir>` with `write_file` (`UserFacing: true`, `RequestFeedback: false`) so the user can drag-select regions and leave visual image comments directly inside Antigravity (`screenshots.md`).

## 2. Run Fresh-Context `pr-verifier`

1. Read `REVIEW.md` and `GLOSSARY.md` strictly from the base ref (`git show <base>:REVIEW.md`).
2. Spawn `pr-verifier` (`agents/pr-verifier.md`) with `Workspace: "branch"` (or via cross-family `/swarm` when distinct model families have quota). Pass the base ref, `evidence.json` path, and `skills/review-pr/scripts/findings-schema.json`. Keep `pr-verifier` strictly headless (it must not call `compile_pr_dossier`, `audit_architecture`, `doctor_workspace`, or `ask_question`).
3. Validate the emitted JSON against `findings-schema.json` and save it to `<artifact-dir>/astack-trust/findings.json`. Confirm `git status --short` in the parent workspace remains clean of verifier edits.
4. Re-run `compile_pr_dossier` in the parent conversation (when `astack_trust` is connected, rendering the updated PR Dossier card inline while the `AStack` sidecar Dossier view reflects the new `findings.json`) and `pr-dossier.mjs` with `--findings "<artifact-dir>/astack-trust/findings.json"` so `<artifact-dir>/pr-review.md` embeds the `Important`, `Nit`, `Pre-existing`, and `Dropped` sections alongside the Mermaid blast-radius graph, ````carousel```` strip, and clickable `file:///` links into Antigravity's Review pane.

## 3. Remediation Loop (3-Round Cap)

- If `verdict` is `FAIL`, fix verified `important` findings, rerun verification, and re-run `/review-pr` up to `maxReviewRounds` (default `3`).
- At round 3 failure, stop autonomous retries (`roundState: "escalated"`) and escalate to the human reviewer with `<artifact-dir>/pr-review.md`.

## 4. Human Review Gate

Present the Risk Tier (`Tier 0..3`), `Freshness`, `Auto-Merge Eligible` flag, and a direct link to `<artifact-dir>/pr-review.md`. Handle interactive and autonomous runs explicitly:

- **Interactive mode (default, Tier 1–3 PRs or Tier 0 without opt-in auto-merge):** Write `<artifact-dir>/pr-review.md` with `UserFacing: true, RequestFeedback: true`, then call native `ask_question` (`questions.length === 1`, unnumbered choices with `(Recommended)` first, e.g. proceed to open/merge PR, fix remaining findings first, or inspect a specific cluster) in the main conversation so Antigravity natively pauses, displays its pending-input indicator, and fires desktop/Remote Control notifications.
- **Full-autonomy / Beast Mode (`/goal`, `autopilot-full`, `autopilot-stack`, Beast Mode full automation, or Tier 0 when `.agents/risk-policy.json` sets `allowTier0AutoMerge: true` and `humanGates.prReview: "tier0-auto"` with all proof checks green):** Never block. Update `compile_pr_dossier` non-blockingly, write `<artifact-dir>/pr-review.md` with `UserFacing: true, RequestFeedback: false`, skip `ask_question`, and proceed automatically when `verdict` is `PASS` or `PASS_WITH_NOTES` (pausing only on `roundState: "escalated"` or an unauthorized irreversible action).

When the AStack Timeline sidecar is enabled in an Antigravity App session and the pill has not yet appeared in this conversation, close with `[AStack Timeline](sidecar://astack/astack_timeline/)` on its own line.
