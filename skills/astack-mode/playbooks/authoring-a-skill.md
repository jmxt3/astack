### Authoring or modifying a skill

**You own the skill's voice.**

1. Follow Antigravity's skill authoring conventions (`agy-customizations` docs): `skills/<name>/SKILL.md` with YAML frontmatter containing only `name` (matching folder) and a crisp third-person `description`, keeping body size `<= 24,000` bytes and putting bulky manuals in `references/`.
2. Validate the skill: run `node scripts/validate-astack.mjs` and `agy plugin validate --strict .` (when in a plugin) so frontmatter, size limit, and relative cross-skill links all pass cleanly.
3. Test cases if structural. Skip if subjective.
4. Run **Opening a PR**.

When in doubt, delete. Keep only prose that changes a decision. Tell it to do the thing and skip the reason. Explain only when the rule is confusing without one. Match tone to scope. Point at structural sources (types, READMEs, config) per the **encode-lessons-in-structure** principle skill. Delegate to other skills by path. Don't restate. A workflow you keep hitting but isn't captured → propose a new skill.

**Reply:** summary of the skill, key design decisions, validation notes.
