---
name: architect
description: "Explore an engineering or API design across competing candidate architectures in parallel, screen for Ousterhout design red flags, synthesize one coherent winner via /arena, and hand off a type sketch + rationale before implementation. Use for /architect or \"design this before coding\"."
---

# Architect

Stop converging on the first plausible shape. Ground the constraints in real code, send multiple candidates into parallel design exploration with caller usage first, screen against structural red flags, synthesize one base architecture via [`/arena`](../arena/SKILL.md), and leave a crisp one-page rationale + type sketch.

## Phase A: Ground the problem

Read before designing (`principle-verify-before-reporting`):

1. Inspect existing entry points, callers, storage/wire types, invariants, and boundaries that this design touches. Cite exact file paths and symbol names you actually read.
2. Capture a short **grounding brief** (under one page):
   - Problem statement and what must get simpler or become structurally impossible (`principle-encode-lessons-in-structure`).
   - Hard constraints from existing callers, schemas, performance limits, or concurrency boundaries (`principle-boundary-discipline`).
   - Ambiguities best settled *before* branching candidates (if any high-cost requirement is genuinely unknown, clarify with `/interrogate` or `ask_question` first).

## Phase B: Parallel candidate exploration

Spin up **2–4 independent design runners** in parallel in an isolated scratch workspace directory (one subfolder per candidate, e.g. `<scratch>/architect-<slug>/candidate-a`, `candidate-b`, `candidate-c`, or isolated subagent workspaces if prototyping interfaces in code):

- **Execution mechanism**:
  - For quick design sketches: `invoke_subagent` (`TypeName: "self"`, `Workspace: "inherit"` writing strictly to its own assigned `<scratch>/candidate-<x>/` directory), defaulting to `Model: "inherit"` (following your active UI model / **Orchestrator**) with distinct architectural lenses such as "minimal functional core" vs "state-machine explicit" vs "zero-allocation hot path" (honoring optional `astack-models.md` if present).
  - For distinct LLM family diversity or large interface prototypes: Native `/swarm` workers discovered live via `swarm{action: "models", all: true}` (checking `quota_remaining`) with `workspace: "branch"` or disjoint sketch subfolders, plus an independent judge.
- Pass every runner:
  1. [`references/runner-prompt.md`](references/runner-prompt.md) (verbatim core discipline: **Usage (caller's view) first**, **data structures first**, **interface depth**, **separate-before-serializing-shared-state**, `not implemented` boundaries).
  2. [`references/rationale-template.md`](references/rationale-template.md) as the mandatory output shape.
  3. Phase A's grounding brief and its isolated output path.

Wait reactively — never poll.

## Phase C: Screen and synthesize

Read every candidate's usage + type sketch + `rationale.md` completely:

1. **Red-flag screen**: Run every candidate through [`references/design-red-flags.md`](references/design-red-flags.md):
   - Shallow module
   - Information leakage (wire/transport types on public surface)
   - Temporal decomposition
   - Pass-through method
   - Split ownership
   - Two ways to do one task
   - Importable internals
   - Hand-synced list
2. **Synthesize with [`arena`](../arena/SKILL.md)**:
   - Pick ONE base candidate that best hides complexity behind clear caller usage (`# Shape`).
   - Reconcile types back to caller usage whenever they drifted — usage is the spec.
   - Graft concrete localized wins from the other candidates without blurring module boundaries.
   - Fill `Synthesis decision` in the final rationale artifact (`rationale.md`) alongside `# Shape`, `Tradeoffs accepted`, `Alternatives considered`, `Open questions and risks`, and `Next implementation step`.

## Phase D: Sign-off or build

- If the user asked only for design, open questions remain that change public behavior, or you hit a checkpoint gate: present the concise artifact / `# Shape` summary, surface open questions explicitly as questions for decision, and pause for sign-off.
- If the design resolves every constraint cleanly and the user asked to build end-to-end: proceed immediately to the `Next implementation step` using `astack-mode`'s build & verification flow (`tdd`, `deslop`, `control-ui`/`control-cli`).
