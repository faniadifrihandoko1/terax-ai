/**
 * In-memory written baseline (Fase 6 proposal registry, write-first
 * since Fase 8).
 *
 * Since Fase 8 the agent's file tools write to disk immediately: their
 * `execute` records the write here, keyed by canonical absolute path,
 * until the user confirms or reverts it in the review tab (or the
 * session changes). The registry is what lets several tool calls to
 * the same file in one run compose into a single reviewable change
 * instead of racing each other:
 *
 * - The first write for a path records the on-disk content as the
 *   original (the baseline); later writes advance only the written
 *   content, so the review tab shows one accumulated diff against the
 *   original file — and a Reject reverts to the original, never to an
 *   intermediate write.
 * - The bridge opens (or updates) one ai-diff tab per path from this
 *   registry and takes the checkpoint from it; without a registry
 *   entry it falls back to the persisted checkpoint, or to deriving
 *   the proposal from the on-disk content (pre-Fase-8 sessions only).
 * - Confirm/Revert (reviewApply) and plan-apply (planStore) clear the
 *   entry, so the next edit starts from the new on-disk content.
 * - Plan mode never touches the registry: queued plan edits keep their
 *   own per-item proposed content.
 *
 * Module-level state, deliberately not in a store: tools run outside
 * React, and the bridge reads it from an effect. It is wiped on session
 * change by AgentRunBridge; a restart loses it, and the bridge then
 * re-derives proposals from the persisted checkpoint or messages
 * instead.
 */
export type PendingProposalKind = "edit" | "delete" | "rename";

export type PendingProposal = {
  /** On-disk content when the first write for this path happened. */
  originalContent: string;
  /** Content of the latest write for this path (what is on disk now). */
  proposedContent: string;
  /** True when the file did not exist on disk at first-write time. */
  isNewFile: boolean;
  /** What the write did. Defaults to "edit". */
  kind: PendingProposalKind;
  /** Rename destination. Only set when kind is "rename". */
  targetPath?: string;
  /**
   * Tool call id of the first write for this path (Fase 9, slice 2).
   * The review tab's proposal id is that same id, so the tool-side
   * checkpoint and the bridge checkpoint for the path share one key:
   * the first write records the checkpoint under it, later writes
   * only advance the written state of that same checkpoint.
   */
  approvalId?: string;
};

const pending = new Map<string, PendingProposal>();

/**
 * Change notifications for the registry (Fase 34). The registry is
 * module-level mutable state outside React, so a component that
 * renders from it (the explorer's pending-review badges) needs a
 * subscription to know when to re-read it. The version only moves
 * when the set actually changes: a compose always moves the written
 * content forward, a clear only notifies when it removed an entry.
 */
let pendingVersion = 0;
const pendingListeners = new Set<() => void>();

function notifyPendingProposalsChanged(): void {
  pendingVersion += 1;
  for (const listener of pendingListeners) listener();
}

/** Snapshot of every live pending proposal, with its path. */
export function listPendingProposals(): Array<{
  path: string;
  proposal: PendingProposal;
}> {
  return [...pending.entries()].map(([path, proposal]) => ({
    path,
    proposal,
  }));
}

/**
 * Subscribes to registry changes; returns an unsubscribe function.
 * Pair with `getPendingProposalsVersion` in `useSyncExternalStore`.
 */
export function subscribePendingProposals(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

/** Monotonic version of the registry contents (see above). */
export function getPendingProposalsVersion(): number {
  return pendingVersion;
}

export function getPendingProposal(
  path: string,
): PendingProposal | undefined {
  return pending.get(path);
}

/**
 * Records (or extends) the written baseline for a path. An existing
 * entry keeps its original content, its kind and its approval id — the
 * review is always against the on-disk baseline the first write saw —
 * and only the written content moves forward.
 */
export function composePendingProposal(
  path: string,
  originalContent: string,
  proposedContent: string,
  isNewFile: boolean,
  kind: PendingProposalKind = "edit",
  targetPath?: string,
  approvalId?: string,
): PendingProposal {
  const existing = pending.get(path);
  const next: PendingProposal = existing
    ? { ...existing, proposedContent }
    : {
        originalContent,
        proposedContent,
        isNewFile,
        kind,
        ...(targetPath !== undefined ? { targetPath } : {}),
        ...(approvalId !== undefined ? { approvalId } : {}),
      };
  pending.set(path, next);
  notifyPendingProposalsChanged();
  return next;
}

export function clearPendingProposal(path: string): void {
  if (pending.delete(path)) notifyPendingProposalsChanged();
}

export function clearAllPendingProposals(): void {
  if (pending.size === 0) return;
  pending.clear();
  notifyPendingProposalsChanged();
}
