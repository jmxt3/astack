---
name: security-audit
description: Coverage-led security guidance, PR-diff boundary checks, and 6-phase vulnerability audits for codebases, APIs, CLIs, libraries, AI/LLM tools, and daemons. Use for security audits, threat models, vulnerability hunting, or PR security reviews.
license: MIT
---

# Security Audit

Find vulnerabilities that violate a real trust boundary, then deliver source evidence, bounded local reproduction, priority, and the smallest effective fix. This is a defensive, source-first workflow. A candidate without a concrete affected principal, resource, or security outcome is never a confirmed finding.

## Operating modes

This skill defaults to **Guidance mode**. Loading it does not authorize a full multi-phase audit or create report directories.

- **Guidance mode**: Use for security questions, PR diff boundary reviews, threat-model walkthroughs, or focused single-endpoint checks. Apply only relevant blocks from [`references/ATTACK-CLASSES.md`](./references/ATTACK-CLASSES.md) and domain companions without creating output folders or running all six phases.
- **Full audit mode**: Run all six phases and write report artifacts only when the user explicitly requests a codebase security audit, pen test, end-to-end security review, or report artifacts.

If intent is ambiguous, call `ask_question` with unnumbered options (no manual `"Other"` choice, `(Recommended)` first):

- `(Recommended) Guidance mode: review only the named diff, question, or boundary with zero artifact clutter`
- `Full audit mode (quick): bounded single-wave audit with fresh independent verifier`
- `Full audit mode (standard): full 6-phase coverage-led audit with coverage critics and independent Phase 3 + Phase 5 verifiers`

## Antigravity orchestration

- **Parent coordinator**: Owns `run-metadata.json`, `architecture.md`, `coverage-ledger.json`, `findings.json`, final reports, and parent-side artifact promotion.
- **Reconnaissance & coverage critics**: Launch `invoke_subagent` with `TypeName: "research"` (`Model: "flash"`). Return structured facts only; never write files.
- **Hunters & Phase 3 candidate verifiers**: Launch `invoke_subagent` with `TypeName: "astack-agent"` or `"self"` (omit `Model` so workers inherit your active UI model or **Orchestrator**), using isolated `scratch/` directories per agent. For large targets spanning 4 or more subsystems, escalate to native `/swarm` (`workspace: "inherit"` read-only on target source, disjoint `scratch/` directories per agent).
- **Phase 5 final record verifiers**: Launch `invoke_subagent` with `TypeName: "research"` (omit `Model` to inherit the active frontier/Orchestrator setting for strict verification).

## Native Antigravity execution & isolation

Keep security reviews lightweight, local, and safe using Antigravity's built-in boundaries with zero external container daemons or servers:

- **Read-only subagent sandbox (`TypeName: "research"`)**: Antigravity natively runs `research` subagents in a read-only sandbox with no network access. Use `research` for Reconnaissance (`Agent 1a` to `1d`), coverage critics, and Phase 5 final record verification.
- **Trusted local projects (your own repository)**: When auditing your own codebase inside Antigravity's native Terminal Sandbox (`Default` or `Auto` permission presets, or `agy --sandbox`), run only small offline tests or bounded local checks (`node --test`, `pytest`, [`control-cli`](../control-cli/SKILL.md), [`control-ui`](../control-ui/SKILL.md)) with clean environment variables, explicit timeouts, and dummy fixtures.
- **Untrusted code or unisolated hosts (`needs_validation` fallback)**: Whenever auditing untrusted third-party code or running without OS-enforced network, environment, and filesystem isolation (`Turbo`, `Request Review`, or hosts where native terminal sandboxing is inactive), execute **zero** target-controlled code (`method: "source"` only) and record dynamic hypotheses as `needs_validation` with exact local or owner-observed validation plans.

Use dummy principals, fixtures, and secrets only. Never probe deployed endpoints, external services, shared infrastructure, production accounts, or paid APIs. Stop at the minimum local boundary result.

## Full audit setup & write isolation

In full audit mode, resolve these before Phase 1:

- **Skill directory**: Absolute directory containing this `SKILL.md`.
- **Target**: Absolute repository root under review.
- **Output directory**: New writable directory outside the target, defaulting to `path.join(os.homedir(), "astack-security-audit", repoName, "run-<N>")` where `<N>` is the next unused integer. Write inside the target repository only when the user explicitly selects a path verified to be gitignored.
- **Source ref**: Checked-out commit SHA and whether the worktree is dirty.

