import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  PIPELINE_STAGES,
  TOOL_MATCHERS,
  classifyCommandCategory,
  computeFreshness,
  loadRiskPolicy,
  readEvidenceSnapshot,
  readHeadShaFast,
  readMergedReceipts,
  resolveTrustDir,
} from "../../scripts/trust/index.mjs";

import { COMMAND_DOCS, STAGE_COMMAND_CATALOG } from "./command-catalog.mjs";

export { COMMAND_DOCS };

const STAGE_BY_ID = new Map(PIPELINE_STAGES.map((stage) => [stage.id, stage]));

function makeCommandItem(command, state, optional = false) {
  const doc = COMMAND_DOCS[command] ?? {};
  const trimmed = String(command).trim();
  return {
    command,
    copyText: trimmed,
    state,
    optional,
    description: doc.description ?? "",
    docsUrl: doc.docsUrl ?? null,
  };
}

function buildStageSubCommands(stageId, detected, excludeCommands = null) {
  const entry = STAGE_COMMAND_CATALOG[stageId] ?? { autoSubCommands: [], moreCommands: [] };
  const moreIds = excludeCommands
    ? entry.moreCommands.filter((cmd) => !excludeCommands.has(cmd))
    : entry.moreCommands;
  return {
    autoSubCommands: entry.autoSubCommands.map((cmd) => ({
      ...makeCommandItem(cmd, detected.has(cmd) ? "done" : "pending", true),
      ran: detected.has(cmd),
    })),
    moreCommands: moreIds.map((cmd) =>
      makeCommandItem(cmd, detected.has(cmd) ? "done" : "pending", true),
    ),
  };
}

export const TIMELINE_STEPS = [
  {
    id: "plan",
    number: 1,
    label: "Plan",
    summary: "Agree on a written plan before editing code.",
    gate: "GATE",
    primaryCommand: "/plan",
    optionalCommands: ["/grill-me"],
    pipelineStages: [STAGE_BY_ID.get("understand")?.id, STAGE_BY_ID.get("plan")?.id].filter(Boolean),
  },
  {
    id: "build",
    number: 2,
    label: "Build & Prove",
    summary: "Implement, clean the diff, and prove it works.",
    gate: "AUTO",
    primaryCommand: "/astack-mode",
    optionalCommands: ["/interrogate"],
    pipelineStages: [
      STAGE_BY_ID.get("build")?.id,
      STAGE_BY_ID.get("clean")?.id,
      STAGE_BY_ID.get("verify")?.id,
    ].filter(Boolean),
  },
  {
    id: "review",
    number: 3,
    label: "PR Review",
    summary: "Compile PR proof and run isolated verification.",
    gate: "GATE",
    primaryCommand: "/review-pr",
    optionalCommands: [],
    pipelineStages: [STAGE_BY_ID.get("pr-review")?.id].filter(Boolean),
  },
  {
    id: "ship",
    number: 4,
    label: "Ship",
    summary: "Open the PR and track CI to merge-ready.",
    gate: "AUTO",
    primaryCommand: "/astack-mode open the pr",
    optionalCommands: ["babysit"],
    pipelineStages: [],
  },
];

const FILE_WRITE_TOOLS = new Set(TOOL_MATCHERS.fileWriteTools);
const FILE_READ_TOOLS = new Set(["read_file", "view_file"]);
const VERIFY_CATEGORIES = new Set(["test", "verify", "lint", "build"]);
const DOC_EXT_RE = /\.(?:md|txt)$/i;
const POLICY_REL_PATHS = [
  [".agents/risk-policy.json", "risk-policy.json"],
  [".agents/boundaries.json", "boundaries.json"],
  ["REVIEW.md", "REVIEW.md"],
  ["GLOSSARY.md", "GLOSSARY.md"],
];

function normalizePosix(p) {
  return String(p ?? "").replace(/\\/g, "/");
}

function parseTimestampMs(raw) {
  if (!raw) return 0;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

function makeMarker(ts, order) {
  return { ts: ts || null, tsMs: parseTimestampMs(ts), order };
}

function latestMarker(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.tsMs && b.tsMs && a.tsMs !== b.tsMs) {
    return a.tsMs > b.tsMs ? a : b;
  }
  return a.order >= b.order ? a : b;
}

function isMarkerAfter(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.tsMs && b.tsMs && a.tsMs !== b.tsMs) {
    return a.tsMs > b.tsMs;
  }
  return a.order > b.order;
}

