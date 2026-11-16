# Ship daily tickets from Jira and Confluence

Complete two everyday ticket workflows in this tutorial. First, you deliver invoice-export ticket `BILL-142` from Confluence acceptance criteria to a verified local commit in an isolated worktree. Second, you switch cleanly to afternoon ticket `BILL-149` and convert a recurring UTC date bug into an automated check.

## Deliver a daily ticket from spec to local commit

Suppose Jira ticket `BILL-142` asks you to add a `--since YYYY-MM-DD` filter to `export-invoices` while keeping unfiltered CSV output byte-identical, based on rules on a Confluence spec page.

1. Create a dedicated git worktree and branch from `main`, then open the new folder in a fresh Antigravity chat.

   ```bash
   git worktree add ../billing-bill-142 -b feat/bill-142 main
   ```

   **Visible result.** Running `git branch --show-current` inside `../billing-bill-142` prints `feat/bill-142`. Files, build outputs, and local ports stay isolated from any other ticket you work on today.

2. Check that the agent reads the spec accurately before any code edits by running [`/in-your-own-words`](../../skills/in-your-own-words/SKILL.md). Reference the Jira key if Atlassian Teamwork Graph CLI is connected, or paste the ticket summary and Confluence acceptance rules directly.

   ```text
   /in-your-own-words Read BILL-142 and its linked Confluence spec. Restate the goal, inclusive or exclusive date boundary, and invalid-date exit code without editing any files.
   ```

   **Visible result.** The agent states the goal, the inclusive UTC date boundary, and the exit code `2` rule in plain sentences, and `git status --short` prints nothing. If the restatement misses an edge case, reply in one sentence to correct it before any code exists.

3. Build, clean, and verify the ticket live with [`/astack-mode`](../../skills/astack-mode/SKILL.md).

   ```text
   /astack-mode implement BILL-142: add --since YYYY-MM-DD to export-invoices using inclusive UTC dates and exit 2 on invalid dates. keep unfiltered CSV output byte-identical, prove all three cases live with /control-cli on a sample fixture, and stop before git push.
   ```

   **Visible result.** `/astack-mode` loads the [Feature playbook](../../skills/astack-mode/playbooks/feature.md), creates a todo checklist, implements the filter, runs [`/control-cli`](../../skills/control-cli/SKILL.md) in an isolated temp folder, automatically runs [`/deslop`](../../skills/deslop/SKILL.md) and [`/no-comments`](../../skills/no-comments/SKILL.md) before committing, and pauses before pushing.

4. Inspect the local commit and the pasted terminal proof from the reply, then push the branch.

   ```bash
   git log -1 --stat
   git push -u origin feat/bill-142
   ```

   **Visible result.** `git log -1 --stat` shows only the files needed for `BILL-142`, and the remote branch updates only after you review the evidence.

## Switch to a second ticket and stop a repeat mistake

Later that day, you pick up `BILL-149` to reject `--since` dates in the future. During review, you also notice a recurring team mistake where `new Date("2026-11-15")` and local date constructors shift midnight by the machine timezone.

1. Create a fresh branch from `main`. If you stay in the same chat window, pass `new task.` so `/astack-mode` clears the previous playbook state as described in [Route work through `/astack-mode`](../guide/02-astack-mode.md).

   ```bash
   git checkout -b feat/bill-149 main
   ```

   ```text
   /astack-mode new task. implement BILL-149: reject future --since dates in export-invoices with exit code 2 and a clear stderr message. prove today passes and tomorrow fails via /control-cli, and stop before git push.
   ```

   **Visible result.** The `new task.` prefix resets sticky playbook tracking and opens a fresh checklist for `BILL-149`, followed by live output showing today passing and tomorrow exiting `2`.

2. Turn the recurring UTC mistake into a permanent check using [`/correct`](../../skills/correct/SKILL.md).

   ```text
   /correct agents keep parsing YYYY-MM-DD CLI flags with local-timezone Date constructors instead of a strict UTC date parser.
   ```

   **Visible result.** Following `principle-encode-lessons-in-structure`, `/correct` adds a typed parser or lint check, or stages `learning_proposal.md` via `/learn` when a repository rule is needed. It then proves the new check fails against a local-timezone call before passing on the fixed code.

Next: [Set up once and maintain verification skills](./02-setup-and-skill-maintenance.md).
