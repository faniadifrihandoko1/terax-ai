import type { AiDiffStatus } from "@/modules/tabs";
import type { HunkDecision, LineDecision } from "./reviewApply";

/**
 * Persistence of the review state (FR-10, Fase 4): what survives a restart
 * is the review progress, which proposals are still open, their status, and
 * the per-hunk decisions, so a pending proposal survives an app restart.
 *
 * File contents are never stored here; the bridge re-derives them from the
 * chat messages on reopen. Only decided hunks are stored, so the default
 * state is an empty map.
 */

export const REVIEW_STATE_VERSION = 2;

/** Statuses worth restoring on restart. */
export type RestorableReviewStatus =
  | "pending"
  | "reviewing"
  | "done"
  | "conflict";

export type PersistedReviewProposal = {
  approvalId: string;
  path: string;
  isNewFile: boolean;
  status: RestorableReviewStatus;
  /** Decided hunks only: hunk index -> accepted | rejected. */
  hunkDecisions: Record<string, HunkDecision>;
  /**
   * v1 legacy: per-line decisions, kept so the bridge can migrate them to
   * hunks on restore. Absent in v2 states.
   */
  lineDecisions?: Record<string, LineDecision>;
  savedAt: number;
};

export type PersistedReviewState = {
  version: typeof REVIEW_STATE_VERSION;
  sessionId: string;
  proposals: PersistedReviewProposal[];
};

/** Minimal tab shape the snapshot needs (no React state, no contents). */
export type ReviewTabSnapshot = {
  approvalId: string;
  path: string;
  isNewFile: boolean;
  status: AiDiffStatus;
  hunkDecisions: Record<number, HunkDecision>;
};

const RESTORABLE: ReadonlySet<string> = new Set([
  "pending",
  "reviewing",
  "done",
  "conflict",
]);

function isRestorable(value: unknown): value is RestorableReviewStatus {
  return typeof value === "string" && RESTORABLE.has(value);
}

function isHunkDecision(value: unknown): value is HunkDecision {
  return value === "accepted" || value === "rejected";
}

function isLineDecision(value: unknown): value is LineDecision {
  return value === "accepted" || value === "rejected" || value === "undecided";
}

function parseDigitKeyed<T>(
  value: unknown,
  valid: (v: unknown) => v is T,
): Record<string, T> | null {
  if (typeof value !== "object" || value === null) return null;
  const out: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) return null;
    if (!valid(entry)) return null;
    out[key] = entry;
  }
  return out;
}

export function snapshotReviewState(
  sessionId: string,
  tabs: readonly ReviewTabSnapshot[],
  now: number = Date.now(),
): PersistedReviewState {
  return {
    version: REVIEW_STATE_VERSION,
    sessionId,
    proposals: tabs
      .filter((tab) => isRestorable(tab.status))
      .map((tab) => {
        const hunkDecisions: Record<string, HunkDecision> = {};
        for (const [key, decision] of Object.entries(tab.hunkDecisions)) {
          if (decision === "accepted" || decision === "rejected") {
            hunkDecisions[key] = decision;
          }
        }
        return {
          approvalId: tab.approvalId,
          path: tab.path,
          isNewFile: tab.isNewFile,
          status: tab.status as RestorableReviewStatus,
          hunkDecisions,
          savedAt: now,
        };
      }),
  };
}

export function serializeReviewState(state: PersistedReviewState): string {
  return JSON.stringify(state);
}

/**
 * Parses a stored review state. Accepts both v1 (per-line decisions) and
 * v2 (per-hunk decisions); v1 entries keep their `lineDecisions` so the
 * bridge can migrate them. Unknown versions are rejected, damaged entries
 * are skipped instead of dropping the whole state.
 */
export function parseReviewState(value: unknown): PersistedReviewState | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1 && obj.version !== REVIEW_STATE_VERSION) return null;
  if (typeof obj.sessionId !== "string" || !obj.sessionId) return null;
  if (!Array.isArray(obj.proposals)) return null;
  const proposals: PersistedReviewProposal[] = [];
  for (const raw of obj.proposals) {
    if (typeof raw !== "object" || raw === null) continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.approvalId !== "string" || !p.approvalId) continue;
    if (typeof p.path !== "string" || !p.path) continue;
    if (typeof p.isNewFile !== "boolean") continue;
    if (!isRestorable(p.status)) continue;
    if (typeof p.savedAt !== "number" || Number.isNaN(p.savedAt)) continue;
    const hunkDecisions = parseDigitKeyed(p.hunkDecisions, isHunkDecision);
    if (obj.version === REVIEW_STATE_VERSION && hunkDecisions === null)
      continue;
    if (
      obj.version === 1 &&
      hunkDecisions === null &&
      p.hunkDecisions !== undefined
    ) {
      continue;
    }
    const lineDecisions =
      obj.version === 1
        ? parseDigitKeyed(p.lineDecisions, isLineDecision)
        : undefined;
    if (obj.version === 1 && lineDecisions === null) continue;
    proposals.push({
      approvalId: p.approvalId,
      path: p.path,
      isNewFile: p.isNewFile,
      status: p.status,
      hunkDecisions: hunkDecisions ?? {},
      ...(lineDecisions ? { lineDecisions } : {}),
      savedAt: p.savedAt,
    });
  }
  return { version: REVIEW_STATE_VERSION, sessionId: obj.sessionId, proposals };
}

/**
 * A saved "conflict" reopens as "done": the disk guard re-checks at Apply
 * time, so the restored tab must still allow an apply attempt.
 */
export function restoreStatus(saved: RestorableReviewStatus): AiDiffStatus {
  return saved === "conflict" ? "done" : saved;
}
