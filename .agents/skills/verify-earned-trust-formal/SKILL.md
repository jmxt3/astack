---
name: verify-earned-trust-formal
description: "Formal bounded state-space and exhaustive truth-table verifier for AStack's earned-trust autonomy engine (`scripts/trust/index.mjs`: `resolveEffectiveAutonomy`, `evaluateCategoryState`, `evaluateDecisionTable`). Use when editing `scripts/trust/internal/trust-level.mjs`, `scripts/trust/internal/policy.mjs`, `scripts/trust/internal/handoff.mjs`, or `scripts/trust/index.mjs` to verify ceiling caps, governance locks, demotions, and stage-handoff safety without Java or TLC."
---

# Verify Earned Trust (Formal)

Runs an exhaustive finite-domain and bounded-BFS state-space verifier directly against the live production exports in [`scripts/trust/index.mjs`](../../../scripts/trust/index.mjs).

## Why this tool

The earned-trust policy, EMA scoring, level state machine, and decision table are deterministic ES modules running on Node 22+ (`engines.node >= 22.6.0` in `package.json`). Running this TypeScript verifier directly against `scripts/trust/index.mjs` eliminates hand-model drift and requires zero external installs (no Java 11+ or `tla2tools.jar`).

## Coverage record and sync commit

- **Covered files:**
  - [`scripts/trust/internal/trust-level.mjs`](../../../scripts/trust/internal/trust-level.mjs) (`resolveEffectiveAutonomy`, `evaluateCategoryState`)
  - [`scripts/trust/internal/policy.mjs`](../../../scripts/trust/internal/policy.mjs) (`evaluateDecisionTable`, `DEFAULT_RISK_POLICY`)
  - [`scripts/trust/internal/handoff.mjs`](../../../scripts/trust/internal/handoff.mjs) (stage-handoff action mapping and max-hop alignment)
  - [`scripts/trust/index.mjs`](../../../scripts/trust/index.mjs) and [`scripts/trust/index.d.mts`](../../../scripts/trust/index.d.mts)
- **Sync commit:** `ee5d14605be46a379fbe129566c3f6fd5f148ac7`

When a change modifies any covered file after the sync commit, run the check below before accepting the change. Move the sync commit forward only after confirming every property and scope assumption still matches the code.

## Properties checked (and the harm each prevents)

1. **`EffectiveAutonomyPolicyPrecedence` (378 category evaluations across 54 policy/settings pairs):** Verifies across all 7 categories that a base-branch `manual` lock overrides local `auto` settings and that `governance` ceilings never exceed `L2`. Prevents an agent or user setting from bypassing base-branch autonomy locks or unlocking `L3` on governance files.
2. **`DecisionTableSafetyMatrix` (3,072 states):** Exhaustively checks every `(action, residual, trustLevel, category, beastOn, headless, isOwnRevert)` tuple so `blocked` always denies, irreversible actions (`deploy`, `external_message`, `destructive`) never auto-approve, `beastOn: false` never auto-approves, `high` residual never auto-approves, `headless` never returns an interactive prompt, and non-revert `merge` auto-approvals happen only for non-`governance` categories with `low` residual at `L3`.
3. **`CategoryStateAndDemotionInvariants` (2,323 evaluations):** Exhaustively checks real ledger entry histories across clean tiers, promotion modes, ceilings, `confirmedLevel`, broken hash chains (`chainValid: false`), `policyReset`, `reverted` (`y = 0`) outcomes, and missed sampled audits. Proves `TypeOK`, `LevelRespectsCeiling`, `GovernanceNeverExceedsL2`, `GovernanceNeverAutoPromotes`, `ManualNeverExceedsConfirmed`, `FrozenForcesL0`, `PolicyResetCapsAtL1`, and strict demotion on bad outcomes or missed audits.
4. **`EarnedTrustLifecycleBFS` (bounded 8-action BFS up to `MAX_STAGE_HOPS = 3`):** Explores reachable `(cat, mode, ceiling, tier, confirmed, autoPromoted, hasUndo, chainValid, demotionOk, stage, stageHops)` states using real calls to `resolveEffectiveAutonomy`, `evaluateCategoryState`, and `evaluateDecisionTable`. Proves all 9 safety invariants end-to-end (`TypeOK`, `LevelRespectsCeiling`, `GovernanceNeverExceedsL2`, `GovernanceNeverAutoPromotes`, `GovernanceNeverAutoMerges`, `ManualNeverExceedsConfirmed`, `FrozenForcesL0`, `BadOutcomeDemotes`, `StageHandoffsBounded`) and emits a `formal-ts` Mermaid `stateDiagram-v2`.

## Scope and exclusions

- **Included:** Deterministic autonomy resolution, EMA ledger evaluation, manual/auto promotion, `Undo` downgrade, ledger-freeze fallback, `policyReset`, bad-outcome demotion, `(action, residual, trustLevel)` decision table, and bounded `Stage 1 -> Stage 4` handoffs.
- **Excluded:** Cross-process file lock contention (`ledger.lock` / `settings.lock`), atomic rename retries on Windows, symlink canonicalization in `outcomes.mjs`, and Antigravity `PreToolUse` / `Stop` CLI stdin/stdout JSON envelopes (covered by `scripts/test/outcomes.test.mjs` and `scripts/test/trust-level.test.mjs`).

## How to run

Run from the repository root:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning .agents/skills/verify-earned-trust-formal/scripts/verify-trust.ts --json
```

Pass `--emit-mermaid <path>` to write the `%% provenance: formal-ts` `stateDiagram-v2` chart for PR proof compilation (`pr-dossier.mjs`).

- **Exit `0` (`ok: true`):** All 4 properties and all 9 invariants hold across every explored state.
- **Exit `1` (`ok: false`):** Prints JSON `findings` with the property name, plain-English summary, and exact `counterexample` input or step trace. Never weaken an invariant in `verify-trust.ts` to make a failing check pass; either fix the bug in `scripts/trust/` or confirm an intentional contract change and update this skill together.

## Verified baseline at sync commit `ee5d146`

At `ee5d14605be46a379fbe129566c3f6fd5f148ac7`, all 4 properties pass with `0` findings (`EffectiveAutonomyPolicyPrecedence` 378 states, `DecisionTableSafetyMatrix` 3,072 states, `CategoryStateAndDemotionInvariants` 2,323 evaluations, `EarnedTrustLifecycleBFS` 876 visited states / 3,984 transitions).
