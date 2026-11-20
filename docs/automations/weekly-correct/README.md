# Weekly Correction Compiler Automation

This directory provides a dormant Antigravity App automation template (`sidecar.json`) that turns recurring PR review feedback and reverts into permanent structural checks via `/audit-architecture` and `/correct`.

## Enable in Antigravity App

1. Run `/automation` in the Antigravity App (or copy `sidecar.json` into `~/.gemini/config/sidecars/astack-weekly-correct/sidecar.json`).
2. Bind `repo_dir` to your repository and adjust `CRON_TZ=` to your timezone.
3. Keep automated proposals read-only until reviewed and merged through your standard PR gate.
