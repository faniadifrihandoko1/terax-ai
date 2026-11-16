import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { HunkBarWidget, planInlineReview } from "./inlineReview";
import { computeLineChanges } from "./lineDiff";
import {
  applyDiffHunkBarAction,
  buildDiffHunkBarDecorations,
  diffHunkBarEntries,
  diffHunkBarsExtension,
  setDiffHunkBarsEffect,
  type DiffHunkBarsCallbacks,
  type DiffHunkBarsData,
} from "./diffHunkBars";

// Two separated hunks: line 2 changes, line 4 changes.
const original = "a\nb\nc\nd\ne\n";
const proposed = "a\nB\nc\nD\ne\n";

type RecordingCallbacks = DiffHunkBarsCallbacks & {
  calls: Array<[string, ...unknown[]]>;
};

function recordingCallbacks(): RecordingCallbacks {
  const calls: Array<[string, ...unknown[]]> = [];
  return {
    calls,
    onDecideHunk: (hunkIndex, decision) =>
      calls.push(["decide", hunkIndex, decision]),
    onFocusHunk: (hunkIndex) => calls.push(["focus", hunkIndex]),
    onMoveHunk: (hunkIndex) => calls.push(["move", hunkIndex]),
    onUndo: () => calls.push(["undo"]),
    onRedo: () => calls.push(["redo"]),
  };
}

function data(
  overrides: Partial<Omit<DiffHunkBarsData, "callbacks">> & {
    callbacks?: RecordingCallbacks;
  } = {},
): DiffHunkBarsData & { callbacks: RecordingCallbacks } {
  return {
    changeSet: computeLineChanges(original, proposed),
    decisions: new Map(),
    focusedHunk: null,
    reviewable: true,
    callbacks: recordingCallbacks(),
    ...overrides,
  };
}

describe("diffHunkBarEntries (Fase 21)", () => {
  it("maps one entry per hunk with anchor, state, focus, and enabled state", () => {
    const state = EditorState.create({ doc: proposed });
    const entries = diffHunkBarEntries(state.doc, data());
    expect(entries).toEqual([
      {
        hunkIndex: 0,
        from: 2,
        state: "undecided",
        focused: false,
        disabled: false,
      },
      {
        hunkIndex: 1,
        from: 6,
        state: "undecided",
        focused: false,
        disabled: false,
      },
    ]);
  });

  it("marks decided and focused hunks", () => {
    const state = EditorState.create({ doc: proposed });
    const entries = diffHunkBarEntries(
      state.doc,
      data({
        decisions: new Map([[1, "rejected" as const]]),
        focusedHunk: 1,
      }),
    );
    expect(entries[0].state).toBe("undecided");
    expect(entries[0].focused).toBe(false);
    expect(entries[1].state).toBe("rejected");
    expect(entries[1].focused).toBe(true);
  });

  it("disables every entry when the review is no longer reviewable", () => {
    const state = EditorState.create({ doc: proposed });
    const entries = diffHunkBarEntries(state.doc, data({ reviewable: false }));
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.disabled)).toBe(true);
  });
});

