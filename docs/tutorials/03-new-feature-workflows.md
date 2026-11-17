# Run new features from rough idea to verified code

Pick and run the right entry command across four new-feature workflows. You build a clear CLI flag directly with `/astack-mode`, gate login rate limiting behind `/plan /astack-mode`, clarify an ambiguous audit-log export ticket with `/plan /grill-me /astack-mode`, and approve a shared retry interface with `/architect` checkpoints.

## Build a clear feature directly with /astack-mode

Suppose Jira ticket `OPS-88` specifies adding `--dry-run` to `prune-sessions` so it prints how many expired rows match without deleting them. The requirements have zero open questions.

1. Create a clean branch and send your goal with an observable done check to [`/astack-mode`](../../skills/astack-mode/SKILL.md).

   ```bash
   git checkout -b feat/ops-88-dry-run
   ```

   ```text
   /astack-mode add --dry-run to prune-sessions so it prints "Would delete N expired sessions", deletes zero rows, and exits 0. prove row counts before and after both --dry-run and real runs via /control-cli, and stop before git push.
   ```

2. Inspect the completed reply and commit diff.

   **Visible result.** Under **Orchestrator**, the planner inspects callers read-only first, then runs the [Feature playbook](../../skills/astack-mode/playbooks/feature.md). The agent automatically runs `/deslop` and `/no-comments` before committing, pastes terminal output proving the row count stays unchanged under `--dry-run` and drops on a normal run, and leaves clean local commits ready for `git push`.

## Gate edits behind plan approval with /plan /astack-mode

Suppose ticket `AUTH-204` adds per-IP login rate limiting where five failed attempts within 15 minutes return HTTP `429` with a `Retry-After` header. The spec is clear, and you want to approve the file list and test plan before any code changes.

1. Send the stacked `/plan` and `/astack-mode` prompt following [Native Planning and Learning Contracts](../../skills/astack-mode/references/plan-contract.md).

   ```text
   /plan /astack-mode add per-IP login rate limiting on POST /api/login: return HTTP 429 with Retry-After after 5 failed attempts within 15 minutes, and reset on successful login.
   ```

2. Inspect `implementation_plan.md` in Antigravity's artifact panel and verify the working tree is untouched.

   ```bash
   git status --short
   ```

   **Visible result.** `implementation_plan.md` opens with `Goal Description`, `Proposed Changes` marked `[NEW]` and `[MODIFY]`, a Mermaid dependency flowchart, and `Verification Plan` including the embedded post-approval finish gates, while `git status --short` prints nothing because zero workspace files changed.

3. Highlight any step in `implementation_plan.md` to leave an inline review comment before approving. For example, ask for an injectable clock parameter so tests simulate the 15-minute window in milliseconds without sleeping.

4. Click **Proceed** on `implementation_plan.md`, or reply with `approved`.

   ```text
   approved
   ```

   **Visible result.** The post-approval finish gates embedded in `implementation_plan.md` automatically fold in your inline comment, execute the tasks in dependency order, prove the live HTTP `429` flow, run `/deslop` and `/no-comments`, write `walkthrough.md`, and stop at clean local commits before `git push`. Reply `approved, open the PR` instead if you want AStack to push and open the PR automatically.

## Clarify an ambiguous ticket first with /plan /grill-me /astack-mode

Suppose Confluence has a two-line stub for `ADM-310` asking to let workspace admins export audit logs. The export format, maximum row limit, and email-masking rules for deleted users are still undecided. Notice the hyphen in `/grill-me`.

1. Send the three-part stacked prompt.

   ```text
   /plan /grill-me /astack-mode implement ADM-310: let workspace admins export audit logs from the admin settings page.
   ```

2. Answer each interactive question card one turn at a time.

   **Visible result.** `/grill-me` reads your existing admin routes and `audit_logs` schema first so it never asks what the code already answers. It then presents one `ask_question` card per turn, such as choosing `(Recommended) Stream NDJSON and CSV` or picking a `90-day` window cap, where each answer shapes the next question.

3. Review `implementation_plan.md` once the interview ends.

   **Visible result.** Every decision from your answers appears inside `Proposed Changes` and `Verification Plan`, and zero workspace files have changed yet.

4. Click **Proceed** on `implementation_plan.md`, or reply `approved`.

   **Visible result.** Clicking **Proceed** automatically implements the agreed design, verifies the admin export flow in the browser via [`/control-ui`](../../skills/control-ui/SKILL.md), runs `/deslop` and `/no-comments`, writes `walkthrough.md`, and pauses at local commits before `git push` with zero extra prompt text.

## Compare API boundaries first with /architect checkpoints

Suppose ticket `PLAT-77` adds a shared webhook retry-policy module imported by both `packages/http-api` and `packages/worker`. Getting that module boundary wrong forces edits across two packages later.

1. Run [`/architect`](../../skills/architect/SKILL.md) with `with checkpoint` so execution stops after design comparison.

   ```text
   /architect design a shared webhook retry-policy contract imported by packages/http-api and packages/worker. with checkpoint. compare candidate designs, screen for red flags, write the TypeScript type sketch and rationale, and stop for my approval before implementing.
   ```

2. Inspect the candidate comparison and TypeScript type sketch.

   **Visible result.** `/architect` explores competing shapes in parallel, screens them against [design-red-flags.md](../../skills/architect/references/design-red-flags.md) for information leakage, shallow wrappers, and pass-through arguments, recommends one TypeScript interface, and edits zero files.

3. Reply `approved` to build and verify both packages, or `approved, open the PR` if you want AStack to push and open the PR as well.

   ```text
   approved
   ```

   **Visible result.** Both `packages/http-api` and `packages/worker` build on the approved interface, pass live checks, run `/deslop` and `/no-comments`, and stay at clean local commits until you push.

Next: [Harden UI, migrations, and security before pushing](./04-pre-pr-audits-and-hardening.md).