function unquoteArg(v) {
  if (typeof v !== "string") return v == null ? "" : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function targetPathOf(args) {
  return normalizePosix(unquoteArg(args.Path || args.AbsolutePath || args.TargetFile));
}

function isVerifyReceipt(receipt) {
  return receipt.kind === "verifier" || (receipt.kind === "command" && VERIFY_CATEGORIES.has(receipt.category));
}

/**
 * Resolves a regular file inside `brainConvDir` to a canonical `file://` URI, rejecting traversal or external symlinks.
 */
export function resolveSafeArtifactUri(brainConvDir, relName) {
  if (!brainConvDir || !relName || typeof relName !== "string") return null;
  if (/[\\/%:\0]/.test(relName) || relName === "." || relName === "..") return null;
  try {
    const rootReal = fs.realpathSync(brainConvDir);
    const candidate = path.join(rootReal, relName);
    if (!fs.existsSync(candidate)) return null;
    const real = fs.realpathSync(candidate);
    const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`;
    if (!real.startsWith(rootPrefix) || !fs.statSync(real).isFile()) return null;
    return pathToFileURL(real).href;
  } catch {
    return null;
  }
}

function readGitBranchFast(workspaceDir) {
  if (!workspaceDir) return null;
  let current = path.resolve(workspaceDir);
  while (true) {
    const dotGit = path.join(current, ".git");
    if (fs.existsSync(dotGit)) {
      try {
        const stat = fs.statSync(dotGit);
        const gitDir = stat.isDirectory()
          ? dotGit
          : path.resolve(current, (fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/im)?.[1] ?? "").trim());
        const headRaw = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
        const m = headRaw.match(/^ref:\s*refs\/heads\/(.+)$/);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function inspectSetupReadiness(workspaceDir) {
  if (!workspaceDir || !fs.existsSync(workspaceDir)) {
    return { workspaceKnown: false, configured: false, verifySkills: [], policies: [], branch: null, headSha: null };
  }
  const verifySkills = [];
  const skillsDir = path.join(workspaceDir, ".agents", "skills");
  let skillsStat = null;
  try {
    skillsStat = fs.statSync(skillsDir);
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
  }
  if (skillsStat?.isDirectory()) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("verify-")) continue;
      if (fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
        verifySkills.push(entry.name);
      }
    }
  }
  verifySkills.sort();

  const policies = POLICY_REL_PATHS
    .filter(([rel]) => fs.existsSync(path.join(workspaceDir, ...rel.split("/"))))
    .map(([, label]) => label);

  return {
    workspaceKnown: true,
    configured: verifySkills.length > 0 || policies.length > 0,
    verifySkills,
    policies,
    branch: readGitBranchFast(workspaceDir),
    headSha: readHeadShaFast(workspaceDir),
  };
}

function extractRequestBody(rawContent) {
  return String(rawContent ?? "").match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i)?.[1] ?? String(rawContent ?? "");
}

function extractLeadingSlashCommands(rawContent) {
  const stripped = extractRequestBody(rawContent).replace(/```[\s\S]*?```/g, " ").trim();
  const withoutNewTask = stripped.replace(/^new\s+task\.?\s*/i, "");
  const match = withoutNewTask.match(/^((?:\/[a-z0-9_-]+(?:\s+|$))+)/i);
  if (!match) return [];
  return [...match[1].matchAll(/\/([a-z0-9_-]+)/gi)].map((m) => `/${m[1].toLowerCase()}`);
}

function isWorkspaceFileTarget(rawPath, workspaceDir, brainConvDir) {
  if (!rawPath) return false;
  const norm = normalizePosix(rawPath);
  if (/(?:^|\/)(?:\.system_generated|\.gemini)(?:\/|$)/i.test(norm)) return false;
  const resolved = workspaceDir ? path.resolve(workspaceDir, rawPath) : path.resolve(rawPath);
  if (brainConvDir) {
    const convNorm = normalizePosix(path.resolve(brainConvDir)).replace(/\/$/, "").toLowerCase();
    const fileNorm = normalizePosix(resolved).toLowerCase();
    if (fileNorm === convNorm || fileNorm.startsWith(`${convNorm}/`)) return false;
  }
  if (workspaceDir) {
    const rel = path.relative(path.resolve(workspaceDir), resolved);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  }
  return !path.isAbsolute(rawPath) && norm !== ".." && !norm.startsWith("../");
}

function analyzeTranscript(transcriptPath, brainConvDir, workspaceDir) {
  const sig = {
    startedAt: null,
    childConvIds: new Set(),
    detected: new Set(),
    setupAt: null,
    grillMeAt: null,
    planCmdAt: null,
    planContractAt: null,
    askQuestionAt: null,
    planWrittenAt: null,
    planApprovedAt: null,
    approvalIntentAt: null,
    astackModeAt: null,
    interrogateAt: null,
    cleanAt: null,
    verifyRunAt: null,
    latestCodeWriteAt: null,
    latestWorkspaceWriteAt: null,
    reviewPrAt: null,
    openPrAt: null,
    pushOrPrAt: null,
    babysitAt: null,
  };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return sig;

  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  const pendingTestCmds = new Map();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let step;
    try {
      step = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!step || typeof step !== "object") continue;

    const order = Number.isFinite(step.step_index) ? step.step_index : i;
    const marker = makeMarker(step.created_at, order);
    if (!sig.startedAt && marker.ts) sig.startedAt = marker.ts;

    if (step.type === "USER_INPUT" || step.source === "USER_EXPLICIT") {
      const cmds = extractLeadingSlashCommands(step.content);
      const body = extractRequestBody(step.content).trim();
      for (const cmd of cmds) {
        if (COMMAND_DOCS[cmd]) sig.detected.add(cmd);
        if (cmd === "/setup-astack") sig.setupAt = latestMarker(sig.setupAt, marker);
        else if (cmd === "/grill-me") sig.grillMeAt = latestMarker(sig.grillMeAt, marker);
        else if (cmd === "/plan") sig.planCmdAt = latestMarker(sig.planCmdAt, marker);
        else if (cmd === "/astack-mode") sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        else if (cmd === "/interrogate") sig.interrogateAt = latestMarker(sig.interrogateAt, marker);
        else if (cmd === "/review-pr") sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
      }
      if (cmds.includes("/astack-mode")) {
        if (/\b(?:open\s+(?:the|a)\s+pr|gh\s+pr\s+create)\b/i.test(body)) {
          sig.openPrAt = latestMarker(sig.openPrAt, marker);
          sig.detected.add("/astack-mode open the pr");
        }
        if (/\bland\s+(?:the\s+)?stack\b/i.test(body)) sig.detected.add("/astack-mode land the stack");
        if (/\bprune\s+worktrees?\b/i.test(body)) sig.detected.add("/astack-mode prune worktrees");
      }
      if (/\bProceeded\s+with\b/i.test(body) || /^(?:approved|approve|proceed|do it|go ahead)\b/i.test(body)) {
        if (sig.planWrittenAt && isMarkerAfter(marker, sig.planWrittenAt)) {
          sig.planApprovedAt = latestMarker(sig.planApprovedAt, marker);
        } else if (!sig.planWrittenAt) {
          sig.approvalIntentAt = latestMarker(sig.approvalIntentAt, marker);
        }
      }
      continue;
    }

    if (step.type === "GENERIC" && typeof step.content === "string") {
      for (const m of step.content.matchAll(/"conversationId"\s*:\s*"([0-9a-f-]{8,})"/gi)) {
        sig.childConvIds.add(m[1]);
      }
      for (const [cmdOrder, cmdMarker] of pendingTestCmds.entries()) {
        if (order > cmdOrder && order <= cmdOrder + 4) {
          const failed = step.status === "ERROR" || /Command exited with code [1-9]/i.test(step.content);
          if (!failed) sig.verifyRunAt = latestMarker(sig.verifyRunAt, cmdMarker);
          pendingTestCmds.delete(cmdOrder);
          break;
        }
      }
      continue;
    }

    if (step.type !== "PLANNER_RESPONSE" || !Array.isArray(step.tool_calls)) continue;

    for (const tc of step.tool_calls) {
      const name = String(tc?.name ?? "");
      const args = tc?.args && typeof tc.args === "object" ? tc.args : {};

      if (FILE_READ_TOOLS.has(name)) {
        const p = targetPathOf(args);
        const skillRead = p.match(/\/skills\/([a-z0-9-]+)\/SKILL\.md$/i);
        if (skillRead) {
          const slug = `/${skillRead[1].toLowerCase()}`;
          if (COMMAND_DOCS[slug]) sig.detected.add(slug);
        }
        const pbRead = p.match(/\/skills\/astack-mode\/playbooks\/([a-z0-9-]+)\.md$/i);
        if (pbRead) {
          const pbName = pbRead[1].toLowerCase();
          if (pbName === "shipping") sig.detected.add("/astack-mode land the stack");
          else if (pbName === "release-and-postmortem") sig.detected.add("release-and-postmortem");
          else if (pbName === "worktree-cleanup") sig.detected.add("/astack-mode prune worktrees");
        }
        if (/\/skills\/setup-astack\/SKILL\.md$/i.test(p)) sig.setupAt = latestMarker(sig.setupAt, marker);
        else if (/\/skills\/astack-mode\/references\/plan-contract\.md$/i.test(p)) sig.planContractAt = latestMarker(sig.planContractAt, marker);
        else if (/\/skills\/astack-mode\/SKILL\.md$/i.test(p)) sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        else if (/\/skills\/interrogate\/SKILL\.md$/i.test(p)) sig.interrogateAt = latestMarker(sig.interrogateAt, marker);
        else if (/\/skills\/(?:deslop|no-comments)\/SKILL\.md$/i.test(p)) sig.cleanAt = latestMarker(sig.cleanAt, marker);
        else if (/\/skills\/(?:control-ui|control-cli)\/SKILL\.md$/i.test(p) || /\/\.agents\/skills\/verify-[^/]+\/SKILL\.md$/i.test(p)) {
          sig.astackModeAt = latestMarker(sig.astackModeAt, marker);
        } else if (/\/skills\/review-pr\/SKILL\.md$/i.test(p)) {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        } else if (/\/skills\/astack-mode\/playbooks\/opening-a-pr\.md$/i.test(p)) {
          sig.openPrAt = latestMarker(sig.openPrAt, marker);
        } else if (/\/skills\/astack-mode\/playbooks\/babysit\.md$/i.test(p)) {
          sig.babysitAt = latestMarker(sig.babysitAt, marker);
        }
      } else if (FILE_WRITE_TOOLS.has(name)) {
        const p = targetPathOf(args);
        if (/\/implementation_plan\.md$/i.test(p)) {
          sig.planWrittenAt = latestMarker(sig.planWrittenAt, marker);
        } else if (/\/pr-review\.md$/i.test(p)) {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
        } else if (isWorkspaceFileTarget(p, workspaceDir, brainConvDir)) {
          sig.latestWorkspaceWriteAt = latestMarker(sig.latestWorkspaceWriteAt, marker);
          if (!DOC_EXT_RE.test(p)) {
            sig.latestCodeWriteAt = latestMarker(sig.latestCodeWriteAt, marker);
          }
        }
      } else if (name === "ask_question") {
        sig.askQuestionAt = latestMarker(sig.askQuestionAt, marker);
      } else if (name === "invoke_subagent") {
        const subType = unquoteArg(args.TypeName);
        if (subType === "comment-sicko") {
          sig.cleanAt = latestMarker(sig.cleanAt, marker);
          sig.detected.add("/no-comments");
        } else if (subType === "pr-verifier") {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
          sig.detected.add("pr-verifier");
        } else if (subType === "browser") {
          sig.verifyRunAt = latestMarker(sig.verifyRunAt, marker);
          sig.detected.add("/control-ui");
        }
      } else if (name === "run_command") {
        const cmd = unquoteArg(args.CommandLine || args.commandLine || args.command);
        if (/\bsetup-banner\.mjs\b/i.test(cmd)) sig.setupAt = latestMarker(sig.setupAt, marker);
        if (/\barch-audit\.mjs\b/i.test(cmd)) {
          sig.cleanAt = latestMarker(sig.cleanAt, marker);
          sig.detected.add("/audit-architecture");
        }
        if (/\bpr-dossier\.mjs\b/i.test(cmd)) {
          sig.reviewPrAt = latestMarker(sig.reviewPrAt, marker);
          sig.detected.add("pr-dossier");
        }
        if (/\bwatch-pr\.mjs\b/i.test(cmd)) {
          sig.babysitAt = latestMarker(sig.babysitAt, marker);
          sig.detected.add("watch-pr");
        }
        if (/\bworktree-audit\.mjs\b/i.test(cmd)) sig.detected.add("/astack-mode prune worktrees");
        if (/\bstatechart\.mjs\b/i.test(cmd)) sig.detected.add("/statechart");
        if (/\blog\.mjs\b/i.test(cmd)) sig.detected.add("/show-me-your-work");
        if (/\b(?:gh\s+pr\s+create|git\s+push)\b/i.test(cmd)) sig.pushOrPrAt = latestMarker(sig.pushOrPrAt, marker);
        const category = classifyCommandCategory(cmd);
        if (category === "test" || category === "verify") {
          pendingTestCmds.set(order, marker);
        }
      } else if (name === "call_mcp_tool" && unquoteArg(args.ToolName) === "create_pull_request") {
        sig.pushOrPrAt = latestMarker(sig.pushOrPrAt, marker);
      }
    }
  }

  return sig;
}

function mergeChildTranscriptSignals(sig, brainDir, workspaceDir, parentConvId) {
  if (!brainDir || sig.childConvIds.size === 0) return sig;
  const mergeKeys = ["cleanAt", "verifyRunAt", "latestCodeWriteAt", "latestWorkspaceWriteAt"];
  for (const childId of sig.childConvIds) {
    if (!childId || childId === parentConvId) continue;
    const childConvDir = path.join(brainDir, childId);
    const childTranscript = path.join(childConvDir, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(childTranscript)) continue;
    const childSig = analyzeTranscript(childTranscript, childConvDir, workspaceDir);
    for (const key of mergeKeys) {
      sig[key] = latestMarker(sig[key], childSig[key]);
    }
    for (const d of childSig.detected) {
      sig.detected.add(d);
    }
  }
  return sig;
}

function loadConversationTrust(brainConvDir, workspaceDir, conversationId, childConvIds, headSha, sig) {
  const convTrustDir = brainConvDir ? resolveTrustDir({ artifactDir: brainConvDir }) : null;
  const repoTrustDir = workspaceDir ? resolveTrustDir({ workspaceDir }) : null;

  const actorIds = new Set(childConvIds);
  if (conversationId) actorIds.add(conversationId);

  const merged = [];
  const seen = new Set();
  const addReceipts = (list, filterActors) => {
    for (const r of list) {
      if (filterActors && actorIds.size > 0 && !actorIds.has(r.conversationId)) continue;
      const key = `${r.ts}|${r.conversationId}|${r.kind}|${r.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
  };

  if (convTrustDir) addReceipts(readMergedReceipts(convTrustDir), false);
  if (repoTrustDir && repoTrustDir !== convTrustDir) {
    addReceipts(readMergedReceipts(repoTrustDir), Boolean(conversationId));
  }
  merged.sort((a, b) => String(a.ts ?? "").localeCompare(String(b.ts ?? "")));

  const convEvidence = convTrustDir ? readEvidenceSnapshot(convTrustDir) : null;
  const repoEvidence = repoTrustDir && repoTrustDir !== convTrustDir ? readEvidenceSnapshot(repoTrustDir) : null;
  let evidence = convEvidence;
  if (!evidence && repoEvidence) {
    const sameHead = !headSha || repoEvidence.headSha === headSha;
    const afterStart = !sig.startedAt || !repoEvidence.generatedAt || repoEvidence.generatedAt >= sig.startedAt;
    if (sameHead && (afterStart || Boolean(sig.reviewPrAt))) {
      evidence = repoEvidence;
    }
  }

  return { receipts: merged, evidence };
}

function buildArtifactRef(brainConvDir, filename) {
  const uri = resolveSafeArtifactUri(brainConvDir, filename);
  return uri ? { name: filename, uri } : null;
}

function buildSetupReadiness(setup, sig) {
  const ranInSession = Boolean(sig.setupAt);
  const ready = Boolean(setup.configured || ranInSession);
  const status = ready ? "ready" : setup.workspaceKnown ? "needs_setup" : "unknown";
  const parts = [];
  if (setup.verifySkills.length > 0) parts.push(`verify: ${setup.verifySkills.join(", ")}`);
  if (setup.policies.length > 0) parts.push(`policies: ${setup.policies.join(", ")}`);

  const detail = parts.length > 0
    ? parts.join(" · ")
    : ranInSession
      ? "Setup ran in this session."
      : setup.workspaceKnown
        ? "No verify-<app> skill or repo policy files detected yet."
        : "Open a workspace conversation to check setup readiness.";

  const summary = status === "ready"
    ? detail
    : status === "needs_setup"
      ? "Run /setup-astack once in this repo to scaffold verification skills and guardrails."
      : "Open a workspace conversation to inspect setup readiness.";

  const commands = status === "ready"
    ? [
        makeCommandItem("/setup-astack", "done"),
        makeCommandItem("/maintain-verification-skill", sig.detected.has("/maintain-verification-skill") ? "done" : "pending", true),
      ]
    : [makeCommandItem("/setup-astack", status === "needs_setup" ? "next" : "pending")];

  return {
    workspaceKnown: setup.workspaceKnown,
    configured: ready,
    ranInSession,
    status,
    summary,
    detail,
    verifySkills: setup.verifySkills,
    policies: setup.policies,
    commands,
  };
}

function buildPlanStage({ hasConv, setupState, sig, planArtifact, planWrittenMarker, latestAnyWrite }) {
  const editsAfterPlan = Boolean(planWrittenMarker && latestAnyWrite && isMarkerAfter(latestAnyWrite, planWrittenMarker));
  const diskPlanApproved = Boolean(!sig.planWrittenAt && planArtifact && sig.approvalIntentAt);
  const planApproved = Boolean(
    (sig.planApprovedAt && (!planWrittenMarker || isMarkerAfter(sig.planApprovedAt, planWrittenMarker))) ||
      diskPlanApproved ||
      editsAfterPlan,
  );
  const grillMe = Boolean(sig.grillMeAt || (sig.planContractAt && sig.askQuestionAt));
  const triggered = Boolean(sig.planCmdAt || sig.planContractAt || planWrittenMarker);

  let status = "pending";
  if (planWrittenMarker && planApproved) status = "done";
  else if (planWrittenMarker) status = "waiting_gate";
  else if (Boolean(latestAnyWrite) && !triggered) status = "skipped";
  else if (triggered || grillMe) status = "active";
  else if (!hasConv) status = setupState.status === "ready" ? "next" : "pending";
  else if (setupState.status !== "needs_setup") status = "next";

  const detail = status === "waiting_gate"
    ? "implementation_plan.md staged. Review comments and click Proceed."
    : status === "done"
      ? "Plan approved and execution started."
      : status === "skipped"
        ? "Skipped for direct edit flow."
        : grillMe
          ? "Clarifying requirements via /grill-me."
          : "Write implementation_plan.md before editing code.";

  return {
    ...TIMELINE_STEPS[0],
    status,
    commands: [
      makeCommandItem("/plan", planWrittenMarker ? "done" : status === "active" ? "active" : status === "next" ? "next" : "pending"),
      makeCommandItem("/grill-me", grillMe ? "done" : "pending", true),
    ],
    subChecks: [],
    detail,
    artifact: planArtifact,
  };
}

function buildBuildStage({
  planStatus,
  sig,
  hasEdits,
  hasCodeEdits,
  cleanDone,
  cleanFresh,
  verifyDone,
  verifyFresh,
  buildStale,
  reviewStarted,
  reviewFresh,
  walkthroughArtifact,
}) {
  const astackModeActive = Boolean(sig.astackModeAt || hasEdits);
  const walkthroughComplete = Boolean(walkthroughArtifact);
  let status = "pending";
  if (buildStale) status = "stale";
  else if (verifyFresh && (!hasCodeEdits || cleanFresh || walkthroughComplete || (reviewStarted && reviewFresh))) status = "done";
  else if (astackModeActive || Boolean(sig.interrogateAt) || cleanDone || verifyDone) status = "active";
  else if (planStatus === "done" || planStatus === "skipped") status = "next";

  const subChecks = [
    { id: "edits", label: "edits", status: hasEdits ? "done" : "pending" },
    { id: "clean", label: "clean", status: cleanDone ? (cleanFresh ? "done" : "stale") : "pending" },
    { id: "verify", label: "verify", status: verifyFresh ? "done" : buildStale ? "stale" : "pending" },
  ];
  const detail = status === "stale"
    ? "New file edits landed after cleanup or tests. Re-run verification before PR review."
    : status === "done"
      ? cleanFresh || !hasCodeEdits
        ? "Code edits cleaned and verified on HEAD."
        : "Edits verified on HEAD with walkthrough recorded."
      : status === "active"
        ? "Running build, cleanup, and live verification."
        : "Run /astack-mode with your goal and done check.";

  return {
    ...TIMELINE_STEPS[1],
    status,
    commands: [
      makeCommandItem(
        "/astack-mode",
        status === "done" ? "done" : status === "stale" ? "stale" : astackModeActive ? "active" : status === "next" ? "next" : "pending",
      ),
      makeCommandItem("/interrogate", sig.interrogateAt ? "done" : "pending", true),
    ],
    subChecks,
    detail,
    artifact: walkthroughArtifact,
  };
}

function buildReviewStage({ buildStatus, reviewStarted, staleFromReceipts, reviewFresh, reviewArtifact, evidence, maxReviewRounds, shipped }) {
  const roundState = evidence?.roundState ?? "open";
  const reviewRound = evidence?.reviewRound ?? 0;
  const verdict = evidence?.verifier?.verdict ?? null;
  const reviewPass = verdict === "PASS" || verdict === "PASS_WITH_NOTES";

  let status = "pending";
  if (roundState === "escalated") status = "error";
  else if (reviewStarted && staleFromReceipts) status = "stale";
  else if (reviewStarted && reviewFresh && (reviewArtifact || reviewPass)) {
    status = shipped || evidence?.autoMergeEligible ? "done" : "waiting_gate";
  } else if (reviewStarted) status = "active";
  else if (buildStatus === "done") status = "next";

  const detail = roundState === "escalated"
    ? `Remediation hit ${reviewRound}/${maxReviewRounds} round cap. Human decision required.`
    : status === "stale"
      ? "New changes invalidated prior PR evidence. Re-run /review-pr."
      : status === "waiting_gate"
        ? `Risk Tier ${evidence?.riskTier ?? 1} (${evidence?.riskLabel ?? "medium"}) · pr-verifier ${verdict ?? "pending"} (${reviewRound}/${maxReviewRounds}). Awaiting your visual review.`
        : status === "done"
          ? `PR review passed (Tier ${evidence?.riskTier ?? 1}).`
          : "Compile pr-review.md and run isolated pr-verifier.";

  return {
    ...TIMELINE_STEPS[2],
    status,
    commands: [
      makeCommandItem(
        "/review-pr",
        status === "done" || status === "waiting_gate"
          ? "done"
          : status === "stale" || status === "error"
            ? "stale"
            : status === "active"
              ? "active"
              : status === "next"
                ? "next"
                : "pending",
      ),
    ],
    subChecks: [],
    detail,
    artifact: reviewArtifact,
  };
}

function buildShipStage({ reviewStatus, shipped, sig }) {
  let status = "pending";
  if (shipped) status = "done";
  else if (reviewStatus === "waiting_gate" || reviewStatus === "done") status = "next";
  else if (sig.openPrAt) status = "active";

  const detail = shipped
    ? sig.babysitAt
      ? "PR opened or pushed; babysit tracking active."
      : "PR opened or pushed."
    : "Review local commits and open PR when ready.";

  return {
    ...TIMELINE_STEPS[3],
    status,
    commands: [
      makeCommandItem("/astack-mode open the pr", shipped ? "done" : status === "next" ? "next" : "pending"),
      makeCommandItem("babysit", sig.babysitAt ? "done" : "pending", true),
    ],
    subChecks: [],
    detail,
    artifact: null,
  };
}

function selectNextAction(stepViews, setupState) {
  const [plan, build, review, ship] = stepViews;
  if (review.status === "error") {
    return { stageId: "review", stageLabel: "PR Review", command: "/review-pr", hint: review.detail };
  }
  if (build.status === "stale") {
    return { stageId: "build", stageLabel: "Build & Prove", command: "/astack-mode", hint: "Edits landed after verify. Re-clean and re-verify on HEAD." };
  }
  if (review.status === "stale") {
    return { stageId: "review", stageLabel: "PR Review", command: "/review-pr", hint: "Re-run PR dossier on updated HEAD." };
  }
  if (plan.status === "waiting_gate") {
    return { stageId: "plan", stageLabel: "Plan", command: "Proceed", hint: "Review implementation_plan.md and click Proceed." };
  }
  if (review.status === "waiting_gate") {
    return { stageId: "ship", stageLabel: "Ship", command: "/astack-mode open the pr", hint: "Inspect pr-review.md, then open the PR when ready." };
  }
  if (setupState.status === "needs_setup" && stepViews.every((s) => s.status === "pending")) {
    return {
      stageId: "setup",
      stageLabel: "First-time setup",
      command: "/setup-astack",
      hint: "Run once in this repo to scaffold verification skills and policies.",
    };
  }
  const current = stepViews.find((s) => s.status === "next" || s.status === "active");
  if (current) {
    return {
      stageId: current.id,
      stageLabel: current.label,
      command: current.primaryCommand,
      hint: current.detail,
    };
  }
  if (ship.status === "done" || stepViews.every((s) => s.status === "done" || s.status === "skipped")) {
    return {
      stageId: "ship",
      stageLabel: "Ship",
      command: "/astack-mode open the pr",
      hint: "All workflow steps completed.",
    };
  }
  return {
    stageId: "plan",
    stageLabel: "Start",
    command: "/plan",
    hint: "Start a task with /plan or /astack-mode.",
  };
}

/**
 * Projects workspace readiness, transcript signals, and trust ledger receipts into the 4-step AStack timeline.
 */
export function evaluateTimelineSnapshot({
  conversationId = "",
  brainDir = "",
  workspaceDir = "",
} = {}) {
  const hasConv = Boolean(conversationId && brainDir);
  const brainConvDir = hasConv ? path.join(brainDir, conversationId) : "";
  const transcriptPath = hasConv
    ? path.join(brainConvDir, ".system_generated", "logs", "transcript.jsonl")
    : "";

  const setup = inspectSetupReadiness(workspaceDir);
  const policyResult = loadRiskPolicy(workspaceDir);
  const sig = mergeChildTranscriptSignals(
    analyzeTranscript(transcriptPath, brainConvDir, workspaceDir),
    brainDir,
    workspaceDir,
    conversationId,
  );
  const { receipts, evidence } = loadConversationTrust(
    brainConvDir,
    workspaceDir,
    conversationId,
    sig.childConvIds,
    setup.headSha,
    sig,
  );

  const planArtifact = buildArtifactRef(brainConvDir, "implementation_plan.md");
  const reviewArtifact = buildArtifactRef(brainConvDir, "pr-review.md");
  const walkthroughArtifact = buildArtifactRef(brainConvDir, "walkthrough.md");

  let planWrittenMarker = sig.planWrittenAt;
  if (!planWrittenMarker && planArtifact) {
    try {
      const mtime = fs.statSync(path.join(brainConvDir, "implementation_plan.md")).mtime.toISOString();
      planWrittenMarker = makeMarker(mtime, 0);
    } catch {
      planWrittenMarker = makeMarker(null, 0);
    }
  }

  let latestCodeWrite = sig.latestCodeWriteAt;
  let latestAnyWrite = sig.latestWorkspaceWriteAt;
  let latestReceiptVerify = null;
  let hadReceiptWrite = false;
  let hasVerifyReceipt = false;
  let receiptPush = false;

  for (const r of receipts) {
    const m = makeMarker(r.ts, Number.MAX_SAFE_INTEGER);
    if (r.kind === "file_write") {
      const workspacePaths = Array.isArray(r.paths)
        ? r.paths.filter((p) => isWorkspaceFileTarget(p, workspaceDir, brainConvDir))
        : [];
      if (Array.isArray(r.paths) && r.paths.length > 0 && workspacePaths.length === 0) continue;
      hadReceiptWrite = true;
      latestAnyWrite = latestMarker(latestAnyWrite, m);
      const allDocs = workspacePaths.length > 0 && workspacePaths.every((p) => DOC_EXT_RE.test(p));
      if (!allDocs) latestCodeWrite = latestMarker(latestCodeWrite, m);
    } else if (isVerifyReceipt(r)) {
      hasVerifyReceipt = true;
      if (r.ok) latestReceiptVerify = latestMarker(latestReceiptVerify, m);
    } else if (r.kind === "command" && r.ok && /\b(?:gh\s+pr\s+create|git\s+push)\b/i.test(r.summary)) {
      receiptPush = true;
    }
  }

  const hasEdits = Boolean(hadReceiptWrite || latestAnyWrite);
  const hasCodeEdits = Boolean(latestCodeWrite);
  const receiptFreshness = receipts.length > 0
    ? computeFreshness({ receipts, headSha: setup.headSha, priorEvidence: evidence })
    : evidence?.freshness ?? "missing_receipts";

  const cleanDone = Boolean(sig.cleanAt);
  const cleanFresh = cleanDone && (!latestCodeWrite || !isMarkerAfter(latestCodeWrite, sig.cleanAt));
  const latestVerify = latestMarker(latestReceiptVerify, sig.verifyRunAt);
  const verifyDone = Boolean(latestVerify || (evidence && (evidence.freshness === "fresh" || evidence.freshness === "fresh_rebase_patch_id")));
  const verifyFreshFromReceipts = receiptFreshness === "fresh" || receiptFreshness === "fresh_rebase_patch_id";
  const verifyFreshFromTranscript = Boolean(sig.verifyRunAt && (!latestCodeWrite || !isMarkerAfter(latestCodeWrite, sig.verifyRunAt)));
  const verifyFresh = hasVerifyReceipt
    ? verifyFreshFromReceipts && (!latestCodeWrite || !isMarkerAfter(latestCodeWrite, latestVerify))
    : Boolean(verifyFreshFromTranscript || (evidence && verifyFreshFromReceipts));

  const staleFromReceipts = hasEdits && (receiptFreshness === "dirty_after_verify" || receiptFreshness === "stale_sha");
  const buildStale = staleFromReceipts || Boolean(cleanDone && !cleanFresh) || Boolean(sig.verifyRunAt && !verifyFresh && hasCodeEdits);

  const reviewStarted = Boolean(sig.reviewPrAt || reviewArtifact || evidence?.verifier?.verdict);
  const reviewRound = evidence?.reviewRound ?? 0;
  const maxReviewRounds = evidence?.maxReviewRounds ?? policyResult.policy.maxReviewRounds ?? 3;
  const reviewFresh = !staleFromReceipts && (!evidence?.freshness || evidence.freshness === "fresh" || evidence.freshness === "fresh_rebase_patch_id");
  const shipped = Boolean(sig.pushOrPrAt || receiptPush);

  const setupState = buildSetupReadiness(setup, sig);
  if (setup.verifySkills.some((s) => !s.endsWith("-formal"))) sig.detected.add("/create-verification-skill");
  if (setup.verifySkills.some((s) => s.endsWith("-formal"))) sig.detected.add("/create-formal-verification-skill");
  if (evidence) sig.detected.add("pr-dossier");
  if (evidence?.verifier?.verdict) sig.detected.add("pr-verifier");
  Object.assign(
    setupState,
    buildStageSubCommands("setup", sig.detected, new Set((setupState.commands || []).map((c) => c.command))),
  );

  const planStage = buildPlanStage({ hasConv, setupState, sig, planArtifact, planWrittenMarker, latestAnyWrite });
  const buildStage = buildBuildStage({
    planStatus: planStage.status,
    sig,
    hasEdits,
    hasCodeEdits,
    cleanDone,
    cleanFresh,
    verifyDone,
    verifyFresh,
    buildStale,
    reviewStarted,
    reviewFresh,
    walkthroughArtifact,
  });
  const reviewStage = buildReviewStage({
    buildStatus: buildStage.status,
    reviewStarted,
    staleFromReceipts,
    reviewFresh,
    reviewArtifact,
    evidence,
    maxReviewRounds,
    shipped,
  });
  const shipStage = buildShipStage({ reviewStatus: reviewStage.status, shipped, sig });
  const stepViews = [planStage, buildStage, reviewStage, shipStage].map((stage) => ({
    ...stage,
    ...buildStageSubCommands(stage.id, sig.detected),
  }));

  let liveState = "ok";
  let liveLabel = hasConv ? "Live" : "Idle";
  if (reviewStage.status === "error") {
    liveState = "error";
    liveLabel = "Escalated";
  } else if (buildStage.status === "stale" || reviewStage.status === "stale") {
    liveState = "warn";
    liveLabel = "Stale";
  } else if (planStage.status === "waiting_gate" || reviewStage.status === "waiting_gate") {
    liveState = "warn";
    liveLabel = "Gate";
  }

  const snapshot = {
    conversationId: conversationId || null,
    hasConversation: hasConv,
    workspace: workspaceDir || null,
    workspaceName: workspaceDir ? path.basename(workspaceDir) : null,
    branch: setup.branch,
    headSha: setup.headSha ? setup.headSha.slice(0, 7) : null,
    setup: setupState,
    riskTier: evidence?.riskTier ?? null,
    riskLabel: evidence?.riskLabel ?? null,
    freshness: receipts.length > 0 || evidence ? receiptFreshness : null,
    reviewRound,
    maxReviewRounds,
    doneCount: stepViews.filter((s) => s.status === "done" || s.status === "skipped").length,
    totalCount: stepViews.length,
    liveState,
    liveLabel,
    nextAction: selectNextAction(stepViews, setupState),
    stages: stepViews,
  };

  const etag = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
  return { ...snapshot, etag };
}
