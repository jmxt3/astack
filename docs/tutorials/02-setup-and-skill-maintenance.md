# Set up once and maintain verification skills

Complete three verification-upkeep workflows in this tutorial. First, you run `/setup-astack` once on a shared service repository named `orders-api`. Second, you repair drifted verification steps a week later with `/maintain-verification-skill`. Third, you build and verify a brand-new daily CLI repository named `csv-sanitizer` without extra setup steps.

## Onboard a shared team repository once with /setup-astack

Suppose your team merges PRs into `orders-api` every day, and the repository does not have a verification skill yet.

1. Confirm that the AStack plugin is installed globally on your machine.

   ```bash
   agy plugin list --json
   ```

   **Visible result.** `astack` appears in the JSON plugin list. Daily `git pull` updates in `orders-api` never require reinstalling the plugin.

2. Open `orders-api` in Antigravity and run [`/setup-astack`](../../skills/setup-astack/SKILL.md).

   ```text
   /setup-astack
   ```

   **Visible result.** Antigravity prints the `ASTACK` ASCII banner showing `verify skills : none`, reports that it inherits your active UI model or **Orchestrator**, and opens an interactive `ask_question` selector.

3. Select **(Recommended) Generate runtime verification skill (/create-verification-skill)** and submit.

   **Visible result.** [`/create-verification-skill`](../../skills/create-verification-skill/SKILL.md) inspects `orders-api`, generates `.agents/skills/verify-orders-api/SKILL.md` and `.agents/skills/verify-orders-api/features/`, starts `orders-api` on an isolated port, exercises each feature live to prove the generated skill works, and stops the server cleanly.

4. Commit `.agents/skills/verify-orders-api/` on a branch and merge it once.

   ```bash
   git add .agents/skills/verify-orders-api
   git commit -m "Add verify-orders-api verification skill"
   ```

   **Visible result.** Running `git ls-files .agents/skills/verify-orders-api` lists the committed verification skill and feature map. Every teammate and future branch now shares those checks without running `/setup-astack` again.

5. Optionally run workspace health diagnostics (`--doctor`) and decide whether to enable [hooks.json](../../hooks.json) safety guards (`astack-secret-guard` for accidental `.env`/key writes, `astack-irreversible-guard` for destructive shell commands, and `astack-verify-reminder` on stop).

   ```bash
   node skills/setup-astack/scripts/setup-banner.mjs --doctor --cwd .
   ```

   **Visible result.** `--doctor` checks Node `>= 22.6.0`, `verify-*` skill freshness against recent commits, opt-in hook status (`0/3` by default), `astack-models.md` overrides, and stale git worktrees read-only with zero changes to your repository.

## Repair drifted verification steps with /maintain-verification-skill

A week after daily merges in `orders-api`, a teammate renames the readiness route from `GET /health` to `GET /readyz` and requires `--port` on startup. Do not run `/setup-astack` again.

1. Pull the latest `main` branch and invoke [`/maintain-verification-skill`](../../skills/maintain-verification-skill/SKILL.md).

   ```bash
   git pull --ff-only
   ```

   ```text
   /maintain-verification-skill
   ```

2. Wait for the parallel source audit and live pass to finish.

   **Visible result.** Read-only `research` subagents inspect source files for every entry in `.agents/skills/verify-orders-api/features/` and flag the `/health` to `/readyz` change and the new `--port` flag. The coordinator then boots `orders-api` live, updates the drifted verification skill files, and re-runs the live check until it passes.

3. Check `git status --short` and read the final outcome, which is `clean`, `changed`, or `blocked`.

   ```bash
   git status --short
   ```

   **Visible result.** Only files inside `.agents/skills/verify-orders-api/` show changes, and product code under `src/` stays untouched. If the live run exposes a real application bug, the skill reports that product defect separately instead of hiding it in docs. Run `/maintain-verification-skill` weekly, via a scheduled `/automation`, or right after changes to startup commands, auth, CLI flags, or core routes.

## Verify a brand-new daily repository without setup overhead

Suppose your Jira ticket today asks you to create and push a brand-new `csv-sanitizer` CLI repository from an empty folder.

1. Create the repository directory and run `/astack-mode` directly to build and test the first version.

   ```bash
   mkdir csv-sanitizer && cd csv-sanitizer && git init
   ```

   ```text
   /astack-mode build a Node 22 CLI bin/sanitize.mjs that strips UTF-8 BOM headers and trims blank trailing rows from CSV stdin. prove it on a dirty sample file via /control-cli and stop before git push.
   ```

   **Visible result.** Even with no `.agents/skills/verify-*` directory present, `/astack-mode` falls back to [`/control-cli`](../../skills/control-cli/SKILL.md) for terminal tools or [`/control-ui`](../../skills/control-ui/SKILL.md) for web apps, runs `bin/sanitize.mjs` in a temp folder, prints exit code `0` and exact output bytes, and cleans up temporary files.

2. Decide whether `csv-sanitizer` will live past today. If teammates will keep extending the repository, run `/setup-astack` once now that `bin/sanitize.mjs` exists and commit `.agents/skills/verify-csv-sanitizer/`. If the repository is a one-day utility that rarely changes, skip `/setup-astack` completely.

Next: [Run new features from rough idea to verified code](./03-new-feature-workflows.md).
