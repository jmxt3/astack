# AStack User Guide: Quickstart, Daily Workflow & Mastery

**AStack** (`astack`) adapts Lauren Tan's (`@poteto`) verification-first `pstack` workflows natively for **Google Antigravity**. Instead of reviewing long unverified diffs by hand, you state **what outcome you want and how to prove it works**, while AStack matches a rigorous playbook, coordinates Antigravity's subagents and multi-agent modes, cleans the diff, and proves behavior on the running app before reporting done.

> **Credits & Attribution**  
> **Original Plugin (`pstack`):** Created by **Lauren Tan** (`@poteto`) in [`cursor/plugins/pstack`](https://github.com/cursor/plugins/tree/main/pstack) (MIT License, baseline `v0.15.36`).  
> **Antigravity Port (`astack`):** Adapted and engineered for Google Antigravity by **João Machete** ([`jmxt3/astack`](https://github.com/jmxt3/astack)).

**Contents:**
- [Part 1: Start using AStack in 1 minute](#part-1-start-using-astack-in-1-minute)
- [Part 2: Plan-first workflow (write a plan, approve, then execute)](#part-2-plan-first-workflow-write-a-plan-approve-then-execute)
- [Part 3: Day-to-day 5-stage workflow](#part-3-day-to-day-5-stage-workflow)
- [Part 4: Multi-agent modes and power moves](#part-4-multi-agent-modes-and-power-moves)

---

## Part 1: Start Using AStack in 1 Minute

### Step 1: Install the Plugin

From GitHub:

```bash
agy plugin install https://github.com/jmxt3/astack
agy plugin list --json
```

If you are updating from a local clone (for example `./astack`) on Windows while Antigravity is running, run `agy plugin uninstall astack` before `agy plugin install .`.

### Step 2: Run `/setup-astack` Once in Your Project

Open your project workspace and run:

```text
/setup-astack
```

Select the **`(Recommended)`** option when prompted so [`/setup-astack`](../skills/setup-astack/SKILL.md) teaches agents how to launch and verify your app automatically.

> [!TIP]
> AStack works out of the box with **any model on any Antigravity plan**, with zero model config or chat restart needed. `33` manual-only/principle skills set `disable-model-invocation: true` so only `28` workflow skills sit in your model index, broad sweeps use `flash`, `/arena` checks live models via `swarm{action: "models"}`, and **Orchestrator (Carbon)** (Google AI Ultra) or **Orchestrator (Argon)** (Google AI Pro and Ultra) runs dynamic bidirectional routing with [Gemini 4 Carbon](https://antigravity.google/blog/gemini-4-carbon-in-google-antigravity) and [Gemini 4 Hydrogen](https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity/) automatically.

### Step 3: Run Tasks With `/astack-mode`

Describe **what you want** and **how to check it works** in plain English:

```text
/astack-mode add a --json flag to the export command. keep plain text output byte-identical, prove both outputs on the sample fixture, and don't push yet.
```

`/astack-mode` picks the right playbook from its 23 playbooks, writes and cleans the code, and proves behavior on the real surface before finishing.

Unsure which skill fits? Ask [`/astack-help`](../skills/astack-help/SKILL.md) without spending execution tokens yet:

```text
/astack-help which skill should I use to review this branch before opening a PR?
```

---

## Part 2: Plan-first workflow (write a plan, approve, then execute)

Under **Orchestrator** (**Carbon** on Google AI Ultra or **Argon** on Google AI Pro and Ultra), a frontier planner already explores read-only before handing edits and tests to Hydrogen, and recovers automatically on friction. Whenever you ask for a plan (or invoke `/plan`), AStack's [`plan-contract.md`](../skills/astack-mode/references/plan-contract.md) enforces a hard stop: write `<artifact-dir>/implementation_plan.md` (`RequestFeedback: true`, `UserFacing: true`) and make zero workspace edits until you approve:

```mermaid
flowchart LR
    P["`**1. Write plan**
Read-only investigation
Zero file edits`"] --> A["`**2. Review & approve**
Inspect or revise steps
Explicit go-ahead`"] --> E["`**3. Execute & verify**
/astack-mode + Control Glass
Stop before push or merge`"]
```

### Step 1: Write a plan without changing code

Pick the stacked prompt that matches the work:

1. **Everyday feature or bug fix (`/plan /astack-mode`):** Pairs Antigravity's `/plan` gate with AStack's discovery and verification rigor (for bugs, reproduce live first via `control-ui` or `control-cli` before finalizing the fix plan):
   ```text
   /plan /astack-mode <task or bug>
   ```
2. **Unclear requirements or product forks (`/plan /grill-me` or [`prototype.md`](../skills/astack-mode/playbooks/prototype.md)):** Runs `/grill-me`'s one-question-at-a-time interview first, then writes `implementation_plan.md` and stops for approval (or use `prototype` when running code settles empirical forks directly; save [`/interrogate`](../skills/interrogate/SKILL.md) for breaking built code):
   ```text
   /plan /grill-me <idea>
   ```
3. **API, module boundary, or architecture change ([`/architect`](../skills/architect/SKILL.md) with checkpoint):** By default `/architect` moves straight from design into code unless you pass `with checkpoint`:
   ```text
   /architect <feature or API>. With checkpoint. Compare candidate designs, screen for red flags, write the type sketch and rationale, and stop for my approval before implementing.
   ```
4. **Multi-PR feature, refactor, or migration ([`multi-phase-plan.md`](../skills/astack-mode/playbooks/multi-phase-plan.md)):** Writes the `check-plan.mjs`-validated multi-PR checklist into `<artifact-dir>/implementation_plan.md` first with zero edits, then materializes `docs/<name>-plan.md` only after you approve (pair with `/teamwork` for milestone gates):
   ```text
   /plan /astack-mode Turn <goal> into a multi-PR plan with small verifiable units and live verification steps.
   ```

### Step 2: Review, revise, or sharpen

Ask for revisions directly in chat before giving the go-ahead:

```text
Update step 2 to use <X> instead of <Y>, keep <Z> out of scope, and show me the revised plan before implementing.
```

Three zero-execution skills help refine prompts and check understanding before you spend execution turns:

- [`/sharpen`](../skills/sharpen/SKILL.md): rewrites a rough prompt deeper without running the task.
- [`/in-your-own-words`](../skills/in-your-own-words/SKILL.md): restates what the agent thinks your goal is so you catch misreadings early.
- [`/astack-help`](../skills/astack-help/SKILL.md): recommends the right skill and returns a copyable prompt without starting work.

### Step 3: Execute the approved plan through AStack

Once you approve the plan, execute it through AStack while keeping final git push and merge decisions in your hands:

- **Single-branch execution** (prepend `/boost` for hard race conditions or coupled defects):
  ```text
  /astack-mode Approved. Execute the plan above, prove it works end-to-end, run /deslop and /no-comments, and stop before git push so I can review the diff.
  ```
- **Parallel or stacked multi-PR execution from a saved plan file:** Use [`autopilot-stack.md`](../skills/astack-mode/playbooks/autopilot-stack.md) instead of [`autopilot-full.md`](../skills/astack-mode/playbooks/autopilot-full.md). `autopilot-stack` builds and verifies every PR in the plan, then stops and hands them back without merging:
  ```text
  /swarm /astack-mode Approved. Execute docs/<name>-plan.md with the autopilot-stack playbook. Stop once every unit is verified and wait for my review before pushing or merging.
  ```

---

## Part 3: Day-to-day 5-stage workflow

Most engineering tasks flow naturally through five stages. You don't have to memorize or chain these commands manually. `/astack-mode` invokes them automatically when needed, and knowing each stage lets you call any skill directly when you want focused control.

```mermaid
flowchart LR
    S1["`**1. Understand**
/how · /why
/teach · /recall`"]
    S2["`**2. Design**
/architect · /arena
/interrogate`"]
    S3["`**3. Build**
/astack-mode
playbooks + /tdd`"]
    S4["`**4. Clean**
/deslop · /no-comments
/unslop`"]
    S5["`**5. Verify & ship**
/control-ui · /control-cli
verify-app · /blast-radius`"]

    S1 --> S2 --> S3 --> S4 --> S5
```

### Stage 1: Understand Before Changing Code

Editing unfamiliar code causes regressions. Use read-only exploration first:

1. **Trace how code works now:** `/how` ([SKILL.md](../skills/how/SKILL.md)) gives an onboarding-grade mental model of runtime flow, ownership, and gotchas.
   ```text
   /how do background job retries avoid running twice?
   ```
2. **Dig up why a rule or branch exists:** `/why` ([SKILL.md](../skills/why/SKILL.md)) queries git history, PRs, and connected MCPs (issues, docs, team chat, logs, error trackers, analytics) in parallel and separates facts from inference.
   ```text
   /why is the retry limit hardcoded to 5? does that constraint still hold?
   ```
3. **Force a convincing explanation:** `/teach` ([SKILL.md](../skills/teach/SKILL.md)) weaves `/how` and `/why` into a plain-language argument with diagrams.
   ```text
   /teach me how this PR changes retries and convince me it fixes the root cause.
   ```
4. **Rebuild context across chats:** `/recall` ([SKILL.md](../skills/recall/SKILL.md)) mines your recent Antigravity transcripts and live repo/PR state so a fresh chat doesn't repeat old dead ends.
5. **Run a pure read-only investigation:**
   ```text
   /astack-mode investigate why workers stall under load. give me confirmed facts, files read, and falsifiable hypotheses. don't change any code yet.
   ```

### Stage 2: Design Before Locking In Structure

One attempt locks in the first shape the model thinks of. For boundary-crossing work, force competition before committing to code:

- **Cross-boundary API & architecture design:** `/architect` ([SKILL.md](../skills/architect/SKILL.md)) grounds constraints in real callers, spawns parallel design candidates (caller usage first, data shape first), screens for Ousterhout design red flags, and synthesizes one clean architecture.
  ```text
  /architect design the webhook rate limiter across our API gateway. stop and show me the design before implementing.
  ```
- **Competitive multi-candidate bakeoff:** `/arena` ([SKILL.md](../skills/arena/SKILL.md)) runs 2–3 isolated implementations in parallel, screens them against the same empirical pass predicate, picks **one clean base**, and grafts 1–2 non-conflicting wins.
  ```text
  /arena solve the cache key invalidation bug in 3 isolated candidates and graft the cleanest solution.
  ```
- **Settle empirical questions with code, not debate:**
  ```text
  /astack-mode prototype two layouts for the filter bar in a scratch folder and show screenshots via /control-ui.
  ```

### Stage 3: Build With `/astack-mode`

[`/astack-mode`](../skills/astack-mode/SKILL.md) selects the matching playbook automatically from how you phrase your goal:

| Task Type | Copy-Pasteable Prompt Pattern | Playbook / Skill Triggered |
|---|---|---|
| **Bug fix (Web/UI)** | `/astack-mode <symptom> when clicking <flow>. repro live first via /control-ui, fix root cause, and prove with before/after DevTools output.` | `bug-fix` + [`control-ui`](../skills/control-ui/SKILL.md) + `/browser` |
| **Bug fix (CLI/API)** | `/astack-mode <command> fails with <error>. repro live first via /control-cli, add a failing test if cheap, fix root cause, and show failing-then-passing output.` | `bug-fix` + [`control-cli`](../skills/control-cli/SKILL.md) + [`tdd`](../skills/tdd/SKILL.md) |
| **New feature** | `/astack-mode add <behavior> starting from the domain data shape. keep <existing flow> unchanged and verify end-to-end.` | `feature` + `/architect` (if cross-boundary) |
| **Refactor** | `/astack-mode refactor <module> with zero behavior change. capture baseline output first and prove parity after.` | `refactoring` |
| **Measured perf** | `/astack-mode <operation> takes <X>ms on <fixture>. trace it, fix the measured bottleneck, and vet before/after numbers.` | `perf-issue` + [`benchmark-checklist`](../skills/benchmark-checklist/SKILL.md) |

> [!NOTE]
> When editing TypeScript (`.ts` / `.tsx`), explicitly mention `/typescript-best-practices` ([SKILL.md](../skills/typescript-best-practices/SKILL.md)) to enforce discriminated unions, `unknown` boundary parsing, and exhaustive matching. For cheap local failing-test-first iterations, run `/tdd` ([SKILL.md](../skills/tdd/SKILL.md)) directly.

### Stage 4: Clean the Diff Before Commit & Review

AStack separates code cleanup, comment removal, and prose cleanup into three specialized passes:

1. **`/deslop` ([SKILL.md](../skills/deslop/SKILL.md)) strip code bloat:** Inlines single-caller wrappers, deletes unsupported defensive fallbacks and dead compatibility layers, removes unrelated changes, and re-runs verification.
2. **`/no-comments` ([SKILL.md](../skills/no-comments/SKILL.md)) fresh-eyes comment & suppression audit:** Spawns [`comment-sicko`](../agents/comment-sicko.md) (`TypeName: "comment-sicko"`) to delete narrating comments, flag workaround comments for root-cause fixes, and offer structural encodings (types/lints/tests) for claimed constraints.
3. **`/unslop` ([SKILL.md](../skills/unslop/SKILL.md)) & `/technical-writing` ([SKILL.md](../skills/technical-writing/SKILL.md)) tighten prose:** Removes AI writing tells, filler, long dashes, and mid-sentence colons from docs, READMEs, RFCs, PR descriptions, and commit messages.

### Stage 5: Verify on the Real Surface & Ship

"It compiles" or mocked unit tests alone are never accepted as proof:

- **Prove behavior live:** Use `.agents/skills/verify-<app>/`, [`/control-ui`](../skills/control-ui/SKILL.md) (browser/Electron via Antigravity's `browser` subagent + Chrome DevTools MCP), or [`/control-cli`](../skills/control-cli/SKILL.md) (isolated temp dirs, exit codes, stdout/stderr contracts, and background daemon cleanup).
- **Check hidden ripple effects:** Run `/blast-radius` ([SKILL.md](../skills/blast-radius/SKILL.md)) on small risky diffs to prove safety with real execution.
- **Adversarial pre-ship review:** Run `/interrogate` ([SKILL.md](../skills/interrogate/SKILL.md)) over a branch; only findings backed by a failing rerun survive.
- **Babysit and land PRs:**
  - `/astack-mode babysit pr <number> to green.`
  - `/astack-mode land the verified stack.`

---

## Part 4: Multi-agent modes and power moves

### 1. Pair `/astack-mode` With Antigravity's 16 Native Slash Commands

AStack routes matching intent to all 16 public Antigravity slash commands ([`native-commands.md`](../skills/astack-mode/references/native-commands.md)) across four engagement modes (`run`, `load`, `contract`, `recommend`):

| Category / Command | Mode | Use When | AStack Pairing |
|---|---|---|---|
| **Planning:** `/plan`, `/grill-me` | `contract` | Need a reviewable `implementation_plan.md` gate or one-question-at-a-time interview | [`plan-contract.md`](../skills/astack-mode/references/plan-contract.md), `/architect` |
| **Learning & Customization:** `/learn`, `/agy-customizations`, `/plugin` | `contract` / `load` | Persist rules/skills (`learning_proposal.md` gate), author rules/hooks, or manage plugins | `/reflect`, `/correct`, `/automate-me` |
| **Subagents & `/fanout` / `/browser`:** `invoke_subagent`, `/browser` | `run` | 2-5 independent sweeps, research, or live UI verification (`browser` subagent) | `/how`, `/why`, `/fanout`, `/arena`, `/control-ui` |
| **Workflows:** `/run-workflow` | `run` | Same check across many files or staged multi-phase Python `pipeline()` (Pro & Ultra) | `/fanout`, [`swarm-coordination.md`](../skills/astack-mode/references/swarm-coordination.md) |
| **Deep Reasoning:** `/boost` | `recommend` | Hard, tightly coupled bug, race condition, or perf bottleneck | `bug-fix`, `perf-issue`, `hillclimb`, `/tdd`, `/statechart` |
| **Swarm Board:** `/swarm` | `run` | Broad, divisible work across modules, test suites, or PRs with `@verifier` + `@monitor` | `autopilot-full`, `autopilot-stack`, [`swarm-coordination.md`](../skills/astack-mode/references/swarm-coordination.md) |
| **Campaigns:** `/teamwork` | `recommend` | Multi-milestone, multi-hour or multi-day migration needing Sentinel audit gates | `orchestrate`, `/architect`, `/show-me-your-work` |
| **Autonomy & Schedulers:** `/goal`, `/schedule`, `/automation` | `recommend` / `run` / `load` | `/goal` for uninterrupted completion; `/schedule` for in-session timers/crons; `/automation` (App only, `CRON_TZ=`) for persistent background triggers | `autonomous-run`, `/figure-it-out`, `decisions.tsv` |
| **Interactive & Docs:** `/btw`, `/generative_ui`, `/antigravity-guide` | `recommend` / `load` | Side queries, rich HTML widgets (App only), or official Antigravity CLI/App docs | `/ketchup`, `/astack-help` |

When returning from a long `/swarm`, `/teamwork`, or `/goal` run, catch up in seconds using [`/ketchup`](../skills/ketchup/SKILL.md) (which uses `/generative_ui` in the App and markdown in the CLI) or [`/ketchup-video`](../skills/ketchup-video/SKILL.md).

### 2. Build the Compounding Repository Flywheel

AStack gets exponentially faster the longer you use it in a repo because each run strengthens the environment for future runs:

1. **Keep `verify-<app>` honest:** Run [`/maintain-verification-skill`](../skills/maintain-verification-skill/SKILL.md) periodically (or via `/schedule` / `/automation`) so your feature map never drifts from your UI/CLI.
2. **Prove tricky state machines formally:** Run [`/create-formal-verification-skill`](../skills/create-formal-verification-skill/SKILL.md) and [`/statechart`](../skills/statechart/SKILL.md) where unit tests miss subtle interleavings.
3. **Never correct the same mistake twice:** Run [`/correct`](../skills/correct/SKILL.md) to push repeated agent errors up the 5-layer hierarchy (architecture/types -> lint/CI error naming the fix -> tests -> rules/hooks, using `/learn` `learning_proposal.md` for persistent rules).
4. **Capture durable workflow wins:** After a hard session, run [`/reflect`](../skills/reflect/SKILL.md) (`learning_proposal.md` gate for new skills or rules), or [`/automate-me`](../skills/automate-me/SKILL.md) (powered by `/agy-customizations`) to distill your personal coding preferences out of your transcripts.
5. **Opt into safety guardrails ([hooks.json](../hooks.json)):** Flip `"enabled": true` on `astack-irreversible-guard` to require explicit confirmation on destructive commands (`git push --force`, `git reset --hard`, `DROP TABLE`), and `astack-verify-reminder` when you want a stop-time verification check.

### 3. Steer Mid-Chat With One-Line Principle Shortcuts

Instead of writing paragraphs of correction, drop a principle name or slash shortcut:

- **Agent claimed "done" off a build/typecheck:** `"Apply principle-prove-it-works: drive the real flow and paste the output."`
- **Agent added a defensive `if` guard instead of fixing why bad state happened:** `"Apply principle-fix-root-causes: trace where the invalid value entered and fix it there."`
- **Agent is retrying variations of the same failing fix:** `"Apply principle-attack-the-premise: isolate and test the shared assumption directly first."`
- **Diff got bloated with wrappers or speculative flags:** `"Apply principle-laziness-protocol and run /deslop."`
- **Reply got too dense with jargon:** Type [`/bro`](../skills/bro/SKILL.md) for a crisp, jargon-free restatement.

### 4. High-Leverage Do's vs. Common Pitfalls

| Do This (High Leverage) | Avoid This (Common Pitfall) |
|---|---|
| State **goal + empirical done check** and let `/astack-mode` pick the playbook. | Micromanaging skill chains (`"use /how then /architect then /arena..."`). |
| State **symptoms and artifacts first**; let the agent restate the problem before sharing your hunch. | Leading with your own guess so the agent only searches where you pointed. |
| Keep default **UI model inheritance**. Works on any model and plan, preserves Orchestrator's bidirectional planner and executor hand-offs, and discovers live models in `/arena`. | Pinning dated model version slugs in config files, which locks turns to one model and breaks when new models ship or quota runs out. |
| Give parallel writers isolated workspaces when running swarms. | Letting two concurrent writers edit the same working tree. |
| Save `/astack-mode` for real features, bugs, refactors, and investigations. | Running full `/astack-mode` playbooks for a trivial one-line typo edit. |
| Demand real artifacts (failing->passing output, screenshots, `decisions.tsv`, vetted medians). | Trusting `"all tests pass"` or unvetted benchmark speedups without [`/benchmark-checklist`](../skills/benchmark-checklist/SKILL.md). |

---

## Further Reading

- [10-Part Step-by-Step Guide](./guide/README.md)
- [Architecture & Swarm Reference](./architecture-and-swarm.md)
