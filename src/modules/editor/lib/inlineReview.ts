/**
 * Inline AI review in the editor (Fase 4, Antigravity-style).
 *
 * The editor buffer keeps showing the on-disk (original) content; the
 * pending proposal is rendered on top of it with CodeMirror decorations:
 *
 * - Removed lines: rose background + strikethrough while undecided,
 *   hidden once accepted, plain once rejected.
 * - Added lines: a block widget after the hunk anchor, green while
 *   undecided, plain once accepted, gone once rejected.
 * - Every hunk gets a header widget above it with Accept / Reject
 *   buttons and its current state, like Antigravity's per-change
 *   Accept/Reject above each change.
 *
 * The buffer is the original file on purpose: the proposal is not
 * written anywhere until the user applies it, so the review can never
 * silently change the file, and the existing disk-hash conflict guard
 * (FR-07) still applies at Apply time. While a review is active the
 * editor is read-only (the EditorPane owns that switch); editing
 * resumes once the proposal is applied or discarded.
 *
 * Pure parts (`planInlineReview`, `hunkAtLine`, `anchorPosition`) are
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
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import type { HunkDecision, HunkDecisions } from "@/modules/ai/lib/reviewApply";
import type { LineChangeSet, LineHunk } from "./lineDiff";
import { nextReviewFocus } from "./reviewKeyboard";

/** One hunk's worth of inline rendering, derived from the change set. */
export type InlineHunkPlan = {
  hunkIndex: number;
  state: HunkDecision;
  focused: boolean;
  /** 0-based base line the hunk anchors at (first removed line, or the insertion point). */
  anchorLine: number;
  /** 0-based base lines this hunk removes. */
  removedLines: number[];
  /** Added line texts, without terminators. */
  addedLines: string[];
  /** Display label, e.g. "lines 3-5" or "insert after line 2". */
  label: string;
};

/**
 * Turns a change set + hunk decisions into one plan per hunk. Pure, so
 * the rendering below is a thin translation of the plan.
 */
/** Human label for a hunk, e.g. "lines 2-4" or "insert after line 2". */
export function labelForHunk(hunk: LineHunk): string {
  return hunk.baseFrom === hunk.baseTo
    ? `insert after line ${hunk.baseFrom}`
    : `lines ${hunk.baseFrom + 1}-${hunk.baseTo}`;
}

export function planInlineReview(
  changeSet: LineChangeSet,
  decisions: HunkDecisions,
  focusedHunk: number | null,
): InlineHunkPlan[] {
  return changeSet.hunks.map((hunk) => {
    const changes = changeSet.changes.filter((c) => c.hunkIndex === hunk.index);
    return {
      hunkIndex: hunk.index,
      state: decisions.get(hunk.index) ?? "undecided",
      focused: focusedHunk === hunk.index,
      anchorLine: hunk.baseFrom,
      removedLines: changes
        .filter((c) => c.kind === "removed")
        .map((c) => c.baseLine ?? 0),
      addedLines: changes.filter((c) => c.kind === "added").map((c) => c.text),
      label: labelForHunk(hunk),
    };
  });
}

/**
 * Character position a hunk's widgets anchor at: the start of the first
 * affected base line, or the end of the document for an insertion at the
 * very end.
 */
export function anchorPosition(doc: Text, hunk: LineHunk): number {
  if (hunk.baseFrom >= doc.lines) return doc.length;
  return doc.line(Math.max(1, hunk.baseFrom + 1)).from;
}

/** Hunk index whose base range contains 0-based `baseLine`, if any. */
export function hunkAtLine(
  changeSet: LineChangeSet,
  baseLine: number,
): number | null {
  for (const hunk of changeSet.hunks) {
    if (hunk.baseFrom <= baseLine && baseLine < hunk.baseTo) {
      return hunk.index;
    }
    // A pure insertion sits between lines: it belongs to the line
    // before and the line after its anchor.
    if (
      hunk.baseFrom === hunk.baseTo &&
      (baseLine === hunk.baseFrom || baseLine === hunk.baseFrom - 1)
    ) {
      return hunk.index;
    }
  }
  return null;
}

