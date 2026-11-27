import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isHeadless, sanitizeConversationId } from "./envelope.mjs";
import {
  detectSessionTestRegression,
  evaluateIntentScope,
  readIntentCard,
} from "./intent.mjs";
import {
  classifyCommandCategory,
  computeFreshness,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  resolveTrustDir,
} from "./ledger.mjs";
import { classifyActionClass, resolveResidual } from "./mitigation.mjs";
import {
  isProtectedTrustStorePath,
  readTrustSettings,
  resolvePluginDataDir,
  resolveRealPathBestEffort,
} from "./outcomes.mjs";
import {
  collectLeafSegments,
  evaluateDecisionTable,
  extractCommandSubstitutions,
  loadBoundaries,
  loadRiskPolicy,
  resolveEnrolledWorkspaceScope,
  scanBacktickSubstitution,
  scanBalancedSubshell,
  splitShellPipelines,
  stripPowerShellBackticks,
  stripTransparentWrappers,
  tokenizeSimpleWords,
  unwrapShellInvocation,
} from "./policy.mjs";
import { assessChange, classifyDominantCategory } from "./risk.mjs";
import { evaluateRepoTrust } from "./trust-level.mjs";

const READ_ONLY_VERBS = new Set([
  "cat",
  "type",
  "get-content",
  "gc",
  "head",
  "tail",
  "ls",
  "dir",
  "get-childitem",
  "gci",
  "rg",
  "ripgrep",
  "grep",
  "select-string",
  "sls",
  "findstr",
  "stat",
  "wc",
]);

const MUTATING_TRUST_CLI_CMDS = new Set([
  "beast",
  "promotion",
  "ceiling",
  "promote",
  "undo",
  "record-outcome",
]);

const TRUST_CLI_VALUE_FLAGS = new Set([
  "--cwd",
  "--data-dir",
  "--base",
  "--sha",
  "--risk",
  "--pr",
  "--note",
]);

const SHELL_WRITE_OPERATOR_RE = /(?:>>?|\|\s*tee\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b)/i;
const TRUST_STORE_HINT_RE =
  /(?:plugin[-_]data[\\/]+astack[\\/]+trust|(?:\$\{?(?:env:)?|%|\$env:)(?:ASTACK_PLUGIN_DATA|ANTIGRAVITY_PLUGIN_DATA|PLUGIN_DATA)[}%]?[\\/]+trust)/i;

const INTERPRETER_VERBS = new Set([
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "py",
  "perl",
  "ruby",
]);
const SHELL_AND_INTERPRETER_VERBS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "pwsh",
  "powershell",
  "cmd",
  "xargs",
  "source",
  ".",
  ...INTERPRETER_VERBS,
]);
const PWSH_ENCODED_FLAG_RE =
  /^[-/](?:e|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)(?::.*)?$/i;
const PROTECTED_INLINE_CODE_RE =
  /(?:plugin[-_]data[\\/]astack[\\/]trust|scripts[\\/]trust|\bsettings\.json\b|\bledger\.jsonl\b|\bcli\.mjs\b|\bapplyTrustSettingsAction\b|\bappendOutcome\b|\bwriteTrustSettingsAtomic\b)/i;
const PROTECTED_INLINE_PARTS_RE =
  /\bscripts\b[^;\n]{0,40}\btrust\b|\bplugin[-_]data\b[^;\n]{0,40}\btrust\b/i;
const TAINTED_VAR_VALUE_RE =
  /(?:trust|plugin[-_]data|settings\.json|ledger\.jsonl|cli\.mjs|ASTACK_PLUGIN_DATA|ANTIGRAVITY_PLUGIN_DATA|PLUGIN_DATA)/i;
const PLUGIN_DATA_DIR_HINT_RE = /(?:ASTACK_PLUGIN_DATA|ANTIGRAVITY_PLUGIN_DATA|PLUGIN_DATA|plugin[-_]data[\\/]astack)/i;
const B64_TOKEN_RE = /^[A-Za-z0-9+/=]{16,}$/;
const HEX_TOKEN_RE = /^[0-9a-fA-F]{16,}$/;
const XARGS_VALUE_FLAGS = new Set([
  "-n", "-L", "-P", "-I", "-i", "-d", "-s", "-a", "-E", "-e",
  "--max-args", "--max-lines", "--max-procs", "--replace", "--delimiter", "--max-chars", "--arg-file", "--eof",
]);

