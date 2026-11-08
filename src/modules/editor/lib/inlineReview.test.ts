import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { computeLineChanges } from "./lineDiff";
import {
  anchorPosition,
  firstUndecidedHunk,
  hunkAtLine,
  inlineReviewExtension,
  nextHunkAtOrAfter,
  planInlineReview,
  setInlineReviewEffect,
  type InlineReviewData,
} from "./inlineReview";

const noopCallbacks = {
  onDecideHunk: () => {},
  onFocusHunk: () => {},
};

// Two separated hunks: line 2 changes, line 4 changes.
const original = "a\nb\nc\nd\ne\n";
const proposed = "a\nB\nc\nD\ne\n";

function changeSet() {
  return computeLineChanges(original, proposed);
}

describe("planInlineReview (Fase 4, write-first since Fase 8)", () => {
  it("plans one entry per hunk with labels, anchors, and states", () => {
    const cs = changeSet();
    expect(cs.hunks).toHaveLength(2);
    const plans = planInlineReview(cs, new Map(), null);
    expect(plans).toEqual([
      {
        hunkIndex: 0,
        state: "undecided",
        focused: false,
        anchorLine: 1,
        addedLines: [1],
        removedLines: ["b"],
        label: "lines 2-2",
      },
      {
        hunkIndex: 1,
        state: "undecided",
        focused: false,
        anchorLine: 3,
        addedLines: [3],
        removedLines: ["d"],
        label: "lines 4-4",
      },
    ]);
  });

  it("marks decided hunks and the focused one", () => {
    const cs = changeSet();
    const plans = planInlineReview(cs, new Map([[1, "rejected" as const]]), 1);
    expect(plans[0].state).toBe("undecided");
    expect(plans[0].focused).toBe(false);
    expect(plans[1].state).toBe("rejected");
    expect(plans[1].focused).toBe(true);
  });

  it("labels a pure insertion by its proposed lines", () => {
    const cs = computeLineChanges("a\nb\n", "a\nb\nc\n");
    const plans = planInlineReview(cs, new Map(), null);
    expect(plans).toHaveLength(1);
    expect(plans[0].label).toBe("lines 3-3");
    expect(plans[0].removedLines).toEqual([]);
    expect(plans[0].addedLines).toEqual([2]);
  });

  it("labels a pure deletion by the original lines it removes", () => {
    const cs = computeLineChanges("a\nb\nc\n", "a\nc\n");
    const plans = planInlineReview(cs, new Map(), null);
    expect(plans).toHaveLength(1);
    expect(plans[0].label).toBe("remove lines 2-2");
    expect(plans[0].anchorLine).toBe(1);
    expect(plans[0].removedLines).toEqual(["b"]);
    expect(plans[0].addedLines).toEqual([]);
  });
});

describe("hunkAtLine / firstUndecidedHunk / nextHunkAtOrAfter", () => {
  it("finds the hunk a proposed line belongs to", () => {
    const cs = changeSet();
    expect(hunkAtLine(cs, 0)).toBeNull();
    expect(hunkAtLine(cs, 1)).toBe(0);
    expect(hunkAtLine(cs, 2)).toBeNull();
    expect(hunkAtLine(cs, 3)).toBe(1);
    expect(hunkAtLine(cs, 4)).toBeNull();
  });

  it("treats a deletion anchor as belonging to its neighboring lines", () => {
    const cs = computeLineChanges("a\nb\nc\n", "a\nc\n");
    expect(hunkAtLine(cs, 1)).toBe(0);
    expect(hunkAtLine(cs, 0)).toBe(0);
    expect(hunkAtLine(cs, 2)).toBeNull();
  });

  it("finds the first undecided hunk and the next hunk at or after a line", () => {
    const cs = changeSet();
    const d = new Map([[0, "accepted" as const]]);
    expect(firstUndecidedHunk(cs, d)).toBe(1);
    expect(
      firstUndecidedHunk(
        cs,
        new Map([
          [0, "accepted" as const],
          [1, "rejected" as const],
        ]),
      ),
    ).toBeNull();
    expect(nextHunkAtOrAfter(cs, 0)).toBe(0);
    expect(nextHunkAtOrAfter(cs, 2)).toBe(1);
    expect(nextHunkAtOrAfter(cs, 4)).toBeNull();
  });
});

