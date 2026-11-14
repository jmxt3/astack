### Bug fix

**You own this task. Plan, review, verify.** Delegate investigation and the fix to subagents, stay in the lead. Pick each subagent's reasoning level and fast or standard speed for the job, per the Subagents section.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix. It does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more.

1. Reproduce it yourself on the matching surface via `control-ui` or `control-cli` (or the repo's `verify-<app>` skill), even when a debug protocol suggests asking the user. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
2. Binary-search the cause. Form candidate hypotheses, then rule them out until one survives. Seed them with [`how`](../../how/SKILL.md) over the affected subsystem and [`why`](../../why/SKILL.md) for regression history. Each pass, take the split that cuts the most remaining problem space, collect runtime evidence, and eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Do not guess. For stubborn or timing-sensitive bugs across coupled state, run or recommend `/boost` for multi-round hypothesis testing -> fix -> verify. Confirm the surviving *mechanism* with runtime evidence before planning the fix.
3. Plan the fix. If it crosses a function boundary, run [`architect`](../../architect/SKILL.md) first. Delegate implementation via `invoke_subagent` (`TypeName: "self"` following `agents/astack-agent.md`, using your configured bug-fix tier in `astack-models.md`, default `inherit` or `pro` for complex defects) with a specific scope.
4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.
6. Run **Opening a PR**.

**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.
