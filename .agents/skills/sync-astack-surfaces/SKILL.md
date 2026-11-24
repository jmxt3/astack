---
name: sync-astack-surfaces
description: "Project pre-ship audit skill for the astack repository: checks whether skills, native Antigravity commands, playbooks, or agents changed and verifies timeline UI, user guides, help catalog, and verification maps stay synchronized. Use before opening PRs, shipping releases, or touching command catalogs."
---

# Sync AStack Command Surfaces

Keep the AStack Timeline sidecar UI, user guides, `/astack-help`, and `.agents/skills/verify-astack/` synchronized with real skills, playbooks, agents, and Google Antigravity's native slash commands before shipping any change in this repository.

## Workflow

1. **Run the surface audit CLI.**
   Execute the audit script against the base branch:

   ```bash
   node .agents/skills/sync-astack-surfaces/scripts/audit-surfaces.mjs --base origin/main --json
   ```

   Confirm `ok: true`, `validationErrors: []`, and `unknownSlashCommands: []`.

2. **Check Antigravity's native command list on releases or routing edits.**
   Inspect `<appDataDir>/builtin/skills` or check `https://antigravity.google/docs/commands/` when preparing a release or changing routing. If Antigravity added, renamed, or deprecated a native command, update:
   - `scripts/catalog.mjs` (`EXPECTED_NATIVE_COMMANDS`, `BUILTIN_RESERVED_SKILL_NAMES`)
   - `skills/astack-mode/references/native-commands.json`, then regenerate Markdown with `node scripts/validate-astack.mjs --write-native-commands`

3. **Review changed command surfaces when `changedSurfaces` is non-empty.**
   Whenever any skill, playbook, agent, hook, or native command is added, renamed, deprecated, or removed, verify and update every surface below:
   - **Timeline UI (`sidecars/astack_timeline/`)**: `command-catalog.json`, `timeline-engine.mjs`, `app.js`. Keep `invocable: false` on internal scripts and agents so the UI never displays them as copyable slash commands.
   - **Plugin counts & catalog**: `scripts/catalog.json`, `plugin.json`, `README.md`, `skills/astack-help/SKILL.md`, `rules/astack-orchestration.md`.
   - **Guides & verification maps**: `docs/agent-timeline.md`, `docs/user-guide.md`, `docs/architecture-and-swarm.md`, `docs/guide/README.md`, `docs/guide/01-setup.md`, `docs/guide/09-make-it-yours.md`, and `.agents/skills/verify-astack/`.

4. **Re-run all structural and runtime checks after the final edit.**

   ```bash
   node .agents/skills/sync-astack-surfaces/scripts/audit-surfaces.mjs --json
   node --run validate
   node --run test:sidecar
   node skills/audit-architecture/scripts/arch-audit.mjs --cwd . --strict --json
   ```

5. **Include observed surface sync telemetry in the PR proof.**
   Report the exact command counts (`skills`, `nativeCommands`, `playbooks`, `agents`, `hooks`), `changedSurfaces` summary, and audit exit status in your reply and PR verification section.
