---
name: reflect
description: Spawn three parallel review subagents over the active transcript, surface learnings, and route each to a concrete edit on an existing skill. Use when the user says reflect.
---

# Reflect

Mine the current conversation for durable learnings, then route them into skill edits.

Invoke when the user says "reflect" or "/reflect". Skip when the conversation is trivial, off-topic, or already covered by an existing skill the parent followed correctly. One-offs are not learnings.

## 1. Locate the active transcript

Before fanning out, locate this conversation's transcript at `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (and `transcript_full.jsonl` when `truncated_fields` is present on a step) as named in the system prompt. Never scan across unrelated conversation folders unless explicitly asked to inspect another session.

Inspect the opening `USER_INPUT` step in `transcript.jsonl` (or verify `step_index: 0` / earliest user request) to confirm it matches the active session. If logs are unavailable or unreadable, pass a tight, factual digest of the session instead.

## 2. Spawn three reviewers in parallel

One turn, three `invoke_subagent` calls with `TypeName: "self"` (since `self` inherits your full MCP tools to look up referenced tickets, chat threads, and observability traces; do not use `research`, which has no network or MCP access).

Each reviewer and the synthesizer name a role line in `astack-models.md` and a default `Model` parameter for `invoke_subagent` (`inherit`, `pro`, `flash`, or `flash_lite`). Set `Model` to the mapped tier from `astack-models.md`, or to the default below if the rule or line is missing. Pick each subagent's tier for the job, per the Subagents section of the **astack-mode** skill.

| Lens | Role line | Default `Model` | Prompt template |
|---|---|---|---|
| Judgment | `reflect judgment, divergent, synthesizer` | `pro` | `references/judgment-reviewer.md` |
| Tooling | `reflect tooling` | `inherit` | `references/tooling-reviewer.md` |
| Divergent | `reflect judgment, divergent, synthesizer` | `pro` | `references/divergent-reviewer.md` |

Pass each template verbatim, substituting the transcript path or digest where marked. Reviewers return findings in their final message to you.

## 3. Synthesize

One `invoke_subagent` call with `TypeName: "self"` and `Model` from the `reflect judgment, divergent, synthesizer` line (default `pro`). It spot-verifies citations through inherited MCP tools. Pass `references/synthesizer.md` verbatim, with each reviewer's full output inlined where marked. It returns an Accepted / Rejected / Backlog list.

## 4. Structural enforcement check

Move any Accepted item that a lint rule, script, metadata flag, or runtime check would enforce more reliably to Backlog. See the **encode-lessons-in-structure** principle skill.

## 5. Apply

Present the synthesizer's full Accepted / Rejected / Backlog output and wait for explicit approval before applying any Accepted edit. The user picks the subset and may redirect routings. Skill changes affect every future agent in the org. Do not auto-apply.

File each Backlog item to your team's devex or backlog tracker without waiting. Only the Accepted list waits for approval.

Never edit a skill under `~/.gemini/config/plugins/`. Before approval, show its destination, `.agents/skills/<skill>/` or `~/.agents/skills/<skill>/`. After approval, copy the skill folder there and edit the copy. Never open a PR or push.

Follow each approved row's Routing exactly:

- Trivial existing-skill edit (a one-line bullet, a tightened sentence, a stale fact corrected): the parent does it directly.
- Substantive existing-skill edit (a new section, a new pattern table, more than ~10 lines): follow the project/Antigravity skill conventions in the `agy-customizations` skill to draft, test, and verify the updated `SKILL.md`. If a user rule should persist globally, suggest `/learn`.
- `tune description: <skill path>` (the skill exists but didn't trigger when it should have): tighten the description's trigger phrasing (front-load concrete cues and slash commands) so future model-decision routing fires reliably.
- `new skill via skill-authoring: <kebab-name>`: scaffold `.agents/skills/<kebab-name>/SKILL.md` (or `~/.agents/skills/<kebab-name>/SKILL.md`) following `agy-customizations` rules rather than inventing a custom shape ad hoc.

If touching a workspace or plugin skill, run `agy plugin validate` (or `node scripts/validate-astack.mjs` when inside AStack) on every touched skill before declaring done.

## 6. Summarize for the user

Short list, no preamble:

- Edits applied: `<skill path>`. What changed, one line each.
- New skills created: `<skill path>`. One line each (rare).
- Backlog filed to the devex tracker: `<issue title>` (`<tags>`). One line each.
- Dropped: one line per rejected finding + reason from the synthesizer.