/** First hunk still undecided, if any. */
export function firstUndecidedHunk(
  changeSet: LineChangeSet,
  decisions: HunkDecisions,
): number | null {
  for (const hunk of changeSet.hunks) {
    if ((decisions.get(hunk.index) ?? "undecided") === "undecided") {
      return hunk.index;
    }
  }
  return null;
}

/** First hunk at or after 0-based `baseLine`, if any. */
export function nextHunkAtOrAfter(
  changeSet: LineChangeSet,
  baseLine: number,
): number | null {
  for (const hunk of changeSet.hunks) {
    if (hunk.baseTo > baseLine || hunk.baseFrom >= baseLine) {
      return hunk.index;
    }
  }
  return null;
}

export type InlineReviewCallbacks = {
  onDecideHunk: (hunkIndex: number, decision: HunkDecision) => void;
  onFocusHunk: (hunkIndex: number) => void;
};

export type InlineReviewData = {
  changeSet: LineChangeSet;
  decisions: HunkDecisions;
  focusedHunk: number | null;
  callbacks: InlineReviewCallbacks;
};

export const setInlineReviewEffect =
  StateEffect.define<InlineReviewData | null>();

export const inlineReviewField = StateField.define<InlineReviewData | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setInlineReviewEffect)) return e.value;
    }
    return value;
  },
});

function hunkStateLabel(state: HunkDecision): string {
  return state === "accepted"
    ? "Accepted"
    : state === "rejected"
      ? "Rejected"
      : "Undecided";
}

