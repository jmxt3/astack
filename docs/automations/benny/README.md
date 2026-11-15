# benny

benny gives you two antigravity automations for slack issue reports. one triages each report. the other reproduces confirmed bugs and may prepare a small draft fix.

the files in this directory are dormant setup and automation sources. they do not appear as slash skills.

## set it up

1. point antigravity at [`FOR_AGENTS.md`](./FOR_AGENTS.md) and name the target repository.
2. let setup merge this whole directory into the target at `.agents/automations/benny/`. it must preserve destination-only files and review conflicts instead of overwriting local edits.
3. let setup confirm that **astack** (`astack`) is installed and enabled (`agy plugin list --json`) for shared dependencies (`how`, `why`, `tdd`, `unslop`, `control-ui`, `control-cli`, and the required principle skills).
4. keep user-owned configuration outside the copied pack, for example in `.agents/benny/`. adapt [`configuration.example.yaml`](./templates/configuration.example.yaml) and [`feature-map.example.md`](./skills/reproduce-and-fix-issues/references/feature-map.example.md).
5. commit `.agents/automations/benny/` and any secret-free configuration before enabling either automation.
6. wire both automation runners (via Antigravity `/automation` writing a dormant `sidecar.json` with `CRON_TZ=` in the App, **Remote Agents** via `agy --remote-agent`, headless `agy -p` webhook/CI listeners, or in-session `/schedule`) to read those committed paths. for App `/automation`, keep the entry dormant until an interactive test pass grants tool permissions and you toggle it on in the Automations tab; then send a harmless test report and verify every source-channel post stays in the original thread.
