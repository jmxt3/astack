---
name: architect
description: "Explore an engineering or API design across competing candidate architectures in parallel, screen for Ousterhout design red flags, synthesize one coherent winner via /arena, and hand off a type sketch + rationale before implementation. Use for /architect or \"design this before coding\"."
---

# Architect

Avoid converging on the first plausible abstraction. Ground constraints in real callers and boundaries, run parallel candidates starting from caller usage and core data structures, screen for design red flags, synthesize one coherent shape via [`arena`](../arena/SKILL.md), and scrap the sketch cleanly whenever implementation proves it wrong.

## Phase A. Ground the problem

Read before proposing structure (`principle-prove-it-works`):

1. Run [`how`](../how/SKILL.md) over the subsystems, callers, wire schemas, and state ownership this design touches. Cite real files and symbols you read.
2. Run [`why`](../why/SKILL.md) whenever the change moves ownership, alters layer boundaries, or replaces an existing abstraction so past constraints are not silently broken.
3. Capture a crisp grounding brief (under one page) stating:
   - Core problem and domain invariants (`principle-model-the-domain`, `principle-foundational-thinking`).
   - External boundary constraints and what illegal states types should exclude (`principle-boundary-discipline`, `principle-type-system-discipline`, `principle-encode-lessons-in-structure`).
   - Empirical forks settled via throwaway experiments (`playbooks/prototype.md`), reserving `ask_question` or `/grill-me` strictly for genuine product decisions code cannot decide.

## Phase B. Sketch

Explore at least 2 structurally distinct candidate architectures via [`arena`](../arena/SKILL.md) (`principle-exhaust-the-design-space`):

1. Launch 2 to 4 runners in parallel using isolated subdirectories (`<scratch>/architect-<slug>/candidate-<x>/`) via `invoke_subagent` (`TypeName: "self"`, omitting `Model` to inherit UI or **Orchestrator**, or honoring `astack-models.md` if present) or native `/swarm` (`swarm{action: "models", all: true}`) when distinct model families are desired.
2. Pass every runner:
   - [`references/runner-prompt.md`](references/runner-prompt.md) (caller usage first, data structures before methods, deep interfaces, `principle-separate-before-serializing-shared-state`, `not implemented` stubs).
   - [`references/rationale-template.md`](references/rationale-template.md) for its output document.
   - Phase A's grounding brief plus its isolated output directory.
3. Screen every candidate end to end against [`references/design-red-flags.md`](references/design-red-flags.md) (`shallow module`, `information leakage`, `temporal decomposition`, `pass-through method`, `split ownership`, `two ways to do one task`, `importable internals`, `hand-synced list`).
4. Run `arena` synthesis to choose one cleanest base, reconcile types back to caller usage whenever signatures drifted (usage is the spec), graft discrete localized strengths cleanly (`principle-redesign-from-first-principles`), and fill `Synthesis decision` in the final `rationale.md` alongside `# Shape`, `Tradeoffs accepted`, `Alternatives considered`, `Open questions and risks`, and `Next implementation step`.

## Phase C. Agree (opt-in)

**Default is zero checkpoint.** Proceed straight from Phase B synthesis into Phase D implementation (`principle-never-block-on-the-human`).

Pause before writing implementation code **only** when:

- The user explicitly asked for design review first (`"with checkpoint"`, `"design only"`, `"show me before implementing"`).
- Synthesis uncovered an unresolved product tradeoff that alters external caller behavior or irreversible schemas.

When pausing, present `# Shape`, `Tradeoffs accepted`, and explicit `Open questions and risks` framed as decisions for the user, then wait for approval.

## Phase D. Implement against the sketch

Build starting from `# Shape` and `Next implementation step` using `astack-mode`'s build and verification playbooks (`feature.md`, `tdd`, `deslop`, `control-ui`, `control-cli`). Treat `# Shape` as a living contract: whenever concrete types or runtime checks force a local adjustment, update the sketch and rationale in the same change so design docs never drift from code.

## Phase E. Scrap when the architecture is wrong

Treat the sketch as disposable scaffolding once real code pushes back (`principle-outcome-oriented-execution`). Stop patching and scrap the design immediately if implementation surfaces any of these tells:

1. Callers must inspect or pass hidden internal representation details (`information leakage`).
2. The same workaround, coercion, or adapter glue repeats across two or more unrelated call sites (`principle-minimize-reader-load`).
3. Types only compile with `any`, forced `unknown` casts, or non-null assertions across module boundaries.
4. Adding a second caller or edge case forces mode flags onto core signatures instead of fitting the model cleanly.
5. Tests have to mock private wiring instead of driving public caller behavior (`principle-test-behavior-not-implementation`).
6. Two state owners drift out of sync or need ad-hoc reconciliation logic (`split ownership`).

When those tells appear, halt incremental patching: re-ground via [`how`](../how/SKILL.md) against what code just proved, strip the broken scaffolding via `principle-subtract-before-you-add` and `principle-redesign-from-first-principles`, and rerun [`arena`](../arena/SKILL.md) with the newly surfaced constraint before writing more code.
