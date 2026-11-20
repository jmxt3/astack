---
name: audit-architecture
description: "Scan the repository for .agents/boundaries.json violations, Ousterhout shallow modules, and stale workaround examples agents might copy, then grill refactoring candidates into vertical slices. Use for /audit-architecture."
disable-model-invocation: true
---

# Architecture and Repo Gardening Audit (`/audit-architecture`)

Combine deep-module inspection (`improve-codebase-architecture`) with structural boundary rules (`.agents/boundaries.json`) and stale-example cleanup so agents stop copying accidental complexity.

## 1. Run Deterministic Audit

Run [`scripts/arch-audit.mjs`](./scripts/arch-audit.mjs) from the repository root:

```bash
node "<skill-dir>/scripts/arch-audit.mjs" --cwd . --json
```

If `.agents/boundaries.json` is missing, point out that boundary enforcement is unconfigured and offer `/setup-astack` (`init-repo-policy.mjs`) to scaffold it.

## 2. Triage Top Candidates

Group the findings into three buckets:
1. **Boundary and banned-pattern violations.** Modules crossing declared zone fences or using banned primitives.
2. **Shallow modules and pass-throughs.** Files with wide export lists and thin implementation bodies that force callers to wire internals (`design-red-flags.md`).
3. **Repo gardening targets.** Suppressions (`eslint-disable`, `@ts-ignore`), `TODO(hack)` comments, and zero-delay timer shims (`setTimeout(..., 0)`) that teach future agents bad conventions.

## 3. Grill and Slice Vertically

Before editing code, pick one top candidate with the user via `/grill-me` (one question at a time via `ask_question`), agree on the target deep module shape using `GLOSSARY.md` domain terms, and break the refactor into small vertical slices (`<= 5` files each) plus one permanent `.agents/boundaries.json` or lint rule (`/correct`) so the bad pattern cannot return.
