/**
 * Keyboard navigation for the per-line review list (FR-11).
 *
 * Pure helpers, kept out of AiDiffPane so the key interpretation and the
 * focus movement are unit-testable without rendering the pane.
 *
 * Scoping rule: these keys are only handled while the review list (or a
 * row inside it) is focused. They are NOT global shortcuts — plain `A`/`R`
 * and bare arrow keys must never fire while the user is typing in the
 * composer, the editor, or a terminal, so AiDiffPane attaches the handler
 * to the review-list container only.
 */

export type ReviewKeyAction = "move-prev" | "move-next" | "accept" | "reject";

export type ReviewKeyEvent = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * Interprets one keydown inside the review list. Modifier combos (except
 * Shift, which is how a capital letter is typed) never act, so the keys
 * cannot fight the global shortcut system or text selection.
 */
export function reviewKeyAction(
  event: ReviewKeyEvent,
): ReviewKeyAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "ArrowDown":
      return event.shiftKey ? null : "move-next";
    case "ArrowUp":
      return event.shiftKey ? null : "move-prev";
    case "a":
    case "A":
      return "accept";
    case "r":
    case "R":
      return "reject";
    default:
      return null;
  }
}

/**
 * Next focused row position in a list of `total` rows, clamped at the ends
 * (no wrap-around: wrapping would jump the user's place without warning).
 * `current === null` means nothing is focused yet.
 */
export function nextReviewFocus(
  current: number | null,
  total: number,
  direction: 1 | -1,
): number | null {
  if (total <= 0) return null;
  if (current === null) return direction > 0 ? 0 : total - 1;
  return Math.min(total - 1, Math.max(0, current + direction));
}
