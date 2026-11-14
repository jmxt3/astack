### Worktree and simulator cleanup

1. Snapshot and audit. Record disk free space (`df -h` on Unix or `(Get-PSDrive C).Free` on Windows), then run `node skills/astack-mode/scripts/worktree-audit.mjs [-b <pr-base-ref>] [repo-path]` (`principle-build-the-lever`). Without `-b` it checks `MERGED` against `origin/HEAD`, so pass `-b origin/<branch>` when PRs target another branch. It discovers every path via `git worktree list --porcelain` (catching standalone git worktrees and Antigravity `Workspace: "share"`/`"branch"` clones) and scans Antigravity transcripts under `<appDataDir>/brain/*/.system_generated/logs/transcript.jsonl` to classify age, merge state, uncommitted work, PR state, and last conversation touch. Run the scan via a subagent if the repo has many worktrees.
2. The bucket is advice, not permission. Active swarm boards, active subagent workspaces (`manage_subagents`), and open conversations are the real artifact (`principle-prove-it-works`). Cross-check every candidate against live conversations and pinned sessions before removing anything.
3. Verify usage before deleting. For every `verify-recent-chat` row, use `invoke_subagent` (`TypeName: "research"`) to inspect referenced `transcript.jsonl` files and confirm whether work is ongoing (`principle-guard-the-context-window`). Parallel `arena` or `swarm` workers with `Workspace: "branch"` stay live while their board runs.
4. Pause on irreversible loss. `wip:N` is N tracked uncommitted edits. Show the diff and get a decision first, since removing a clean worktree is recoverable from its branch while uncommitted edits vanish. Clean, merged, unused worktrees can proceed per Autonomy.
5. Prune the confirmed set with `git worktree remove --force <path>` (then delete surviving ignored artifact directories if needed) followed by `git worktree prune`. Confirm disk space reclaimed.
6. Reclaiming OS/simulator caches (optional). On macOS/iOS repos, prune unused Xcode `DerivedData` and `xcrun simctl delete unavailable`; on all platforms, audit large stale package caches (`node_modules`, `pnpm` store, `uv` cache) only when requested.

This is the one playbook that deletes local working state with no PR review to catch a slip, so steps 1–4 are the review gate.

**Reply:** disk free space before and after with bytes reclaimed, worktrees pruned, and one line per held worktree (why it was kept).
