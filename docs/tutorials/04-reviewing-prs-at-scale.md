# Review colleague PRs at scale with proven findings

Review single PRs and large PR queues without guessing in five walkthroughs. You catch reproducible bugs on one branch with `/interrogate`, prove downstream safety across callers with `/blast-radius`, map an 800-line PR with `/teach`, triage four PRs in parallel with `/fanout`, and scale to 10 or more PRs or stacked PRs using `/run-workflow` and `/swarm`. Avoid prompting `/astack-mode review this PR` because generic review prompts generate unverified style opinions, whereas `/interrogate` and `/blast-radius` discard any claim that fails to reproduce against real code.

## Prove real bugs and drop noise on one PR with /interrogate

Suppose a colleague asks you to review `PR #214`, which switches `/api/transactions` from offset pagination to keyset cursor pagination.

1. Fetch the PR into an isolated git worktree and open that folder in Antigravity.

   ```bash
   git fetch origin pull/214/head:pr-214
   git worktree add ../review-pr-214 pr-214
   ```

2. Run [`/interrogate`](../../skills/interrogate/SKILL.md) in read-only mode with nitpicks excluded.

   ```text
   /interrogate this branch against origin/main skeptically. don't change anything. skip nitpicks unless it's an actual bug or regression in behavior.
   ```

3. Read the `Intent`, `Findings`, and `Dropped` sections in the reply and check the working tree.

   ```bash
   git status --short
   ```

   **Visible result.** Two or three isolated `branch` subagents attack boundary inputs such as identical timestamps on page boundaries, state races, and caller contracts. The parent agent reruns every reported failure command itself, keeps only verified defects like skipped rows sharing `created_at` on page 2, lists rejected claims with reasons under `Dropped`, and leaves `git status --short` empty.

4. Paste the verified reproduction command and output from `Findings` directly into your GitHub PR review comment, or approve with evidence when `Findings` reports `no verified findings`.

## Check hidden downstream breakage with /blast-radius

Suppose `PR #219` makes a six-line change to a shared `serializeEvent()` helper that strips keys whose value is `null`. Symbol search shows only four direct callers, yet webhook consumers and SQL JSONB queries depend on its output downstream.

1. Check out `PR #219` in a worktree and run [`/blast-radius`](../../skills/blast-radius/SKILL.md).

   ```text
   /blast-radius of stripping null keys inside serializeEvent on this branch.
   ```

2. Inspect the safety proof in the reply.

   **Visible result.** `/blast-radius` traces past symbol search into wire formats, HMAC signature verification, and JSONB patch handlers, states the single fact the change is safe because of or marks it `unproven`, runs a real script importing `serializeEvent` and downstream consumers, and reports confirmed `Risks` with `file:line` citations alongside `Cleared` checks.

## Understand a large unfamiliar PR with /teach

Suppose you receive a review request on `PR #223`, an 800-line rewrite of dead-letter retry handling in a worker service you have never touched.

1. Open a worktree for `PR #223` and run [`/teach`](../../skills/teach/SKILL.md).

   ```text
   /teach me what PR #223 changes in the dead-letter retry loop and prove whether it fixes the duplicate-delivery root cause.
   ```

2. Read the explanation before clicking through every file in GitHub.

   **Visible result.** `/teach` combines [`/how`](../../skills/how/SKILL.md) and [`/why`](../../skills/why/SKILL.md) to show a state-flow diagram, cite git history explaining why the previous lock timeout existed, pinpoint the 60 lines that own the core state transition, and flag whether any prior invariant changed.

## Triage a morning batch of 4 PRs in parallel with /fanout

Suppose four colleague PRs, `#231`, `#232`, `#235`, and `#238`, sit in your morning review queue.

1. Fetch all pull request refs so local subagents can branch from them without fighting over your checkout.

   ```bash
   git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
   ```

2. Fan out one isolated reviewer per PR with [`/fanout`](../../skills/fanout/SKILL.md).

   ```text
   /fanout review refs/remotes/origin/pr/231, pr/232, pr/235, and pr/238 in isolated branch workspaces. one worker per PR. state intent, run affected tests plus one boundary break script against real code, skip style nitpicks, and return one consolidated report.
   ```

3. Read the consolidated report.

   **Visible result.** Four isolated subagents check the four branches concurrently, and the parent prints one summary marking each PR `PASS`, `ISSUES`, or `BLOCKED` with exact command outputs rather than four raw logs.

4. Review the short diffs on `PASS` PRs to approve them, and run `/interrogate` from the first section only on PRs marked `ISSUES`.

## Scale to 10 or more PRs or stacked PRs with /run-workflow and /swarm

Before sprint close, suppose you need to triage 10 or more open PRs or review stacked PRs `#240`, `#241`, and `#242` where every reported defect needs independent confirmation before you post comments.

1. For 10 or more independent PRs needing the same review checklist, invoke Antigravity's Python workflow engine via `/run-workflow` as described in [Antigravity Multi-Agent Orchestration & Swarm Coordination](../../skills/astack-mode/references/swarm-coordination.md).

   ```text
   /run-workflow list open PRs requesting my review, checkout each in parallel in an isolated temp worktree, run affected tests and boundary checks, clean up worktrees, and return one ranked summary line per PR.
   ```

   **Visible result.** `run_workflow` executes a parallel Python pipeline over the PR list, cleans up temporary worktrees, and prints a compact ranked verdict list while keeping your main context window clean via `principle-guard-the-context-window`.

2. For stacked PRs where cross-PR contracts interact, invoke native `/swarm` with an independent verifier.

   ```text
   /swarm review stacked PRs #240, #241, and #242 with one reviewer worker per PR in branch workspaces plus an independent @verifier worker that reruns every candidate bug before reporting back.
   ```

   **Visible result.** Reviewer workers post candidate breaks to the Swarm board, `@verifier` reruns each reproduction independently per `principle-prove-it-works`, and your final summary keeps only defects confirmed by two separate agents.

Back to [Hands-on daily tutorials](./README.md) or [AStack User Guide](../user-guide.md).
