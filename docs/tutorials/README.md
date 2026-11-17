# Hands-on daily tutorials

Across these tutorials, you follow the complete engineering timeline in order: start daily Jira and Confluence tickets in isolated branches, set up and diagnose repository verification, build new features from rough ideas to approved plans, run pre-PR UI/migration/security audits before pushing, open and babysit PRs through safe landing and release smoke checks, and review colleague PRs at scale. If you want command tables or conceptual reference instead of walkthroughs, read the [AStack User Guide](../user-guide.md) or the 10-part [AStack guide](../guide/README.md).

1. [Ship daily tickets from Jira and Confluence](./01-daily-ticket-workflow.md). Deliver a ticket in an isolated worktree after checking spec alignment with `/in-your-own-words`, switch to a second ticket with `/astack-mode new task.`, and turn a repeated timezone mistake into an automated check with `/correct`.
2. [Set up once and maintain verification skills](./02-setup-and-skill-maintenance.md). Run `/setup-astack` once on a shared service repository, inspect workspace health with `--doctor` and optional `hooks.json` guards, repair drifted startup flags a week later with `/maintain-verification-skill`, and verify a brand-new daily CLI repository with `/control-cli` before setup exists.
3. [Run new features from rough idea to verified code](./03-new-feature-workflows.md). Build a clear CLI flag directly with `/astack-mode`, gate login rate limiting behind `/plan /astack-mode`, clarify an ambiguous audit-log export ticket with `/plan /grill-me /astack-mode`, and approve a shared retry interface with `/architect` checkpoints.
4. [Harden UI, migrations, and security before pushing](./04-pre-pr-audits-and-hardening.md). Audit new UI screens with `/design-audit`, prove zero-downtime schema changes with `safe-migration`, catch auth and secret leaks before push using `/security-audit` (Guidance and Full Audit modes) plus `astack-secret-guard`, and verify tricky state machines formally.
5. [Open PRs, babysit to green, land safely, and verify releases](./05-pr-babysit-and-release.md). Push and open ready PRs with `opening-a-pr`, clear conflicts, bot comments, and CI via `babysit` (`watch-pr.mjs`), land verified stacks bottom-up with `shipping`, and run post-deploy smoke checks plus incident closure with `release-and-postmortem`.
6. [Review colleague PRs at scale with proven findings](./06-reviewing-prs-at-scale.md). Find reproducible bugs on one PR with `/interrogate`, prove serializer safety across downstream callers with `/blast-radius`, map an 800-line unfamiliar PR with `/teach`, triage four morning PRs in parallel with `/fanout`, and audit larger PR queues with `/run-workflow` and `/swarm`.

## Before you start

1. Install AStack with `agy plugin install https://github.com/jmxt3/astack` and select your preferred model or **Orchestrator** in Antigravity by following [Set up astack](../guide/01-setup.md).
2. If your tasks live in Jira and Confluence, install the **Atlassian Teamwork Graph CLI** plugin, `antigravity-plugins-partners/plugin/atlassian-twg-cli`, from the Antigravity Plugins Manager so agents read tickets and spec pages directly without manual copying.

Next: [Ship daily tickets from Jira and Confluence](./01-daily-ticket-workflow.md).
