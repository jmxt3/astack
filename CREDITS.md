# Credits & Lineage

**AStack** (`jmxt3/astack`) is an open-source, verification-first engineering plugin for **Google Antigravity**, built and maintained by **João Machete** ([`@jmxt3`](https://github.com/jmxt3)).

AStack earned its initial foundation from open-source pioneers in agentic engineering and gives explicit credit below.

## Code-Derived Foundation: `pstack` by Lauren Tan (`@poteto`)

- **Repository:** [`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack) (MIT License)
- **Baseline:** `v0.15.36` (commit `3dbd22ff12742fb28c9700b9760baa29ed41dc13`)
- **What AStack derives from `pstack`:**
  - Control Glass runtime verification skills ([`control-ui`](./skills/control-ui/SKILL.md), [`control-cli`](./skills/control-cli/SKILL.md)) and materialized `verify-<app>` Feature Maps ([`create-verification-skill`](./skills/create-verification-skill/SKILL.md), [`maintain-verification-skill`](./skills/maintain-verification-skill/SKILL.md))
  - The 23 engineering playbooks and 24 named engineering principles (`principle-*`) under [`skills/astack-mode/`](./skills/astack-mode/SKILL.md)
  - Code, comment, and prose hygiene passes ([`deslop`](./skills/deslop/SKILL.md), [`no-comments`](./skills/no-comments/SKILL.md), [`unslop`](./skills/unslop/SKILL.md), [`comment-sicko`](./agents/comment-sicko.md))
  - Formal statechart trace checking ([`statechart`](./skills/statechart/SKILL.md)) and automated PR watch loops
  - Lauren Tan's **Deepcoding** and **Loops You Can Trust** engineering philosophy

## Workflow & Gate Inspiration: `gstack` by Garry Tan (`@garrytan`)

- **Repository:** [`garrytan/gstack`](https://github.com/garrytan/gstack) (MIT License)
- **Relationship:** Conceptual inspiration only (no code copied into AStack)
- **Ideas that influenced AStack:**
  - Multi-lens pre-build review gates before locking in structure
  - Real-browser QA treated as a non-negotiable shipping gate
  - Explicit safety guardrails on irreversible actions and structured sprint workflows over ad-hoc prompting

## Security Audit Foundation: `security-audit-skill` by Cloudflare (`@cloudflare`)

- **Repository:** [`cloudflare/security-audit-skill`](https://github.com/cloudflare/security-audit-skill) (MIT License)
- **Baseline:** `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (2026-09-14)
- **What AStack adapts from `cloudflare/security-audit-skill`:**
  - Dual operating modes (`Guidance` and `Full Audit`), 6-phase coverage-led reconnaissance, hunting, adversarial validation, structured output, record verification, and target-neutral reporting
  - Deterministic `coverage-ledger.json` canonical unit state machine, three-branch `findings.json` contract (`confirmed`, `needs_validation`, `rejected`), `report-schema.json`, and zero-dependency Node validators (`validate-findings.cjs` and `validate-coverage-ledger.cjs`)
  - `ATTACK-CLASSES.md` and the 10 domain companion references placed under [`skills/security-audit/references/`](./skills/security-audit/references/ATTACK-CLASSES.md), paired natively with Antigravity `invoke_subagent`, `/swarm`, the 3-Tier Adaptive Sandbox runner, and [`security-audit`](./skills/security-audit/SKILL.md) remediation handoffs

## Google Antigravity Platform

AStack integrates natively with Antigravity platform primitives without duplicating or shadowing built-in commands:

- Dynamic bidirectional model routing via **Orchestrator** (`Carbon` and `Argon` planners paired with `Hydrogen` execution)
- Native **Subagents** (`invoke_subagent`), `/swarm`, `/run-workflow`, `/boost`, `/teamwork`, `/goal`, `/schedule`, and `/automation`
- Interactive `/plan` and `/grill-me` contracts built around `ask_question` cards, `Artifacts`, inline line comments, and the **Proceed** approval gate
- Lifecycle hooks (`PreToolUse` and `Stop`) implemented in zero-dependency Node.js 22+

## From `v0.1` Sync to Read-Only Upstream Watch

AStack `v0.1.0` shipped `scripts/sync-upstream.mjs` and `scripts/UPSTREAM.json` to mirror `pstack` files while protecting overlays. Starting in `v0.2.0`, AStack evolves independently for Google Antigravity:

- All catalog invariants and manual-only frontmatter rules live natively in [`scripts/catalog.mjs`](./scripts/catalog.mjs) and [`scripts/catalog.json`](./scripts/catalog.json).
- Upstream tracking moved to [`scripts/upstream-watch.mjs`](./scripts/upstream-watch.mjs) and [`scripts/upstream-watch.json`](./scripts/upstream-watch.json), a strictly read-only CLI that watches `pstack`, `gstack`, and `cloudflare/security-audit-skill` in an OS temp cache so helpful ideas can be adapted deliberately with attribution.
- All copyright notices in [`LICENSE`](./LICENSE) (Lauren Tan, João Machete, and Cloudflare, Inc.) remain preserved verbatim under the MIT License.
