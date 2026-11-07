import { describe, expect, it } from "vitest";
import {
  clearReviewHistory,
  reviewHistoryFor,
} from "./reviewHistory";

describe("ReviewHistory (Fase 4)", () => {
  it("records, undoes, and redoes a single hunk decision", () => {
    const h = reviewHistoryFor("test-single");
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
    h.record({
      changes: [{ hunkIndex: 0, prev: "undecided", next: "accepted" }],
    });
    expect(h.canUndo).toBe(true);
    const undone = h.undo();
    expect(undone?.changes).toEqual([
      { hunkIndex: 0, prev: "undecided", next: "accepted" },
    ]);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(true);
    expect(h.redo()?.changes).toEqual([
      { hunkIndex: 0, prev: "undecided", next: "accepted" },
    ]);
    expect(h.canRedo).toBe(false);
    clearReviewHistory("test-single");
  });

  it("records a group (Accept all) as one undo step", () => {
    const h = reviewHistoryFor("test-group");
    h.record({
      changes: [
        { hunkIndex: 0, prev: "undecided", next: "accepted" },
        { hunkIndex: 1, prev: "undecided", next: "accepted" },
      ],
    });
    h.record({
      changes: [{ hunkIndex: 0, prev: "accepted", next: "rejected" }],
    });
    expect(h.undo()?.changes).toEqual([
      { hunkIndex: 0, prev: "accepted", next: "rejected" },
    ]);
    // The second undo restores both hunks of the Accept-all group.
    expect(h.undo()?.changes).toHaveLength(2);
    expect(h.undo()).toBeNull();
    clearReviewHistory("test-group");
  });

  it("recording a new action discards the redo stack", () => {
    const h = reviewHistoryFor("test-redo");
    h.record({
      changes: [{ hunkIndex: 0, prev: "undecided", next: "accepted" }],
    });
    h.undo();
    expect(h.canRedo).toBe(true);
    h.record({
      changes: [{ hunkIndex: 0, prev: "undecided", next: "rejected" }],
    });
    expect(h.canRedo).toBe(false);
    clearReviewHistory("test-redo");
  });

  it("ignores empty groups and keeps separate histories per approval", () => {
    const a = reviewHistoryFor("test-a");
    const b = reviewHistoryFor("test-b");
    a.record({ changes: [] });
    expect(a.canUndo).toBe(false);
    a.record({
      changes: [{ hunkIndex: 0, prev: "undecided", next: "accepted" }],
    });
    expect(b.canUndo).toBe(false);
    clearReviewHistory("test-a");
    clearReviewHistory("test-b");
  });

  it("clear drops the whole history", () => {
    const h = reviewHistoryFor("test-clear");
    h.record({
      changes: [{ hunkIndex: 0, prev: "undecided", next: "accepted" }],
    });
    h.clear();
    expect(h.canUndo).toBe(false);
    expect(h.undo()).toBeNull();
    clearReviewHistory("test-clear");
  });
});
