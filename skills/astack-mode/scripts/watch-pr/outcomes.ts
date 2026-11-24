import path from "node:path";
import {
  TRUST_CATEGORIES,
  classifyDominantCategory,
  classifyObservedOutcome,
  loadRiskPolicy,
  readEvidenceSnapshot,
  readHeadShaFast,
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
import type * as T from "./types.ts";

const HEX40_RE = /^[0-9a-f]{40}$/i;

export interface OutcomeRecordingOptions {
  readonly enabled: boolean;
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

function inferCategoryAndRisk(args: {
  readonly options: OutcomeRecordingOptions;
  readonly evidence: EvidenceSnapshot | null;
  readonly receipts: readonly ReceiptEntry[];
  readonly headSha: string;
}): { readonly category: TrustCategory; readonly predictedR: number } {
  const evRisk = args.evidence?.riskAssessment ?? null;
  const evHead = args.evidence?.headSha ?? evRisk?.headSha ?? null;
  const evidenceMatches =
    evRisk !== null &&
    (!evHead || evHead.toLowerCase() === args.headSha.toLowerCase());

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
    const matchingPaths: string[] = [];
    const fallbackPaths: string[] = [];
    for (const receipt of args.receipts) {
      if (receipt.kind !== "file_write" || !Array.isArray(receipt.paths)) continue;
      for (const filePath of receipt.paths) {
        if (typeof filePath !== "string" || !filePath) continue;
        fallbackPaths.push(filePath);
        if (
          typeof receipt.headSha === "string" &&
          receipt.headSha.toLowerCase() === args.headSha.toLowerCase()
        ) {
          matchingPaths.push(filePath);
        }
      }
    }
    const pathsToUse = matchingPaths.length > 0 ? matchingPaths : fallbackPaths;
    category =
      pathsToUse.length > 0 ? classifyDominantCategory(pathsToUse) : "core";
  }

  let predictedR = args.options.risk;
  if (predictedR === null) {
    predictedR =
      evidenceMatches &&
      typeof evRisk.score === "number" &&
      Number.isFinite(evRisk.score) &&
      evRisk.score >= 0 &&
      evRisk.score <= 1
        ? evRisk.score
        : 0;
  }

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

  const workspaceDir = path.resolve(args.options.cwd ?? process.cwd());
  const dataDir = args.options.dataDir ? path.resolve(args.options.dataDir) : null;
  const scope = resolveWorkspaceScope(workspaceDir);
  if (scope.kind !== "enrolled_repo" || !scope.repoId) {
    args.stderr(
      `watch-pr: skipped outcome recording (workspace scope is ${scope.kind})\n`
    );
    return [];
  }

  const { policy } = loadRiskPolicy(scope.repoRoot, { baseRef: scope.baseRef });
  const trustDir = resolveTrustDir({ workspaceDir: scope.repoRoot });
  const receipts = readMergedReceipts(trustDir);
  const evidence = readEvidenceSnapshot(trustDir);
  const agentReceiptShas = collectAgentReceiptShas(receipts);
  const recorded: RecordedPrOutcome[] = [];

  for (const target of targets) {
    try {
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

      const prHeadSha =
        facts.headRefOid !== null && HEX40_RE.test(facts.headRefOid)
          ? facts.headRefOid
          : null;
      const fallbackSha = readHeadShaFast(scope.repoRoot);
      const headSha =
        prHeadSha ??
        (fallbackSha !== null && HEX40_RE.test(fallbackSha) ? fallbackSha : null);
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
        const commits = await args.reader.commitRollups(target.context);
        const branchCommitShas = commits
          .map((commit) => commit.oid)
          .filter((oid) => oid.length > 0);
        const reviews =
          typeof args.reader.pullRequestReviews === "function"
            ? await args.reader.pullRequestReviews(target.context)
            : [];

        const changesRequested =
          facts.reviewDecision === "CHANGES_REQUESTED" ||
          reviews.some(
            (review) => review.state.toUpperCase() === "CHANGES_REQUESTED"
          );
        classified = classifyObservedOutcome({
          changesRequested,
          branchCommitShas,
          agentReceiptShas,
        });
      }

      const existing = readOutcomeLedger(scope.repoId, { dataDir });
      if (!existing.chainValid) {
        args.stderr(
          `watch-pr: skipped outcome recording for PR #${target.context.number} (${existing.reason ?? "ledger hash chain broken"})\n`
        );
        continue;
      }
      const duplicate = existing.entries.some(
        (entry) =>
          entry.prNumber === target.context.number &&
          entry.headSha.toLowerCase() === headSha.toLowerCase() &&
          entry.outcome === classified.outcome
      );
      if (duplicate) continue;

      const { category, predictedR } = inferCategoryAndRisk({
        options: args.options,
        evidence,
        receipts,
        headSha,
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
        now: args.clock.observedAt(),
        dataDir,
      });

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
