/**
 * Persistence of the per-line review state (FR-10).
 *
 * The reviewed contents are NOT stored here: on restart the bridge
 * re-derives `originalContent`/`proposedContent` from the chat messages,
 * exactly like it does on the first open. What is stored is the review
 * progress — which proposals are still open, their status, and the
 * per-line decisions — so a pending proposal survives an app restart.
 *
 * Format (versioned, so a future shape can migrate instead of breaking):
 *   { version: 1, sessionId, proposals: [{ approvalId, path, isNewFile,
 *     status, lineDecisions, savedAt }] }
 * `lineDecisions` only carries decided lines (accepted/rejected);
 * undecided lines are omitted. Terminal statuses (applied/rejected) are
 * never stored: there is nothing left to restore for them.
 */

import type { AiDiffStatus } from "@/modules/tabs";
import type { LineDecision } from "./reviewApply";

export const REVIEW_STATE_VERSION = 1;

/** Statuses worth restoring on restart. */
export type RestorableReviewStatus = "pending" | "reviewing" | "done" | "conflict";

export type PersistedReviewProposal = {
  approvalId: string;
  path: string;
  isNewFile: boolean;
  status: RestorableReviewStatus;
  /** Decided lines only: line index -> accepted | rejected. */
  lineDecisions: Record<string, LineDecision>;
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
  lineDecisions: Record<number, LineDecision>;
};

export function isRestorableStatus(
  status: AiDiffStatus,
): status is RestorableReviewStatus {
  return (
    status === "pending" ||
    status === "reviewing" ||
    status === "done" ||
    status === "conflict"
  );
}

/**
 * Extracts the restorable proposals from the open ai-diff tabs.
 * `savedAt` is the snapshot time; callers pass Date.now() by default.
 */
export function snapshotReviewState(
  sessionId: string,
  tabs: readonly ReviewTabSnapshot[],
  now: number = Date.now(),
): PersistedReviewState {
  const proposals: PersistedReviewProposal[] = [];
  for (const tab of tabs) {
    if (!isRestorableStatus(tab.status)) continue;
    if (!tab.approvalId || !tab.path) continue;
    const lineDecisions: Record<string, LineDecision> = {};
    for (const [index, decision] of Object.entries(tab.lineDecisions)) {
      if (decision === "accepted" || decision === "rejected") {
        lineDecisions[index] = decision;
      }
    }
    proposals.push({
      approvalId: tab.approvalId,
      path: tab.path,
      isNewFile: tab.isNewFile,
      status: tab.status,
      lineDecisions,
      savedAt: now,
    });
  }
  return { version: REVIEW_STATE_VERSION, sessionId, proposals };
}

export function serializeReviewState(state: PersistedReviewState): string {
  return JSON.stringify(state);
}

/** Strict parse: unknown version or malformed shape -> null. */
export function parseReviewState(value: unknown): PersistedReviewState | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (obj.version !== REVIEW_STATE_VERSION) return null;
  if (typeof obj.sessionId !== "string" || !obj.sessionId) return null;
  if (!Array.isArray(obj.proposals)) return null;
  const proposals: PersistedReviewProposal[] = [];
  for (const raw of obj.proposals) {
    if (typeof raw !== "object" || raw === null) continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.approvalId !== "string" || !p.approvalId) continue;
    if (typeof p.path !== "string" || !p.path) continue;
    if (typeof p.isNewFile !== "boolean") continue;
    if (
      p.status !== "pending" &&
      p.status !== "reviewing" &&
      p.status !== "done" &&
      p.status !== "conflict"
    ) {
      continue;
    }
    if (typeof p.lineDecisions !== "object" || p.lineDecisions === null) {
      continue;
    }
    const lineDecisions: Record<string, LineDecision> = {};
    for (const [index, decision] of Object.entries(
      p.lineDecisions as Record<string, unknown>,
    )) {
      if (!/^\d+$/.test(index)) continue;
      if (decision === "accepted" || decision === "rejected") {
        lineDecisions[index] = decision;
      }
    }
    proposals.push({
      approvalId: p.approvalId,
      path: p.path,
      isNewFile: p.isNewFile,
      status: p.status,
      lineDecisions,
      savedAt: typeof p.savedAt === "number" ? p.savedAt : 0,
    });
  }
  return { version: REVIEW_STATE_VERSION, sessionId: obj.sessionId, proposals };
}

/**
 * Status a restored proposal reopens with. A saved "conflict" reopens as
 * "done": the disk-hash guard re-checks at Apply time, and a stale conflict
 * badge must not block a file whose on-disk state has since been fixed.
 */
export function restoreStatus(saved: RestorableReviewStatus): AiDiffStatus {
  return saved === "conflict" ? "done" : saved;
}
