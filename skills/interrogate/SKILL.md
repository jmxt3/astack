---
name: interrogate
description: "Adversarial multi-agent code and design review: give a change and its intent to independent adversaries in isolated workspaces, require each finding to be proven with a run against real code, rerun every finding in the parent to verify, and report verified breaks plus dropped noise without applying fixes. Use for /interrogate or skeptical branch review."
---

# Interrogate

Give a built change and its stated intent to independent adversaries, require every claim to run and fail against real code, and report verified breaks alongside what got dropped.

`/interrogate` tests concrete code, diffs, branches, or prototypes. When scoping an unbuilt idea with no code yet, settle empirical forks via [`playbooks/prototype.md`](../astack-mode/playbooks/prototype.md) or run Antigravity's `/grill-me` for product alignment instead.

## 1. Frame

- **Scope.** Inspect the files or diff named by the user. When unnamed, scope to the current branch diff from merge-base (`git merge-base origin/main HEAD` or `HEAD`) through any uncommitted working-tree changes.
- **Intent.** State what the change intends to accomplish in your own words via [`in-your-own-words`](../in-your-own-words/SKILL.md), synthesized from the user's prompt, commit messages, and open PR body when present. If two engineers could reasonably disagree on what constitutes breakage and neither prompt nor repo context settles it, ask the user via `ask_question` before fanning out.

## 2. Fan out

Follow [`arena`](../arena/SKILL.md) Phase A isolation and runner rules (`principle-separate-before-serializing-shared-state`):

- **Default harness.** Launch 2 to 3 parallel `invoke_subagent` calls (`TypeName: "self"`, `Workspace: "branch"`), omitting `Model` (`"inherit"`) so adversaries inherit your active UI model or **Orchestrator** unless `~/.gemini/config/rules/astack-models.md` or `.agents/rules/astack-models.md` overrides them. Differentiate adversaries by attack angle (for example boundary and malformed inputs, concurrency and state races, caller contract regressions).
- **Cross-family harness.** When distinct model families are requested or under native `/swarm`, call `swarm{action: "models", all: true}` live, filter to models with healthy `quota_remaining`, and spawn 2 to 3 adversaries across distinct families with `workspace: "branch"`.
- **Uncommitted changes.** Ensure working-tree edits are present inside each isolated branch (for example applying `git diff HEAD` inside the branch workspace without mutating the parent copy).

Pass every adversary the scope, stated intent, `agents/astack-agent.md` plus `skills/astack-mode/SKILL.md`, and this breaker brief verbatim:

```text
Break this change. Prove each finding with a run against the real code: a failing input, a reproduction script, a test, or a caller trace that hits the broken path. Report only what ran and failed: the command, its output, and how it breaks the stated intent. Drop anything you didn't run, anything hypothetical, and style opinions.
```

Wait reactively without polling (`invoke_subagent` wakes on completion; `/swarm` uses `swarm_wait`).

## 3. Verify

Skip [`arena`](../arena/SKILL.md) Phases C through E so every verified defect across all adversaries survives rather than choosing one winning reviewer.

1. Rerun each reported finding's exact command in the parent workspace (staging any reproduction harness in an isolated scratch directory so the repo stays clean) per `principle-prove-it-works`.
2. Keep only findings whose rerun reproduces the failure AND violates the stated intent.
3. Merge duplicates sharing the same underlying cause (`principle-fix-root-causes`), crediting every adversary that surfaced them.
4. Record every dropped claim (did not run, did not reproduce, failed before the change too, or did not break intent) with counts and reasons per adversary.
5. Apply zero fixes during `/interrogate`, and clean up temporary branch workspaces (`manage_subagents` `kill` or `swarm{action: "kill"}`) after verification finishes.

## 4. Output

Return three sections:

- **Intent.** 1 to 2 sentences stating what the change is supposed to do.
- **Findings.** For each verified break, include the exact command run, observed failing output, how it breaks the stated intent, and which adversaries found it (or state `no verified findings`).
- **Dropped.** Per-adversary count and concrete drop reasons so the human can review or override any cut.
