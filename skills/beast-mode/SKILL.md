---
name: beast-mode
description: "Autonomous earned-trust engineering loop across Plan, Build, PR Review, and Ship stages on enrolled git repositories. Layers /goal and /astack-mode over residual-risk scoring, Intent Cards, per-category trust ceilings, and live Timeline or CLI controls. Use for /beast-mode."
disable-model-invocation: true
---

# Beast Mode

Run one engineering task across Plan, Build and Verify, PR Review, and Ship with earned autonomy inside an enrolled git repository. Beast Mode never bypasses verification, base-branch policy, or human-set category ceilings.

## Scope and Prerequisites

- **Enrolled repositories only.** Earned autonomy applies strictly when `WorkspaceScope` resolves to `enrolled_repo` (`.agents/risk-policy.json` committed on base ref). Non-git folders (`non_repo`) stay silent with zero receipts; unenrolled git repos (`git_unregistered`) run standard AStack receipts with Trust OFF.
- **Human controls stay out of band.** The user toggles Beast Mode (`Off` / `On`), Promotion (`Manual` default / `Auto`), per-category Ceilings (default `L2`, `governance` capped at `L2` forever), `Promote`, and `Undo` through the observe-only AStack Timeline header drawer or `node scripts/trust/cli.mjs`. Never write to `${PLUGIN_DATA}/trust/**` or invoke mutating `scripts/trust/cli.mjs` subcommands from agent tools (`astack-trust-gate` denies them).
- **Opt-in hooks.** Enable `astack-trust-gate`, `astack-evidence-gate`, `astack-verify-reminder`, `astack-round-limiter`, `astack-boundary-guard`, `astack-secret-guard`, and `astack-irreversible-guard` in `hooks.json` when delegating unattended runs.

## Stage Workflow

Layer `/astack-mode` (and `/goal` for multi-turn autonomous objectives) across four stages:

### 1. Plan and Intent

1. Read base-branch `REVIEW.md`, `GLOSSARY.md`, and `.agents/risk-policy.json` (`git show <base>:...`), never trusting feature-branch policy edits.
2. Call `astack_trust` MCP tool `get_trust_status` to inspect current category level (`L0` to `L3`), trust score `T`, and ceiling.
3. Before writing code (mandatory at `L0`/`L1` and whenever residual risk is `medium` or higher), call `declare_intent` with:
   - `goal`: concise task objective.
   - `affectedGlobs`: narrow repo-relative globs covering only the files this task should touch. Avoid catch-all wildcards (`**/*`) because `wide_declared_scope` raises risk score `R`.
   - `assumptions`, `edgeCases`, and `rollbackPlan` (for example `git revert <sha>`).
   - `predictedRisk`: estimated risk score or label for post-merge calibration.
4. Respect human plan approval gates when required (`L0`/`L1` or `humanGates.planApproval`).

### 2. Build and Verify

1. Implement strictly inside `affectedGlobs` using vertical, verifiable slices (`principle-sequence-verifiable-units`).
2. Lower residual risk `R` with fresh HEAD evidence receipts before pushing:
   - Targeted tests on touched files (`test` receipt on HEAD).
   - `/blast-radius` caller proof when `public_surface_changed` fires (`verify` receipt).
   - `control-ui` or sidecar tests for UI edits (`proof-manifest.json` PASS).
   - `arch-audit.mjs --strict` and `validate-astack.mjs` when touching boundaries or plugin manifests (`lint` receipt).
3. Run `/deslop` and `/no-comments` on code changes and re-run verification after the final edit.

### 3. PR Review and Risk Card

1. Run isolated `pr-verifier` (`skills/review-pr/scripts/workflows/pr-verify-loop.py`) and compile `evidence.json` plus the GitHub PR body (`node skills/review-pr/scripts/pr-dossier.mjs --format github --out <body-file>`).
2. Confirm the Risk Card sentence, signal-to-receipt proofs, and rollback receipt match the actual diff.
3. At `L2+` with `low` or `medium` residual risk, pushing and opening the PR proceed inside the decision table. Merging pauses for human review at `L0` to `L2`, on any `medium`/`high` residual risk, or on `governance` changes (capped at `L2` forever).

### 4. Ship and Watch

1. Only merge automatically when the active category earned `L3`, the human raised its ceiling to `L3`, residual risk is `low`, `pr-verifier` passed on HEAD, and a rollback receipt exists on HEAD.
2. After merge, track the post-merge watch window with `watch-pr.mjs` (via `/schedule` or CLI) so clean merges, human edits (`approved_with_edits`), follow-up fixes, or reverts (`y = 0`) record truthfully into the hash-chained ledger.

## Runtime Handoff and Circuit Breakers

- **Automatic stage handoff.** When Beast Mode is On, `Stop` (`astack-verify-reminder`) continues into the next stage automatically if `fullyIdle === true`, `terminationReason === "model_stop"`, HEAD receipts are fresh, no human gate is reached, and the per-stage transition cap (`<= 2`) is not exhausted. `PreInvocation` injects a compact `ephemeralMessage` naming active stage, category level, residual `R`, and missing mitigations.
- **Stop immediately on circuit breakers.** If `scope_drift`, `test_regression`, `deletes_assertions`, `bundled_sidecar_permissions`, or the 3-round `round-limiter` cap trips, stop autonomous retries and escalate to the human with at least 2 concrete hypotheses already tried and why each failed.
- **Live setting updates.** Any click in Timeline (`Beast`, `Promotion`, `Ceiling`, `Promote`, `Undo`) or `scripts/trust/cli.mjs` command writes atomically to `${PLUGIN_DATA}/trust/<repo-id>/settings.json` and takes effect on the very next tool call without a chat prompt.
- **Surface parity.** Works identically in Antigravity App Chat (close the first workflow reply with `[AStack Timeline](sidecar://astack/astack_timeline/)` when the sidecar is enabled) and Antigravity CLI (`agy --mode=auto` or headless `agy -p`, where `ask` converts to `deny` and `scripts/cli/statusline.mjs` displays `L<x>` and `R`).
