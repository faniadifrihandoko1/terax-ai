/**
 * Undo/redo history for per-hunk review decisions (Fase 4,
 * Antigravity-style: Accept/Reject decisions can be undone with Ctrl+Z).
 *
 * The history is a pure stack per approval id, kept outside React so the
 * ai-diff pane and the inline editor share one history for the same
 * proposal. Callers record a group whenever they change one or more
 * hunk decisions; undo/redo return the group so the caller can apply
 * the previous (or next) decisions itself — the class never touches
 * the tab state.
 */

import type { HunkDecision } from "./reviewApply";

/** One hunk changing from `prev` to `next`. */
export type DecisionChange = {
  hunkIndex: number;
  prev: HunkDecision;
  next: HunkDecision;
};

/** One user action, possibly touching several hunks at once (Accept all). */
export type DecisionGroup = {
  changes: DecisionChange[];
};

const MAX_HISTORY = 100;

export class ReviewHistory {
  private undoStack: DecisionGroup[] = [];
  private redoStack: DecisionGroup[] = [];

  /** Records one action. Any redoable future is discarded. */
  record(group: DecisionGroup): void {
    if (group.changes.length === 0) return;
    this.undoStack.push(group);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Pops the last action for undoing; its `prev` values are the restore. */
  undo(): DecisionGroup | null {
    const group = this.undoStack.pop();
    if (!group) return null;
    this.redoStack.push(group);
    return group;
  }

  /** Re-applies the last undone action; its `next` values are the restore. */
  redo(): DecisionGroup | null {
    const group = this.redoStack.pop();
    if (!group) return null;
    this.undoStack.push(group);
    return group;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}

const histories = new Map<string, ReviewHistory>();

/** The shared history for one proposal, created on first use. */
export function reviewHistoryFor(approvalId: string): ReviewHistory {
  let history = histories.get(approvalId);
  if (!history) {
    history = new ReviewHistory();
    histories.set(approvalId, history);
  }
  return history;
}

/** Drops a proposal's history (apply, discard, or tab close). */
export function clearReviewHistory(approvalId: string): void {
  histories.delete(approvalId);
}
