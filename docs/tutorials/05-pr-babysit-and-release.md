# Open PRs, babysit to green, land safely, and verify releases

Take your verified branch from local commits through PR creation, automated check resolution, merging, and post-deploy verification in four steps along the delivery timeline. You push and open a ready PR via `opening-a-pr`, monitor checks and triage review threads with `babysit`, merge verified PRs cleanly with `shipping`, and close production verification and incident prevention with `release-and-postmortem`.

## Push and open a ready PR without premature babysitting

Once local functional tests and pre-PR audits from [Harden UI, migrations, and security before pushing](./04-pre-pr-audits-and-hardening.md) are green, ask AStack to push and open the PR.

1. Open the PR using the [Opening a PR playbook](../../skills/astack-mode/playbooks/opening-a-pr.md), either at approval time (`approved, open the PR`) or on your committed branch.

   ```text
   /astack-mode run opening-a-pr: push this branch and open a ready PR targeting main.
   ```

   **Visible result.** AStack ensures `/deslop` and `/no-comments` have run, verifies a Conventional Commit title and concise `## Why` / `## Verification` body, pushes the branch, opens a non-draft PR via `gh pr create`, confirms it via `gh pr view`, and posts the PR URL.

2. Understand why opening a PR stops before starting `babysit`. If you are building a multi-PR stack (`PR 1` -> `PR 2` -> `PR 3`), finish opening every PR in the stack first so later stack pushes do not restart CI checks on earlier PRs while a watcher runs.

## Drive an open PR or stack to merge-ready with babysit

Start [Babysit](../../skills/astack-mode/playbooks/babysit.md) **after the PR (or full stack) is open on GitHub** and **before you merge**. Never start `babysit` before pushing, because `watch-pr.mjs` polls live GitHub checks and review threads.

1. Run a one-shot status check first (`check` mode) when you just want a quick summary without polling.

   ```text
   /astack-mode check on PR #42. is anything blocking merge?
   ```

   **Visible result.** AStack runs `watch-pr.mjs --owner <owner> --repo <repo> --pr 42 --status-only --pretty` and prints a concise table showing CI status, review decision, and mergeability, then exits immediately.

2. Run `drive` mode when you want AStack to actively watch CI and clear blockers until the PR is merge-ready.

   ```text
   /astack-mode babysit PR #42. get it merge-ready.
   ```

   For a completed multi-PR stack, point `babysit` at the stack once all PRs exist:

   ```text
   /astack-mode babysit the PR stack #42, #43, #44 and get the frontier merge-ready.
   ```

   **Visible result.** AStack arms `watch-pr.mjs` in the background (`--stack` or `--queued-stack` for stacks), works strictly on the lowest unmerged PR, handles blockers in order (merge conflicts first, then review threads, then CI logs), verifies every bot or human comment skeptically against real code per [Bugbot & review triage](../../skills/astack-mode/references/bugbot-triage.md) before pushing batched fixes or posting disproof replies, and stops cleanly when `watch-pr.mjs` reports `READY` (or `WAITING` / `merge-queue` on queued stacks) without merging on its own.

## Merge verified PRs cleanly with shipping

Green CI alone is not proof that a PR stack is safe to merge. When you are ready to land PRs, invoke [Shipping](../../skills/astack-mode/playbooks/shipping.md).

```text
/astack-mode land the PR stack #42, #43, #44.
```

**Visible result.** Shipping assigns an independent verifier per PR to re-verify live behavior on each branch (separate from the author agent), then merges only the contiguous verified bottom slice in order via `gh pr merge`, halting immediately if any PR breaks verification so later PRs never land over an unverified gap.

## Verify releases and close postmortems after merge

Right after landing changes into `main` or deploying a release, run the [Release and postmortem playbook](../../skills/astack-mode/playbooks/release-and-postmortem.md).

1. Generate release notes from real git history and run read-only post-deploy smoke checks.

   ```text
   /astack-mode prepare release notes since v0.2.0 from merged commits and run read-only post-deploy smoke verification against staging using /control-cli and /control-ui.
   ```

   **Visible result.** AStack pulls `git log v0.2.0..HEAD` and merged PR summaries instead of guessing, verifies health endpoints and critical read-only UI routes return zero 5xx or console errors without mutating live data, and outputs concise release notes.

2. If an incident slips past pre-merge checks after release, trace the root cause and encode the fix permanently.

   ```text
   /astack-mode investigate yesterday's staging 500 timeout logs per release-and-postmortem, add a verify-app regression check, and run /correct to prevent repeats.
   ```

   **Visible result.** AStack captures concrete trace evidence (`trace-forensics.md` / `runtime-forensics.md`), adds a permanent user journey inside `.agents/skills/verify-<app>/features/`, and applies [`/correct`](../../skills/correct/SKILL.md) so the incident class fails automated CI or local hooks before another branch can repeat it.

Next: [Review colleague PRs at scale with proven findings](./06-reviewing-prs-at-scale.md).
