# Harden UI, migrations, and security before pushing

Run your pre-PR quality, migration, and security checks in this tutorial right after building and functionally testing a feature on your branch. You audit a redesigned billing modal with `/design-audit`, prove zero-downtime schema compatibility with the `safe-migration` playbook, review branch changes with `/security-audit` in Guidance mode, run a deeper Full Audit before a major release, and check stateful retry logic formally before pushing commits to GitHub.

## When security checks run automatically versus on demand

Running `/astack-mode` on an ordinary UI or refactor task does not run `/security-audit` automatically, because a multi-agent security pass would add latency to every small edit. Use two controls instead:

- **Continuous secret guard (automatic when enabled):** Turn on `"astack-secret-guard"` in [hooks.json](../../hooks.json) (`"enabled": true`) to catch accidental `.env` writes, private keys, or API token prefixes on every `write_file`, `edit_file`, and `run_command`.
- **Trust-boundary and vulnerability review (`/security-audit`):** Invoke [`/security-audit`](../../skills/security-audit/SKILL.md) explicitly before pushing sensitive diffs, or ask for a security review, threat model, or auth check so Antigravity auto-loads it.

## Audit a new UI before pushing with /design-audit

Suppose your feature in [Run new features from rough idea to verified code](./03-new-feature-workflows.md) also updated the billing plan selector modal, and you have no screenshot baseline yet for [Visual parity](../../skills/astack-mode/playbooks/visual-parity.md).

1. Run [`/design-audit`](../../skills/design-audit/SKILL.md) against your local branch while an isolated instance can boot cleanly.

   ```text
   /design-audit the updated billing plan selector modal. check desktop 1440x900 and mobile 390x844, keyboard navigation, ARIA labels, and empty, loading, and validation-error states.
   ```

2. Inspect each reported defect with its viewport, observed DOM/layout failure, and smallest fix, then apply fixes before opening the PR.

   **Visible result.** Antigravity launches the app cleanly in the `browser` subagent, inspects both viewports plus focus order and error states, tears down the background process afterward, and cites concrete screenshots or DOM checks for any layout overflow or missing `aria-describedby` wiring.

## Prove schema changes are zero-downtime with safe-migration

Suppose the next branch adds a `billing_tier` column to `subscriptions` while live workers still read the existing table schema during rolling deploys.

1. Trigger the [Safe migration playbook](../../skills/astack-mode/playbooks/safe-migration.md) before writing SQL so DDL splits cleanly into expand, backfill, switch, and contract phases.

   ```text
   /astack-mode migrate subscriptions to add nullable billing_tier without table rewrites. prove expand, idempotent backfill run twice, dual-version reads, and rollback against a seeded local DB, and stop before git push.
   ```

2. Confirm local database verification covers both the existing and updated code shapes plus clean rollback.

   **Visible result.** The agent keeps `billing_tier` nullable in the expand migration (with legacy drop deferred to a separate post-deploy contract PR), runs the chunked backfill script twice to prove idempotency, proves both schema readers pass against a seeded local database, and verifies the down migration cleanly.

## Run a pre-PR security diff check in Guidance mode

Once functional tests pass locally and before running `git push`, run [`/security-audit`](../../skills/security-audit/SKILL.md) in **Guidance mode** (its default) over your branch diff.

1. Ask `/security-audit` to inspect changes against `main` for auth bypasses, authorization gaps, injection paths, or unsafe file handling.

   ```text
   /security-audit review my branch diff against main for trust-boundary, authorization, and secret-exposure flaws. stay in guidance mode with zero report files.
   ```

   **Visible result.** `/security-audit` inspects the changed boundaries against [ATTACK-CLASSES.md](../../skills/security-audit/references/ATTACK-CLASSES.md) and matching domain companions without creating report folders. For example, if a newly added route trusts an unverified client `accountId` header, the reply names the lower-trust principal, accepted input, crossed boundary, and exact `file:line`.

2. Fix any confirmed finding and lock in a permanent guard before pushing.

   ```text
   fix the confirmed missing account ownership check using /tdd and /control-cli, then run /correct so every new billing route enforces tenant scope automatically.
   ```

   **Visible result.** Per the [Security audit playbook](../../skills/astack-mode/playbooks/security-audit.md), AStack switches to [Bug fix](../../skills/astack-mode/playbooks/bug-fix.md) and [`/tdd`](../../skills/tdd/SKILL.md), proves the cross-tenant request fails before passing on the fixed handler, and calls [`/correct`](../../skills/correct/SKILL.md) to block future routes that skip tenant checks.

## Run a deep Full Audit before major releases

When preparing a major release or auditing a sensitive service end to end rather than checking one diff, explicitly request **Full Audit mode** (`quick`, `standard`, or `deep`).

1. Invoke Full Audit mode with your chosen depth profile.

   ```text
   /security-audit run a full standard audit on this codebase
   ```

2. Inspect the generated external artifacts once Phase 6 completes.

   **Visible result.** Antigravity uses read-only, network-isolated `research` subagents for reconnaissance and coverage critics, assigns hunters per unit inside `coverage-ledger.json`, sends candidates through fresh refutation and final record verifiers, validates JSON outputs with zero-dependency Node scripts (`validate-findings.cjs` and `validate-coverage-ledger.cjs`), and writes `REPORT.md`, `FINDINGS-DETAIL.md`, and `NEEDS-VALIDATION.md` outside your repository (retaining unisolated or third-party checks strictly as zero-severity `needs_validation` leads).

## Optionally verify stateful concurrency with a formal verifier

When a branch modifies retry state machines, distributed locks, or merge-policy rules where rare event orderings matter, run [`/create-formal-verification-skill`](../../skills/create-formal-verification-skill/SKILL.md) before pushing.

```text
/create-formal-verification-skill verify our webhook delivery state machine guarantees no completed event retries twice.
```

**Visible result.** For deterministic TypeScript modules, AStack builds a zero-dependency Node `--experimental-strip-types` state-space verifier; for interleaved async protocols, it pairs TLA+ with [`/statechart`](../../skills/statechart/SKILL.md) and proves a seeded bug fails before passing on real code.

Next: [Open PRs, babysit to green, land safely, and verify releases](./05-pr-babysit-and-release.md).
