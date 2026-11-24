# AStack Domain Glossary

> Keep shared domain nouns and autonomy boundaries canonical across code, hooks, specs, and Timeline UI copy.

| Term | Canonical Meaning | Avoid / Do Not Confuse With |
|---|---|---|
| `WorkspaceScope` | Three-state boundary classification (`non_repo`, `git_unregistered`, `enrolled_repo`) computed before hooks touch disk or inject prompts | Treating every open folder as a software repository |
| `Inherent risk` | Noisy-OR probability score `R` computed strictly from unmitigated diff signals before verification receipts apply | Highest matching path glob alone |
| `Residual risk` | Risk score `R` and bucket (`low`, `medium`, `high`, `blocked`) remaining after fresh `HEAD` mitigation receipts reduce signal weights | Stale test passes or model self-confidence |
| `Signal` | Deterministic risk indicator extracted from git diff, numstat, Intent Card, or session receipts (such as `deletes_assertions`, `scope_drift`, `bundled_sidecar_permissions`) | Subjective prose warning |
| `Mitigation` | Concrete verification or review step mapped to a fired signal that lowers residual risk when backed by a fresh receipt | Verbal claim that code looks safe |
| `Receipt` | Single-actor execution record bound to a `HEAD` SHA inside `<trustDir>/receipts.<conversationId>.jsonl` | Unverified terminal prose |
| `Intent Card` | Structured pre-write reflection recorded via `declare_intent` with declared scope globs, assumptions, edge cases, rollback plan, and predicted risk `R` | Informal chat intent |
| `Outcome` | Graded post-merge or plan-gate ground-truth label (`clean` = 1, `approved_with_edits` / `follow_up_fix` = 0.5, `reverted` / `trunk_broken` / `human_override` = 0) stored in the hash-chained local ledger | Individual edit or unit test pass |
| `Trust level` | Earned discrete autonomy level (`L0` Observe, `L1` Assist, `L2` Ship with review, `L3` Auto-merge sampled) scoped per `(repoId, category)` | Global on/off switch |
| `Ceiling` | Human-configured maximum autonomy level (`L1`, `L2`, or `L3`; default `L2`, `governance` locked at `L2`) that always caps earned trust and Auto promotion | Earned level or temporary session override |