describe("anchorPosition", () => {
  it("anchors at the first affected proposed line, or the doc end for an end insertion", () => {
    const cs = changeSet();
    // Fase 8: the buffer is the proposed (written) content.
    const state = EditorState.create({ doc: proposed });
    expect(anchorPosition(state.doc, cs.hunks[0])).toBe(2);
    expect(anchorPosition(state.doc, cs.hunks[1])).toBe(6);
    const endCs = computeLineChanges("a\nb\n", "a\nb\nc\n");
    const endState = EditorState.create({ doc: "a\nb\nc\n" });
    expect(anchorPosition(endState.doc, endCs.hunks[0])).toBe(4);
  });
});

function decorationSummary(
  data: InlineReviewData,
): Array<{
  from: number;
  to: number;
  cls: string | undefined;
  widget: boolean;
}> {
  // Fase 8: the buffer is the proposed (written) content.
  const state = EditorState.create({
    doc: proposed,
    extensions: [inlineReviewExtension()],
  });
  const next = state.update({ effects: setInlineReviewEffect.of(data) }).state;
  const out: Array<{
    from: number;
    to: number;
    cls: string | undefined;
    widget: boolean;
  }> = [];
  for (const decos of next.facet(EditorView.decorations)) {
    // The facet type also allows view-dependent providers; the inline
    // extension is a plain DecorationSet, so functions are skipped here.
    if (typeof decos === "function") continue;
    const iter = decos.iter();
    while (iter.value) {
      out.push({
        from: iter.from,
        to: iter.to,
        cls: (iter.value.spec as { class?: string }).class,
        widget: Boolean((iter.value.spec as { widget?: unknown }).widget),
      });
      iter.next();
    }
  }
  return out;
}

describe("buildInlineDecorations via EditorState (Fase 4, write-first)", () => {
  const data = (
    decisions: InlineReviewData["decisions"],
  ): InlineReviewData => ({
    changeSet: changeSet(),
    decisions,
    focusedHunk: null,
    callbacks: noopCallbacks,
  });

  it("renders header + removed widgets and added-line marks while undecided", () => {
    const summary = decorationSummary(data(new Map()));
    // Per hunk: header widget + removed-lines widget + added-line mark.
    expect(summary.filter((d) => d.widget)).toHaveLength(4);
    expect(
      summary.filter((d) => d.cls === "cm-inlineAddedLine"),
    ).toHaveLength(2);
    expect(summary).toHaveLength(6);
  });

  it("hides an accepted deletion and leaves its added line plain", () => {
    const summary = decorationSummary(
      data(new Map([[0, "accepted" as const]])),
    );
    // Hunk 0: header only. Hunk 1: header + removed widget + added mark.
    expect(summary).toHaveLength(4);
    expect(summary.filter((d) => d.widget)).toHaveLength(3);
    expect(
      summary.filter((d) => d.cls === "cm-inlineAddedLine"),
    ).toHaveLength(1);
  });

  it("strikes a rejected hunk's added line and keeps its removed lines", () => {
    const summary = decorationSummary(
      data(new Map([[1, "rejected" as const]])),
    );
    // Hunk 0: header + removed widget + added mark. Hunk 1: header +
    // removed widget + struck added line + struck added text.
    expect(summary).toHaveLength(7);
    expect(summary.filter((d) => d.widget)).toHaveLength(4);
    expect(
      summary.filter((d) => d.cls === "cm-inlineAddedRejectedLine"),
    ).toHaveLength(1);
    expect(
      summary.filter((d) => d.cls === "cm-inlineAddedRejectedText"),
    ).toHaveLength(1);
  });

  it("renders nothing without review data", () => {
    const state = EditorState.create({
      doc: proposed,
      extensions: [inlineReviewExtension()],
    });
    const total = state
      .facet(EditorView.decorations)
      .reduce((n, set) => n + (typeof set === "function" ? 0 : set.size), 0);
    expect(total).toBe(0);
  });
});
