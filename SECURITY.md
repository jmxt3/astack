# Security Policy

## Supported versions

Security fixes apply to the latest revision on `main` and the active release line declared in [`plugin.json`](./plugin.json).

| Version | Supported |
|---|---|
| `0.4.x` (`main`) | Yes |

## Execution and privacy model

AStack runs locally inside your Google Antigravity environment as static markdown skills, rules, custom agent prompts, an optional local sidecar UI, and local Node.js 22+ CLI helper scripts:

- **No hosted service or telemetry**: Installing or loading AStack phones home to zero external servers and stores no credentials. When you enable the optional [`AStack Timeline`](./sidecars/astack_timeline/sidecar.json) sidecar panel, Antigravity launches one read-only localhost HTTP server on `127.0.0.1` that reads local transcripts and `astack-trust` receipts without mutating files or sending agent prompts.
- **Zero model or credential storage**: AStack relies on the model providers and MCP servers already configured in your Antigravity session.
- **Split-default lifecycle hooks**: [`hooks.json`](./hooks.json) enables two passive observe-only hooks by default (`astack-receipt-ledger` and `astack-session-context`) and keeps all six blocking gates (`astack-irreversible-guard`, `astack-secret-guard`, `astack-verify-reminder`, `astack-evidence-gate`, `astack-boundary-guard`, and `astack-round-limiter`) `"enabled": false` until opted in.
- **Base-branch governance isolation**: [`pr-dossier.mjs`](./skills/review-pr/scripts/pr-dossier.mjs) and `astack-session-context` read `REVIEW.md`, `GLOSSARY.md`, and `.agents/risk-policy.json` strictly from the git base ref (`git show <base>:...`), classify edits to `.agents/**` and `REVIEW.md` as Risk Tier 3, and block PR auto-merge if base governance files change.
- **Command guardrails**: When enabled, `astack-irreversible-guard` inspects `run_command` shell strings (unwrapping nested `sh -c`, `bash -c`, `pwsh -Command`, `cmd /c`, and `eval` invocations, scoping SQL `DROP`/`TRUNCATE` away from read-only search commands while catching piped DB clients, and catching trunk refspec pushes such as `+main`, `:main`, and `--delete main`). It returns `{"decision": "force_ask"}` interactively, or `{"decision": "deny"}` in headless `CI=true` / `NON_INTERACTIVE=1` environments. Review any hook script before enabling it in [`hooks.json`](./hooks.json).
- **Dormant automation templates**: Example Slack triage, PR triage, and weekly `/correct` templates under [`docs/automations/`](./docs/automations/beacon/README.md) are documentation and templates only; nothing executes unless you configure and schedule them yourself.

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
