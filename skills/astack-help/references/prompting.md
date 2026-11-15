# Word the prompt

A strong prompt names the intent, any known facts, and a checkable done predicate. Let `/astack-mode` select the playbook and steps.

## Put in

- **The goal.** State what is broken or what users need.
- **The done check.** Use an empirical pass/fail check (`npm test`, `control-ui` screenshot, before/after trace), never a vague request or duration.
- **What you already know.** Include failing logs, repro clicks, PR numbers, or traces.
- **Real constraints.** Phrase boundaries cleanly: "repro first", "don't edit code yet", "keep output byte-identical", or "pause before pushing".

## Leave out

- **Prescriptive file/tool steps.** Let `/astack-mode` inspect with `/how` and choose the clean design.
- **Premature diagnoses.** State symptoms before guesses so the investigator tests all hypotheses.

## Load context & design cleanly

- Messy thread? Ask `/in-your-own-words` before changing code.
- New chat continuing old work? Run `/recall <topic>` or `/astack-mode session pickup`.
- Unfamiliar area? Ask `/how` for current mechanics and `/why` for historical decisions.
- Need 2–3 competing directions? Ask `/astack-mode prototype` or `/arena`.
- Ambiguous requirements? Run `/plan /grill-me <task>` (or `/plan /astack-mode <task>`) to align and gate on a reviewable plan artifact before edits.
- Broad multi-file / multi-PR scope? Pair `/astack-mode` with `/run-workflow` (item pipelines), `/swarm` (plus independent `@verifier`), `/boost` for gnarly races/perf, or `/teamwork` + `/goal` for multi-milestone runs.

## Steer in one line

- Restate scope: `"Goal is repro only via /control-ui; do not patch yet."`
- Invoke a principle: `"Apply principle-prove-it-works: show real CLI/DevTools output, not just build pass."`