describe("buildDiffHunkBarDecorations via EditorState (Fase 21)", () => {
  function widgetSpecs(
    d: DiffHunkBarsData,
  ): Array<{ from: number; block: boolean; widget: unknown }> {
    const state = EditorState.create({
      doc: proposed,
      extensions: [diffHunkBarsExtension()],
    });
    const next = state.update({ effects: setDiffHunkBarsEffect.of(d) }).state;
    const out: Array<{ from: number; block: boolean; widget: unknown }> = [];
    for (const decos of next.facet(EditorView.decorations)) {
      if (typeof decos === "function") continue;
      const iter = decos.iter();
      while (iter.value) {
        const spec = iter.value.spec as {
          widget?: unknown;
          block?: boolean;
        };
        if (spec.widget) {
          out.push({ from: iter.from, block: spec.block === true, widget: spec.widget });
        }
        iter.next();
      }
    }
    return out;
  }

  it("renders one block widget per hunk above its diff, and nothing else", () => {
    const d = data();
    const specs = widgetSpecs(d);
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.from)).toEqual([2, 6]);
    expect(specs.every((s) => s.block)).toBe(true);
    for (const [i, spec] of specs.entries()) {
      expect(spec.widget).toBeInstanceOf(HunkBarWidget);
      const plans = planInlineReview(d.changeSet, d.decisions, d.focusedHunk);
      expect(
        (spec.widget as HunkBarWidget).eq(
          new HunkBarWidget(plans[i], d.callbacks),
        ),
      ).toBe(true);
    }
    // Only the two hunk bars: no removed-lines widgets, no added-line
    // marks — the merge view already renders the diff itself.
    const decorations = buildDiffHunkBarDecorations(
      EditorState.create({ doc: proposed }).doc,
      d,
    );
    expect(decorations.size).toBe(2);
  });

  it("renders disabled widgets when the review is no longer reviewable", () => {
    const d = data({ reviewable: false });
    const specs = widgetSpecs(d);
    expect(specs).toHaveLength(2);
    const plans = planInlineReview(d.changeSet, d.decisions, d.focusedHunk);
    for (const [i, spec] of specs.entries()) {
      expect(
        (spec.widget as HunkBarWidget).eq(
          new HunkBarWidget(plans[i], d.callbacks, true),
        ),
      ).toBe(true);
    }
  });

  it("renders nothing without review data", () => {
    const state = EditorState.create({
      doc: proposed,
      extensions: [diffHunkBarsExtension()],
    });
    const total = state
      .facet(EditorView.decorations)
      .reduce((n, set) => n + (typeof set === "function" ? 0 : set.size), 0);
    expect(total).toBe(0);
  });
});

describe("applyDiffHunkBarAction (Fase 21)", () => {
  it("moves focus between hunks, clamped at the ends", () => {
    const d = data();
    expect(applyDiffHunkBarAction("move-next", d)).toBe(true);
    expect(applyDiffHunkBarAction("move-prev", d)).toBe(true);
    expect(d.callbacks.calls).toEqual([
      ["move", 0],
      ["move", 1],
    ]);
    const atEnd = data({ focusedHunk: 1 });
    expect(applyDiffHunkBarAction("move-next", atEnd)).toBe(true);
    expect(atEnd.callbacks.calls).toEqual([["move", 1]]);
    const atStart = data({ focusedHunk: 0 });
    expect(applyDiffHunkBarAction("move-prev", atStart)).toBe(true);
    expect(atStart.callbacks.calls).toEqual([["move", 0]]);
  });

  it("accepts and rejects the focused hunk through the pane callback", () => {
    const d = data({ focusedHunk: 0 });
    expect(applyDiffHunkBarAction("accept", d)).toBe(true);
    expect(applyDiffHunkBarAction("reject", d)).toBe(true);
    expect(d.callbacks.calls).toEqual([
      ["decide", 0, "accepted"],
      ["decide", 0, "rejected"],
    ]);
  });

  it("does nothing for accept/reject without a focused hunk", () => {
    const d = data();
    expect(applyDiffHunkBarAction("accept", d)).toBe(false);
    expect(applyDiffHunkBarAction("reject", d)).toBe(false);
    expect(d.callbacks.calls).toEqual([]);
  });

  it("undoes and redoes through the pane callbacks", () => {
    const d = data();
    expect(applyDiffHunkBarAction("undo", d)).toBe(true);
    expect(applyDiffHunkBarAction("redo", d)).toBe(true);
    expect(d.callbacks.calls).toEqual([["undo"], ["redo"]]);
  });

  it("does nothing when the review is no longer reviewable", () => {
    const d = data({ reviewable: false, focusedHunk: 0 });
    for (const action of [
      "move-next",
      "move-prev",
      "accept",
      "reject",
      "undo",
      "redo",
    ] as const) {
      expect(applyDiffHunkBarAction(action, d)).toBe(false);
    }
    expect(d.callbacks.calls).toEqual([]);
  });

  it("exposes the callbacks through the widget for the keymap test above", () => {
    // The keymap in diffHunkBarsExtension delegates to
    // applyDiffHunkBarAction with the field data; the widget carries the
    // same callbacks object, so a click and a shortcut decide the same way.
    const d = data();
    const decorations = buildDiffHunkBarDecorations(
      EditorState.create({ doc: proposed }).doc,
      d,
    );
    const iter = decorations.iter();
    const widget = (iter.value?.spec as { widget?: unknown }).widget as
      | HunkBarWidget
      | undefined;
    expect(widget).toBeInstanceOf(HunkBarWidget);
    expect(
      (widget as unknown as { callbacks: unknown }).callbacks,
    ).toBe(d.callbacks);
  });
});
