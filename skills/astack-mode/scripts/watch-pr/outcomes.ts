import fs from "node:fs";
import path from "node:path";
import {
  TRUST_CATEGORIES,
  classifyDominantCategory,
  classifyObservedOutcome,
  loadRiskPolicy,
  readEvidenceSnapshot,
  readMergedReceipts,
  readOutcomeLedger,
  recordOutcomeWithTrustSync,
  resolveTrustDir,
  resolveWorkspaceScope,
  type EvidenceSnapshot,
  type ReceiptEntry,
  type TrustCategory,
  type TrustOutcome,
} from "../../../../scripts/trust/index.mjs";
import { parseRemote } from "./github.ts";
import type * as T from "./types.ts";

const HEX40_RE = /^[0-9a-f]{40}$/i;
const MERGE_DEDUPE_OUTCOMES: readonly TrustOutcome[] = [
  "clean",
  "approved_with_edits",
];
const CLOSED_DEDUPE_OUTCOMES: readonly TrustOutcome[] = ["human_override"];

export interface OutcomeRecordingOptions {
  readonly enabled: boolean;
  readonly explicit?: boolean;
  readonly cwd: string | null;
  readonly dataDir: string | null;
  readonly category: TrustCategory | null;
  readonly risk: number | null;
}

export interface RecordedPrOutcome {
  readonly prNumber: T.PrNumber;
  readonly headSha: string;
  readonly category: TrustCategory;
  readonly outcome: TrustOutcome;
  readonly y: number;
  readonly predictedR: number;
}

type TerminalOutcomeTarget =
  | {
      readonly kind: "merged";
      readonly context: T.PrContext;
      readonly facts?: T.PullRequestFacts;
    }
  | {
      readonly kind: "closed";
      readonly context: T.PrContext;
      readonly facts?: T.PullRequestFacts;
    };

export function isTrustCategory(value: string): value is TrustCategory {
  return (TRUST_CATEGORIES as readonly string[]).includes(value);
}

function readOriginGitHubRepo(commonDir: string): T.Repository | null {
  try {
    const configPath = path.join(commonDir, "config");
    if (!fs.existsSync(configPath)) return null;
    const text = fs.readFileSync(configPath, "utf8");
    let inOrigin = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      if (line.startsWith("[")) {
        inOrigin = /^\[\s*remote\s+"origin"\s*\]$/i.test(line);
        continue;
      }
      if (!inOrigin) continue;
      const match = line.match(/^url\s*=\s*(.+)$/i);
      if (match?.[1]) {
        return parseRemote(match[1].trim());
      }
    }
    return null;
  } catch {
    return null;
  }
}