The parent is the sole writer of shared root files (`run-metadata.json`, `architecture.md`, `coverage-ledger.json`, `findings.json`, `REPORT.md`, `FINDINGS-DETAIL.md`, `NEEDS-VALIDATION.md`). Each hunter or verifier receives `<output-dir>/agents/<agent-id>/` with writable `scratch/` and parent-owned `artifacts/`. Canonical IDs match `^[a-z0-9][a-z0-9_-]{0,63}$` and must not equal Windows reserved names (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`). Never fall back to `/tmp` or host `$HOME` as target scratch.

Before running any bounded local check inside an OS-enforced sandbox, predeclare allowed scratch-relative paths and byte limits, discard `scratch/` if a process times out, and promote outputs afterward only via trusted parent-side verification (if OS sandboxing or race-safe promotion is unavailable, retain `needs_validation`):

```text
Artifact promotion procedure (trusted parent-side code only):
Reference only for you: the parent performs these steps; you never perform them.

Before execution, the parent opens and retains trusted, non-inheritable directory
descriptors for the agent's scratch/ and artifacts/ roots, and records an allowlist
of expected scratch-relative artifact files plus explicit per-file and cumulative
byte limits. Never pass those descriptors to the agent or sandbox. After the sandbox
and all its processes terminate, trusted parent-side code promotes each allowlisted
file separately:

1. Validate the declared relative path: reject absolute, empty, `.`, `..`, or
   symlinked components.
2. Walk each parent component from the retained scratch-root descriptor with
   no-follow directory-relative operations; never reopen by path.
3. Open the leaf no-follow and nonblocking.
4. Verify with `fstat` that it is a regular file with link count exactly one and
   within the recorded per-file and cumulative byte limits.
5. Enforce those limits again while reading from that descriptor.
6. Copy exactly the verified size, repeat `fstat`, and reject a changed identity,
   type, link count, or size.
7. For the destination, walk every parent component from the retained
   artifacts-root descriptor with no-follow directory-relative operations; require
   each existing component to be a real directory, and create any missing directory
   exclusively before reopening and verifying it no-follow.
8. Create the leaf exclusively without following links, verify that the opened
   destination is a regular file with link count exactly one, and copy from the
   verified source descriptor without reopening either path.
9. Use equivalent race-safe APIs on non-POSIX systems.
10. Never recursively copy or glob scratch, extract an archive into artifacts, or
    open or promote a symlink, FIFO, socket, device, directory, hard-linked file,
    changing file, or file that exceeds its bound.
11. If any check is unavailable, cannot be enforced, or fails, discard the scratch
    entry; if it is decisive evidence, retain `needs_validation` with the exact
    promotion blocker.
```

Write `run-metadata.json` before delegation with `run_id`, `repo`, `target`, `source_ref`, `profile`, `scope_paths`, `budget`, `execution_policy`, `selected_companions`, `prior_runs`, `shared_file_owners`, and `run_status: "in_progress"`.

## Profiles, prior runs & budget gate

- **Profiles**: `quick` (coarsened `profile/quick/all-in-scope-subsystems`, one hunter wave, one final critic, single combined Phase 3+5 verifier per candidate), `standard` (default 6-phase flow), `deep` (per-subsystem and lifecycle splits, critic loops to clean pass, separate Phase 3 and Phase 5 verifiers, independent re-pass on `prior_covered_same_source`). Scoped runs mark excluded surfaces `out_of_scope` rather than `covered`.
- **Prior runs**: Read compatible prior `coverage-ledger.json` and `findings.json`. Re-verify unchanged carried `confirmed` records through Phase 3+5 rather than trusting stale commits; turn changed-source records, prior `needs_validation`, `deferred`, `blocked`, and `out_of_scope` units into active planned work.
- **Strict budget gate**: When `budget` is set, reserve 4 Recon calls, mandatory critic calls (1 final for `quick`; 1 post-wave + 1 final-clean per wave for `standard`/`deep`), and ~30% validation reserve before assigning Wave 1 hunters. If budget exhausts mid-run, record `run_status: "incomplete"` with exact `incomplete_reason` (`budget_cannot_fund_reconnaissance_and_reserves`, `critic_budget_exhausted`, `budget_cannot_reserve_critics_and_validation`, or `validation_budget_exhausted`) and disclose gaps in Phase 6.

## Core principles & severity calibration

- **Require a boundary and result**: Name the lower-trust principal, accepted input, intended control, crossed boundary, affected principal or resource, and observed result. Do not report checklist deviations or defense-in-depth notes as vulnerabilities.
- **Separate certainty from priority**: Only `confirmed` records carry severity. `needs_validation` captures a specific blocked source-grounded boundary hypothesis and carries **zero severity**. `rejected` records failed claims so later passes do not repeat them.
- **Severity anchors** (capped at demonstrated impact):
  - **critical**: unauthenticated RCE, full data-store read/write, or arbitrary account takeover.
  - **high**: full defeat of an explicit security control (auth bypass, cross-tenant read/write, stored XSS across users, authenticated RCE, unauthenticated remote service stop).
  - **medium**: limited-blast-radius or uncommon-precondition boundary breach.
  - **low**: non-secret internals or minimal-gain effort.
  - **informational**: confirmed minimal-impact prerequisite.

## 6-Phase full audit workflow

1. **Reconnaissance** ([`references/RECONNAISSANCE.md`](./references/RECONNAISSANCE.md)): Run 4 parallel `research` explorers (`Agent 1a` to `1d`), synthesize `<output-dir>/architecture.md` (~1,000-word cap), seed canonical RFC-3986 `coverage-ledger.json`, and run `node <skill-dir>/scripts/validate-coverage-ledger.cjs <output-dir>/coverage-ledger.json`.
2. **Coverage-led hunting waves** ([`references/HUNTING.md`](./references/HUNTING.md), [`references/ATTACK-CLASSES.md`](./references/ATTACK-CLASSES.md)): Assign isolated hunters (`astack-agent` / `self`), copy selected domain companion blocks verbatim ([AI/LLM](./references/AI-AND-LLM.md), [Web & Auth](./references/WEB-PROTOCOL-AND-AUTH.md), [Client-Side](./references/CLIENT-SIDE.md), [Supply Chain](./references/SUPPLY-CHAIN-AND-RELEASE.md), [Cloud](./references/CLOUD-AND-DEPLOYMENT.md), [Protocols/RPC](./references/PROTOCOLS-RPC-AND-MESSAGING.md), [Resource Exhaustion](./references/RESOURCE-EXHAUSTION-AND-AVAILABILITY.md), [Data Lifecycle](./references/DATA-ISOLATION-AND-LIFECYCLE.md), [Desktop/Mobile/IPC](./references/DESKTOP-MOBILE-AND-LOCAL-IPC.md), [Memory Safety](./references/MEMORY-SAFETY-AND-BINARY.md)), update the ledger, and run `research` coverage critics.
3. **Candidate validation** ([`references/VALIDATION-AND-REPORTING.md`](./references/VALIDATION-AND-REPORTING.md)): Send every unique candidate fingerprint to a fresh verifier trying to refute it.
4. **Structured output**: Write sorted `findings.json` matching [`scripts/report-schema.json`](./scripts/report-schema.json) and pass both `validate-findings.cjs` and `validate-coverage-ledger.cjs`.
5. **Independent record verification**: Verify every final `confirmed` and `needs_validation` record with fresh `research` reviewers; send material replacements through another independent verifier.
6. **Target-neutral report**: Emit `REPORT.md`, `FINDINGS-DETAIL.md`, and `NEEDS-VALIDATION.md` from verified records without live-probe guidance or unvalidated claims.

When presenting audit results inside the Antigravity App, you may pair `REPORT.md` with a compact `/generative_ui` posture card (loading the built-in `generative_ui` skill for verified counts, severity distribution, and `needs_validation` blockers; fall back to Markdown tables in CLI).

## AStack remediation & verification bridge

The security audit itself never edits target source (`method: "source"` + read-only bounded `scratch/` verification only). Once Phase 6 finishes (or Guidance mode surfaces a concrete defect) and the user approves fixing findings:

1. Hand off `confirmed` findings (plus resolved `needs_validation` items) into [`/astack-mode`](../astack-mode/SKILL.md) (`playbooks/bug-fix.md` and [`/tdd`](../tdd/SKILL.md)).
2. Write the smallest boundary fix enforcing the missing invariant and add a regression check in the local test suite, [`control-cli`](../control-cli/SKILL.md), [`control-ui`](../control-ui/SKILL.md), or `.agents/skills/verify-<app>/`.
3. For recurring vulnerability classes, invoke [`/correct`](../correct/SKILL.md) to push prevention into types, lints, CI, or rules so the class cannot recur.
