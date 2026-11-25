---
name: verify-risk-mitigation-formal
description: "Formal bounded state-space and exhaustive matrix verifier for AStack's risk scoring, mitigation algebra, action-class non-downgrade, and freshness/round-escalation engine (`scripts/trust/index.mjs`: `computeNoisyOrScore`, `bucketFromScore`, `classifyDominantCategory`, `resolveResidual`, `classifyActionClass`, `computeFreshness`, `evaluateRoundState`). Use when editing `scripts/trust/internal/risk.mjs`, `scripts/trust/internal/mitigation.mjs`, `scripts/trust/internal/ledger.mjs`, or `scripts/trust/index.mjs`."
---

# Verify Risk & Mitigation (Formal)

Runs an exhaustive finite-domain and bounded-BFS state-space verifier directly against the live production exports in [`scripts/trust/index.mjs`](../../../scripts/trust/index.mjs).

## Why this tool

The noisy-OR risk scorer, category precedence classifier, residual-risk mitigation resolver, shell/MCP action classifier, receipt freshness checker, and review-round state machine are pure deterministic ES modules running on Node 22+ (`engines.node >= 22.6.0` in `package.json`). Importing directly from `scripts/trust/index.mjs` under Node native type stripping eliminates hand-model drift and requires zero external installs (no Java 11+ or `tla2tools.jar`).

## Coverage record and sync commit

- **Covered files:**
  - [`scripts/trust/internal/risk.mjs`](../../../scripts/trust/internal/risk.mjs) (`DEFAULT_RISK_WEIGHTS`, `HARD_BLOCK_SIGNALS`, `computeNoisyOrScore`, `bucketFromScore`, `classifyFileCategory`, `classifyDominantCategory`)
  - [`scripts/trust/internal/mitigation.mjs`](../../../scripts/trust/internal/mitigation.mjs) (`MITIGATION_TABLE`, `classifyActionClass`, `resolveResidual`)
  - [`scripts/trust/internal/ledger.mjs`](../../../scripts/trust/internal/ledger.mjs) (`computeFreshness`, `evaluateRoundState`)
  - [`scripts/trust/index.mjs`](../../../scripts/trust/index.mjs) and [`scripts/trust/index.d.mts`](../../../scripts/trust/index.d.mts)
- **Sync commit:** `3a53ea59a7ee20ffdc12f6c69fba269933586858`

When a change modifies any covered file after the sync commit, run the check below before accepting the change. Move the sync commit forward only after confirming every property and scope assumption still matches the code.

## Properties checked (and the harm each prevents)

1. **`NoisyOrAndDominantCategoryAlgebra` (722 checks):** Exhaustively verifies empty-set score `0`, `[0, 1]` bounds, monotonicity under signal addition and mitigation scaling across all 64 subsets of 6 canonical signals, `hardBlocked` bucket forcing (`critical` vs `blocked`), and order-invariant category precedence (`governance > core > tooling > ui > skills > tests > docs`) across all 127 non-empty subsets of canonical paths plus `[]`. Prevents risk scores from inverting when mitigations apply or high-risk governance edits from being diluted by a `.md` file in the same diff.
2. **`ResidualMitigationNonBypassMatrix` (1,272 evaluations):** Exhaustively runs `resolveResidual` across `MITIGATION_TABLE` invariants, 15 signal profiles, 4 categories (`docs`, `ui`, `core`, `governance`), 3 actions (`local_write`, `open_pr`, `merge`), and 7 receipt worlds (`empty`, `all_fresh_full`, `all_failed`, `stale_sha`, `dirty_write_after_verify`, `merge_missing_verifier`, `merge_missing_rollback`). Proves hard-block signals (`touches_governance`, `bundled_sidecar_permissions`, `scope_drift`, `test_regression`) never exit `blocked`, `deletes_assertions` never auto-satisfies or drops below `high`, unverified/un-rollbackable merges fail closed (`high` or `blocked`), and failed/stale/dirty receipts never satisfy evidence mitigations.
3. **`ActionClassNonDowngradeMatrix` (93 evaluations):** Exhaustively checks compound `&&`/`;` commands, `env`-wrapped commands, flag-prefixed or backslash-escaped `git`/`gh` commands, shell redirections/`$(...)` subshells, and MCP tool names through `classifyActionClass`. Prevents a privileged `git push`, `gh pr merge`, `npm publish`, or destructive command from hiding behind a leading `git status` and downgrading to `read` or `local_exec`.
4. **`FreshnessAndRoundEscalationBFS` (104 visited states / 639 transitions):** Explores bounded transitions (`file_write`, `git_commit`, `verify_pass`, `rebase_same_patch_id`, `verifier_pass`, `verifier_pass_with_notes`, `verifier_fail`, `verifier_escalate`) up to `maxReviewRounds = 3` against live `computeFreshness` and `evaluateRoundState`. Proves `fresh` / `fresh_rebase_patch_id` hold only with a clean working tree and matching HEAD or patch-id, `roundState === "verified"` never triggers on stale or failed verdicts, and `ESCALATE_HUMAN` or 3 failed rounds always enter `escalated`. Emits a `formal-ts` Mermaid `stateDiagram-v2`.

## Scope and exclusions

- **Included:** Deterministic noisy-OR scoring, category precedence, residual mitigation resolution, action-class classification, receipt freshness transitions, and 3-round escalation state transitions.
- **Excluded:** Git subprocess diff/numstat/patch-id collection in `assessChange` / `compilePrDossier`, filesystem symlink and concurrent receipt-file locking in `ledger.mjs`, and Antigravity hook stdin/stdout JSON envelopes (covered by `scripts/test/risk.test.mjs`, `scripts/test/mitigation.test.mjs`, and `scripts/test/hooks.test.mjs`).

## How to run

Run from the repository root:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning .agents/skills/verify-risk-mitigation-formal/scripts/verify-risk.ts --json
```

Pass `--emit-mermaid <path>` to write the `%% provenance: formal-ts` `stateDiagram-v2` chart for PR proof compilation (`pr-dossier.mjs`).

- **Exit `0` (`ok: true`):** All 4 properties hold across every explored state.
- **Exit `1` (`ok: false`):** Prints JSON `findings` with the property name, plain-English summary, and exact `counterexample` input or step trace. Never weaken an invariant in `verify-risk.ts` to make a failing check pass; either fix the bug in `scripts/trust/` or confirm an intentional contract change and update this skill together via `/maintain-formal-verification-skill`.

## Verified baseline at sync commit `3a53ea5`

At `3a53ea59a7ee20ffdc12f6c69fba269933586858`, all 4 properties pass with `0` findings (`NoisyOrAndDominantCategoryAlgebra` 722 checks, `ResidualMitigationNonBypassMatrix` 1,272 evaluations, `ActionClassNonDowngradeMatrix` 93 evaluations, `FreshnessAndRoundEscalationBFS` 104 visited states / 639 transitions).