function normalizePosixLower(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function normalizeShellTokenPath(tok) {
  const unquoted = String(tok ?? "").replace(/["'`\u2018-\u201d]/g, "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!unquoted) return "";
  return path.posix.normalize(unquoted).toLowerCase();
}

function normalizeInlinePayload(text) {
  let collapsed = String(text ?? "")
    .replace(/\$\{[^}]{0,24}\}/g, "")
    .replace(/\[((?:\s*["'`][^"'`]+["'`]\s*,?)+)\]\s*\.join\(\s*(?:""|''|``)\s*\)/g, (_, items) =>
      items.replace(/["'`\s,]+/g, ""),
    );
  for (let pass = 0; pass < 3; pass++) {
    const next = collapsed.replace(/["'`\u2018-\u201d]\s*(?:[+.]\s*)?["'`\u2018-\u201d]/g, "");
    if (next === collapsed) break;
    collapsed = next;
  }
  return collapsed.replace(/["'`\u2018-\u201d]/g, "");
}

function decodeEscapeSequences(text) {
  return String(text ?? "")
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\0([0-7]{1,3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
    .replace(/\\([1-7][0-7]{0,2})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)));
}

function expandHomeDirInPath(target) {
  const cleaned = String(target ?? "").replace(/["'`\u2018-\u201d]/g, "").trim();
  if (!cleaned) return "";
  const home = os.homedir().replace(/\\/g, "/");
  return cleaned
    .replace(/^(?:~|\$(?:HOME|\{HOME\}|env:USERPROFILE)|%USERPROFILE%)(?=[\\/]|$)/i, home);
}

function matchesProtectedInlinePayload(text, resolvedTrustRoot) {
  const raw = String(text ?? "");
  const normalized = normalizeInlinePayload(raw);
  for (const candidate of [raw, normalized]) {
    if (
      PROTECTED_INLINE_CODE_RE.test(candidate) ||
      PROTECTED_INLINE_PARTS_RE.test(candidate) ||
      TRUST_STORE_HINT_RE.test(candidate) ||
      (resolvedTrustRoot && normalizePosixLower(candidate).includes(resolvedTrustRoot))
    ) {
      return true;
    }
  }
  return false;
}

function getLeadingVerb(tokens) {
  return stripTransparentWrappers(tokens).verb;
}

function hasMutatingTrustCliSubcommand(tokens, scriptIdx) {
  for (let j = scriptIdx + 1; j < tokens.length; j++) {
    const arg = String(tokens[j] ?? "").replace(/["'`\u2018-\u201d\\]/g, "").toLowerCase();
    if (!arg) continue;
    if (TRUST_CLI_VALUE_FLAGS.has(arg)) {
      j += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return MUTATING_TRUST_CLI_CMDS.has(arg);
  }
  return false;
}

function extractXargsTargetCommand(stage) {
  let tokens = tokenizeSimpleWords(stage);
  let wrapped = stripTransparentWrappers(tokens);
  if (wrapped.splitCommands.length > 0) {
    tokens = tokenizeSimpleWords(wrapped.splitCommands[0]);
    wrapped = stripTransparentWrappers(tokens);
  }
  if (wrapped.verb !== "xargs") return { targetTokens: [], replaceStr: null };
  const rest = wrapped.rest;
  let replaceStr = null;
  let j = 0;
  while (j < rest.length) {
    const opt = rest[j];
    if (opt === "--") {
      j++;
      break;
    }
    if (opt === "-I" && j + 1 < rest.length) {
      replaceStr = rest[j + 1];
      j += 2;
      continue;
    }
    const attachedI = opt.match(/^-[Ii](.+)$/);
    if (attachedI) {
      replaceStr = attachedI[1];
      j++;
      continue;
    }
    const eqReplace = opt.match(/^--replace=(.+)$/i);
    if (eqReplace) {
      replaceStr = eqReplace[1];
      j++;
      continue;
    }
    if (opt === "--replace" || opt === "-i") {
      replaceStr = "{}";
      j++;
      continue;
    }
    if (XARGS_VALUE_FLAGS.has(opt) && j + 1 < rest.length) {
      j += 2;
      continue;
    }
    if (opt.startsWith("-")) {
      j++;
      continue;
    }
    break;
  }
  return { targetTokens: rest.slice(j), replaceStr };
}

function extractProcessSubAndHereStrings(segment) {
  const extracted = [];
  const hereIdx = segment.indexOf("<<<");
  if (hereIdx !== -1) {
    const rhs = segment.slice(hereIdx + 3).trim();
    if (rhs) extracted.push(rhs);
    for (const sub of extractCommandSubstitutions(rhs)) {
      if (sub) extracted.push(sub);
    }
    for (const tok of tokenizeSimpleWords(rhs)) {
      if (tok) extracted.push(tok);
    }
  }
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < segment.length - 1; i++) {
    const ch = segment[i];
    const next = segment[i + 1];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "$" && next === "(") {
      const sub = scanBalancedSubshell(segment, i + 1);
      if (sub.closed) {
        i = sub.closeIdx;
        continue;
      }
    }
    if (ch === "`") {
      const tick = scanBacktickSubstitution(segment, i);
      if (tick.closed) {
        i = tick.closeIdx;
        continue;
      }
    }
    if (!inDouble && ch === "$" && next === "'") {
      i += 2;
      while (i < segment.length) {
        if (segment[i] === "\\" && i + 1 < segment.length) {
          i += 2;
          continue;
        }
        if (segment[i] === "'") break;
        i++;
      }
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && (ch === "<" || ch === ">") && next === "(") {
      const sub = scanBalancedSubshell(segment, i + 1);
      const inner = sub.inner.trim();
      if (inner) extracted.push(inner);
      i = sub.closed ? sub.closeIdx : segment.length - 1;
    }
  }
  return extracted;
}

function checkPipedShellInputs(raw, resolvedTrustRoot, options, depth) {
  for (const stages of splitShellPipelines(raw)) {
    if (stages.length < 2) continue;
    for (let k = 1; k < stages.length; k++) {
      const sinkVerb = getLeadingVerb(tokenizeSimpleWords(stages[k]));
      if (!SHELL_AND_INTERPRETER_VERBS.has(sinkVerb)) continue;
      const upstreams = stages.slice(0, k);
      const hasBase64Stage = upstreams.some((u) => /\b(?:base64|FromBase64String)\b/i.test(u));
      const hasRevStage = upstreams.some((u) => getLeadingVerb(tokenizeSimpleWords(u)) === "rev");
      const hasHexStage = upstreams.some((u) => /\bxxd\b/i.test(u));
      const xargsInfo = sinkVerb === "xargs" ? extractXargsTargetCommand(stages[k]) : { targetTokens: [], replaceStr: null };

      for (const upstream of upstreams) {
        if (matchesProtectedInlinePayload(upstream, resolvedTrustRoot)) {
          return true;
        }
        const upTokens = tokenizeSimpleWords(upstream);
        const upVerb = getLeadingVerb(upTokens);

        if (upVerb === "printf" || upVerb === "echo") {
          const escDecodedUp = decodeEscapeSequences(upstream);
          if (
            escDecodedUp !== upstream &&
            (matchesProtectedInlinePayload(escDecodedUp, resolvedTrustRoot) ||
              upTokens.some((tok) => {
                const decTok = decodeEscapeSequences(tok);
                return decTok !== tok && depth < 2 && isProtectedTrustShellCommand(decTok, options, depth + 1);
              }))
          ) {
            return true;
          }
        }

        if (xargsInfo.targetTokens.length > 0 && depth < 2) {
          const upArgs =
            READ_ONLY_VERBS.has(upVerb) || upVerb === "echo" || upVerb === "printf" ? upTokens.slice(1) : upTokens;
          const upArgJoined = upArgs.join(" ");
          const substitutedTarget = xargsInfo.replaceStr
            ? xargsInfo.targetTokens.map((t) => (t.includes(xargsInfo.replaceStr) ? t.replaceAll(xargsInfo.replaceStr, upArgJoined) : t))
            : null;
          const candidates = [
            ...(substitutedTarget ? [substitutedTarget.join(" ")] : []),
            [...xargsInfo.targetTokens, ...upArgs].join(" "),
            [...xargsInfo.targetTokens, ...upTokens].join(" "),
          ];
          for (const candidate of candidates) {
            if (candidate && isProtectedTrustShellCommand(candidate, options, depth + 1)) {
              return true;
            }
          }
        }

        if (depth < 2) {
          for (const tok of upTokens) {
            if (!tok || tok.startsWith("-")) continue;
            if (isProtectedTrustShellCommand(tok, options, depth + 1)) {
              return true;
            }
          }
        }
        if (hasRevStage) {
          for (const tok of [upstream, ...upTokens]) {
            if (!tok || tok.length < 4) continue;
            const reversed = [...tok].reverse().join("");
            if (
              matchesProtectedInlinePayload(reversed, resolvedTrustRoot) ||
              (depth < 2 && isProtectedTrustShellCommand(reversed, options, depth + 1))
            ) {
              return true;
            }
          }
        }
        if (hasHexStage) {
          const hexInputs = [];
          for (const tok of upTokens) {
            if (HEX_TOKEN_RE.test(tok) && tok.length % 2 === 0) {
              hexInputs.push(tok);
            }
            if (hasRevStage && tok.length >= 16 && tok.length % 2 === 0) {
              const revTok = [...tok].reverse().join("");
              if (revTok !== tok && HEX_TOKEN_RE.test(revTok)) {
                hexInputs.push(revTok);
              }
            }
          }
          for (const hexTok of hexInputs) {
            try {
              const hexDecoded = Buffer.from(hexTok, "hex").toString("utf8");
              const candidates = hasRevStage ? [hexDecoded, [...hexDecoded].reverse().join("")] : [hexDecoded];
              for (const decoded of candidates) {
                if (
                  matchesProtectedInlinePayload(decoded, resolvedTrustRoot) ||
                  (depth < 2 && isProtectedTrustShellCommand(decoded, options, depth + 1))
                ) {
                  return true;
                }
              }
            } catch {
            }
          }
        }
        if (hasBase64Stage) {
          const b64Inputs = [];
          for (const tok of upTokens) {
            if (B64_TOKEN_RE.test(tok)) {
              b64Inputs.push(tok);
            }
            if (hasRevStage && tok.length >= 16) {
              const revTok = [...tok].reverse().join("");
              if (revTok !== tok && B64_TOKEN_RE.test(revTok)) {
                b64Inputs.push(revTok);
              }
            }
          }
          for (const b64Tok of b64Inputs) {
            try {
              const b64Decoded = Buffer.from(b64Tok, "base64").toString("utf8");
              const candidates = hasRevStage ? [b64Decoded, [...b64Decoded].reverse().join("")] : [b64Decoded];
              for (const decoded of candidates) {
                if (
                  matchesProtectedInlinePayload(decoded, resolvedTrustRoot) ||
                  (depth < 2 && isProtectedTrustShellCommand(decoded, options, depth + 1))
                ) {
                  return true;
                }
              }
            } catch {
            }
          }
        }
      }
    }
  }
  return false;
}

function advanceCdState(curLexDir, curRealDir, dirArg, options, resolvedTrustRoot, trustParents) {
  const expanded = expandHomeDirInPath(dirArg);
  const cleanExpanded = expanded.replace(/^['"]+|['"]+$/g, "");
  const normTarget = normalizeShellTokenPath(cleanExpanded);
  const nextLexDir =
    normTarget.startsWith("/") || /^[a-z]:\//i.test(normTarget) || !curLexDir
      ? normTarget
      : path.posix.normalize(`${curLexDir}/${normTarget}`);
  const realBase = curRealDir || options.workspaceDir || process.cwd();
  const nextRealRaw = cleanExpanded
    ? resolveRealPathBestEffort(cleanExpanded, { baseDir: realBase })
    : curRealDir;
  const nextRealNorm = nextRealRaw ? normalizePosixLower(nextRealRaw) : "";
  const isProtectedDir =
    PLUGIN_DATA_DIR_HINT_RE.test(dirArg) ||
    PLUGIN_DATA_DIR_HINT_RE.test(nextLexDir) ||
    PLUGIN_DATA_DIR_HINT_RE.test(nextRealNorm) ||
    isProtectedTrustStorePath(cleanExpanded, { dataDir: options.dataDir, workspaceDir: realBase }) ||
    isProtectedTrustStorePath(nextRealRaw, { dataDir: options.dataDir, workspaceDir: realBase }) ||
    trustParents.has(nextLexDir) ||
    trustParents.has(nextRealNorm) ||
    (Boolean(resolvedTrustRoot) &&
      (normalizePosixLower(cleanExpanded).includes(resolvedTrustRoot) ||
        nextLexDir.includes(resolvedTrustRoot) ||
        nextRealNorm.includes(resolvedTrustRoot)));
  return { nextLexDir, nextRealDir: nextRealRaw, isProtectedDir };
}

/**
 * Returns true when a shell command attempts to modify `${PLUGIN_DATA}/trust/**` or run mutating `scripts/trust/cli.mjs` commands.
 */
export function isProtectedTrustShellCommand(command, options = {}, _depth = 0) {
  const raw = String(command ?? "").trim();
  if (!raw) return false;

  const pluginTrustDir = path.join(resolvePluginDataDir(options), "trust");
  const resolvedTrustRoot = normalizePosixLower(path.resolve(pluginTrustDir));
  const resolvedTrustReal = normalizePosixLower(resolveRealPathBestEffort(pluginTrustDir));
  const trustParents = new Set(
    [resolvedTrustRoot, resolvedTrustReal].filter(Boolean).map((p) => path.posix.dirname(p)),
  );
  if (checkPipedShellInputs(raw, resolvedTrustRoot, options, _depth)) {
    return true;
  }
  if (_depth < 3 && raw.includes("`")) {
    const psView = stripPowerShellBackticks(raw);
    if (psView !== raw && isProtectedTrustShellCommand(psView, options, _depth + 1)) {
      return true;
    }
  }

  const initialWorkspaceReal =
    typeof options.workspaceDir === "string" && options.workspaceDir.trim()
      ? resolveRealPathBestEffort(options.workspaceDir)
      : "";
  let cdDir = typeof options._cdDir === "string" ? options._cdDir : "";
  let cdRealDir =
    typeof options._cdRealDir === "string" ? options._cdRealDir : initialWorkspaceReal;
  let cdIntoPluginData = Boolean(options._cdIntoPluginData);
  const taintedVars = new Set(options._taintedVars ?? []);

  if (_depth < 4 && /(?:^|[^<])<<-?(?!<)/.test(raw) && raw.includes("\n")) {
    const rawLines = raw.split(/\r?\n/);
    let heredocCdDir = cdDir;
    let heredocCdRealDir = cdRealDir;
    const heredocTaintedVars = new Set(taintedVars);

    for (let lineIdx = 0; lineIdx < rawLines.length - 1; lineIdx++) {
      const headerLine = rawLines[lineIdx];
      const heredocMatches = [
        ...headerLine.matchAll(
          /(?:^|[^<])(<<-?)(?!<)\s*(?:\\?(["'])([^\r\n]*?)\2|\\?([^\s'"`;&|<>()]+))/g,
        ),
      ];
      if (heredocMatches.length === 0) {
        for (const seg of splitShellPipelines(headerLine).flat()) {
          const hToks = tokenizeSimpleWords(seg);
          if (hToks.length === 0) continue;
          const hWrap = stripTransparentWrappers(hToks);
          for (const dArg of hWrap.chdirDirs) {
            const next = advanceCdState(heredocCdDir, heredocCdRealDir, dArg, options, resolvedTrustRoot, trustParents);
            heredocCdDir = next.nextLexDir;
            heredocCdRealDir = next.nextRealDir;
          }
          for (const tok of hToks) {
            const assign = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
            if (assign) {
              const valNorm = assign[2].replace(/["'`]/g, "").replace(/\\/g, "/").toLowerCase();
              if (TAINTED_VAR_VALUE_RE.test(valNorm) || (resolvedTrustRoot && valNorm.includes(resolvedTrustRoot))) {
                heredocTaintedVars.add(assign[1]);
              }
            }
          }
          const psAssign = seg.match(
            /^(?:\[[A-Za-z0-9_.\[\]]+\]\s*)?\$(?:(?:script|global|local|private):)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i,
          );
          if (psAssign) {
            const valNorm = psAssign[2].replace(/["'`]/g, "").replace(/\\/g, "/").toLowerCase();
            if (TAINTED_VAR_VALUE_RE.test(valNorm) || (resolvedTrustRoot && valNorm.includes(resolvedTrustRoot))) {
              heredocTaintedVars.add(psAssign[1]);
            }
          }
          if (hWrap.verb === "cd" || hWrap.verb === "set-location" || hWrap.verb === "sl" || hWrap.verb === "pushd") {
            const targetArg = hWrap.rest.find((t) => !t.startsWith("-") && t.toLowerCase() !== "/d");
            if (targetArg) {
              const next = advanceCdState(heredocCdDir, heredocCdRealDir, targetArg, options, resolvedTrustRoot, trustParents);
              heredocCdDir = next.nextLexDir;
              heredocCdRealDir = next.nextRealDir;
            }
          }
        }
        continue;
      }

      let bodyCursor = lineIdx + 1;
      const pipelinesOnHeader = splitShellPipelines(headerLine);
      for (const hm of heredocMatches) {
        const op = hm[1];
        const delim = hm[3] !== undefined ? hm[3] : (hm[4] ?? "");
        if (bodyCursor >= rawLines.length) break;
        const remainingLines = rawLines.slice(bodyCursor);
        const endLineIdx = remainingLines.findIndex((l) =>
          op === "<<-" ? l.replace(/^\t+/, "") === delim : l === delim,
        );
        const bodyLines = endLineIdx !== -1 ? remainingLines.slice(0, endLineIdx) : remainingLines;
        bodyCursor += endLineIdx !== -1 ? endLineIdx + 1 : remainingLines.length;
        const body = bodyLines.join("\n");
        if (!body.trim()) continue;

        const heredocOpts = {
          ...options,
          _cdDir: heredocCdDir,
          _cdRealDir: heredocCdRealDir,
          _taintedVars: heredocTaintedVars,
        };
        const targetPipes = pipelinesOnHeader.filter((stages) =>
          stages.some((st) => st.includes(op) && (delim === "" || st.includes(delim))),
        );
        const pipelinesToCheck = targetPipes.length > 0 ? targetPipes : pipelinesOnHeader;
        for (const stages of pipelinesToCheck) {
          const stageVerbs = stages.map((seg) => getLeadingVerb(tokenizeSimpleWords(seg))).filter(Boolean);
          const hasShellSink = stageVerbs.some((v) =>
            ["sh", "bash", "zsh", "dash", "pwsh", "powershell", "cmd"].includes(v),
          );
          const hasAnySink = hasShellSink || stageVerbs.some((v) => SHELL_AND_INTERPRETER_VERBS.has(v));
          if (!hasAnySink) continue;

          if (matchesProtectedInlinePayload(body, resolvedTrustRoot)) {
            return true;
          }
          if (hasShellSink && isProtectedTrustShellCommand(body, heredocOpts, _depth + 1)) {
            return true;
          }
          const stageIdx = stages.findIndex((st) => st.includes(op) && (delim === "" || st.includes(delim)));
          if (stageIdx !== -1) {
            const rawStage = stages[stageIdx];
            const cleanedStage = rawStage
              .replace(/(?:^|[^<])<<-?(?!<)\s*(?:\\?(["'])[^\r\n]*?\1|\\?[^\s'"`;&|<>()]+)/g, "")
              .trim();
            const stageVerb = cleanedStage ? getLeadingVerb(tokenizeSimpleWords(cleanedStage)) : "";
            const tailStages = stages.slice(stageIdx + 1);
            const hasDecoder =
              /\b(?:base64|FromBase64String|rev|xxd)\b/i.test(cleanedStage) ||
              tailStages.some((st) => /\b(?:base64|FromBase64String|rev|xxd)\b/i.test(st));
            if (hasDecoder) {
              const trimmedLines = bodyLines.map((l) => l.trim().replace(/'/g, "")).filter(Boolean);
              const singleLineBody = trimmedLines.join("");
              const candidates =
                singleLineBody && !trimmedLines.includes(singleLineBody)
                  ? [...trimmedLines, singleLineBody]
                  : trimmedLines;
              for (const tok of candidates) {
                const rebuiltStages =
                  !cleanedStage || stageVerb === "cat"
                    ? [...stages.slice(0, stageIdx), `echo '${tok}'`, ...tailStages]
                    : [...stages.slice(0, stageIdx), `echo '${tok}'`, cleanedStage, ...tailStages];
                const rebuilt = rebuiltStages.join(" | ");
                if (checkPipedShellInputs(rebuilt, resolvedTrustRoot, heredocOpts, _depth + 1)) {
                  return true;
                }
              }
            }
          }
        }
      }
      if (bodyCursor - 1 > lineIdx) {
        lineIdx = bodyCursor - 1;
      }
    }
  }

  for (const segment of splitShellPipelines(raw).flat()) {
    const tokens = tokenizeSimpleWords(segment);
    if (tokens.length === 0) continue;

    const wrapped = stripTransparentWrappers(tokens);
    let segCdDir = cdDir;
    let segCdRealDir = cdRealDir;
    let segCdIntoPluginData = cdIntoPluginData;
    for (const dirArg of wrapped.chdirDirs) {
      const next = advanceCdState(segCdDir, segCdRealDir, dirArg, options, resolvedTrustRoot, trustParents);
      segCdDir = next.nextLexDir;
      segCdRealDir = next.nextRealDir;
      if (next.isProtectedDir) segCdIntoPluginData = true;
    }

    const childOpts = {
      ...options,
      _cdDir: segCdDir,
      _cdRealDir: segCdRealDir,
      _cdIntoPluginData: segCdIntoPluginData,
      _taintedVars: taintedVars,
    };

    const unwrapped = unwrapShellInvocation(segment);
    if (Array.isArray(unwrapped) && unwrapped.length > 0 && _depth < 4) {
      for (const sub of unwrapped) {
        if (isProtectedTrustShellCommand(sub, childOpts, _depth + 1)) {
          return true;
        }
      }
    }

    const substitutions = extractCommandSubstitutions(segment);
    if (substitutions.length > 0 && _depth < 4) {
      for (const sub of substitutions) {
        if (isProtectedTrustShellCommand(sub, childOpts, _depth + 1)) {
          return true;
        }
      }
    }

    if (segment.includes("<<<") || /[<>]\(/.test(segment)) {
      if (matchesProtectedInlinePayload(segment, resolvedTrustRoot)) {
        return true;
      }
      if (_depth < 4) {
        for (const inner of extractProcessSubAndHereStrings(segment)) {
          if (isProtectedTrustShellCommand(inner, childOpts, _depth + 1)) {
            return true;
          }
          for (const innerStages of splitShellPipelines(inner)) {
            const innerPipe = innerStages.join(" | ");
            if (innerPipe && checkPipedShellInputs(`${innerPipe} | sh`, resolvedTrustRoot, childOpts, _depth + 1)) {
              return true;
            }
          }
        }
      }
    }

    const verb = wrapped.verb;
    const isSymlinkCreateCmd =
      verb === "ln" ||
      verb === "mklink" ||
      ((verb === "new-item" || verb === "ni") && /(?:symboliclink|junction|hardlink)/i.test(segment)) ||
      (verb === "cp" && tokens.some((t) => /^-[a-zA-Z]*s[a-zA-Z]*$|^--symbolic-link$/i.test(t)));
    if (isSymlinkCreateCmd) {
      const normSegLower = normalizePosixLower(segment.replace(/["'`\u2018-\u201d]/g, ""));
      const hitsParentInText = Array.from(trustParents).some((tp) => tp && normSegLower.includes(tp));
      if (
        PLUGIN_DATA_DIR_HINT_RE.test(segment) ||
        TRUST_STORE_HINT_RE.test(segment) ||
        (resolvedTrustRoot && normSegLower.includes(resolvedTrustRoot)) ||
        hitsParentInText ||
        tokens.some((tok) => {
          const tokClean = tok.replace(/["'`\u2018-\u201d]/g, "");
          if (!tokClean || tokClean.startsWith("-")) return false;
          const tokReal = normalizePosixLower(
            resolveRealPathBestEffort(tokClean, { baseDir: segCdRealDir || options.workspaceDir }),
          );
          const inTrustParent = Array.from(trustParents).some(
            (tp) => tp && (tokReal === tp || tokReal.startsWith(`${tp}/`)),
          );
          return (
            PLUGIN_DATA_DIR_HINT_RE.test(tokClean) ||
            PLUGIN_DATA_DIR_HINT_RE.test(tokReal) ||
            inTrustParent ||
            isProtectedTrustStorePath(tokClean, {
              dataDir: options.dataDir,
              workspaceDir: segCdRealDir || options.workspaceDir,
            })
          );
        })
      ) {
        return true;
      }
    }

    const pureRead =
      READ_ONLY_VERBS.has(verb) &&
      !SHELL_WRITE_OPERATOR_RE.test(segment) &&
      substitutions.length === 0;

    for (const tok of tokens) {
      const assign = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (assign) {
        const valNorm = assign[2].replace(/["'`]/g, "").replace(/\\/g, "/").toLowerCase();
        if (TAINTED_VAR_VALUE_RE.test(valNorm) || (resolvedTrustRoot && valNorm.includes(resolvedTrustRoot))) {
          taintedVars.add(assign[1]);
        }
      }
    }
    const psAssign = segment.match(
      /^(?:\[[A-Za-z0-9_.\[\]]+\]\s*)?\$(?:(?:script|global|local|private):)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i,
    );
    if (psAssign) {
      const valNorm = psAssign[2].replace(/["'`]/g, "").replace(/\\/g, "/").toLowerCase();
      if (TAINTED_VAR_VALUE_RE.test(valNorm) || (resolvedTrustRoot && valNorm.includes(resolvedTrustRoot))) {
        taintedVars.add(psAssign[1]);
      }
    }

    if ((verb === "pwsh" || verb === "powershell") && tokens.some((t) => PWSH_ENCODED_FLAG_RE.test(t))) {
      return true;
    }

    const isInlineInterpreterCall =
      INTERPRETER_VERBS.has(verb) &&
      (tokens.some(
        (t) =>
          /^-(?:e|p|c|-eval|-print)$/i.test(t) ||
          /^--(?:eval|print)=/i.test(t) ||
          (/^(?:node|bun)$/.test(verb) && /^-[a-z]*[ep][a-z]*$/i.test(t)) ||
          (/^(?:perl|ruby)$/.test(verb) && /^-[a-zA-Z]*[ep]/i.test(t)) ||
          (/^(?:python|python3|py)$/.test(verb) && /^-[a-zA-Z]*c/.test(t)),
      ) ||
        (verb === "deno" && tokens.some((t) => t.toLowerCase() === "eval")) ||
        (verb === "node" && tokens.some((t) => /^(?:--import|--loader|--require|-r)(?:=|$)/i.test(t))));

    if (isInlineInterpreterCall) {
      if (matchesProtectedInlinePayload(segment, resolvedTrustRoot)) {
        return true;
      }
    }

    if (!pureRead && taintedVars.size > 0) {
      const unquotedSeg = segment.replace(/["'`]/g, "");
      for (const v of taintedVars) {
        const varRefRe = new RegExp(`(?:\\$\\{?${v}\\}?|\\$env:${v}\\b|%${v}%)`, "i");
        if (varRefRe.test(unquotedSeg)) {
          return true;
        }
      }
    }

    if (verb === "cd" || verb === "set-location" || verb === "sl" || verb === "pushd") {
      const targetArg = wrapped.rest.find((t) => !t.startsWith("-") && t.toLowerCase() !== "/d");
      if (targetArg) {
        const next = advanceCdState(cdDir, cdRealDir, targetArg, options, resolvedTrustRoot, trustParents);
        cdDir = next.nextLexDir;
        cdRealDir = next.nextRealDir;
        cdIntoPluginData = next.isProtectedDir;
        segCdDir = cdDir;
        segCdRealDir = cdRealDir;
        segCdIntoPluginData = cdIntoPluginData;
      }
    }

    for (let i = 0; i < tokens.length; i++) {
      const cleanTok = normalizeShellTokenPath(tokens[i]);
      const joinedTok = segCdDir && !cleanTok.startsWith("/") ? path.posix.normalize(`${segCdDir}/${cleanTok}`) : cleanTok;
      const realTok = segCdRealDir
        ? normalizePosixLower(
            resolveRealPathBestEffort(tokens[i].replace(/["'`\u2018-\u201d]/g, ""), { baseDir: segCdRealDir }),
          )
        : "";
      const isTrustCli =
        cleanTok.endsWith("scripts/trust/cli.mjs") ||
        cleanTok.endsWith("/trust/cli.mjs") ||
        cleanTok === "trust/cli.mjs" ||
        joinedTok.endsWith("scripts/trust/cli.mjs") ||
        joinedTok.endsWith("/trust/cli.mjs") ||
        realTok.endsWith("scripts/trust/cli.mjs") ||
        realTok.endsWith("/trust/cli.mjs");
      if (isTrustCli && hasMutatingTrustCliSubcommand(tokens, i)) {
        return true;
      }
    }

    const unquotedNormSeg = normalizePosixLower(segment.replace(/["'`\u2018-\u201d]/g, ""));
    const touchesResolvedDir = Boolean(resolvedTrustRoot && unquotedNormSeg.includes(resolvedTrustRoot));
    const touchesHint =
      TRUST_STORE_HINT_RE.test(segment) || TRUST_STORE_HINT_RE.test(segment.replace(/["'`\u2018-\u201d]/g, ""));
    const touchesCdPluginTrust =
      segCdIntoPluginData && /(?:^|[\s"'/`\\])trust(?:[\\/]|$)|settings\.json|ledger\.jsonl/i.test(segment);
    const touchesTokenPath = tokens.some((tok) => {
      const clean = normalizeShellTokenPath(tok);
      const joinedClean = segCdDir && !clean.startsWith("/") ? path.posix.normalize(`${segCdDir}/${clean}`) : clean;
      const resolvedTokHit = Boolean(resolvedTrustRoot && joinedClean.includes(resolvedTrustRoot));
      const tokPath = tok
        .replace(/["'`\u2018-\u201d]/g, "")
        .replace(/^(?:[0-9&]*>>?|[0-9]*<[<>]?)/, "")
        .trim();
      const shiftedFromWs = Boolean(segCdRealDir && segCdRealDir !== initialWorkspaceReal);
      return (
        resolvedTokHit ||
        (Boolean(tokPath) &&
          !tokPath.startsWith("-") &&
          (clean.includes("/") || tok.includes("\\") || shiftedFromWs || Boolean(options.workspaceDir)) &&
          isProtectedTrustStorePath(tokPath, {
            dataDir: options.dataDir,
            workspaceDir: segCdRealDir || options.workspaceDir,
          }))
      );
    });

    if (touchesResolvedDir || touchesHint || touchesCdPluginTrust || touchesTokenPath) {
      if (!pureRead) {
        return true;
      }
    }
  }

  return false;
}

function buildPendingWriteAssessment({ event, scope, policy, receipts, evidence, intent, headSha }) {
  const relPath = path
    .relative(path.resolve(scope.repoRoot), path.resolve(scope.repoRoot, event.filePath))
    .split(path.sep)
    .join("/");
  const cleanRel = relPath.startsWith("..") ? event.filePath.replace(/\\/g, "/") : relPath;
  const chunkLines = (Array.isArray(event.chunks) ? event.chunks : []).join("\n").split(/\r?\n/);
  const addedDiff = chunkLines.map((line) => `+${line}`).join("\n");
  const diffText = `diff --git a/${cleanRel} b/${cleanRel}\n--- a/${cleanRel}\n+++ b/${cleanRel}\n@@ -1,0 +1,${chunkLines.length} @@\n${addedDiff}\n`;
  const numstat = `${chunkLines.length}\t0\t${cleanRel}\n`;
  const boundaries = loadBoundaries(scope.repoRoot).boundaries;
  const raw = assessChange({
    diffText,
    numstat,
    statusText: ` M ${cleanRel}\n`,
    policy,
    receipts,
    boundaries,
    intent,
    action: "local_write",
    headSha,
  });
  return resolveResidual(raw, receipts, {
    headSha,
    priorEvidence: evidence,
    intent,
  });
}

function synthesizeSessionAssessment({ action, policy, receipts, evidence, intent, headSha, changedFiles }) {
  const statusText = changedFiles.map((f) => ` M ${f}`).join("\n");
  const raw = assessChange({
    diffText: "",
    numstat: "",
    statusText,
    policy,
    receipts,
    intent,
    action,
    headSha,
  });
  if (changedFiles.length === 0) {
    raw.category = intent?.category ?? "core";
  }
  return resolveResidual(raw, receipts, {
    headSha,
    priorEvidence: evidence,
    intent,
  });
}

function hasFreshEvidenceRisk(evidence, headSha, receipts = []) {
  if (!evidence?.riskAssessment) return false;
  const normHead = typeof headSha === "string" && headSha.trim() ? headSha.trim().toLowerCase() : null;
  const topHead = typeof evidence.headSha === "string" && evidence.headSha.trim() ? evidence.headSha.trim().toLowerCase() : null;
  const innerHead =
    typeof evidence.riskAssessment.headSha === "string" && evidence.riskAssessment.headSha.trim()
      ? evidence.riskAssessment.headSha.trim().toLowerCase()
      : null;
  if (normHead) {
    if (!topHead && !innerHead) return false;
    if (topHead && topHead !== normHead) return false;
    if (innerHead && innerHead !== normHead) return false;
  }
  const evidenceTs = evidence.generatedAt || evidence.riskAssessment.predictedAt || null;
  if (evidenceTs && Array.isArray(receipts)) {
    const hasNewerWrite = receipts.some(
      (r) => r?.kind === "file_write" && r.ts && String(r.ts) > String(evidenceTs),
    );
    if (hasNewerWrite) return false;
  }
  return true;
}

function resolveEvidenceOrSessionAssessment({
  action,
  policy,
  receipts,
  evidence,
  intent,
  headSha,
  changedFiles,
  requireChanges = false,
}) {
  if (hasFreshEvidenceRisk(evidence, headSha, receipts)) {
    const base = structuredClone(evidence.riskAssessment);
    base.action = action;
    const reg = detectSessionTestRegression(receipts);
    if (reg.regressed && !(base.signals ?? []).some((s) => s.id === "test_regression")) {
      base.signals = [
        ...(base.signals ?? []),
        {
          id: "test_regression",
          severity: 3,
          weight: policy?.risk?.weights?.test_regression ?? 0.65,
          evidence: `regressed test(s): ${reg.commands.slice(0, 2).join(", ")}`,
        },
      ];
    }
    if (intent && changedFiles.length > 0 && !evaluateIntentScope(intent, changedFiles).inScope) {
      if (!(base.signals ?? []).some((s) => s.id === "scope_drift")) {
        base.signals = [
          ...(base.signals ?? []),
          {
            id: "scope_drift",
            severity: 3,
            weight: policy?.risk?.weights?.scope_drift ?? 0.55,
            evidence: `outside intent scope: ${evaluateIntentScope(intent, changedFiles).driftedFiles.slice(0, 4).join(", ")}`,
          },
        ];
      }
    }
    return resolveResidual(base, receipts, {
      headSha,
      priorEvidence: evidence,
      intent,
    });
  }
  if (requireChanges && changedFiles.length === 0) {
    return null;
  }
  return synthesizeSessionAssessment({ action, policy, receipts, evidence, intent, headSha, changedFiles });
}

function buildActionAssessment({ event, action, scope, policy, receipts, evidence, intent, headSha }) {
  if (event.kind === "tool-write" && event.filePath) {
    return buildPendingWriteAssessment({ event, scope, policy, receipts, evidence, intent, headSha });
  }
  const changedFiles = collectReceiptPaths(receipts);
  return resolveEvidenceOrSessionAssessment({
    action,
    policy,
    receipts,
    evidence,
    intent,
    headSha,
    changedFiles,
    requireChanges: false,
  });
}

/**
 * Evaluates `PreToolUse` autonomy decisions strictly on enrolled repos while denying agent mutations to `${PLUGIN_DATA}/trust/**`.
 */
export function evaluateTrustGate(event, options = {}) {
  if (!event || (event.kind !== "tool-write" && event.kind !== "tool-command" && event.kind !== "tool-mcp")) {
    return { decision: "allow" };
  }

  try {
    if (
      event.kind === "tool-write" &&
      isProtectedTrustStorePath(event.filePath, {
        dataDir: options.dataDir,
        workspaceDir: event.workspaceDir,
      })
    ) {
      return {
        decision: "deny",
        reason: "AStack trust-gate: agent writes to protected trust ledger or human settings are forbidden.",
      };
    }
    if (
      event.kind === "tool-command" &&
      isProtectedTrustShellCommand(event.command, {
        dataDir: options.dataDir,
        workspaceDir: event.workspaceDir,
      })
    ) {
      return {
        decision: "deny",
        reason: "AStack trust-gate: shell commands modifying protected trust ledger or human settings are forbidden.",
      };
    }
  } catch {
    return {
      decision: "deny",
      reason: "AStack trust-gate: failed closed while checking protected trust store boundary.",
    };
  }

  try {
    const scope =
      options.scope ?? resolveEnrolledWorkspaceScope(event.workspaceDir, { baseRef: options.baseRef });
    if (!scope || scope.kind !== "enrolled_repo" || !scope.repoId) {
      return { decision: "allow" };
    }

    const action = options.action ?? classifyActionClass(event);
    if (action === "read") {
      return { decision: "allow" };
    }

    const policyLoaded = options.policy
      ? { policy: options.policy, error: null }
      : loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
    if (policyLoaded.error) {
      return { decision: "allow" };
    }
    const policy = policyLoaded.policy;

    const settingsRes = readTrustSettings(scope.repoId, { dataDir: options.dataDir });
    if (settingsRes.parseError) {
      return { decision: "allow" };
    }

    const trust =
      options.trust ??
      evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir: options.dataDir,
        nowMs: options.nowMs,
      });
    if (!trust || trust.frozen || !trust.chainValid) {
      return { decision: "allow" };
    }

    const trustDir = options.trustDir ?? resolveTrustDir(event);
    const evidence = options.evidence !== undefined ? options.evidence : readEvidenceSnapshot(trustDir);
    const receipts = options.receipts !== undefined ? options.receipts : readMergedReceipts(trustDir);
    const headSha = options.headSha ?? readHeadShaFast(scope.repoRoot);
    const intent =
      options.intent !== undefined
        ? options.intent
        : readIntentCard(trustDir, event.conversationId || "default");
    const headless = options.headless ?? isHeadless();

const PURE_VERIFY_NAV_VERBS = new Set(["cd", "set-location", "sl", "pushd", "true"]);

function isPureVerificationCommand(command) {
  const leaves = collectLeafSegments(String(command ?? ""));
  if (leaves.length === 0) return false;
  let hasVerifyLeaf = false;
  for (const leaf of leaves) {
    const cat = classifyCommandCategory(leaf);
    if (cat === "test" || cat === "verify" || cat === "lint") {
      hasVerifyLeaf = true;
      continue;
    }
    if (classifyActionClass({ kind: "tool-command", command: leaf }) === "read") {
      continue;
    }
    const leadVerb = getLeadingVerb(tokenizeSimpleWords(leaf));
    if (PURE_VERIFY_NAV_VERBS.has(leadVerb) && !SHELL_WRITE_OPERATOR_RE.test(leaf)) {
      continue;
    }
    return false;
  }
  return hasVerifyLeaf;
}

    const assessment =
      options.assessment ??
      buildActionAssessment({ event, action, scope, policy, receipts, evidence, intent, headSha });

    if (
      action === "local_exec" &&
      isPureVerificationCommand(event.command)
    ) {
      const nonRegBlockers = (assessment.signals ?? []).filter(
        (s) => s.id !== "test_regression" && s.severity === 3,
      );
      if (assessment.residual === "blocked" && nonRegBlockers.length === 0) {
        return { decision: "allow" };
      }
    }

    const category = assessment.category ?? "core";
    const catState = trust.categories?.[category] ?? { level: 0, score: 0 };

    if (
      action === "local_write" &&
      trust.beastOn &&
      !intent &&
      (catState.level <= 1 || assessment.residual !== "low")
    ) {
      const askDecision = headless ? "deny" : "force_ask";
      const verb = headless ? "Blocked" : "Paused";
      return {
        decision: askDecision,
        reason: `${verb}. Local write needs an Intent Card (declare_intent) before editing ${category} at L${catState.level} (T ${catState.score.toFixed(2)}). Residual ${assessment.residual} (R ${Number(assessment.score ?? 0).toFixed(2)}).`,
      };
    }

    const result = evaluateDecisionTable({
      action,
      residual: assessment.residual,
      trustLevel: catState.level,
      category,
      trustScore: catState.score,
      riskScore: assessment.score,
      signals: assessment.signals,
      beastOn: trust.beastOn,
      policy,
      headless,
      isOwnRevert: Boolean(options.isOwnRevert),
    });

    if (result.decision === "deny" && result.reason) {
      const sigIds = new Set((assessment.signals ?? []).map((s) => s.id));
      if (sigIds.has("scope_drift") || sigIds.has("test_regression")) {
        return {
          decision: "deny",
          reason: `${result.reason} Escalate with the 2+ failed hypotheses tried or amend the Intent Card.`,
        };
      }
    }

    return result.reason ? { decision: result.decision, reason: result.reason } : { decision: result.decision };
  } catch {
    return { decision: "allow" };
  }
}

function handoffStatePath(trustDir, conversationId = "default") {
  return path.join(trustDir, `handoff.${sanitizeConversationId(conversationId)}.json`);
}

function readHandoffState(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return { transitions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.transitions
      ? parsed
      : { transitions: {} };
  } catch {
    return { transitions: {} };
  }
}

function writeHandoffStateAtomic(filePath, state) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

function collectReceiptPaths(receipts = []) {
  const paths = new Set();
  for (const r of receipts) {
    if (r?.kind === "file_write" && Array.isArray(r.paths)) {
      for (const p of r.paths) {
        if (typeof p === "string" && p.trim()) paths.add(p.replace(/\\/g, "/"));
      }
    }
  }
  return [...paths];
}

function hasFreshVerifierPass({ receipts, evidence, headSha }) {
  const hasReceipt = receipts.some(
    (r) =>
      r?.kind === "verifier" &&
      r.ok &&
      (r.verdict === "PASS" || r.verdict === "PASS_WITH_NOTES") &&
      (!headSha || !r.headSha || r.headSha === headSha),
  );
  const verifier = evidence?.verifier ?? null;
  const hasEvidence = Boolean(
    verifier &&
      !verifier.stale &&
      (verifier.verdict === "PASS" || verifier.verdict === "PASS_WITH_NOTES") &&
      (verifier.importantCount ?? 0) === 0 &&
      (verifier.reviewViolationCount ?? 0) === 0 &&
      (!headSha || verifier.headSha === headSha),
  );
  return hasReceipt || hasEvidence;
}

function hasMergeCompleted(receipts = []) {
  return receipts.some(
    (r) =>
      r?.ok &&
      ((r.kind === "mcp" && /merge_pull_request/i.test(String(r.toolName ?? ""))) ||
        (r.kind === "command" && /\bgh\s+pr\s+merge\b/i.test(String(r.summary ?? "")))),
  );
}

function hasRollbackReady({ receipts, evidence, intent, headSha }) {
  if (receipts.some((r) => r?.kind === "rollback" && r.ok && (!headSha || !r.headSha || r.headSha === headSha))) {
    return true;
  }
  const rb = hasFreshEvidenceRisk(evidence, headSha, receipts) ? evidence?.riskAssessment?.rollback : null;
  if (rb && rb.kind && rb.kind !== "none" && typeof rb.plan === "string" && rb.plan.trim() && !/^manual rollback/i.test(rb.plan)) {
    return true;
  }
  return Boolean(intent?.rollbackPlan && String(intent.rollbackPlan).trim());
}

/**
 * Evaluates Beast Mode stage-to-stage `Stop` continuation with strict idle, receipt, breaker, human-gate, and transition-cap guards.
 */
export function evaluateStageHandoff(event, options = {}) {
  if (!event || event.kind !== "stop") return { decision: "allow" };
  if (event.fullyIdle !== true || event.terminationReason !== "model_stop") {
    return { decision: "allow" };
  }
  if (event.continuationActive === true) return { decision: "allow" };
  if (typeof event.executionNum === "number" && event.executionNum > 2) {
    return { decision: "allow" };
  }

  try {
    const scope =
      options.scope ?? resolveEnrolledWorkspaceScope(event.workspaceDir, { baseRef: options.baseRef });
    if (!scope || scope.kind !== "enrolled_repo" || !scope.repoId) {
      return { decision: "allow" };
    }

    const policyLoaded = options.policy
      ? { policy: options.policy, error: null }
      : loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
    if (policyLoaded.error) return { decision: "allow" };
    const policy = policyLoaded.policy;

    const settingsRes = readTrustSettings(scope.repoId, { dataDir: options.dataDir });
    if (settingsRes.parseError) return { decision: "allow" };

    const trust =
      options.trust ??
      evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir: options.dataDir,
        nowMs: options.nowMs,
      });
    if (!trust || !trust.beastOn || trust.frozen || !trust.chainValid) {
      return { decision: "allow" };
    }

    const trustDir = options.trustDir ?? resolveTrustDir(event);
    const evidence = options.evidence !== undefined ? options.evidence : readEvidenceSnapshot(trustDir);
    const receipts = options.receipts !== undefined ? options.receipts : readMergedReceipts(trustDir);
    const headSha = options.headSha ?? readHeadShaFast(scope.repoRoot);
    const intent =
      options.intent !== undefined
        ? options.intent
        : readIntentCard(trustDir, event.conversationId || "default");

    if (hasMergeCompleted(receipts)) {
      return { decision: "allow" };
    }

    const maxRounds = evidence?.maxReviewRounds ?? policy.maxReviewRounds ?? 3;
    const escalated =
      evidence?.roundState === "escalated" ||
      evidence?.verifier?.verdict === "ESCALATE_HUMAN" ||
      ((evidence?.reviewRound ?? 0) >= maxRounds && evidence?.verifier?.verdict === "FAIL");
    if (escalated) return { decision: "allow" };
    if (evidence?.assertionDelta?.flagged) return { decision: "allow" };
    if (detectSessionTestRegression(receipts).regressed) return { decision: "allow" };

    const changedFiles = collectReceiptPaths(receipts);
    if (intent && changedFiles.length > 0 && !evaluateIntentScope(intent, changedFiles).inScope) {
      return { decision: "allow" };
    }

    const freshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
    const fresh = freshness === "fresh" || freshness === "fresh_rebase_patch_id";
    const verifiedPass = hasFreshVerifierPass({ receipts, evidence, headSha });

    const riskAssessment = resolveEvidenceOrSessionAssessment({
      action: fresh && verifiedPass ? "merge" : "open_pr",
      policy,
      receipts,
      evidence,
      intent,
      headSha,
      changedFiles,
      requireChanges: true,
    });
    if (riskAssessment?.residual === "blocked") {
      return { decision: "allow" };
    }

    const category =
      riskAssessment?.category ??
      intent?.category ??
      (changedFiles.length > 0 ? classifyDominantCategory(changedFiles) : "core");
    const catState = trust.categories?.[category] ?? { level: 0, score: 0 };
    const residual = riskAssessment?.residual ?? "low";
    const riskScore = riskAssessment?.score ?? 0;
    const signals = riskAssessment?.signals ?? [];

    let transitionId = null;
    let prompt = null;

    if (fresh && verifiedPass) {
      const mergeRes = evaluateDecisionTable({
        action: "merge",
        residual,
        trustLevel: catState.level,
        category,
        trustScore: catState.score,
        riskScore,
        signals,
        beastOn: trust.beastOn,
        policy,
        headless: false,
      });
      if (mergeRes.decision === "auto_approve" && hasRollbackReady({ receipts, evidence, intent, headSha })) {
        transitionId = "stage3_to_stage4";
        prompt = `Beast Mode Stage 3 -> Stage 4 (Ship): HEAD ${(headSha ?? "").slice(0, 7)} passed isolated pr-verifier with ${residual} residual risk (${category} L${catState.level}). Merge the verified PR, record the rollback receipt, and schedule post-merge watch.`;
      } else {
        return { decision: "allow" };
      }
    } else if (fresh && changedFiles.length > 0) {
      const prRes = evaluateDecisionTable({
        action: "open_pr",
        residual,
        trustLevel: catState.level,
        category,
        trustScore: catState.score,
        riskScore,
        signals,
        beastOn: trust.beastOn,
        policy,
        headless: false,
      });
      if (prRes.decision === "auto_approve") {
        transitionId = "stage2_to_stage3";
        prompt = `Beast Mode Stage 2 -> Stage 3 (PR Review): HEAD ${(headSha ?? "").slice(0, 7)} verification receipts are fresh (${category} L${catState.level}, residual ${residual}). Run isolated pr-verifier and compile the PR dossier (pr-dossier.mjs --format github) before opening or updating the PR.`;
      } else {
        return { decision: "allow" };
      }
    } else if (intent && intent.approved === true && changedFiles.length === 0) {
      const writeRes = evaluateDecisionTable({
        action: "local_write",
        residual,
        trustLevel: catState.level,
        category,
        trustScore: catState.score,
        riskScore,
        signals,
        beastOn: trust.beastOn,
        policy,
        headless: false,
      });
      if (writeRes.decision === "auto_approve") {
        transitionId = "stage1_to_stage2";
        prompt = `Beast Mode Stage 1 -> Stage 2 (Build & Verify): Intent Card is approved for ${category} (L${catState.level}). Implement the declared scope, run targeted tests on HEAD, and collect fresh verification receipts.`;
      } else {
        return { decision: "allow" };
      }
    }

    if (!transitionId || !prompt) {
      return { decision: "allow" };
    }

    const maxPerStage = options.maxTransitionsPerStage ?? 2;
    const stateFile = trustDir ? handoffStatePath(trustDir, event.conversationId) : null;
    const state = readHandoffState(stateFile);
    const stageKey = `${headSha ?? "none"}:${transitionId}`;
    const priorCount = Number(state.transitions?.[stageKey] ?? 0);
    if (priorCount >= maxPerStage) {
      return { decision: "allow" };
    }

    state.transitions[stageKey] = priorCount + 1;
    state.lastTransition = {
      transitionId,
      headSha: headSha ?? null,
      ts: new Date().toISOString(),
    };
    writeHandoffStateAtomic(stateFile, state);

    return {
      decision: "continue",
      reason: prompt,
    };
  } catch {
    return { decision: "allow" };
  }
}

/**
 * Injects one compact `PreInvocation` `ephemeralMessage` naming active stage, category level, residual risk, and missing receipts when Beast Mode is On.
 */
export function evaluateStageContext(event, options = {}) {
  if (!event || event.kind !== "pre-invocation") return {};

  try {
    const scope =
      options.scope ?? resolveEnrolledWorkspaceScope(event.workspaceDir, { baseRef: options.baseRef });
    if (!scope || scope.kind !== "enrolled_repo" || !scope.repoId) {
      return {};
    }

    const policyLoaded = options.policy
      ? { policy: options.policy, error: null }
      : loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
    if (policyLoaded.error) return {};
    const policy = policyLoaded.policy;

    const settingsRes = readTrustSettings(scope.repoId, { dataDir: options.dataDir });
    if (settingsRes.parseError) return {};

    const trust =
      options.trust ??
      evaluateRepoTrust({
        repoId: scope.repoId,
        policy,
        dataDir: options.dataDir,
        nowMs: options.nowMs,
      });
    if (!trust || !trust.beastOn || trust.frozen || !trust.chainValid) {
      return {};
    }

    const trustDir = options.trustDir ?? resolveTrustDir(event);
    const evidence = options.evidence !== undefined ? options.evidence : readEvidenceSnapshot(trustDir);
    const receipts = options.receipts !== undefined ? options.receipts : readMergedReceipts(trustDir);
    const headSha = options.headSha ?? readHeadShaFast(scope.repoRoot);
    const intent =
      options.intent !== undefined
        ? options.intent
        : readIntentCard(trustDir, event.conversationId || "default");

    const changedFiles = collectReceiptPaths(receipts);
    const freshness = computeFreshness({ receipts, headSha, priorEvidence: evidence });
    const fresh = freshness === "fresh" || freshness === "fresh_rebase_patch_id";
    const verifiedPass = hasFreshVerifierPass({ receipts, evidence, headSha });
    const merged = hasMergeCompleted(receipts);

    const stage = merged
      ? "4. Ship"
      : verifiedPass && fresh
        ? "3. PR Review (ready)"
        : changedFiles.length > 0
          ? "2. Build & Verify"
          : "1. Plan & Intent";

    const riskAssessment = resolveEvidenceOrSessionAssessment({
      action: verifiedPass && fresh ? "merge" : "open_pr",
      policy,
      receipts,
      evidence,
      intent,
      headSha,
      changedFiles,
      requireChanges: true,
    });
    const category =
      riskAssessment?.category ??
      intent?.category ??
      (changedFiles.length > 0 ? classifyDominantCategory(changedFiles) : "core");
    const catState = trust.categories?.[category] ?? { level: 0, score: 0, ceiling: 2 };
    const residual = riskAssessment?.residual ?? "low";
    const riskScore = Number(riskAssessment?.score ?? 0).toFixed(2);
    const satisfiedIds = new Set((riskAssessment?.satisfied ?? []).map((s) => s.id));
    const missing = (riskAssessment?.requiredMitigations ?? []).filter((id) => !satisfiedIds.has(id));

    const hintParts = [];
    if (!intent && (catState.level <= 1 || residual !== "low")) {
      hintParts.push("declare Intent Card via declare_intent before writes");
    }
    if (missing.length > 0) {
      hintParts.push(`missing mitigations: ${missing.join(", ")}`);
    } else if (!fresh && changedFiles.length > 0) {
      hintParts.push(`HEAD freshness=${freshness}`);
    } else {
      hintParts.push(`ceiling L${catState.ceiling}, promotion=${trust.promotionMode}`);
    }

    const ephemeralMessage = `AStack Beast Mode active (stage=${stage}, category=${category}, L${catState.level} T=${catState.score.toFixed(2)}, residual=${residual} R=${riskScore}; ${hintParts.join("; ")}).`;
    return {
      injectSteps: [{ ephemeralMessage }],
    };
  } catch {
    return {};
  }
}
