/**
 * Bookkeeping for the AgentRunBridge file-mutation effect (Fase 9,
 * slice 2). Functional core; the component stays thin.
 *
 * The problem: the effect used to mark a file-mutation fingerprint as
 * done BEFORE its async work ran, and marked proposal ids as opened
 * up-front. When the effect was cancelled mid-await (a re-render with
 * new messages, a session switch), the fingerprint was already
 * considered done, so the effect never ran again for it — and any
 * proposal marked-but-never-opened stayed stranded until a new file
 * mutation changed the fingerprint.
 *
 * The tracker fixes both halves:
 * - A fingerprint counts as done only when a run finishes it WITHOUT
 *   cancellation. A cancelled run leaves the fingerprint undone and
 *   requests a retry run.
 * - A cancelled run unmarks the proposals it marked but never
 *   finished handling, so the retry run picks them up again.
 *   Proposals it did finish stay marked — the retry never opens them
 *   twice.
 * - `markOpened` returns false when another overlapping run already
 *   marked the id (a cancelled run's tail racing its retry), so two
 *   runs in flight never open the same tab twice.
 */

export type BridgeFlight = {
  /** Proposal ids this run marked as opened, in order. */
  marked: string[];
  /**
   * Proposal ids this run finished handling (tab opened/updated, or
   * intentionally skipped, e.g. a derive failure).
   */
  completed: Set<string>;
};

export class FileMutationBridgeTracker {
  private doneFingerprint = "";
  private openedIds = new Set<string>();
  private retryPending = false;

  /** Ids already handled — the double-open guard. */
  get opened(): ReadonlySet<string> {
    return this.openedIds;
  }

  /** Session change: forget everything. */
  reset(): void {
    this.doneFingerprint = "";
    this.openedIds.clear();
    this.retryPending = false;
  }

  shouldProcess(fingerprint: string): boolean {
    return fingerprint !== this.doneFingerprint || this.retryPending;
  }

  beginFlight(): BridgeFlight {
    this.retryPending = false;
    return { marked: [], completed: new Set<string>() };
  }

  /**
   * Marks a proposal as opened. Returns false when another
   * overlapping run already marked it — the caller must skip it.
   */
  markOpened(flight: BridgeFlight, proposalId: string): boolean {
    if (this.openedIds.has(proposalId)) return false;
    this.openedIds.add(proposalId);
    flight.marked.push(proposalId);
    return true;
  }

  markCompleted(flight: BridgeFlight, proposalId: string): void {
    flight.completed.add(proposalId);
  }

  /**
   * Ends a run. On success the fingerprint is done and no retry is
   * needed; on cancellation the proposals this run marked but never
   * finished are unmarked, a retry is requested, and the return value
   * tells the caller to trigger it (React state tick).
   */
  finishFlight(
    flight: BridgeFlight,
    fingerprint: string,
    cancelled: boolean,
  ): boolean {
    if (!cancelled) {
      this.doneFingerprint = fingerprint;
      return false;
    }
    for (const id of flight.marked) {
      if (!flight.completed.has(id)) this.openedIds.delete(id);
    }
    this.retryPending = true;
    return true;
  }
}
