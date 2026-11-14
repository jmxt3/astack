---
name: arena
description: "Competitive multi-approach / multi-model bakeoff: spin up independent candidate implementations or architectures in isolated workspaces, pit them against the same empirical proof and red-flag screen, pick one winner, graft concrete strengths, and land verified code."
---

# Arena

When ambiguity is architectural, algorithmic, or high-leverage enough that picking the wrong abstraction early costs 10x later, don't guess linearly — run a structured bakeoff, prove candidates empirically, pick **one clean base**, and graft only the non-conflicting strengths.

## Choose Your Arena Harness

Check `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` and `swarm{action: "models", all: true}` to use genuinely distinct model tiers or model families.

1. **Subagent Branch Arena (2–3 isolated candidates)**:
   - Launch 2–3 concurrent candidates via `invoke_subagent` (`TypeName: "self"`, `Workspace: "branch"` for code candidates; for read-only architectural sketches, keep `Workspace: "inherit"` and give each candidate its own unique subfolder under your scratch/sketch dir).
   - Route tiers explicitly (e.g., `Model: "pro"` vs `"inherit"`, or distinct prompts/constraints when competing approaches rather than models).
   - For design bakeoffs paired with [`/architect`](../architect/SKILL.md), pass `skills/architect/references/runner-prompt.md` + Phase A grounding brief + target output dir.
2. **Native `/swarm` Cross-Family Arena (best for distinct LLM families + `@judge`)**:
   - Discover live models via `swarm{action: "models", all: true}`.
   - Spawn `candidate-1`, `candidate-2` (optionally `candidate-3`) with `workspace: "branch"` across different model families when available, plus an independent `@judge` / `@verifier` on a *separate* model family from the code candidates (`workspace: "inherit"` or checking out each candidate branch).

Wait reactively — never sleep-poll (`invoke_subagent` wakes automatically; `/swarm` uses `swarm_wait` or reactive wakeups).

## Bakeoff Contract (Every Candidate Receives)

- Same problem statement, invariants, constraints, and Phase A grounding notes.
- Same **empirical pass predicate** (exact tests, benchmark/regression command, `control-ui` or `control-cli` flow).
- Instruction to read `agents/astack-agent.md` + `skills/astack-mode/SKILL.md` and **not hedge** toward a generic middle ground — differences between candidates are the signal.

## Judge & Synthesize

Do not compare prose summaries — compare **real diffs, types, red flags, and empirical runs**:

1. **Screen disqualifiers first**:
   - Fails the empirical proof / benchmark / typecheck / build (`principle-prove-it-works`).
   - Introduces design red flags (`skills/architect/references/design-red-flags.md`: shallow module, information leakage, temporal decomposition, pass-through methods, split ownership, duplicate paths, importable internals, hand-synced lists).
   - Leaves explanatory comments, suppressions, or fake fallbacks covering root causes.
2. **Score surviving candidates on**:
   - **Interface depth & data structure clarity**: simplest caller surface hiding the most complexity.
   - **Failure / edge-case discipline**: idempotency, narrow error handling, boundary validation.
   - **Diff size & maintainability**: fewest moving parts and shortest call chains that satisfy every requirement.
3. **Pick ONE base + selective graft**:
   - Name the base candidate and why it won (fill `Synthesis decision` when invoked inside `/architect`).
   - Graft at most 1–2 discrete improvements from losing candidates (e.g., a sharper invariant check, cleaner error type, or tighter test case). Never mash together incompatible architectures into a hybrid Franken-design.
4. **Land, re-verify, then clean up**:
   - Apply/merge the chosen candidate + grafts into your working tree **before** killing any branch workers (`manage_subagents` `kill` and `swarm{action: "kill"}` permanently delete branched workspaces).
   - Re-run the full empirical verification suite on the landed working copy — judging a candidate branch does not prove the final merged state (`principle-verify-before-reporting`).
