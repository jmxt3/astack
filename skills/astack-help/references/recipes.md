# Prompts worth copying

Swap in real paths, PR numbers, and done checks.

## Understand

- `/astack-mode read <issue-or-thread>. restate the underlying problem in plain English before changing any code.`
- `/in-your-own-words <long or messy ask>`
- `/sharpen <prompt you are about to send>`
- `/astack-mode investigate why <symptom> happens. give me confirmed facts, files read, and falsifiable hypotheses. read-only.`
- `use /how to explain <subsystem>, then /why to explain why <constant-or-branch> exists.`
- `/recall my work on <topic>, then inspect <issue>.`
- `/astack-mode session pickup on branch <name> from recent transcript.`

## Plan First, Approve, Then Execute

- Everyday gate (`plan-contract.md`): `/plan /astack-mode <task>`
- Ambiguous requirements interview first: `/plan /grill-me <task>`
- Architecture gate: `/architect <feature>. with checkpoint. compare designs, write the type sketch and rationale, and wait for sign-off before coding.`
- Multi-PR written plan (writes `implementation_plan.md` artifact first, repo `docs/<name>-plan.md` after approval): `/plan /astack-mode build a multi-PR plan for <goal> with small verifiable units and live proof steps.`
- Execute after approval: click **Proceed** on `implementation_plan.md` (or send `approved`), which runs live verification, `/deslop`, and `/no-comments` automatically and stops at local commits before `git push`. Send `approved, open the PR` to push and open the PR, or `/swarm /astack-mode execute docs/<name>-plan.md with autopilot-stack` for multi-PR plans.

## Build

- Bug (Web/UI): `/astack-mode repro <symptom> with /control-ui. if it reproduces on main, /tdd if cheap, fix the root cause, and prove with before/after DevTools output.`
- Bug (CLI/API): `/astack-mode repro <command> via /control-cli. fix root cause, strip bloat with /deslop, and show failing-then-passing output.`
- Hard coupled race / perf: `/boost /astack-mode <operation> races under load (or takes <time>). capture baseline, fix cause, prove delta under benchmark-checklist.`
- Feature: `/astack-mode add <behavior> starting from the domain data shape. keep <existing behavior> byte-identical.`
- Refactor: `/astack-mode refactor <module> with zero behavior change. record baseline output first and prove parity after.`

## Design, Fan-out & Swarm

- `/astack-mode prototype two approaches for <feature> and show screenshots via /control-ui.`
- `/architect <feature> across <module-boundary>. stop with design rationale before coding.`
- `/arena solve <hard-problem> in three isolated branch candidates and graft the cleanest solution.`
- `/run-workflow inspect every file changed since main in parallel and return a one-line verdict per file.`
- `/swarm /astack-mode migrate these N independent packages (one shared worker per package + independent @verifier gate on each).`
- `/fanout check every workspace package against its test script and return one report.`
- `/browser verify the settings flow renders cleanly at http://localhost:3000 with zero console errors.`

## Review, Babysit & Ship

- `/interrogate review this branch skeptically for real bugs and regressions. skip nitpicks.`
- `/create-formal-verification-skill model <protocol-or-state> in TLA+ and render counterexamples with /statechart.`
- `/astack-mode /deslop and /no-comments over this diff, then open the PR cleanly.`
- `/astack-mode babysit pr <number> to green.` (Status only: `/astack-mode check on pr <number>.`)
- `/astack-mode land the verified stack.`

## Multi-milestone, Automations & Customizations (`/teamwork`, `/goal`, `/automation`, `/learn`)

- `/teamwork /astack-mode plan and execute <migration> across phases with milestone verification gates.`
- `/goal /astack-mode in a fresh worktree off main, drive until <check command> passes. keep a decision trail via /show-me-your-work, commit clean verified units, stop only if blocked by a real dead end.`
- `/automation every weekday at 9am check open PRs in this repo and summarize blockers.` (App persistent sidecar; use `/schedule` inside active chats.)
- `/show-me-your-work summarize what changed overnight.`
- `/ketchup` (or `/ketchup-video` for slide summary + open decisions)
- `/learn remember to always run migrations in transactions` (proposes `learning_proposal.md` before writing rules)
- `/agy-customizations add a PreToolUse hook blocking force push`
- `/antigravity-guide how do I run the Antigravity CLI headless in CI?`
- `/reflect` and `/correct` after the run so mistakes upgrade into code/lint/rules/hooks/`/learn`.
