/**
 * Per-hunk Accept/Reject bars inside the ai-diff tab's diff view
 * (Fase 21, Antigravity-style).
 *
 * Before this phase the per-hunk buttons lived in a "Review hunks"
 * list at the top of the tab, detached from the diff itself. The bars
 * now render above each hunk in the diff, reusing the Fase 4
 * `HunkBarWidget` from the editor's inline review — same label, same
 * Accept/Reject buttons, same toggle-to-clear semantics.
 *
 * Deliberately NOT the whole inline review extension: the pane's diff
 * is a `unifiedMergeView`, which already renders removed lines
 * (deleted-chunk widgets) and highlights changed lines itself, so
 * reusing the removed-lines widget and added-line marks would show
 * every deletion twice. Only the hunk bars are added here.
 *
 * Keyboard: the old list owned ↑↓ / Alt+Enter / Alt+Shift+Enter /
 * Ctrl+Z / Ctrl+Y while it was focused. The keymap below keeps that
 * exact set on the diff view itself (the pane is read-only, so plain
 * arrows and Ctrl+Z have no buffer behaviour to hijack — unlike the
 * live editor, where only the Alt combos act).
 *
 * Pure parts (`diffHunkBarEntries`, `applyDiffHunkBarAction`) are
 * unit-tested without a view; the StateField just renders the plan.
 */

import type { Text } from "@codemirror/state";
import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
} from "@codemirror/view";
import type { HunkDecision } from "@/modules/ai/lib/reviewApply";
import type { LineChangeSet } from "./lineDiff";
import {
  anchorPosition,
  HunkBarWidget,
  INLINE_REVIEW_THEME,
  planInlineReview,
  type InlineReviewCallbacks,
} from "./inlineReview";
import {
  nextReviewFocus,
  type ReviewKeyAction,
} from "./reviewKeyboard";

export type DiffHunkBarsCallbacks = InlineReviewCallbacks & {
  /** Focus a hunk (the pane scrolls it into view). */
  onMoveHunk: (hunkIndex: number) => void;
  onUndo: () => void;
  onRedo: () => void;
};

export type DiffHunkBarsData = {
  changeSet: LineChangeSet;
  decisions: Map<number, HunkDecision>;
  focusedHunk: number | null;
  /**
   * False once the review is resolved (applied/rejected/restored):
   * the bars stay visible showing each hunk's state, but their
   * buttons are inert.
   */
  reviewable: boolean;
  callbacks: DiffHunkBarsCallbacks;
};

/** One hunk's bar, derived from the change set. Pure. */
export type DiffHunkBarEntry = {
  hunkIndex: number;
  /** Character position the block widget anchors at. */
  from: number;
  state: HunkDecision;
  focused: boolean;
  /** True when the review is no longer reviewable. */
  disabled: boolean;
};

export function diffHunkBarEntries(
  doc: Text,
  data: DiffHunkBarsData,
): DiffHunkBarEntry[] {
  return planInlineReview(data.changeSet, data.decisions, data.focusedHunk).map(
    (plan) => ({
      hunkIndex: plan.hunkIndex,
      from: anchorPosition(doc, data.changeSet.hunks[plan.hunkIndex]),
      state: plan.state,
      focused: plan.focused,
      disabled: !data.reviewable,
    }),
  );
}

/**
 * One block widget per hunk, above its diff — and nothing else. The
 * merge view renders the removed/added lines itself.
 */
export function buildDiffHunkBarDecorations(
  doc: Text,
  data: DiffHunkBarsData,
): DecorationSet {
  const plans = planInlineReview(
    data.changeSet,
    data.decisions,
    data.focusedHunk,
  );
  const entries = plans.map((plan) => ({
    from: anchorPosition(doc, data.changeSet.hunks[plan.hunkIndex]),
    widget: new HunkBarWidget(plan, data.callbacks, !data.reviewable),
  }));
  entries.sort((a, b) => a.from - b.from);
  return Decoration.set(
    entries.map((e) => ({
      from: e.from,
      to: e.from,
      value: Decoration.widget({
        widget: e.widget,
        block: true,
        side: -1,
      }),
    })),
    true,
  );
}

/**
 * Applies one keyboard action against the current review data. Pure:
 * the keymap below translates keys into actions and calls this.
 * Returns false when nothing was done (not reviewable, or
 * accept/reject with no focused hunk) so the keymap can let the key
 * fall through.
 */
export function applyDiffHunkBarAction(
  action: ReviewKeyAction,
  data: DiffHunkBarsData,
): boolean {
  if (!data.reviewable) return false;
  switch (action) {
    case "move-next":
    case "move-prev": {
      const next = nextReviewFocus(
        data.focusedHunk,
        data.changeSet.hunks.length,
        action === "move-next" ? 1 : -1,
      );
      if (next === null) return false;
      data.callbacks.onMoveHunk(next);
      return true;
    }
    case "accept":
    case "reject": {
      if (data.focusedHunk === null) return false;
      data.callbacks.onDecideHunk(
        data.focusedHunk,
        action === "accept" ? "accepted" : "rejected",
      );
      return true;
    }
    case "undo":
      data.callbacks.onUndo();
      return true;
    case "redo":
      data.callbacks.onRedo();
      return true;
  }
}

export const setDiffHunkBarsEffect =
  StateEffect.define<DiffHunkBarsData | null>();

export const diffHunkBarsField = StateField.define<DiffHunkBarsData | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiffHunkBarsEffect)) return e.value;
    }
    return value;
  },
});

const diffHunkBarsDecorations = EditorView.decorations.compute(
  [diffHunkBarsField],
  (state) => {
    const data = state.field(diffHunkBarsField);
    if (!data) return Decoration.none;
    return buildDiffHunkBarDecorations(state.doc, data);
  },
);

/**
 * Hunk bars + theme + the pane's review keymap for the ai-diff tab's
 * diff view. The field starts empty; AiDiffPane pushes data through
 * `setDiffHunkBarsEffect`.
 */
export function diffHunkBarsExtension(): Extension {
  return [
    diffHunkBarsField,
    diffHunkBarsDecorations,
    INLINE_REVIEW_THEME,
    Prec.high(
      keymap.of([
        {
          key: "ArrowDown",
          run: (view) => {
            const data = view.state.field(diffHunkBarsField);
            if (!data) return false;
            return applyDiffHunkBarAction("move-next", data);
          },
        },
        {
          key: "ArrowUp",
          run: (view) => {
            const data = view.state.field(diffHunkBarsField);
            if (!data) return false;
            return applyDiffHunkBarAction("move-prev", data);
          },
        },
        {
          key: "Alt-Enter",
          run: (view) => {
            const data = view.state.field(diffHunkBarsField);
            if (!data) return false;
            return applyDiffHunkBarAction("accept", data);
          },
        },
        {
          key: "Alt-Shift-Enter",
          run: (view) => {
            const data = view.state.field(diffHunkBarsField);
            if (!data) return false;
            return applyDiffHunkBarAction("reject", data);
          },
        },
        {
          key: "Mod-z",
          run: (view) => {
            const data = view.state.field(diffHunkBarsField);
            if (!data) return false;
            return applyDiffHunkBarAction("undo", data);
          },
        },
        {
          key: "Mod-Shift-z",
          run: (view) => {
            const data = view.state.field(diffHunkBarsField);
            if (!data) return false;
            return applyDiffHunkBarAction("redo", data);
          },
        },
        {
          key: "Mod-y",
          run: (view) => {
            const data = view.state.field(diffHunkBarsField);
            if (!data) return false;
            return applyDiffHunkBarAction("redo", data);
          },
        },
      ]),
    ),
  ];
}