function buildButton(
  text: string,
  className: string,
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Header widget above a hunk: label + Accept / Reject. Clicking a
 * decided button again clears the decision back to undecided (the
 * inline equivalent of undoing that hunk).
 */
class HunkBarWidget extends WidgetType {
  constructor(
    private plan: InlineHunkPlan,
    private callbacks: InlineReviewCallbacks,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cm-inlineHunkBar";
    if (this.plan.focused) bar.classList.add("cm-inlineHunkBar-focused");
    bar.addEventListener("click", () => {
      this.callbacks.onFocusHunk(this.plan.hunkIndex);
    });
    const label = document.createElement("span");
    label.className = "cm-inlineHunkBar-label";
    label.textContent = `Hunk ${this.plan.hunkIndex + 1} · ${this.plan.label} · ${hunkStateLabel(this.plan.state)}`;
    bar.appendChild(label);
    bar.appendChild(
      buildButton(
        this.plan.state === "accepted" ? "✓ Accepted" : "Accept",
        "cm-inlineHunkBar-btn cm-inlineHunkBar-accept",
        (e) => {
          e.stopPropagation();
          this.callbacks.onDecideHunk(
            this.plan.hunkIndex,
            this.plan.state === "accepted" ? "undecided" : "accepted",
          );
        },
      ),
    );
    bar.appendChild(
      buildButton(
        this.plan.state === "rejected" ? "✕ Rejected" : "Reject",
        "cm-inlineHunkBar-btn cm-inlineHunkBar-reject",
        (e) => {
          e.stopPropagation();
          this.callbacks.onDecideHunk(
            this.plan.hunkIndex,
            this.plan.state === "rejected" ? "undecided" : "rejected",
          );
        },
      ),
    );
    return bar;
  }

  eq(other: HunkBarWidget): boolean {
    return (
      other.plan.hunkIndex === this.plan.hunkIndex &&
      other.plan.state === this.plan.state &&
      other.plan.focused === this.plan.focused &&
      other.plan.label === this.plan.label
    );
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** Block widget showing a hunk's added lines in place. */
class AddedLinesWidget extends WidgetType {
  constructor(private plan: InlineHunkPlan) {
    super();
  }

  toDOM(): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-inlineAddedBox";
    if (this.plan.state === "accepted") {
      box.classList.add("cm-inlineAddedBox-accepted");
    }
    if (this.plan.focused) box.classList.add("cm-inlineAddedBox-focused");
    for (const text of this.plan.addedLines) {
      const line = document.createElement("div");
      line.className = "cm-inlineAddedLine";
      line.textContent = `+ ${text}`;
      box.appendChild(line);
    }
    return box;
  }

  eq(other: AddedLinesWidget): boolean {
    return (
      other.plan.hunkIndex === this.plan.hunkIndex &&
      other.plan.state === this.plan.state &&
      other.plan.focused === this.plan.focused &&
      other.plan.addedLines.join("\n") === this.plan.addedLines.join("\n")
    );
  }

  ignoreEvent(): boolean {
    return true;
  }
}

type DecoEntry = {
  from: number;
  to: number;
  order: number;
  deco: Decoration;
};

/**
 * Builds the decoration set for the current review data. Entries are
 * sorted by position so the RangeSet builder accepts them; at one
 * position the hunk bar comes first, then the added lines, then line
 * decorations.
 */
export function buildInlineDecorations(
  doc: Text,
  data: InlineReviewData,
): DecorationSet {
  const plans = planInlineReview(
    data.changeSet,
    data.decisions,
    data.focusedHunk,
  );
  const entries: DecoEntry[] = [];
  for (const plan of plans) {
    const hunk = data.changeSet.hunks[plan.hunkIndex];
    const anchor = anchorPosition(doc, hunk);
    entries.push({
      from: anchor,
      to: anchor,
      order: 0,
      deco: Decoration.widget({
        widget: new HunkBarWidget(plan, data.callbacks),
        block: true,
        side: -1,
      }),
    });
    for (const lineNo of plan.removedLines) {
      if (lineNo + 1 > doc.lines) continue;
      const line = doc.line(lineNo + 1);
      if (plan.state === "accepted") {
        // Hide the line including its terminator, so an accepted
        // deletion disappears from view exactly like the result.
        let end = line.to;
        if (end < doc.length) {
          end +=
            doc.sliceString(end, end + 2) === "\r\n"
              ? 2
              : doc.sliceString(end, end + 1) === "\n"
                ? 1
                : 0;
        }
        entries.push({
          from: line.from,
          to: end,
          order: 2,
          deco: Decoration.replace({}),
        });
      } else if (plan.state === "undecided") {
        entries.push({
          from: line.from,
          to: line.from,
          order: 2,
          deco: Decoration.line({ class: "cm-inlineRemovedLine" }),
        });
        entries.push({
          from: line.from,
          to: line.to,
          order: 3,
          deco: Decoration.mark({ class: "cm-inlineRemovedText" }),
        });
      }
      // Rejected: the line stays, undecorated, like the result.
    }
    if (plan.addedLines.length > 0 && plan.state !== "rejected") {
      entries.push({
        from: anchor,
        to: anchor,
        order: 1,
        deco: Decoration.widget({
          widget: new AddedLinesWidget(plan),
          block: true,
          side: 0,
        }),
      });
    }
  }
  entries.sort((a, b) => a.from - b.from || a.to - b.to || a.order - b.order);
  return Decoration.set(
    entries.map((e) => ({ from: e.from, to: e.to, value: e.deco })),
    true,
  );
}

const INLINE_REVIEW_THEME = EditorView.theme({
  ".cm-inlineRemovedLine": {
    backgroundColor: "color-mix(in srgb, #f43f5e 10%, transparent)",
  },
  ".cm-inlineRemovedText": {
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, #f43f5e 70%, transparent)",
  },
  ".cm-inlineHunkBar": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "2px 8px",
    margin: "2px 0",
    border: "1px solid color-mix(in srgb, #22c55e 40%, transparent)",
    borderRadius: "6px",
    backgroundColor: "color-mix(in srgb, #22c55e 8%, var(--background))",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    cursor: "pointer",
  },
  ".cm-inlineHunkBar-focused": {
    borderColor: "color-mix(in srgb, #22c55e 80%, transparent)",
    boxShadow: "0 0 0 1px color-mix(in srgb, #22c55e 50%, transparent)",
  },
  ".cm-inlineHunkBar-label": {
    flex: "1",
    color: "var(--muted-foreground)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  ".cm-inlineHunkBar-btn": {
    flexShrink: "0",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    padding: "1px 8px",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
    cursor: "pointer",
  },
  ".cm-inlineHunkBar-accept": {
    color: "#16a34a",
  },
  ".cm-inlineHunkBar-reject": {
    color: "#e11d48",
  },
  ".cm-inlineAddedBox": {
    borderLeft: "2px solid color-mix(in srgb, #22c55e 60%, transparent)",
    backgroundColor: "color-mix(in srgb, #22c55e 8%, transparent)",
    padding: "1px 0",
  },
  ".cm-inlineAddedBox-accepted": {
    borderLeftColor: "transparent",
    backgroundColor: "transparent",
  },
  ".cm-inlineAddedBox-focused": {
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, #22c55e 40%, transparent)",
  },
  ".cm-inlineAddedLine": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    paddingLeft: "8px",
    whiteSpace: "pre",
  },
});

