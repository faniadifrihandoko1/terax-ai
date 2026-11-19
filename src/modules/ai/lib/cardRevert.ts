/**
 * Card-level Revert (Fase 35): one click on a Changed Files row undoes
 * the agent's change for that file, without prompting the agent.
 *
 * It reuses the tab's headless path — `restoreCheckpoint` from
 * reviewCheckpoint, the same function the ai-diff tab's Reject all /
 * Reject remaining / Restore call — instead of inventing a second
 * revert. For a pending file that is "reject all hunks + return the
 * disk to the checkpoint baseline"; for a confirmed file it is the
 * Restore the card already had, now also reachable when the tab is
 * closed. The checkpoint is the only thing a revert needs, so the
 * button only shows while one exists for the row.
 *
 * Two pieces of bookkeeping ride along with the restore itself:
 * - The pending-proposal registry entry for the path is cleared, so
 *   the sidebar badge (Fase 34) stops marking the file pending.
 * - The caller records the approval id as card-resolved (see
 *   `mergeCardStatuses`): the card's status comes from the open tabs,
 *   so a tab-less row would otherwise fall back to "Pending" after
 *   its revert.
 */
import { normalizeToLf } from "@/modules/editor/lib/eol";
import type { AiDiffStatus } from "@/modules/tabs";
import { clearPendingProposal } from "./pendingProposals";
import {
  getCheckpoint,
  restoreCheckpoint,
  type FileCheckpoint,
  type RestoreOutcome,
} from "./reviewCheckpoint";

export type CardRevertOutcome =
  | { outcome: "restored"; approvalId: string; path: string }
  | {
      outcome: "conflict";
      approvalId: string;
      path: string;
      reason: string;
    }
  | {
      outcome: "restore-failed";
      approvalId: string;
      path: string;
      reason: string;
    }
  | { outcome: "no-checkpoint"; approvalId: string; path: string };

/** Injectable seams for `revertReviewedFile` (tests fake the disk). */
export type CardRevertIo = {
  getCheckpoint: (approvalId: string) => FileCheckpoint | undefined;
  restore: (approvalId: string) => Promise<RestoreOutcome>;
  clearPendingProposal: (path: string) => void;
};

export function defaultCardRevertIo(): CardRevertIo {
  return {
    getCheckpoint: (approvalId) => getCheckpoint(approvalId),
    restore: (approvalId) => restoreCheckpoint(approvalId, {}),
    clearPendingProposal: (path) => clearPendingProposal(path),
  };
}

/**
 * Reverts one file from its checkpoint: the disk goes back to the
 * content before the agent's change, whatever the review status was.
 *
 * The conflict guard inside `restoreCheckpoint` still applies — when
 * the file moved on disk since the apply, the revert is refused
 * instead of silently overwriting the user's later changes, and the
 * proposal stays so the user can fix the disk and retry. A revert
 * that never happened never clears the registry either.
 */
export async function revertReviewedFile(
  approvalId: string,
  io: CardRevertIo = defaultCardRevertIo(),
): Promise<CardRevertOutcome> {
  const cp = io.getCheckpoint(approvalId);
  if (!cp) {
    return { outcome: "no-checkpoint", approvalId, path: "" };
  }
  const result = await io.restore(approvalId);
  if (result.outcome === "restored") {
    io.clearPendingProposal(cp.path);
    return { outcome: "restored", approvalId, path: cp.path };
  }
  if (result.outcome === "conflict") {
    return {
      outcome: "conflict",
      approvalId,
      path: cp.path,
      reason: result.reason,
    };
  }
  if (result.outcome === "restore-failed") {
    return {
      outcome: "restore-failed",
      approvalId,
      path: cp.path,
      reason: result.reason,
    };
  }
  return { outcome: "no-checkpoint", approvalId, path: cp.path };
}

/**
 * True status of a card row that has no review tab. The card's status
 * map is built from the open tabs, so a tab-less row defaults to
 * "pending" — which lies for a confirmed file whose tab was closed.
 * The in-memory sources still tell the truth while the session lives:
 *
 * - The registry still holds the proposal while it is pending, so a
 *   registry entry means pending (it is cleared by Confirm/Revert).
 * - A checkpoint without a registry entry means the file was
 *   confirmed: for edits the written content tells whether the
 *   confirm accepted anything (it differs from the baseline) or
 *   rejected everything (a full reject confirms with the
 *   reconstruction equal to the baseline). Deletes and renames carry
 *   the same content on both sides by construction, so any checkpoint
 *   there means applied.
 * - Neither source knows the file: a legacy proposal without a
 *   checkpoint keeps the old "pending" default.
 *
 * The comparison is EOL-insensitive (Fase 36): only the text matters.
 */
export function deriveTabLessStatus(input: {
  hasRegistryProposal: boolean;
  checkpoint?: FileCheckpoint | undefined;
}): AiDiffStatus {
  if (input.hasRegistryProposal) return "pending";
  const cp = input.checkpoint;
  if (!cp) return "pending";
  if (cp.kind !== "edit") return "applied";
  const after = cp.contentAfter ?? "";
  return normalizeToLf(after) === normalizeToLf(cp.contentBefore)
    ? "rejected"
    : "applied";
}

/**
 * Which approval id a card Revert should run under for one row. The
 * row id first — for a composed row that is the last tabbed id, whose
 * checkpoint the bridge created when the second tab opened — then any
 * other mutation id behind the row that has a checkpoint (a composed
 * row's checkpoint lives under the first write's id). Undefined when
 * no id has a checkpoint: the row is not revertible.
 */
export function pickRevertApprovalId(
  candidates: readonly (string | null)[],
  restorable: ReadonlySet<string>,
): string | undefined {
  for (const id of candidates) {
    if (id !== null && restorable.has(id)) return id;
  }
  return undefined;
}

/**
 * Merges the card-resolved statuses (rows the user reverted or
 * restored from the card, whose tab may be closed or gone) under the
 * live tab statuses: an open tab always wins, so a stale card record
 * can never override what the tab says.
 */
export function mergeCardStatuses(
  tabStatuses: ReadonlyMap<string, AiDiffStatus>,
  cardResolved: ReadonlyMap<string, AiDiffStatus>,
): Map<string, AiDiffStatus> {
  const out = new Map(cardResolved);
  for (const [id, status] of tabStatuses) out.set(id, status);
  return out;
}
