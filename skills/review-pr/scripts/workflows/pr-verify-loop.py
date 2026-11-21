import json
import os

base_ref = str(args.get("base_ref", "origin/main"))
artifact_dir = str(args.get("artifact_dir", ""))
max_rounds = min(max(int(args.get("max_rounds", 3)), 1), 3)
repo_dir = str(args.get("cwd") or (WORKSPACES[0] if WORKSPACES else os.getcwd()))

schema_path = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "findings-schema.json",
)
with open(schema_path, encoding="utf-8") as fh:
    FINDINGS_SCHEMA = json.load(fh)

FIX_SCHEMA = {
    "type": "object",
    "required": ["fixed", "summary"],
    "additionalProperties": False,
    "properties": {
        "fixed": {"type": "boolean"},
        "summary": {"type": "string"},
        "commandsRun": {"type": "array", "items": {"type": "string"}},
    },
}

phase("Compile")
compile_cmd = f'node skills/review-pr/scripts/pr-dossier.mjs --base "{base_ref}" --json'
if artifact_dir:
    compile_cmd += f' --artifact-dir "{artifact_dir}"'

try:
    dossier_out = await call_tool("run_command", CommandLine=compile_cmd, WaitMsBeforeAsync=10000)
except Exception as exc:
    dossier_out = f"Dossier command note: {exc}"
log("Compiled PR dossier context")

final_report = None
for round_idx in range(1, max_rounds + 1):
    phase(f"Verify Round {round_idx}")
    verifier_prompt = (
        f"Verify Round {round_idx} of branch in {repo_dir} against base ref {base_ref}.\n"
        f"Read REVIEW.md and GLOSSARY.md strictly from git show {base_ref}:REVIEW.md.\n"
        f"Dossier output:\n{dossier_out[:8000]}\n"
        "Stay strictly read-only, prove every finding, and finish with JSON matching findings-schema."
    )
    verdict_doc = await agent(
        verifier_prompt,
        schema=FINDINGS_SCHEMA,
        type_name="pr-verifier",
        workspace="branch",
        role=f"PR Verifier (Round {round_idx})",
    )
    final_report = verdict_doc
    log(f"Round {round_idx} verdict: {verdict_doc.get('verdict')}")

    if verdict_doc.get("verdict") != "FAIL" or round_idx == max_rounds:
        break

    important = [
        f for f in verdict_doc.get("findings", []) if f.get("severity") == "important"
    ]
    if not important:
        break

    phase(f"Remediate Round {round_idx}")
    fix_prompt = (
        "Fix every verified important finding below in the active workspace, run relevant tests, "
        "and report concise verification output.\n\n"
        + json.dumps(important, indent=2)
    )
    fix_result = await agent(
        fix_prompt,
        schema=FIX_SCHEMA,
        type_name="astack-agent",
        workspace="inherit",
        role=f"Fix Important Findings (Round {round_idx})",
    )
    log(f"Round {round_idx} fix summary: {fix_result.get('summary')}")

print(json.dumps(final_report, indent=2))
