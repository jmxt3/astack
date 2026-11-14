---
name: deslop
description: "Pre-commit anti-slop cleanup pass: inspect the entire branch diff, strip unnecessary helpers, defensive fallbacks, dead compatibility layers, justificatory comments, and scope creep, then re-verify everything cleanly after the final edit."
---

# Deslop

Before calling any non-trivial change done, step back and audit your own diff like an unforgiving senior staff reviewer (`principle-elegance-and-minimalism`, `principle-delete-your-darlings`, `principle-review-before-committing`).

Pair this pass with [`no-comments`](../no-comments/SKILL.md) (or the `comment-sicko` subagent) for pure comment/type-suppression hygiene, and [`unslop`](../unslop/SKILL.md) when a larger module needs structural surgery.

## 1. Inspect the Entire Diff Unfiltered

Run `git status` and inspect the full diff (`git diff` / `git diff --cached` / `git diff origin/main...HEAD`) — never rely on memory of what you touched.

Check **scope boundary** first:
- Did unrelated formatting, lockfile churn, debug scripts, or leftover scratch edits slip in? Revert them.
- Did you accidentally leave two ways to do the same task (`principle-keep-one-way`)? Migrate callers and delete the old way in the same change.

## 2. Cut Slop Line by Line

- **Single-use abstractions & pass-through wrappers**: Inline trivial one-off helpers that hide nothing and add indirection (`skills/architect/references/design-red-flags.md`). Conversely, combine duplicated copy-paste blocks into one shared parameterized helper.
- **Speculative configurability & dead code**: Delete unused parameters, unreachable fallback branches, unused imports/exports, and compatibility shims for callers that no longer exist.
- **Silent failure & defensive clutter**: Replace empty `catch {}`, bogus defaults, and "handle impossible state silently" checks at internal call sites with boundary validation + failing loudly (`principle-boundary-discipline`, `principle-fail-loudly`).
- **Explanatory / band-aid comments & suppressions**: Delete narrating comments (`// increment counter`), justification comments explaining away hacks (`// fallback just in case`), `@ts-ignore` / `@ts-expect-error` / `eslint-disable` bandaids, and `any` casts (`no-comments`).
- **Short-circuit test weakening**: Check every test diff carefully — never loosen assertions, mock away the code under test, or add permissive fallbacks just to turn red tests green.

## 3. Re-Verify After the Final Edit

A cleanup edit invalidates earlier runs (`principle-verify-before-reporting`):

1. Run static checks (typecheck, linter, build, `agy plugin validate` if editing a plugin).
2. Re-run the full relevant test suite (`--test`, unit + integration).
3. Re-run empirical runtime proof (`control-ui` / `control-cli` / project `verify-*` skill) if behavior or control flow changed.

Report only checks run **after** your last cleanup edit.
