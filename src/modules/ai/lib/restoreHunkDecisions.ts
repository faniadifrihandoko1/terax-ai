import {
  computeLineChanges,
  migrateLineDecisionsToHunks,
} from "@/modules/editor/lib/lineDiff";
import type { HunkDecision, LineDecision } from "./reviewApply";
import type { PersistedReviewProposal } from "./reviewPersistence";

/**
 * Restores per-hunk decisions for a tab from the persisted review
 * state. v2 states carry hunk decisions directly; v1 states carry line
 * decisions, migrated to hunks against the given change set.
 *
 * Lives in its own module (Fase 33) because it needs `lineDiff`,
 * which imports `@codemirror/merge`: the only callers are
 * `AgentRunBridge` (React.lazy) and `recreateAiDiffTab` (dynamic
 * import from App), so the heavy import stays out of the eager
 * startup graph. Do NOT move this into `reviewPersistence` — App
 * imports that statically and the eager-budget tests fail.
 */
export function restoreHunkDecisions(
  saved: PersistedReviewProposal | undefined,
  originalContent: string,
  proposedContent: string,
): Record<number, HunkDecision> {
  const hunkDecisions: Record<number, HunkDecision> = {};
  if (!saved) return hunkDecisions;
  for (const [index, decision] of Object.entries(saved.hunkDecisions)) {
    hunkDecisions[Number(index)] = decision;
  }
  if (saved.lineDecisions) {
    const lineDecisions: Record<number, LineDecision> = {};
    for (const [index, decision] of Object.entries(saved.lineDecisions)) {
      lineDecisions[Number(index)] = decision;
    }
    const changeSet = computeLineChanges(originalContent, proposedContent);
    for (const [hunkIndex, decision] of Object.entries(
      migrateLineDecisionsToHunks(lineDecisions, changeSet),
    )) {
      hunkDecisions[Number(hunkIndex)] = decision;
    }
  }
  return hunkDecisions;
}
