/**
 * In-memory pending proposals (Fase 6, Antigravity-style).
 *
 * Since Fase 6 the agent's file tools no longer write to disk: their
 * `execute` only *proposes*. A proposal lives here, keyed by canonical
 * absolute path, until the user applies or discards it in the review tab
 * (or the session changes). The registry is what lets several tool calls
 * to the same file in one run compose into a single reviewable proposal
 * instead of racing each other:
 *
 * - The first proposal for a path records the on-disk content as the
 *   original; later proposals apply their delta on top of the composed
 *   proposed content, so the review tab shows one accumulated diff.
 * - The bridge opens (or updates) one ai-diff tab per path from this
 *   registry; without a registry entry it falls back to deriving the
 *   proposal from the on-disk content, as before.
 * - Apply/Discard (reviewApply) and plan-apply (planStore) clear the
 *   entry, so the next edit starts from the new on-disk content.
 * - Plan mode never touches the registry: queued plan edits keep their
 *   own per-item proposed content.
 *
 * Module-level state, deliberately not in a store: tools run outside
 * React, and the bridge reads it from an effect. It is wiped on session
 * change by AgentRunBridge; a restart loses it, and the bridge then
 * re-derives proposals from the persisted messages instead.
 */
export type PendingProposal = {
  /** On-disk content when the first proposal for this path was made. */
  originalContent: string;
  /** Composed content of every pending proposal for this path. */
  proposedContent: string;
  /** True when the file did not exist on disk at proposal time. */
  isNewFile: boolean;
};

const pending = new Map<string, PendingProposal>();

export function getPendingProposal(
  path: string,
): PendingProposal | undefined {
  return pending.get(path);
}

/**
 * Records (or extends) the pending proposal for a path. An existing
 * entry keeps its original content — the review is always against the
 * on-disk baseline the first proposal saw — and only the proposed
 * content moves forward.
 */
export function composePendingProposal(
  path: string,
  originalContent: string,
  proposedContent: string,
  isNewFile: boolean,
): PendingProposal {
  const existing = pending.get(path);
  const next: PendingProposal = existing
    ? { ...existing, proposedContent }
    : { originalContent, proposedContent, isNewFile };
  pending.set(path, next);
  return next;
}

export function clearPendingProposal(path: string): void {
  pending.delete(path);
}

export function clearAllPendingProposals(): void {
  pending.clear();
}
