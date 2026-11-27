### Investigation

**You own the answer. Plan, route, write.**

Investigation requests are read-only. They produce a cited explanation, a recommendation, or a `diagnosis.md` artifact, never a production code change.

1. Choose the path matching the question:
   - **Architecture, provenance, or feasibility Q&A:** route through [`how`](../../how/SKILL.md) (and [`why`](../../why/SKILL.md) for rationale), producing the `how`-shaped output (`Overview / Key Concepts / How It Works / Where Things Live / Gotchas`) or a tradeoffs table.
   - **Defect, build break, CI failure, or unknown runtime behavior:** load [`investigate`](../../investigate/SKILL.md), run read-only reproduction and binary-search localization (probes strictly in `<artifact-dir>/scratch/`), write `<artifact-dir>/diagnosis.md` (`UserFacing: true`, `RequestFeedback: true`), and stop.
2. Throughput checkpoint stays one line: `throughput checkpoint: n/a, read-only investigation`.
3. Apply the **unslop** skill to the reply.

No PR, no babysit, no `architect` unless the investigation precedes a code change. When the request asks to investigate an unknown bug and fix it (mixed prompt), follow the 4-case matrix in [`investigate`](../../investigate/SKILL.md): finish the read-only diagnosis, then hand straight into [`../references/plan-contract.md`](../references/plan-contract.md) as a Combined Gate (`implementation_plan.md` with `## Root Cause & Empirical Evidence` and `## Hypotheses Tested & Ruled Out`) when the cause is proven and unambiguous, or stop at `diagnosis.md` (`RequestFeedback: true`) when uncertain, external, or architecturally forked.

**Reply:** the investigation output or `diagnosis.md` summary. For "are we sure?" answers, include your real judgment with reasons. Push back if the premise is wrong (see Autonomy).
