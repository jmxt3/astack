### Release and postmortem

**You own post-merge verification and permanent prevention. A release is verified by live smoke evidence, and every incident ends with a structural guard.**

1. **Generate evidence-backed release notes.** Inspect actual merged commits and PRs (`git log <prev-tag>..HEAD`, `gh pr list --state merged`) rather than guessing. Group user-facing changes, breaking steps, migrations, and known limits accurately (`/technical-writing`, `/unslop`).
2. **Run read-only post-deploy smoke verification (`control-cli` / `control-ui`).** Never trust build-green alone (`principle-prove-it-works`). Probe live read-only health endpoints, expected version/commit markers, rendered key routes, and zero new 5xx/console errors without mutating production data. Keep destructive actions gated.
3. **Investigate incidents from facts, not guesses.** Capture trace/log evidence (`playbooks/trace-forensics.md`, `playbooks/runtime-forensics.md`), establish the earliest broken invariant (`principle-fix-root-causes`), and record a blameless timeline (trigger, detection gap, blast radius, mitigation).
4. **Close the loop permanently.**
   - Add a regression test or user journey covering the failure in `.agents/skills/verify-<app>/features/` (`maintain-verification-skill`).
   - Run [`/correct`](../../correct/SKILL.md) to encode the prevention as high up the 5-layer hierarchy as possible (types -> lint/CI -> hooks -> rules), rather than leaving a one-off doc reminder (`principle-encode-lessons-in-structure`).

**Reply:** release tag/range or incident summary, verified post-deploy smoke results, new regression journey added, `/correct` enforcement level chosen, and open follow-ups.
