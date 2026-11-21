import json

limit = min(max(int(args.get("last", 40)), 5), 200)

PROPOSAL_SCHEMA = {
    "type": "object",
    "required": ["lens", "candidates"],
    "additionalProperties": False,
    "properties": {
        "lens": {"type": "string"},
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["title", "target", "enforcement", "rationale"],
                "additionalProperties": False,
                "properties": {
                    "title": {"type": "string"},
                    "target": {"type": "string"},
                    "enforcement": {
                        "type": "string",
                        "enum": ["architecture", "type", "lint", "test", "hook", "skill", "rule"],
                    },
                    "rationale": {"type": "string"},
                },
            },
        },
    },
}

phase("Collect Trajectory Digest")
steps = await trajectory(last=limit)
digest_items = []
for step in steps:
    stype = step.get("type")
    status = step.get("status")
    text = (step.get("text") or "").strip()
    tool = step.get("tool")
    if stype == "USER_INPUT" and text:
        digest_items.append(f"[step {step.get('index')} USER] {text[:400]}")
    elif status == "ERROR":
        out = (step.get("output") or "").strip()[:400]
        digest_items.append(f"[step {step.get('index')} ERROR tool={tool}] {out}")

digest = "\n".join(digest_items) or "No user inputs or tool errors found in trajectory slice."
log(f"Collected {len(digest_items)} notable trajectory entries across {len(steps)} steps")

LENS_BRIEFS = {
    "judgment": "Focus on framing mistakes, wrong assumptions, skipped read-only checks, or premature edits.",
    "tooling": "Focus on missing structural checks, fragile commands, test gaps, or lint/type enforcement candidates.",
    "divergent": "Look for second-order friction, hidden coupling, or alternative simplifications missed earlier.",
}

phase("Parallel Reflect Review")
reviews = await parallel(
    list(LENS_BRIEFS.keys()),
    lambda lens: agent(
        f"Review this session digest through the `{lens}` lens.\n"
        f"{LENS_BRIEFS[lens]}\n"
        "Propose durable structural improvements (/correct or /learn) backed strictly by the digest below; ignore one-offs.\n\n"
        f"{digest}",
        schema=PROPOSAL_SCHEMA,
        type_name="research",
        model="inherit",
        role=f"Reflect ({lens})",
    ),
)

print(json.dumps({"stepsInspected": len(steps), "reviews": reviews}, indent=2))
