/**
 * Inline AI review in the editor (Fase 4, Antigravity-style; write-first
 * since Fase 8).
 *
 * The editor buffer shows the agent-written (proposed) content — the
 * change is already on disk — and the review renders the diff against
 * the checkpoint baseline on top of it with CodeMirror decorations:
 *
 * - Added lines: real buffer lines, green while undecided, plain once
 *   accepted, struck through once rejected.
 * - Removed lines: a block widget showing the original text, struck
 *   through while undecided, hidden once accepted, plain once rejected.
 * - Every hunk gets a header widget above it with Accept / Reject
 *   buttons and its current state, like Antigravity's per-change
 *   Accept/Reject above each change.
 *
 * The editor stays editable during review (unlike the read-only
 * ai-diff tab): the decorations map through edits via CodeMirror range
 * mapping (approximately right), the ai-diff tab stays the
 * authoritative review surface, and the FR-07 conflict guard still
 * protects the confirm — a mid-review edit to the buffer blocks the
 * confirm instead of being silently overwritten. The save path has its
 * own mtime guard (useDocument): saving a buffer whose file changed
 * on disk is withheld with a toast until the user explicitly
 * overwrites.
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
  /** 0-based proposed line the hunk anchors at (first added line, or the insertion point). */
  anchorLine: number;
  /** 0-based proposed lines this hunk adds (real buffer lines). */
  addedLines: number[];
  /** Original line texts this hunk removes (shown as a widget). */
  removedLines: string[];
  /** Display label, e.g. "lines 3-5" or "remove lines 2-2". */
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

/**
 * Human label for a hunk against the proposed buffer (Fase 8): the
 * user sees the written content, so the label counts proposed lines —
 * except a pure deletion, which has no proposed lines and is labelled
 * by the original lines it removes.
 */
export function labelForHunkProposed(hunk: LineHunk): string {
  return hunk.proposedFrom === hunk.proposedTo
    ? `remove lines ${hunk.baseFrom + 1}-${hunk.baseTo}`
    : `lines ${hunk.proposedFrom + 1}-${hunk.proposedTo}`;
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
      anchorLine: hunk.proposedFrom,
      addedLines: changes
        .filter((c) => c.kind === "added")
        .map((c) => c.proposedLine ?? 0),
      removedLines: changes
        .filter((c) => c.kind === "removed")
        .map((c) => c.text),
      label: labelForHunkProposed(hunk),
    };
  });
}

/**
 * Character position a hunk's widgets anchor at: the start of the first
 * affected proposed line, or the end of the document for an insertion at
 * the very end.
 */
export function anchorPosition(doc: Text, hunk: LineHunk): number {
  if (hunk.proposedFrom >= doc.lines) return doc.length;
  return doc.line(Math.max(1, hunk.proposedFrom + 1)).from;
}