/**
 * The hunk the keyboard acts on: the focused hunk when one is set, else
 * the hunk under the cursor, else the first undecided hunk.
 */
export function focusedHunkFor(
  view: EditorView,
  data: InlineReviewData,
): number | null {
  if (data.focusedHunk !== null) return data.focusedHunk;
  const head = view.state.selection.main.head;
  const lineNo = view.state.doc.lineAt(head).number - 1;
  return (
    hunkAtLine(data.changeSet, lineNo) ??
    nextHunkAtOrAfter(data.changeSet, lineNo) ??
    firstUndecidedHunk(data.changeSet, data.decisions)
  );
}

const inlineReviewDecorations = EditorView.decorations.compute(
  [inlineReviewField],
  (state) => {
    const data = state.field(inlineReviewField);
    if (!data) return Decoration.none;
    return buildInlineDecorations(state.doc, data);
  },
);

/**
 * Full inline-review extension for the editor: decorations + theme +
 * Alt+Enter / Alt+Shift+Enter / Alt+arrows keymap. The field starts
 * empty; EditorPane pushes data through `setInlineReviewEffect`.
 */
export function inlineReviewExtension(): Extension {
  return [
    inlineReviewField,
    inlineReviewDecorations,
    INLINE_REVIEW_THEME,
    Prec.high(
      keymap.of([
        {
          key: "Alt-Enter",
          run: (view) => {
            const data = view.state.field(inlineReviewField);
            if (!data) return false;
            const hunk = focusedHunkFor(view, data);
            if (hunk === null) return false;
            const current = data.decisions.get(hunk) ?? "undecided";
            data.callbacks.onDecideHunk(
              hunk,
              current === "accepted" ? "undecided" : "accepted",
            );
            return true;
          },
        },
        {
          key: "Alt-Shift-Enter",
          run: (view) => {
            const data = view.state.field(inlineReviewField);
            if (!data) return false;
            const hunk = focusedHunkFor(view, data);
            if (hunk === null) return false;
            const current = data.decisions.get(hunk) ?? "undecided";
            data.callbacks.onDecideHunk(
              hunk,
              current === "rejected" ? "undecided" : "rejected",
            );
            return true;
          },
        },
        {
          key: "Alt-ArrowDown",
          run: (view) => {
            const data = view.state.field(inlineReviewField);
            if (!data) return false;
            const next = nextReviewFocus(
              data.focusedHunk,
              data.changeSet.hunks.length,
              1,
            );
            if (next === null) return false;
            data.callbacks.onFocusHunk(next);
            const hunk = data.changeSet.hunks[next];
            view.dispatch({
              effects: EditorView.scrollIntoView(
                anchorPosition(view.state.doc, hunk),
                { y: "center" },
              ),
            });
            return true;
          },
        },
        {
          key: "Alt-ArrowUp",
          run: (view) => {
            const data = view.state.field(inlineReviewField);
            if (!data) return false;
            const next = nextReviewFocus(
              data.focusedHunk,
              data.changeSet.hunks.length,
              -1,
            );
            if (next === null) return false;
            data.callbacks.onFocusHunk(next);
            const hunk = data.changeSet.hunks[next];
            view.dispatch({
              effects: EditorView.scrollIntoView(
                anchorPosition(view.state.doc, hunk),
                { y: "center" },
              ),
            });
            return true;
          },
        },
      ]),
    ),
  ];
}
