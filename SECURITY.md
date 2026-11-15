# Security Policy

## Supported versions

Security fixes apply to the latest revision on `main` and the active release line declared in [`plugin.json`](./plugin.json).

| Version | Supported |
|---|---|
| `0.2.x` (`main`) | Yes |

## Execution and privacy model

AStack runs locally inside your Google Antigravity environment as static markdown skills, rules, custom agent prompts, and local Node.js 22+ CLI helper scripts:

- **No hosted service or telemetry**: Installing or loading AStack does not start background daemons, open network ports, or phone home.
- **Zero model or credential storage**: AStack relies on the model providers and MCP servers already configured in your Antigravity session.
- **Opt-in lifecycle hooks**: [`hooks.json`](./hooks.json) ships both [`astack-irreversible-guard`](./scripts/hooks/irreversible-guard.mjs) (`PreToolUse`) and [`astack-verify-reminder`](./scripts/hooks/verify-reminder.mjs) (`Stop`) with `"enabled": false` by default.
- **Command guardrails**: When enabled, `astack-irreversible-guard` inspects `run_command` shell strings (unwrapping nested `sh -c`, `bash -c`, `pwsh -Command`, `cmd /c`, and `eval` invocations, scoping SQL `DROP`/`TRUNCATE` away from read-only search commands while catching piped DB clients, and catching trunk refspec pushes such as `+main`, `:main`, and `--delete main`). It returns `{"decision": "force_ask"}` interactively, or `{"decision": "deny"}` in headless `CI=true` / `NON_INTERACTIVE=1` environments. Review any hook script before enabling it in [`hooks.json`](./hooks.json).
- **Dormant automation templates**: Example Slack triage and reproduction packs under [`docs/automations/benny/`](./docs/automations/benny/README.md) are documentation and templates only; nothing executes unless you configure and schedule them yourself.

## Reporting a vulnerability

Do not open a public GitHub issue for security vulnerabilities, command-guard bypasses, or hook injection flaws.

Report issues privately through GitHub Security Advisories:

- **Private report**: https://github.com/jmxt3/astack/security/advisories/new

Include:

1. Affected file path, hook, or CLI script
2. Reproduction steps or minimal input payload
3. Expected behavior vs observed behavior
4. Impact assessment (for example, unintended shell execution or hook bypass)

Maintainers will acknowledge private reports, investigate reproduction steps, and coordinate a fix before public disclosure.
