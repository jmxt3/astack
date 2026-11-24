# AStack Repository Review Rules

> Loaded strictly from the base branch (`git show <base>:REVIEW.md`). Pull request diffs cannot relax these invariants.

## Must-Check Invariants

1. **Never self-promote trust.** Plain deterministic code computes category trust scores and levels strictly from the tamper-evident outcome ledger inside human-set Ceilings. Agents must never edit Promotion mode, Ceilings, or the ledger.
2. **Governance stays capped at L2 forever.** Changes touching `.agents/**`, `REVIEW.md`, `hooks.json`, `scripts/hooks/**`, or `scripts/trust/**` never auto-promote and never auto-merge.
3. **Hooks stay silent on `non_repo` workspaces.** Workflow hooks (`receipt-ledger`, `session-context`, `pr-intent`, `verify-reminder`, `evidence-gate`, `boundary-guard`, `round-limiter`, `trust-gate`) must return `{}` or `{ decision: "allow" }` with zero disk writes outside git repositories. Workstation safety guards (`secret-guard`, `irreversible-guard`) stay active everywhere when enabled.
4. **Bundled sidecars stay observe-only.** `sidecars/*/sidecar.json` must keep `allows_user_interactions: false` and zero permission-gated keys (`arguments`, `agent_permissions.workspace_uris`, `agent_permissions.access_grants`).
5. **Preserve facade boundaries and proof hygiene.** Consumers import `scripts/trust/index.mjs`, never `scripts/trust/internal/*`. Never weaken or delete assertions to make failing tests pass. Every behavioral change ships with fresh `HEAD` verification receipts.
