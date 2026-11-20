# Scheduled PR Triage Automation

This directory provides a dormant Antigravity App automation template (`sidecar.json`) that triages open pull requests on weekday mornings and compiles visual `/review-pr` summaries without editing branches.

## Enable in Antigravity App

1. Run `/automation` in the Antigravity App (or copy `sidecar.json` into `~/.gemini/config/sidecars/astack-pr-triage/sidecar.json`).
2. Select your repository for `repo_dir` and adjust `CRON_TZ=` to your local timezone.
3. Run one manual test turn first to confirm `gh` authentication before toggling the schedule active.
