import { describe, expect, it } from "vitest";
import {
  inlineReviewKeyAction,
  nextReviewFocus,
  reviewKeyAction,
} from "./reviewKeyboard";

describe("reviewKeyAction (Fase 4, ai-diff pane)", () => {
  it("maps plain arrows to hunk movement", () => {
    expect(reviewKeyAction({ key: "ArrowDown" })).toBe("move-next");
    expect(reviewKeyAction({ key: "ArrowUp" })).toBe("move-prev");
    expect(reviewKeyAction({ key: "ArrowDown", shiftKey: true })).toBeNull();
  });

  it("maps Alt+Enter to accept and Alt+Shift+Enter to reject (Antigravity)", () => {
    expect(reviewKeyAction({ key: "Enter", altKey: true })).toBe("accept");
    expect(
      reviewKeyAction({ key: "Enter", altKey: true, shiftKey: true }),
    ).toBe("reject");
  });

  it("maps Ctrl/Cmd+Z to undo and Ctrl/Cmd+Y / Ctrl/Cmd+Shift+Z to redo", () => {
    expect(reviewKeyAction({ key: "z", ctrlKey: true })).toBe("undo");
    expect(reviewKeyAction({ key: "Z", metaKey: true, shiftKey: true })).toBe(
      "redo",
    );
    expect(reviewKeyAction({ key: "y", ctrlKey: true })).toBe("redo");
    expect(reviewKeyAction({ key: "Y", metaKey: true })).toBe("redo");
  });

  it("no longer maps bare A/R to decisions", () => {
    expect(reviewKeyAction({ key: "a" })).toBeNull();
    expect(reviewKeyAction({ key: "A" })).toBeNull();
    expect(reviewKeyAction({ key: "r" })).toBeNull();
    expect(reviewKeyAction({ key: "R" })).toBeNull();
  });

  it("ignores other keys and modifier combos", () => {
    expect(reviewKeyAction({ key: "Enter" })).toBeNull();
    expect(reviewKeyAction({ key: " " })).toBeNull();
    expect(reviewKeyAction({ key: "Enter", ctrlKey: true })).toBeNull();
    expect(reviewKeyAction({ key: "Enter", metaKey: true })).toBeNull();
    expect(reviewKeyAction({ key: "ArrowDown", ctrlKey: true })).toBeNull();
  });
});

describe("inlineReviewKeyAction (Fase 4, inline editor)", () => {
  it("maps Alt+Enter to accept and Alt+Shift+Enter to reject", () => {
    expect(inlineReviewKeyAction({ key: "Enter", altKey: true })).toBe(
      "accept",
    );
    expect(
      inlineReviewKeyAction({ key: "Enter", altKey: true, shiftKey: true }),
    ).toBe("reject");
  });

  it("maps Alt+arrows to hunk movement, plain arrows to nothing", () => {
    expect(
      inlineReviewKeyAction({ key: "ArrowDown", altKey: true }),
    ).toBe("move-next");
    expect(inlineReviewKeyAction({ key: "ArrowUp", altKey: true })).toBe(
      "move-prev",
    );
    expect(inlineReviewKeyAction({ key: "ArrowDown" })).toBeNull();
    expect(inlineReviewKeyAction({ key: "ArrowUp" })).toBeNull();
  });

  it("never hijacks Ctrl/Cmd+Z (the buffer's own undo)", () => {
    expect(inlineReviewKeyAction({ key: "z", ctrlKey: true })).toBeNull();
    expect(inlineReviewKeyAction({ key: "z", metaKey: true })).toBeNull();
    expect(inlineReviewKeyAction({ key: "a" })).toBeNull();
  });
});

describe("nextReviewFocus (FR-11)", () => {
  it("starts at the first hunk going down and the last hunk going up", () => {
    expect(nextReviewFocus(null, 5, 1)).toBe(0);
    expect(nextReviewFocus(null, 5, -1)).toBe(4);
  });

  it("moves one hunk and clamps at the ends instead of wrapping", () => {
    expect(nextReviewFocus(2, 5, 1)).toBe(3);
    expect(nextReviewFocus(2, 5, -1)).toBe(1);
    expect(nextReviewFocus(4, 5, 1)).toBe(4);
    expect(nextReviewFocus(0, 5, -1)).toBe(0);
  });

  it("returns null for an empty list", () => {
    expect(nextReviewFocus(null, 0, 1)).toBeNull();
    expect(nextReviewFocus(0, 0, 1)).toBeNull();
  });
});
