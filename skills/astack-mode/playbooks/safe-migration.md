### Safe migration

**You own zero-downtime data integrity. Old and new application code must survive side by side across every step.**

1. **Prove current schema state and lock risk first.** Inspect the schema, row counts/table shapes, indexes, and foreign-key locks locally before writing a migration (`how`, `why`). Identify operations that acquire long `ACCESS EXCLUSIVE` or table-rewrite locks.
2. **Sequence into expand, backfill, switch, contract (`principle-sequence-verifiable-units`).**
   - **Expand:** add nullable columns, new tables, or concurrent/non-blocking indexes without removing or renaming columns read by running code.
   - **Dual-write & backfill:** keep backfills chunked, resumable, and **idempotent** (`principle-make-operations-idempotent`) so partial crashes converge on rerun.
   - **Switch & verify dual versions:** run the existing (pre-change) contract and the new code side by side against a seeded local database to prove forward and backward compatibility during rolling deploys.
   - **Contract separately:** drop legacy columns, triggers, or dual-write paths only after the new release has soaked cleanly and no reader uses the old shape.
3. **Prove rollback locally (`principle-prove-it-works`).** Against a seeded disposable local database via `control-cli`, run migrate-up, execute the backfill twice (proving idempotency), run read/write queries from both schema versions, and execute the rollback/down step cleanly. Keep destructive DB shell guards in `irreversible-guard.mjs` active on shared targets.

**Reply:** migration phases (expand, backfill, switch, contract), lock and timeout guards, dual-schema + idempotency + rollback evidence against a seeded local DB, and what remains deferred to post-deploy contract cleanup.
