export type TrustCategory =
  | "docs"
  | "tests"
  | "ui"
  | "skills"
  | "tooling"
  | "core"
  | "governance";

export type TrustOutcome =
  | "clean"
  | "plan_accepted"
  | "approved_with_edits"
  | "plan_revised"
  | "follow_up_fix"
  | "human_override"
  | "reverted"
  | "trunk_broken";

export const TRUST_CATEGORIES: readonly TrustCategory[];

export type WorkspaceScope =
  | {
      readonly kind: "non_repo";
      readonly repoRoot: null;
      readonly gitDir: null;
      readonly commonDir: null;
      readonly repoId: null;
    }
  | {
      readonly kind: "git_unregistered";
      readonly repoRoot: string;
      readonly gitDir: string;
      readonly commonDir: string;
      readonly repoId: string;
    }
  | {
      readonly kind: "enrolled_repo";
      readonly repoRoot: string;
      readonly gitDir: string;
      readonly commonDir: string;
      readonly repoId: string;
      readonly baseRef: string;
    };

export interface ReceiptEntry {
  readonly kind?: string;
  readonly headSha?: string | null;
  readonly paths?: readonly string[];
  readonly ts?: string;
  readonly ok?: boolean;
}

export interface EvidenceSnapshot {
  readonly headSha?: string | null;
  readonly generatedAt?: string | null;
  readonly riskAssessment?: {
    readonly headSha?: string | null;
    readonly category?: string | null;
    readonly score?: number | null;
    readonly predictedAt?: string | null;
  } | null;
}

export interface LedgerEntry {
  readonly ts: string;
  readonly repoId: string;
  readonly category: TrustCategory;
  readonly headSha: string;
  readonly prNumber: number | null;
  readonly outcome: TrustOutcome;
  readonly y: number;
  readonly predictedR: number;
  readonly source: string;
  readonly note: string;
  readonly prevHash: string;
}

export interface LedgerReadResult {
  readonly ok: boolean;
  readonly chainValid: boolean;
  readonly brokenAtLine: number | null;
  readonly reason: string | null;
  readonly entries: readonly LedgerEntry[];
  readonly ledgerPath: string | null;
}

export function resolveWorkspaceScope(
  workspaceDir: string,
  options?: { readonly baseRef?: string; readonly checkEnrollment?: boolean }
): WorkspaceScope;

export function loadRiskPolicy(
  workspaceDir: string,
  options?: { readonly baseRef?: string }
): {
  readonly present: boolean;
  readonly path: string | null;
  readonly policy: Record<string, unknown>;
  readonly error?: string | null;
};

export function resolveTrustDir(event: {
  readonly workspaceDir?: string;
  readonly artifactDir?: string;
}): string | null;

export function readHeadShaFast(workspaceDir: string): string | null;

export function readMergedReceipts(trustDir: string | null): readonly ReceiptEntry[];

export function readEvidenceSnapshot(
  trustDir: string | null
): EvidenceSnapshot | null;

export function readOutcomeLedger(
  repoId: string,
  options?: { readonly dataDir?: string | null }
): LedgerReadResult;

export function classifyDominantCategory(
  paths: readonly string[]
): TrustCategory;

export function classifyObservedOutcome(args?: {
  readonly reverted?: boolean;
  readonly trunkBroken?: boolean;
  readonly rejected?: boolean;
  readonly followUpFix?: boolean;
  readonly changesRequested?: boolean;
  readonly branchCommitShas?: readonly string[];
  readonly agentReceiptShas?: readonly string[];
}): {
  readonly outcome: TrustOutcome;
  readonly y: number;
  readonly reason: string;
};

export function recordOutcomeWithTrustSync(args: {
  readonly workspaceDir: string;
  readonly scope?: WorkspaceScope;
  readonly policy?: Record<string, unknown>;
  readonly category: TrustCategory;
  readonly outcome: TrustOutcome;
  readonly headSha: string;
  readonly predictedR?: number;
  readonly prNumber?: number | null;
  readonly source?: string;
  readonly note?: string;
  readonly dedupeOutcomes?: readonly TrustOutcome[] | null;
  readonly now?: string;
  readonly dataDir?: string | null;
}): {
  readonly duplicate: boolean;
  readonly entry: LedgerEntry;
  readonly ledgerPath: string;
  readonly entryHash: string | null;
  readonly trust: Record<string, unknown>;
};

export function applyTrustSettingsAction(args: {
  readonly repoId: string;
  readonly policy?: Record<string, unknown>;
  readonly action: Record<string, unknown>;
  readonly dataDir?: string | null;
  readonly now?: string;
}): {
  readonly settingsPath: string;
  readonly trust: Record<string, unknown>;
};

export function evaluateRepoTrust(args: {
  readonly repoId: string;
  readonly policy?: Record<string, unknown>;
  readonly dataDir?: string | null;
  readonly nowMs?: number;
}): {
  readonly chainValid: boolean;
  readonly frozen: boolean;
  readonly beastOn: boolean;
  readonly totalOutcomes: number;
  readonly categories: Readonly<
    Record<
      TrustCategory,
      {
        readonly id: TrustCategory;
        readonly level: number;
        readonly earnedLevel: number;
        readonly score: number;
        readonly clean: number;
        readonly edited: number;
        readonly reverted: number;
      }
    >
  >;
};

export function recordReceipt(
  event: Record<string, unknown>,
  options?: {
    readonly trustDir?: string;
    readonly headSha?: string;
    readonly now?: string;
  }
): Record<string, unknown> | null;

export function writeEvidenceSnapshotAtomic(
  trustDir: string,
  snapshot: Record<string, unknown>
): string;