function collectTerminalTargets(
  verdict: T.TerminalVerdict
): readonly TerminalOutcomeTarget[] {
  switch (verdict.kind) {
    case "READY":
      if (verdict.scope.kind === "single") {
        return verdict.scope.pr.kind === "merged-pr"
          ? [{ kind: "merged", context: verdict.scope.pr.context }]
          : [];
      }
      return verdict.scope.prs.flatMap((pr) =>
        pr.kind === "merged-pr"
          ? [{ kind: "merged" as const, context: pr.context }]
          : []
      );
    case "COMPLETE":
      return verdict.merged.map((pr) => ({
        kind: "merged" as const,
        context: pr.context,
      }));
    case "BLOCKER":
      if (
        verdict.blocker.kind === "merge-gate" &&
        verdict.blocker.reason === "closed-without-merge"
      ) {
        return [{ kind: "closed", context: verdict.blocker.pr }];
      }
      return [];
    case "STATUS":
      return verdict.rows.flatMap((row): readonly TerminalOutcomeTarget[] => {
        if (row.kind === "merged") {
          return [{ kind: "merged", context: row.context, facts: row.facts }];
        }
        if (row.kind === "closed") {
          return [{ kind: "closed", context: row.context, facts: row.facts }];
        }
        return [];
      });
    case "TIMEOUT":
      return [];
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function collectAgentReceiptShas(receipts: readonly ReceiptEntry[]): string[] {
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (typeof receipt.headSha === "string" && HEX40_RE.test(receipt.headSha)) {
      seen.add(receipt.headSha.toLowerCase());
    }
  }
  return [...seen];
}

function normalizeSha(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return HEX40_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

function inferCategoryAndRisk(args: {
  readonly options: OutcomeRecordingOptions;
  readonly evidence: EvidenceSnapshot | null;
  readonly receipts: readonly ReceiptEntry[];
  readonly headSha: string;
  readonly branchCommitShas: readonly string[];
}): { readonly category: TrustCategory; readonly predictedR: number } {
  const normHead = args.headSha.toLowerCase();
  const evRisk = args.evidence?.riskAssessment ?? null;
  const topHead = normalizeSha(args.evidence?.headSha);
  const innerHead = normalizeSha(evRisk?.headSha);
  const evidenceMatches =
    evRisk !== null &&
    (topHead !== null || innerHead !== null) &&
    (topHead === null || topHead === normHead) &&
    (innerHead === null || innerHead === normHead);

  let category: TrustCategory | null = args.options.category;
  if (
    category === null &&
    evidenceMatches &&
    typeof evRisk.category === "string" &&
    isTrustCategory(evRisk.category)
  ) {
    category = evRisk.category;
  }
  if (category === null) {
    const prCommitShas = new Set<string>([normHead]);
    for (const sha of args.branchCommitShas) {
      const normalized = normalizeSha(sha);
      if (normalized !== null) prCommitShas.add(normalized);
    }
    const matchingPaths: string[] = [];
    for (const receipt of args.receipts) {
      if (receipt.kind !== "file_write" || !Array.isArray(receipt.paths)) continue;
      const receiptSha = normalizeSha(receipt.headSha);
      if (receiptSha === null || !prCommitShas.has(receiptSha)) continue;
      for (const filePath of receipt.paths) {
        if (typeof filePath === "string" && filePath) {
          matchingPaths.push(filePath);
        }
      }
    }
    category =
      matchingPaths.length > 0 ? classifyDominantCategory(matchingPaths) : "core";
  }

  const evidenceScore =
    evidenceMatches &&
    typeof evRisk.score === "number" &&
    Number.isFinite(evRisk.score) &&
    evRisk.score >= 0 &&
    evRisk.score <= 1
      ? evRisk.score
      : 0;
  const predictedR: number = args.options.risk !== null ? args.options.risk : evidenceScore;

  return { category, predictedR };
}

export async function recordVerdictOutcomes(args: {
  readonly verdict: T.TerminalVerdict;
  readonly reader: T.GitHubReader;
  readonly clock: { readonly observedAt: () => string };
  readonly options: OutcomeRecordingOptions;
  readonly stderr: (value: string) => void;
}): Promise<readonly RecordedPrOutcome[]> {
  if (!args.options.enabled) return [];
  const targets = collectTerminalTargets(args.verdict);
  if (targets.length === 0) return [];
  const warnSkipped = (message: string): void => {
    if (args.options.explicit === true) {
      args.stderr(message);
    }
  };

  let scope: ReturnType<typeof resolveWorkspaceScope>;
  let policy: Record<string, unknown>;
  let receipts: readonly ReceiptEntry[];
  let evidence: EvidenceSnapshot | null;
  let dataDir: string | null;
  try {
    const workspaceDir = path.resolve(args.options.cwd ?? process.cwd());
    dataDir = args.options.dataDir ? path.resolve(args.options.dataDir) : null;
    scope = resolveWorkspaceScope(workspaceDir);
    if (scope.kind !== "enrolled_repo" || !scope.repoId) {
      warnSkipped(
        `watch-pr: skipped outcome recording (workspace scope is ${scope.kind})\n`
      );
      return [];
    }
    policy = loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef }).policy;
    const trustDir = resolveTrustDir({ workspaceDir: scope.repoRoot });
    receipts = readMergedReceipts(trustDir);
    evidence = readEvidenceSnapshot(trustDir);
  } catch (error) {
    warnSkipped(
      `watch-pr: skipped outcome recording (${error instanceof Error ? error.message : String(error)})\n`
    );
    return [];
  }

  const originRepo = readOriginGitHubRepo(scope.commonDir);
  const agentReceiptShas = collectAgentReceiptShas(receipts);
  const recorded: RecordedPrOutcome[] = [];

  for (const target of targets) {
    try {
      if (
        originRepo !== null &&
        (originRepo.owner.toLowerCase() !== target.context.owner.toLowerCase() ||
          originRepo.repo.toLowerCase() !== target.context.repo.toLowerCase())
      ) {
        warnSkipped(
          `watch-pr: skipped outcome recording for PR #${target.context.number} (PR repo ${target.context.owner}/${target.context.repo} does not match local origin ${originRepo.owner}/${originRepo.repo})\n`
        );
        continue;
      }

      let facts = target.facts ?? null;
      if (facts === null) {
        try {
          facts = await args.reader.pullRequest(target.context);
        } catch (error) {
          args.stderr(
            `watch-pr: skipped outcome recording for PR #${target.context.number} (could not read PR metadata: ${error instanceof Error ? error.message : String(error)})\n`
          );
          continue;
        }
      }

      let branchCommitShas: string[] = [];
      let headSha = normalizeSha(facts.headRefOid);
      if (target.kind === "merged" || headSha === null) {
        const commits = await args.reader.commitRollups(target.context);
        branchCommitShas = commits
          .map((commit) => normalizeSha(commit.oid))
          .filter((oid): oid is string => oid !== null);
        if (headSha === null && branchCommitShas.length > 0) {
          headSha = branchCommitShas[branchCommitShas.length - 1];
        }
      }

      if (headSha === null) {
        args.stderr(
          `watch-pr: skipped outcome recording for PR #${target.context.number} (no valid 40-hex headSha)\n`
        );
        continue;
      }

      let classified: ReturnType<typeof classifyObservedOutcome>;
      if (target.kind === "closed") {
        classified = classifyObservedOutcome({ rejected: true });
      } else {
        const reviews =
          typeof args.reader.pullRequestReviews === "function"
            ? await args.reader.pullRequestReviews(target.context)
            : [];
        const changesRequested =
          facts.reviewDecision === "CHANGES_REQUESTED" ||
          reviews.some(
            (review) => review.state.toUpperCase() === "CHANGES_REQUESTED"
          );
        const branchCommitSet = new Set(branchCommitShas);
        const matchedAgentShas = agentReceiptShas.filter((sha) =>
          branchCommitSet.has(sha)
        );
        classified = classifyObservedOutcome({
          changesRequested,
          branchCommitShas,
          agentReceiptShas: matchedAgentShas,
        });
      }

      const existing = readOutcomeLedger(scope.repoId, { dataDir });
      if (!existing.chainValid) {
        args.stderr(
          `watch-pr: skipped outcome recording for PR #${target.context.number} (${existing.reason ?? "ledger hash chain broken"})\n`
        );
        continue;
      }

      const { category, predictedR } = inferCategoryAndRisk({
        options: args.options,
        evidence,
        receipts,
        headSha,
        branchCommitShas,
      });

      const saved = recordOutcomeWithTrustSync({
        workspaceDir: scope.repoRoot,
        scope,
        policy,
        category,
        outcome: classified.outcome,
        headSha,
        predictedR,
        prNumber: target.context.number,
        source: "watch-pr",
        note: classified.reason,
        dedupeOutcomes:
          target.kind === "closed"
            ? CLOSED_DEDUPE_OUTCOMES
            : MERGE_DEDUPE_OUTCOMES,
        now: args.clock.observedAt(),
        dataDir,
      });

      if (saved.duplicate) continue;

      recorded.push({
        prNumber: target.context.number,
        headSha: saved.entry.headSha,
        category: saved.entry.category,
        outcome: saved.entry.outcome,
        y: saved.entry.y,
        predictedR: saved.entry.predictedR,
      });
    } catch (error) {
      args.stderr(
        `watch-pr: failed to record outcome for PR #${target.context.number}: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }

  return recorded;
}
