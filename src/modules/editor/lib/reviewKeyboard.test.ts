import { describe, expect, it } from "vitest";
import { nextReviewFocus, reviewKeyAction } from "./reviewKeyboard";

describe("reviewKeyAction (FR-11)", () => {
  it("maps arrows to movement and A/R to decisions", () => {
    expect(reviewKeyAction({ key: "ArrowDown" })).toBe("move-next");
    expect(reviewKeyAction({ key: "ArrowUp" })).toBe("move-prev");
    expect(reviewKeyAction({ key: "a" })).toBe("accept");
    expect(reviewKeyAction({ key: "A" })).toBe("accept");
    expect(reviewKeyAction({ key: "r" })).toBe("reject");
    expect(reviewKeyAction({ key: "R" })).toBe("reject");
  });

  it("ignores other keys and modifier combos", () => {
    expect(reviewKeyAction({ key: "Enter" })).toBeNull();
    expect(reviewKeyAction({ key: " " })).toBeNull();
    expect(reviewKeyAction({ key: "a", ctrlKey: true })).toBeNull();
    expect(reviewKeyAction({ key: "a", metaKey: true })).toBeNull();
    expect(reviewKeyAction({ key: "a", altKey: true })).toBeNull();
    expect(reviewKeyAction({ key: "ArrowDown", shiftKey: true })).toBeNull();
  });
});

describe("nextReviewFocus (FR-11)", () => {
  it("starts at the first row going down and the last row going up", () => {
    expect(nextReviewFocus(null, 5, 1)).toBe(0);
    expect(nextReviewFocus(null, 5, -1)).toBe(4);
  });

  it("moves one row and clamps at the ends instead of wrapping", () => {
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
