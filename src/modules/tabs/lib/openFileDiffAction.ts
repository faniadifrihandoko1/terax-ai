/**
 * Pure decision helper for "open review for a file" clicks on the Changed
 * Files card (FR-02 fix).
 *
 * The old handler returned silently when the ai-diff tab for an approval
 * did not exist yet. The tab is created by AgentRunBridge after the
 * proposal lands, while the card row already appears from the message
 * parts, so a click while the agent is still working did nothing at all.
 * Every branch below maps to a visible outcome, never to silence.
 */
export type OpenFileDiffInput = {
  /** Whether an ai-diff tab exists for the approval right now. */
  tabExists: boolean;
  /** Settings toggle: inline review in the editor. */
  aiReviewInline: boolean;
  /** What the proposal does. Only "edit" has an inline editor view. */
  mutationKind: "edit" | "delete" | "rename";
  /**
   * Result of activateAiDiffTab, once the activate branch was attempted.
   * Undefined means activation has not been attempted yet.
   */
  activateSucceeded?: boolean;
};

export type OpenFileDiffAction =
  /** Open the file in the editor; the inline review renders there. */
  | { kind: "open-editor" }
  /** Bring the ai-diff tab to the front. */
  | { kind: "activate-ai-diff" }
  /**
   * No ai-diff tab exists yet. Open the file in the editor so the click
   * still lands somewhere, and show a toast saying honestly that the
   * review itself is not ready yet (there is no inline decoration
   * without a tab to sync from).
   */
  | { kind: "fallback-editor-toast" }
  /** The ai-diff tab existed but could not be activated. Show an error. */
  | { kind: "error-toast" };

export function decideOpenFileDiff(
  input: OpenFileDiffInput,
): OpenFileDiffAction {
  if (!input.tabExists) {
    return { kind: "fallback-editor-toast" };
  }
  if (input.aiReviewInline && input.mutationKind === "edit") {
    return { kind: "open-editor" };
  }
  if (input.activateSucceeded === false) {
    return { kind: "error-toast" };
  }
  return { kind: "activate-ai-diff" };
}
