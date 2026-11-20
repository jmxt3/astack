### Opening a PR

Invoked at the end of build playbooks. Prepare small ordered local commits and run `/deslop` and `/no-comments` on code diffs. After an interactive `/plan`, `/grill-me`, or `/architect` checkpoint (or whenever the user asked to stop before `git push`), stop at verified local commits before `git push` or `gh pr create` unless the user asked to push or open a PR. Push and open the PR immediately when requested or under `autopilot-*` and `shipping` playbooks.

**Worktree.** Work from a git worktree (or `Workspace: "share"` / `"branch"`) off main. Subagents inherit it unless isolated. Multiple parallel writers on the same branch each take their own `Workspace: "share"` / `"branch"` checkout so writes never race. Dirty branch with unrelated work: patch out, fresh worktree, apply. Snarled worktree: reset from main, redo minimally.

**Commits.** Commit liberally. Rebase into small, ordered commits before opening PRs. Each commit is a future PR: landable, ordered to tell the story. Amend when the fix belongs in a just-made commit. New commit when separable. Commit bodies don't restate the subject.

**PRs.** Run `/deslop` (bundled in AStack at `../../deslop/SKILL.md`) over the diff before commit and `/no-comments` before review. Before opening or updating a PR, run [`/review-pr`](../../review-pr/SKILL.md) (`node skills/review-pr/scripts/pr-dossier.mjs`) to classify Risk Tier (`0..3`), verify `evidence.json` SHA freshness and test-assertion integrity, inspect `<artifact-dir>/pr-review.md`, and run an isolated `pr-verifier` pass when changes cross Risk Tier 1 or higher. Compile the GitHub PR proof block (`<!-- astack:pr-proof:start -->` through `<!-- astack:pr-proof:end -->`) with `node skills/review-pr/scripts/pr-dossier.mjs --format github --merge-body <body-file> --out <body-file>`, then pass `--body-file <body-file>` to `gh pr create` (or the compiled body to `github-mcp-server`). Write every PR title, description, and commit body with `/technical-writing` (every layer except Diátaxis, and apply the STE vocabulary rules: one word per action, keep articles, a plain verb over `-ing` where one works), then apply `/unslop`.

**Titles.** Conventional Commits `type(scope): subject`, no trailing period. Type such as `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `perf`. Scope is the area, such as `astack` or `astack-mode`. Subject is short, imperative, and names a real symbol when one carries the change, for example `fix(astack): retarget opening-a-pr babysit trigger`.

**Descriptions.** The PR body pairs a concise human briefing at the top with the compiled Statechart and `PASS`/`FAIL`/`SKIP`/`UNREACHABLE` proof block below it. Keep the top narrative short and simple without walls of text. Configure GitHub squash merges to use the PR title (or pass explicit `gh pr merge --squash --subject ... --body ...`) so Mermaid graphs and tables do not bloat `git log`. Use `##` headings, not bold lead-ins, in this order, and drop a section with nothing to say:

- `## Why`: the problem and approach, 1-3 short sentences. No SHAs, rebase genealogy, or "based on main" preamble.
- `## What changed`: 1-3 short bullets. Name a real symbol or path only when it carries the change. Name both sides of a rename or retarget.
- `## Scope`: always. 1-3 short items on what it covers and what it deliberately leaves out (a follow-up, a known gap). No symbols, paths, or file-by-file essay.
- `## Tradeoffs`: only rejected alternatives a reviewer would otherwise ask about. Skip when there was no real choice.
- `## Blast Radius`: 1-2 sentences on Risk Tier (`Tier 0..3`), who or what it touches, and why that is safe or risky. If main is red, state the cost of leaving it red.

Below those narrative headings, embed the deterministic `<!-- astack:pr-proof:start -->` block from `pr-dossier.mjs --format github` (containing `<!-- astack:proof-meta {...} -->`, `## Statechart`, `## Verification Proof`, and collapsible receipts/verifier details). Keep local UI screenshots in Antigravity's `<artifact-dir>/pr-review.md` via `--screenshots` rather than embedding binary screenshot galleries in GitHub PR descriptions. Full SHAs, swarm or arena lane recitals, lever-correction essays, and file-by-file checklists belong in a linked local artifact, not the PR body.

**Forge.** Use GitHub CLI (`gh`) and/or Antigravity's `github-mcp-server` (`create_pull_request`, `pull_request_read`). Do not require proprietary wrappers like Graphite (`gt`).

**MCP PR tool.** When using `github-mcp-server`, keep PR state consistent with `gh pr view` before reporting status.

**Size and stacks.** Prefer five narrow PRs to one large PR. A stack is a base-branch chain. The root PR targets trunk. Each child branch rebases onto its parent's exact tip and its PR targets the parent branch. As a parent merges, move its child onto trunk per `playbooks/shipping.md` step 4. Create a child with `gh pr create --base <parent-branch>` and retarget one with `gh pr edit <pr> --base <parent-branch>`. Branch from trunk only for independent work. Rebase on trunk before substantial stack work.

**Readiness.** Open every PR ready, never as a draft. Set `draft: false` with `github-mcp-server` or omit `--draft` with `gh`. Run `gh pr view <number>` before reporting PR status.

**Babysit.** Opening a PR does not start a babysit. Post the URL and keep building. Finish the phase or stack first. Run a separate babysit pass only when the user asks for one after the whole stack exists. A babysit for each new PR stalls the build and spends checks on commits later waves restart. Push back when feedback drifts from intent.

A subagent that opens a PR runs `/deslop` and `/no-comments`, and posts the URL. It returns to the parent without babysitting, unless it is an Autopilot-full or Autopilot-stack owner. That owner's brief assigns the babysit loop and is the ask `playbooks/babysit.md` waits for. The owner starts the loop after its code-ready report, reports merge-ready, and is exempt from the rules here and in `playbooks/babysit.md` that hold babysitting until a whole stack is built.
