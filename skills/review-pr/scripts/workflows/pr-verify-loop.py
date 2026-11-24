import json
import os
import re
import shlex

base_ref = str(args.get("base_ref", "origin/main"))
if not re.fullmatch(r"[A-Za-z0-9._/@~^+-]+", base_ref) or base_ref.startswith("-"):
    raise ValueError(f"Invalid git base_ref: {base_ref!r}")
artifact_dir = str(args.get("artifact_dir", ""))
max_rounds = min(max(int(args.get("max_rounds", 3)), 1), 3)
repo_dir = str(args.get("cwd") or (WORKSPACES[0] if WORKSPACES else os.getcwd()))


def quote_shell_arg(value: str) -> str:
    if any(ch in value for ch in ("\0", "\r", "\n")):
        raise ValueError("Shell argument contains unsupported control character")
    if os.name == "nt":
        return "'" + value.replace("'", "''") + "'"
    return shlex.quote(value)


scripts_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
schema_path = os.path.join(scripts_dir, "findings-schema.json")
dossier_script = os.path.join(scripts_dir, "pr-dossier.mjs")
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

final_report = None
for round_idx in range(1, max_rounds + 1):
    phase(f"Compile Round {round_idx}")
    cmd_parts = [
        "node",
        quote_shell_arg(dossier_script),
        "--cwd",
        quote_shell_arg(repo_dir),
        "--base",
        quote_shell_arg(base_ref),
    ]
    if artifact_dir:
        cmd_parts.extend(["--artifact-dir", quote_shell_arg(artifact_dir)])
    cmd_parts.append("--json")
    compile_cmd = " ".join(cmd_parts)

    try:
        dossier_out = await call_tool(
            "run_command",
            CommandLine=compile_cmd,
            WaitMsBeforeAsync=10000,
            toolSummary=f"Compile PR dossier (Round {round_idx})",
        )
    except Exception as exc:
        raise RuntimeError(
            f"Failed to compile PR dossier for round {round_idx}: {exc}"
        ) from exc
    log(f"Compiled PR dossier context for round {round_idx}")

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

    evidence_dir = None
    try:
        parsed_compile = json.loads(dossier_out)
        if isinstance(parsed_compile, dict) and parsed_compile.get("evidencePath"):
            evidence_dir = os.path.dirname(str(parsed_compile["evidencePath"]))
    except Exception:
        evidence_dir = None
    if not evidence_dir and artifact_dir:
        evidence_dir = os.path.join(artifact_dir, "astack-trust")
    if evidence_dir:
        os.makedirs(evidence_dir, exist_ok=True)
        findings_path = os.path.join(evidence_dir, "findings.json")
        if isinstance(verdict_doc, dict) and "round" not in verdict_doc:
            verdict_doc = {**verdict_doc, "round": round_idx}
        with open(findings_path, "w", encoding="utf-8") as fh:
            json.dump(verdict_doc, fh, indent=2)
            fh.write("\n")
        record_parts = [
            "node",
            quote_shell_arg(dossier_script),
            "--cwd",
            quote_shell_arg(repo_dir),
            "--base",
            quote_shell_arg(base_ref),
            "--findings",
            quote_shell_arg(findings_path),
            "--record-verifier",
            "--json",
        ]
        if artifact_dir:
            record_parts.extend(["--artifact-dir", quote_shell_arg(artifact_dir)])
        await call_tool(
            "run_command",
            CommandLine=" ".join(record_parts),
            WaitMsBeforeAsync=10000,
            toolSummary=f"Record verifier receipt and recompile evidence (Round {round_idx})",
        )

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
