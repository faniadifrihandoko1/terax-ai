import type { AiDiffTab } from "./useTabs";

/**
 * Applies a newer composed proposal to an existing ai-diff tab (Fase 6).
 *
 * Several tool calls to one file in a run compose into a single
 * proposal (pendingProposals registry); the tab for that file absorbs
 * the newer composed content instead of spawning a second tab.
 *
 * Returns the updated tab, or null when the tab must not absorb the
 * update. Only a tab nobody has started reviewing may change its
 * proposed content: hunk decisions are keyed by hunk index, so new
 * content would silently re-point them at different hunks. A null
 * result tells the caller (AgentRunBridge) to open a separate tab for
 * the new proposal instead. Delete/rename tabs never absorb updates —
 * they have no composed content.
 */
export function updateAiDiffTabState(
  tab: AiDiffTab,
  proposedContent: string,
): AiDiffTab | null {
  if (tab.mutationKind !== "edit") return null;
  if (tab.status !== "pending") return null;
  if (tab.proposedContent === proposedContent) return tab;
  return { ...tab, proposedContent, hunkDecisions: {} };
}
