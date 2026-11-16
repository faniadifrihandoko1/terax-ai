/**
 * Pure decision helper for "open review for a file" clicks on the Changed
 * Files card (FR-02 fix, Fase 20).
 *
 * Fase 20: a click always brings the ai-diff tab to the front when the
 * tab exists — like Antigravity, the card opens the diff, not the file.
 * The old Fase 4 behaviour (open the file in the editor when inline
 * review is on) is deliberately gone: the inline decorations disappear
 * once a file is no longer reviewable, so the click landed on a plain
 * file with no diff at all, and there was no path from the card to the
 * tab that did exist in the background. The inline review itself still
 * renders in the editor; only the card's click routing changed.
 *
 * The tab is created by AgentRunBridge after the proposal lands, while
 * the card row already appears from the message parts, so a click while
 * the agent is still working did nothing at all. Every branch below
 * maps to a visible outcome, never to silence.
 */
export type OpenFileDiffInput = {
  /** Whether an ai-diff tab exists for the approval right now. */
  tabExists: boolean;
  /**
   * Result of activateAiDiffTab, once the activate branch was attempted.
   * Undefined means activation has not been attempted yet.
   */
  activateSucceeded?: boolean;
};

export type OpenFileDiffAction =
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
  if (input.activateSucceeded === false) {
    return { kind: "error-toast" };
  }
  return { kind: "activate-ai-diff" };
}
