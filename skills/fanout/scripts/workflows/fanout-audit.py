import json

files = [str(f) for f in args.get("files", []) if str(f).strip()]
criteria = str(
    args.get(
        "criteria",
        "Audit correctness, boundary handling, error propagation, and missing tests.",
    )
)

SLICE_SCHEMA = {
    "type": "object",
    "required": ["file", "verdict", "findings"],
    "additionalProperties": False,
    "properties": {
        "file": {"type": "string"},
        "verdict": {"type": "string", "enum": ["PASS", "ISSUES", "BLOCKED"]},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["line", "claim", "evidence"],
                "additionalProperties": False,
                "properties": {
                    "line": {"type": "integer"},
                    "claim": {"type": "string"},
                    "evidence": {"type": "string"},
                },
            },
        },
    },
}

if not files:
    phase("Discover Targets")
    files = await agent(
        "List changed or scoped source files in this workspace to audit (relative paths array only).",
        schema={"type": "array", "items": {"type": "string"}},
        type_name="research",
        model="flash",
        role="Discover target files",
    )

phase("Fanout Audit")
results = await parallel(
    files,
    lambda file_path: agent(
        f"Audit `{file_path}` strictly read-only.\nCriteria: {criteria}\n"
        "Report every concrete defect with line number and evidence, or PASS with empty findings.",
        schema=SLICE_SCHEMA,
        type_name="research",
        model="flash",
        role=f"Audit {file_path}",
    ),
)

issues_count = sum(1 for item in results if item.get("verdict") == "ISSUES")
passed_count = sum(1 for item in results if item.get("verdict") == "PASS")
log(f"Fanout complete: passed={passed_count}/{len(results)} issues={issues_count}")

print(
    json.dumps(
        {
            "total": len(results),
            "passed": passed_count,
            "issues": issues_count,
            "results": results,
        },
        indent=2,
    )
)
