### Security audit

**You own evidence-backed trust-boundary verification. Keep the audit read-only on target source until the user approves remediation.**

1. **Choose operating mode (`Guidance` vs `Full audit`).** Use **Guidance mode** by default for PR-diff boundary checks, threat questions, or single-endpoint reviews (avoiding output directory clutter). Enter **Full audit mode** (`quick`, `standard`, or `deep`) when the user requests a codebase security audit, pen test, or report artifacts. Follow [`../../security-audit/SKILL.md`](../../security-audit/SKILL.md).
2. **Probe execution isolation first.** Run `node skills/security-audit/scripts/sandbox-runner.mjs --probe --json` (or `<skill-dir>/scripts/sandbox-runner.mjs --probe --json`). Use Tier 2 (`opensandbox`) or empirically verified Tier 1 (`antigravity-terminal-sandbox`) for bounded local checks; fail closed to Tier 0 (`needs_validation`) whenever isolation is unverified.
3. **Preserve independent validation.** In Full audit mode, follow all six phases verbatim (`Reconnaissance` -> `Coverage-led hunting` + coverage critics -> fresh Phase 3 refutation -> `validate-findings.cjs` + `validate-coverage-ledger.cjs` -> fresh Phase 5 verification -> Phase 6 reporting). Never trust hunter prose without schema validation and independent review.
4. **Bridge approved fixes into AStack.** After the audit completes and the user asks to remediate findings, switch cleanly to `playbooks/bug-fix.md` + `/tdd`, prove each boundary fix live via `control-cli` / `control-ui` / `verify-<app>`, run `/deslop` and `/no-comments`, and run `/correct` if the flaw represents a recurring repo pattern.

**Reply:** mode used, sandbox tier, verified `confirmed` / `needs_validation` / `rejected` counts (or PR-diff boundary findings), validator pass status, artifact output path (if full audit), and next remediation options.
