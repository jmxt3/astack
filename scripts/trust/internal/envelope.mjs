import fs from "node:fs";

export const FILE_WRITE_TOOLS = [
  "write_file",
  "edit_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
];

export const FILE_WRITE_TOOL_MATCHER = FILE_WRITE_TOOLS.join("|");
export const SECRET_GUARD_MATCHER = `${FILE_WRITE_TOOL_MATCHER}|run_command`;

const FILE_WRITE_TOOL_SET = new Set(FILE_WRITE_TOOLS);

/**
 * Normalizes a conversation identifier into a filesystem-safe filename segment.
 */
export function sanitizeConversationId(raw) {
  const cleaned = String(raw ?? "default")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 80) || "default";
}

/**
 * Returns true when running in CI or non-interactive headless execution.
 */
export function isHeadless(env = process.env) {
  return (
    env.NON_INTERACTIVE === "1" ||
    env.CI === "true" ||
    env.CI === "1"
  );
}

function extractWorkspaceDir(payload) {
  if (Array.isArray(payload.workspacePaths)) {
    for (const candidate of payload.workspacePaths) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  if (typeof payload.cwd === "string" && payload.cwd.trim()) {
    return payload.cwd.trim();
  }
  return "";
}

function extractTextChunks(args) {
  const chunks = [];
  for (const key of [
    "Content",
    "content",
    "CodeContent",
    "codeContent",
    "Replacement",
    "replacement",
    "ReplacementContent",
    "replacementContent",
  ]) {
    if (typeof args[key] === "string" && args[key].length > 0) {
      chunks.push(args[key]);
    }
  }
  const replacementChunks = args.ReplacementChunks ?? args.replacementChunks;
  if (Array.isArray(replacementChunks)) {
    for (const item of replacementChunks) {
      if (!item || typeof item !== "object") continue;
      const text = item.ReplacementContent ?? item.replacementContent;
      if (typeof text === "string" && text.length > 0) {
        chunks.push(text);
      }
    }
  }
  return chunks;
}

/**
 * Normalizes raw Antigravity App, IDE, and CLI hook stdin payloads into a uniform event union.
 */
export function parseHookPayload(payload, hint) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const conversationId = sanitizeConversationId(
    payload.conversationId ?? payload.sessionId ?? "default",
  );
  const workspaceDir = extractWorkspaceDir(payload);
  const artifactDir =
    typeof payload.artifactDirectoryPath === "string" &&
    payload.artifactDirectoryPath.trim()
      ? payload.artifactDirectoryPath.trim()
      : null;

  const toolCall = payload.toolCall;
  const rawToolName = String(
    toolCall?.name ?? payload.tool_name ?? "",
  ).trim();
  const lowerTool = rawToolName.toLowerCase();
  const args = toolCall?.args ?? payload.tool_input ?? payload.args;
  const hasToolShape = Boolean(toolCall || payload.tool_input || rawToolName);

  if (hint === "stop" || (!hasToolShape && (
    payload.terminationReason !== undefined ||
    payload.fullyIdle !== undefined ||
    payload.continuationActive !== undefined ||
    payload.executionNum !== undefined
  ))) {
    const rawReason = String(payload.terminationReason ?? "");
    const terminationReason =
      rawReason === "" ||
      rawReason === "model_stop" ||
      rawReason === "NO_TOOL_CALL"
        ? "model_stop"
        : "other";
    return {
      kind: "stop",
      conversationId,
      terminationReason,
      fullyIdle: payload.fullyIdle !== false,
      continuationActive: payload.continuationActive === true,
      workspaceDir,
      artifactDir,
    };
  }

  if (hasToolShape) {
    const safeArgs = args && typeof args === "object" ? args : {};
    const phase = payload.error !== undefined || hint === "post" ? "post" : "pre";
    const error = typeof payload.error === "string" ? payload.error : "";
    const command = String(
      safeArgs.CommandLine ?? safeArgs.commandLine ?? safeArgs.command ?? "",
    );
    const filePath = String(
      safeArgs.Path ?? safeArgs.path ?? safeArgs.TargetFile ?? safeArgs.targetFile ?? "",
    );
    const chunks = extractTextChunks(safeArgs);

    if (lowerTool === "run_command" || (!FILE_WRITE_TOOL_SET.has(lowerTool) && command && !filePath)) {
      return {
        kind: "tool-command",
        phase,
        conversationId,
        tool: rawToolName || "run_command",
        command,
        error,
        workspaceDir,
        artifactDir,
      };
    }

    if (FILE_WRITE_TOOL_SET.has(lowerTool) || (!rawToolName && chunks.length > 0)) {
      return {
        kind: "tool-write",
        phase,
        conversationId,
        tool: rawToolName || "write_file",
        filePath,
        chunks,
        error,
        workspaceDir,
        artifactDir,
      };
    }

    return {
      kind: "tool-other",
      phase,
      conversationId,
      tool: rawToolName || "unknown",
      error,
      workspaceDir,
      artifactDir,
    };
  }

  return {
    kind: "session-start",
    conversationId,
    workspaceDir,
    artifactDir,
  };
}

/**
 * Parses raw UTF-8 stdin text fail-open, returning `{ event, raw }` or `{ event: null, raw: null }`.
 */
export function parseHookStdin(rawText, hint) {
  if (typeof rawText !== "string" || !rawText.trim()) {
    return { event: null, raw: null };
  }
  try {
    const parsed = JSON.parse(rawText);
    return {
      event: parseHookPayload(parsed, hint),
      raw: parsed,
    };
  } catch {
    return { event: null, raw: null };
  }
}

/**
 * Executes a hook handler over stdin/stdout fail-open, always exiting 0 with valid JSON.
 */
export function runHookShell(handler, { hint, fallback = { decision: "allow" } } = {}) {
  let rawText = "";
  try {
    rawText = fs.readFileSync(0, "utf8");
  } catch {
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    return;
  }

  const { event, raw } = parseHookStdin(rawText, hint);
  if (!event) {
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
    return;
  }

  try {
    const out = handler(event, raw);
    process.stdout.write(`${JSON.stringify(out ?? fallback)}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify(fallback)}\n`);
  }
}
