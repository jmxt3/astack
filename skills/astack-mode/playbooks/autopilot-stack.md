### Autopilot-stack

Run the Autopilot-full playbook, but do not merge.

1. **In place of step 5, stop at verified.** Stop when each PR is verified and green at its current head, then hand the PRs to the operator. After the handoff, nobody pushes without the operator's go. Every loop tick prompt names this file, so each tick sees the no-merge rule.
2. **Stack a PR only when it builds on another PR.** This is the one exception to step 3. Base the PR on the other PR's branch in place of trunk, per **Size and stacks** in `playbooks/opening-a-pr.md`. In place of step 2's rebase onto trunk, each PR rebases onto its parent PR's branch, and the stack root rebases onto trunk. A new head on the lower PR restacks the PRs above it, and a PR whose `git patch-id` the restack leaves unchanged keeps its verdict.

**Reply:** list each PR with its verdict, in place of what merged. When native `/swarm` ran, post `[done] <summary>` (no `@`), append the exact `open_board` value from `swarm{action: "status"}` on its own line so the operator can inspect the **Swarm** UI (**Overview**, **Board**, **Members**, **Graph** / `/swarm board`), and point to **Overview > Review** (App) or `/diff` (CLI) for final branch review.
