import type { AiDiffStatus } from "@/modules/tabs";
import {
  isFileCheckpoint,
  type FileCheckpoint,
} from "./reviewCheckpoint";
import type { HunkDecision, LineDecision } from "./reviewApply";

/**
 * Persistence of the review state (FR-10, Fase 4): what survives a restart
 * is the review progress, which proposals are still open, their status, and
 * the per-hunk decisions, so a pending proposal survives an app restart.
 *
 * File contents are not stored here, except for applied proposals: a
 * checkpoint (Fase 5) holds the pre-apply content so an applied change
 * can be restored after a restart. The bridge re-derives proposal
 * contents from the chat messages on reopen. Only decided hunks are
 * stored, so the default state is an empty map.
 */

export const REVIEW_STATE_VERSION = 3;

/** Statuses worth restoring on restart. */
export type RestorableReviewStatus =
  | "pending"
  | "reviewing"
  | "done"
  | "applied"
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
  /** v3: what the proposal does. Absent means "edit". */
  mutationKind?: "edit" | "delete" | "rename";
  /** v3: rename destination. Only set for rename proposals. */
  targetPath?: string;
  /** v3: per-file decision for delete/rename proposals. */
  fileDecision?: "accepted" | "rejected";
  /** v3: checkpoint of an applied proposal, for Restore. */
  checkpoint?: FileCheckpoint;
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
  mutationKind: "edit" | "delete" | "rename";
  targetPath?: string;
  fileDecision?: "accepted" | "rejected";
  hunkDecisions: Record<number, HunkDecision>;
};

const RESTORABLE: ReadonlySet<string> = new Set([
  "pending",
  "reviewing",
  "done",
  "applied",
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

/**
 * Snapshots restorable review state for one session. An "applied"
 * proposal is only restorable when it has a checkpoint; without one,
 * restoring it would show an Applied file that cannot be undone.
 *
 * Fase 9 (slice 2): checkpoints without an open tab are snapshotted
 * too, as pending checkpoint-only proposals. The tool already wrote
 * the change, but the bridge never opened the tab (or it was closed
 * before the debounced save) — without this the checkpoint would be
 * lost on restart and Restore would stop working. A checkpoint has
 * no isNewFile flag; like ChangedFilesCard, an empty baseline means
 * a new file. A tab's proposal always wins over its checkpoint.
 */
export function snapshotReviewState(
  sessionId: string,
  tabs: readonly ReviewTabSnapshot[],
  now: number = Date.now(),
  checkpoints: ReadonlyMap<string, FileCheckpoint> = new Map(),
): PersistedReviewState {
  const covered = new Set(tabs.map((tab) => tab.approvalId));
  const proposals: PersistedReviewProposal[] = tabs
    .filter(
      (tab) =>
        isRestorable(tab.status) &&
        (tab.status !== "applied" || checkpoints.has(tab.approvalId)),
    )
    .map((tab) => {
      const hunkDecisions: Record<string, HunkDecision> = {};
      for (const [key, decision] of Object.entries(tab.hunkDecisions)) {
        if (decision === "accepted" || decision === "rejected") {
          hunkDecisions[key] = decision;
        }
      }
      const checkpoint = checkpoints.get(tab.approvalId);
      return {
        approvalId: tab.approvalId,
        path: tab.path,
        isNewFile: tab.isNewFile,
        status: tab.status as RestorableReviewStatus,
        hunkDecisions,
        ...(tab.mutationKind !== "edit"
          ? { mutationKind: tab.mutationKind }
          : {}),
        ...(tab.targetPath !== undefined
          ? { targetPath: tab.targetPath }
          : {}),
        ...(tab.fileDecision !== undefined
          ? { fileDecision: tab.fileDecision }
          : {}),
        ...(checkpoint !== undefined ? { checkpoint } : {}),
        savedAt: now,
      };
    });
  for (const cp of checkpoints.values()) {
    if (covered.has(cp.approvalId)) continue;
    proposals.push({
      approvalId: cp.approvalId,
      path: cp.path,
      isNewFile: cp.kind === "edit" && cp.contentBefore === "",
      status: "pending",
      hunkDecisions: {},
      ...(cp.kind !== "edit" ? { mutationKind: cp.kind } : {}),
      ...(cp.targetPath !== undefined ? { targetPath: cp.targetPath } : {}),
      checkpoint: cp,
      savedAt: now,
    });
  }
  return {
    version: REVIEW_STATE_VERSION,
    sessionId,
    proposals,
  };
}

export function serializeReviewState(state: PersistedReviewState): string {
  return JSON.stringify(state);
}

/**
 * Parses a stored review state. Accepts v1 (per-line decisions), v2
 * (per-hunk decisions) and v3 (per-file decisions, checkpoints);
 * v1 entries keep their `lineDecisions` so the bridge can migrate
 * them. Unknown versions are rejected, damaged entries are skipped
 * instead of dropping the whole state.
 */
export function parseReviewState(value: unknown): PersistedReviewState | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (
    obj.version !== 1 &&
    obj.version !== 2 &&
    obj.version !== REVIEW_STATE_VERSION
  )
    return null;
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
    if (hunkDecisions === null && p.hunkDecisions !== undefined) continue;
    const lineDecisions =
      obj.version === 1
        ? parseDigitKeyed(p.lineDecisions, isLineDecision)
        : undefined;
    if (obj.version === 1 && lineDecisions === null) continue;
    const mutationKind =
      p.mutationKind === "delete" || p.mutationKind === "rename"
        ? p.mutationKind
        : "edit";
    const targetPath =
      typeof p.targetPath === "string" && p.targetPath
        ? p.targetPath
        : undefined;
    if (mutationKind === "rename" && targetPath === undefined) continue;
    const fileDecision =
      p.fileDecision === "accepted" || p.fileDecision === "rejected"
        ? p.fileDecision
        : undefined;
    const checkpoint = isFileCheckpoint(p.checkpoint)
      ? (p.checkpoint as FileCheckpoint)
      : undefined;
    proposals.push({
      approvalId: p.approvalId,
      path: p.path,
      isNewFile: p.isNewFile,
      status: p.status,
      hunkDecisions: hunkDecisions ?? {},
      ...(lineDecisions ? { lineDecisions } : {}),
      ...(mutationKind !== "edit" ? { mutationKind } : {}),
      ...(targetPath !== undefined ? { targetPath } : {}),
      ...(fileDecision !== undefined ? { fileDecision } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
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
