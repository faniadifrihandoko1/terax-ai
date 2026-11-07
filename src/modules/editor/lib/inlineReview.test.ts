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

describe("planInlineReview (Fase 4)", () => {
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
        removedLines: [1],
        addedLines: ["B"],
        label: "lines 2-2",
      },
      {
        hunkIndex: 1,
        state: "undecided",
        focused: false,
        anchorLine: 3,
        removedLines: [3],
        addedLines: ["D"],
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

  it("labels a pure insertion by its anchor line", () => {
    const cs = computeLineChanges("a\nb\n", "a\nb\nc\n");
    const plans = planInlineReview(cs, new Map(), null);
    expect(plans).toHaveLength(1);
    expect(plans[0].label).toBe("insert after line 2");
    expect(plans[0].removedLines).toEqual([]);
    expect(plans[0].addedLines).toEqual(["c"]);
  });
});

describe("hunkAtLine / firstUndecidedHunk / nextHunkAtOrAfter", () => {
  it("finds the hunk a base line belongs to", () => {
    const cs = changeSet();
    expect(hunkAtLine(cs, 0)).toBeNull();
    expect(hunkAtLine(cs, 1)).toBe(0);
    expect(hunkAtLine(cs, 2)).toBeNull();
    expect(hunkAtLine(cs, 3)).toBe(1);
    expect(hunkAtLine(cs, 4)).toBeNull();
  });

  it("treats an insertion anchor as belonging to its neighboring lines", () => {
    const cs = computeLineChanges("a\nb\n", "a\nb\nc\n");
    expect(hunkAtLine(cs, 2)).toBe(0);
    expect(hunkAtLine(cs, 1)).toBe(0);
    expect(hunkAtLine(cs, 0)).toBeNull();
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
  it("anchors at the first affected line, or the doc end for an end insertion", () => {
    const cs = changeSet();
    const state = EditorState.create({ doc: original });
    expect(anchorPosition(state.doc, cs.hunks[0])).toBe(2);
    expect(anchorPosition(state.doc, cs.hunks[1])).toBe(6);
    const endCs = computeLineChanges("a\nb\n", "a\nb\nc\n");
    expect(anchorPosition(state.doc, endCs.hunks[0])).toBe(4);
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
  const state = EditorState.create({
    doc: original,
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

describe("buildInlineDecorations via EditorState (Fase 4)", () => {
  const data = (
    decisions: InlineReviewData["decisions"],
  ): InlineReviewData => ({
    changeSet: changeSet(),
    decisions,
    focusedHunk: null,
    callbacks: noopCallbacks,
  });

  it("renders header + added widgets and removed-line marks while undecided", () => {
    const summary = decorationSummary(data(new Map()));
    expect(summary.filter((d) => d.widget)).toHaveLength(4);
    expect(
      summary.filter((d) => d.cls === "cm-inlineRemovedLine"),
    ).toHaveLength(2);
    expect(
      summary.filter((d) => d.cls === "cm-inlineRemovedText"),
    ).toHaveLength(2);
    expect(summary).toHaveLength(8);
  });

  it("hides an accepted deletion and keeps its added lines", () => {
    const summary = decorationSummary(
      data(new Map([[0, "accepted" as const]])),
    );
    expect(summary).toHaveLength(7);
    expect(summary.filter((d) => d.widget)).toHaveLength(4);
    expect(
      summary.filter((d) => d.cls === "cm-inlineRemovedLine"),
    ).toHaveLength(1);
    expect(
      summary.filter((d) => d.cls === "cm-inlineRemovedText"),
    ).toHaveLength(1);
  });

  it("drops a rejected hunk's added lines, keeping only its header", () => {
    const summary = decorationSummary(
      data(new Map([[1, "rejected" as const]])),
    );
    expect(summary).toHaveLength(5);
    expect(summary.filter((d) => d.widget)).toHaveLength(3);
  });

  it("renders nothing without review data", () => {
    const state = EditorState.create({
      doc: original,
      extensions: [inlineReviewExtension()],
    });
    const total = state
      .facet(EditorView.decorations)
      .reduce((n, set) => n + (typeof set === "function" ? 0 : set.size), 0);
    expect(total).toBe(0);
  });
});
