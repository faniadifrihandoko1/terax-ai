/**
 * Keyboard navigation for per-hunk review (Fase 4, Antigravity-style).
 *
 * Pure helpers, kept out of AiDiffPane and the inline editor so the key
 * interpretation and the focus movement are unit-testable without
 * rendering any UI.
 *
 * Two surfaces, two key sets:
 * - The ai-diff pane is a read-only review list: plain ArrowUp/ArrowDown
 *   move between hunks, Alt+Enter accepts the focused hunk,
 *   Alt+Shift+Enter rejects it, Ctrl/Cmd+Z undoes the last review
 *   decision and Ctrl/Cmd+Y (or Ctrl/Cmd+Shift+Z) redoes it.
 * - The inline editor is a live buffer: plain arrows move the cursor and
 *   Ctrl/Cmd+Z belongs to the buffer's own undo, so only the Alt combos
 *   act there (Alt+arrows move between hunks). That is a deliberate
 *   deviation from the pane, documented where the editor wires it up.
 */

export type ReviewKeyAction =
  | "move-prev"
  | "move-next"
  | "accept"
  | "reject"
  | "undo"
  | "redo";

export type ReviewKeyEvent = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

function isMod(event: ReviewKeyEvent): boolean {
  return event.ctrlKey === true || event.metaKey === true;
}

/**
 * Interprets one keydown in the ai-diff pane. Alt+Enter / Alt+Shift+Enter
 * match Antigravity's Accept/Reject Focused Change; Ctrl/Cmd+Z / Ctrl/Cmd+Y
 * match its undo/redo of review decisions.
 */
export function reviewKeyAction(
  event: ReviewKeyEvent,
): ReviewKeyAction | null {
  if (isMod(event)) {
    if (event.key === "z" || event.key === "Z") {
      return event.shiftKey ? "redo" : "undo";
    }
    if ((event.key === "y" || event.key === "Y") && !event.shiftKey) {
      return "redo";
    }
    return null;
  }
  if (event.altKey === true && (event.key === "Enter" || event.key === "\r")) {
    return event.shiftKey ? "reject" : "accept";
  }
  if (event.altKey === true) return null;
  switch (event.key) {
    case "ArrowDown":
      return event.shiftKey ? null : "move-next";
    case "ArrowUp":
      return event.shiftKey ? null : "move-prev";
    default:
      return null;
  }
}

/**
 * Interprets one keydown in the inline editor. Only Alt combos act here:
 * plain arrows move the cursor and Ctrl/Cmd+Z is the buffer's own undo,
 * so neither is hijacked for review.
 */
export function inlineReviewKeyAction(
  event: ReviewKeyEvent,
): ReviewKeyAction | null {
  if (isMod(event)) return null;
  if (event.altKey !== true) return null;
  if (event.key === "Enter" || event.key === "\r") {
    return event.shiftKey ? "reject" : "accept";
  }
  if (event.shiftKey) return null;
  if (event.key === "ArrowDown") return "move-next";
  if (event.key === "ArrowUp") return "move-prev";
  return null;
}

/**
 * Next focused hunk position in a list of `total` hunks, clamped at the
 * ends (no wrap-around: wrapping would jump the user's place without
 * warning). `current === null` means nothing is focused yet.
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
