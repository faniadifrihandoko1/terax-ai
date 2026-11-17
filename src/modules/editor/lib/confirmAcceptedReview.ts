import type { AcceptAllSkipReason } from "@/modules/ai/lib/acceptAllSkips";
import {
  applyReviewedDelete,
  applyReviewedEdit,
  applyReviewedRename,
  confirmReviewedDelete,
  confirmReviewedEdit,
  confirmReviewedRename,
  defaultReviewApplyIo,
  type HunkDecisions,
  type ReviewApplyIo,
  type ReviewApplyOutcome,
} from "@/modules/ai/lib/reviewApply";
import type { AiDiffTab } from "@/modules/tabs";
import { computeLineChanges, reconstructFileFromHunks } from "./lineDiff";

/**
 * Headless "accept everything, then confirm" for one ai-diff tab
 * (Fase 20, Accept all on the Changed Files card).
 *
 * This is the per-file Confirm from AiDiffPane, without the pane: it
 * calls the same `confirmReviewed*` / `applyReviewed*` functions with
 * the same inputs the pane would use once every hunk is decided, so
 * Accept all can never drift from Confirm. It does NOT touch the tab
 * store or the review history — the caller records the returned
 * decisions and maps the outcome to a status, exactly like the pane
 * does (`clearReviewHistory` + `onSetStatus` on applied/discarded,
 * `onSetStatus("conflict")` on conflict).
 *
 * Semantics mirror pressing Confirm on the file after accepting
 * everything still undecided:
 * - Edits: undecided hunks become accepted; hunks the user already
 *   rejected stay rejected, so their content reverts via the
 *   reconstruction — Accept all never overrides an explicit rejection.
 * - Delete/rename: an undecided or accepted file decision becomes
 *   accepted; a file the user already rejected is skipped, never
 *   flipped — it still needs its own Confirm in the diff tab.
 * - Tabs that are already resolved, and edits with no hunks at all
 *   (the pane could never confirm those either), are skipped.
 */
export type ConfirmAcceptedResult = {
  /** Outcome of the underlying confirm/apply call, or "skipped". */
  outcome: ReviewApplyOutcome["outcome"] | "skipped";
  reason?: string;
  /**
   * Machine-readable reason when the outcome is "skipped" (Fase 28):
   * the caller reports it honestly instead of lumping every skip
   * under "already done or rejected". Absent when not skipped.
   */
  skipReason?: AcceptAllSkipReason;
  /**
   * Merged per-hunk decisions for edits (pre-existing decisions kept,
   * undecided accepted). Empty for file ops and skipped tabs.
   */
  hunkDecisions: HunkDecisions;
  /** True when the caller should record the file decision as accepted. */
  acceptFileOp: boolean;
};

const RESOLVED: ReadonlySet<AiDiffTab["status"]> = new Set([
  "applied",
  "rejected",
  "conflict",
  "restored",
]);

export async function confirmAcceptedReview(
  tab: AiDiffTab,
  sessionId: string | undefined,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ConfirmAcceptedResult> {
  const empty: HunkDecisions = new Map();
  if (RESOLVED.has(tab.status)) {
    return {
      outcome: "skipped",
      reason: `review already ${tab.status}`,
      skipReason: "already-resolved",
      hunkDecisions: empty,
      acceptFileOp: false,
    };
  }

  if (tab.mutationKind === "edit") {
    const changeSet = computeLineChanges(
      tab.originalContent,
      tab.proposedContent,
    );
    if (changeSet.hunks.length === 0) {
      return {
        outcome: "skipped",
        reason: "no changes to confirm",
        skipReason: "no-changes",
        hunkDecisions: empty,
        acceptFileOp: false,
      };
    }
    const decisions: HunkDecisions = new Map();
    for (const hunk of changeSet.hunks) {
      const existing = tab.hunkDecisions[hunk.index];
      decisions.set(
        hunk.index,
        existing === "rejected" ? "rejected" : "accepted",
      );
    }
    const reconstruction = reconstructFileFromHunks(
      tab.originalContent,
      changeSet,
      decisions,
    );
    const acceptedHunks = [...decisions.entries()]
      .filter(([, d]) => d === "accepted")
      .map(([i]) => i);
    const result = tab.written
      ? await confirmReviewedEdit(
          {
            approvalId: tab.approvalId,
            sessionId,
            path: tab.path,
            isNewFile: tab.isNewFile,
            originalContent: tab.originalContent,
            proposedContent: tab.proposedContent,
            reconstructedContent: reconstruction.content,
            appliedHunks: acceptedHunks,
          },
          io,
        )
      : await applyReviewedEdit(
          {
            approvalId: tab.approvalId,
            sessionId,
            path: tab.path,
            isNewFile: tab.isNewFile,
            originalContent: tab.originalContent,
            reconstructedContent: reconstruction.content,
            appliedHunks: acceptedHunks,
          },
          io,
        );
    return {
      outcome: result.outcome,
      reason: "reason" in result ? result.reason : undefined,
      hunkDecisions: decisions,
      acceptFileOp: false,
    };
  }

  // Delete / rename: a single per-file decision, no hunks.
  if (tab.fileDecision === "rejected") {
    return {
      outcome: "skipped",
      reason: "file already rejected — confirm it in its diff tab",
      skipReason: "file-rejected",
      hunkDecisions: empty,
      acceptFileOp: false,
    };
  }
  const targetPath = tab.targetPath ?? tab.path;
  const result =
    tab.mutationKind === "delete"
      ? tab.written
        ? await confirmReviewedDelete(
            {
              approvalId: tab.approvalId,
              sessionId,
              path: tab.path,
              originalContent: tab.originalContent,
            },
            io,
          )
        : await applyReviewedDelete(
            {
              approvalId: tab.approvalId,
              sessionId,
              path: tab.path,
              originalContent: tab.originalContent,
            },
            io,
          )
      : tab.written
        ? await confirmReviewedRename(
            {
              approvalId: tab.approvalId,
              sessionId,
              path: tab.path,
              targetPath,
              originalContent: tab.originalContent,
            },
            io,
          )
        : await applyReviewedRename(
            {
              approvalId: tab.approvalId,
              sessionId,
              path: tab.path,
              targetPath,
              originalContent: tab.originalContent,
            },
            io,
          );
  return {
    outcome: result.outcome,
    reason: "reason" in result ? result.reason : undefined,
    hunkDecisions: empty,
    acceptFileOp: true,
  };
}