/** Hunk index whose proposed range contains 0-based `proposedLine`, if any. */
export function hunkAtLine(
  changeSet: LineChangeSet,
  proposedLine: number,
): number | null {
  for (const hunk of changeSet.hunks) {
    if (hunk.proposedFrom <= proposedLine && proposedLine < hunk.proposedTo) {
      return hunk.index;
    }
    // A pure deletion sits between proposed lines: it belongs to the
    // line before and the line after its anchor.
    if (
      hunk.proposedFrom === hunk.proposedTo &&
      (proposedLine === hunk.proposedFrom ||
        proposedLine === hunk.proposedFrom - 1)
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

/** First hunk at or after 0-based `proposedLine`, if any. */
export function nextHunkAtOrAfter(
  changeSet: LineChangeSet,
  proposedLine: number,
): number | null {
  for (const hunk of changeSet.hunks) {
    if (hunk.proposedTo > proposedLine || hunk.proposedFrom >= proposedLine) {
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

/**
 * Block widget showing a hunk's removed lines in place. The removed
 * lines are not in the buffer anymore (the buffer is the written
 * content), so they render here: struck through while undecided, plain
 * once rejected. Accepted deletions are not rendered at all.
 */
class RemovedLinesWidget extends WidgetType {
  constructor(private plan: InlineHunkPlan) {
    super();
  }

  toDOM(): HTMLElement {
    const box = document.createElement("div");
    box.className = "cm-inlineRemovedBox";
    if (this.plan.state === "rejected") {
      box.classList.add("cm-inlineRemovedBox-rejected");
    }
    if (this.plan.focused) box.classList.add("cm-inlineRemovedBox-focused");
    for (const text of this.plan.removedLines) {
      const line = document.createElement("div");
      line.className = "cm-inlineRemovedBoxLine";
      line.textContent = `- ${text}`;
      box.appendChild(line);
    }
    return box;
  }

  eq(other: RemovedLinesWidget): boolean {
    return (
      other.plan.hunkIndex === this.plan.hunkIndex &&
      other.plan.state === this.plan.state &&
      other.plan.focused === this.plan.focused &&
      other.plan.removedLines.join("\n") === this.plan.removedLines.join("\n")
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
 * position the hunk bar comes first, then the removed lines, then line
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
    // Removed lines are not in the buffer anymore: show them as a
    // widget. Undecided: struck through. Accepted: hidden (the
    // deletion is already the result). Rejected: plain (they come back).
    if (plan.removedLines.length > 0 && plan.state !== "accepted") {
      entries.push({
        from: anchor,
        to: anchor,
        order: 1,
        deco: Decoration.widget({
          widget: new RemovedLinesWidget(plan),
          block: true,
          side: 0,
        }),
      });
    }
    // Added lines are real buffer lines: mark them. Undecided: green.
    // Accepted: plain. Rejected: struck through (they will be removed).
    for (const lineNo of plan.addedLines) {
      if (lineNo + 1 > doc.lines) continue;
      const line = doc.line(lineNo + 1);
      if (plan.state === "undecided") {
        entries.push({
          from: line.from,
          to: line.from,
          order: 2,
          deco: Decoration.line({ class: "cm-inlineAddedLine" }),
        });
      } else if (plan.state === "rejected") {
        entries.push({
          from: line.from,
          to: line.from,
          order: 2,
          deco: Decoration.line({ class: "cm-inlineAddedRejectedLine" }),
        });
        entries.push({
          from: line.from,
          to: line.to,
          order: 3,
          deco: Decoration.mark({ class: "cm-inlineAddedRejectedText" }),
        });
      }
      // Accepted: the line stays, undecorated, like the result.
    }
  }
  entries.sort((a, b) => a.from - b.from || a.to - b.to || a.order - b.order);
  return Decoration.set(
    entries.map((e) => ({ from: e.from, to: e.to, value: e.deco })),
    true,
  );
}

const INLINE_REVIEW_THEME = EditorView.theme({
  ".cm-inlineAddedLine": {
    backgroundColor: "color-mix(in srgb, #22c55e 10%, transparent)",
  },
  ".cm-inlineAddedRejectedLine": {
    backgroundColor: "color-mix(in srgb, #f43f5e 10%, transparent)",
  },
  ".cm-inlineAddedRejectedText": {
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
  ".cm-inlineRemovedBox": {
    borderLeft: "2px solid color-mix(in srgb, #f43f5e 60%, transparent)",
    backgroundColor: "color-mix(in srgb, #f43f5e 8%, transparent)",
    padding: "1px 0",
  },
  ".cm-inlineRemovedBox-rejected": {
    borderLeftColor: "transparent",
    backgroundColor: "transparent",
  },
  ".cm-inlineRemovedBox-rejected .cm-inlineRemovedBoxLine": {
    textDecoration: "none",
  },
  ".cm-inlineRemovedBox-focused": {
    boxShadow: "inset 0 0 0 1px color-mix(in srgb, #f43f5e 40%, transparent)",
  },
  ".cm-inlineRemovedBoxLine": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    paddingLeft: "8px",
    whiteSpace: "pre",
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, #f43f5e 70%, transparent)",
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
