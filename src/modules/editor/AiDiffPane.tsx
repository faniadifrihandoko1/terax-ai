import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiDiffStatus } from "@/modules/tabs";
import {
  AI_DIFF_STATUS_BADGE,
  AI_DIFF_STATUS_LABEL,
} from "@/modules/tabs/lib/aiDiffStatus";
import {
  applyReviewedEdit,
  checkDiskConflict,
  defaultReviewApplyIo,
  discardReviewedProposal,
  type LineDecision,
  type LineDecisions,
} from "@/modules/ai/lib/reviewApply";
import { unifiedMergeView } from "@codemirror/merge";
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  Cancel01Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
} from "./lib/extensions";
import { computeLineStats } from "./lib/diffStats";
import {
  nextReviewFocus,
  reviewKeyAction,
} from "./lib/reviewKeyboard";
import {
  computeLineChanges,
  countDecisions,
  reconstructFile,
  splitPairs,
  type LineChange,
  type LineHunk,
} from "./lib/lineDiff";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";

type Props = {
  path: string;
  originalContent: string;
  proposedContent: string;
  status: AiDiffStatus;
  isNewFile: boolean;
  approvalId: string;
  lineDecisions: Record<number, LineDecision>;
  onSetLineDecision: (index: number, decision: LineDecision) => void;
  onSetStatus: (status: AiDiffStatus) => void;
  /** FR-11: false renders the per-file Accept/Reject fallback instead. */
  perLineEnabled: boolean;
};

const SHARED_EXT: readonly Extension[] = buildSharedExtensions();
const READONLY_EXT: Extension[] = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];

const DIFF_THEME = EditorView.theme({
  ".cm-changedText": {
    background: "#88ff881a !important",
  },
});

// --- FR-08 preview: highlight the result lines that came from a decision.
const setDecidedLinesEffect = StateEffect.define<number[]>();
const decidedLinesField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setDecidedLinesEffect)) {
        const builder = new RangeSetBuilder<Decoration>();
        for (const n of e.value) {
          if (n < 1 || n > tr.state.doc.lines) continue;
          const line = tr.state.doc.line(n);
          builder.add(
            line.from,
            line.from,
            Decoration.line({ class: "cm-decidedLine" }),
          );
        }
        return builder.finish();
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

const PREVIEW_THEME = EditorView.theme({
  ".cm-decidedLine": {
    backgroundColor: "color-mix(in srgb, #22c55e 14%, transparent)",
  },
});

export function AiDiffPane({
  path,
  originalContent,
  proposedContent,
  status,
  isNewFile,
  approvalId,
  lineDecisions,
  onSetLineDecision,
  onSetStatus,
  perLineEnabled,
}: Props) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const previewRef = useRef<ReactCodeMirrorRef>(null);
  const themeExt = useEditorThemeExt();

  // Language resolves before mount; reconfiguring after would leave the
  // merge view's deleted-chunk widgets unhighlighted.
  const [lang, setLang] = useState<Extension | null>(
    () => resolveLanguageSync(path)?.ext ?? null,
  );
  useEffect(() => {
    if (lang) return;
    let cancelled = false;
    resolveLanguage(path).then((res) => {
      if (!cancelled && res) setLang(res.ext);
    });
    return () => {
      cancelled = true;
    };
  }, [path, lang]);

  const extensions = useMemo(
    () => [
      ...SHARED_EXT,
      DEFAULT_INDENT,
      languageCompartment.of(lang ?? []),
      ...READONLY_EXT,
      unifiedMergeView({
        original: originalContent,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      }),
      DIFF_THEME,
    ],
    [originalContent, lang],
  );

  const stats = useMemo(
    () => computeLineStats(originalContent, proposedContent),
    [originalContent, proposedContent],
  );

  // --- FR-03/FR-04: per-line change set and decisions ---------------------
  const changeSet = useMemo(
    () => computeLineChanges(originalContent, proposedContent),
    [originalContent, proposedContent],
  );
  const decisions = useMemo<LineDecisions>(() => {
    const m = new Map<number, LineDecision>();
    for (const [k, v] of Object.entries(lineDecisions)) {
      m.set(Number(k), v);
    }
    return m;
  }, [lineDecisions]);
  const counts = useMemo(
    () => countDecisions(changeSet.changes, decisions),
    [changeSet, decisions],
  );
  const splitPairIds = useMemo(
    () => new Set(splitPairs(changeSet.changes, decisions)),
    [changeSet, decisions],
  );
  const allDecided = counts.total > 0 && counts.decided === counts.total;
  const allRejected = counts.total > 0 && counts.rejected === counts.total;

  const hunkGroups = useMemo(() => {
    const byHunk = new Map<
      number,
      { removed: LineChange[]; added: LineChange[] }
    >();
    for (const c of changeSet.changes) {
      let entry = byHunk.get(c.hunkIndex);
      if (!entry) {
        entry = { removed: [], added: [] };
        byHunk.set(c.hunkIndex, entry);
      }
      if (c.kind === "removed") entry.removed.push(c);
      else entry.added.push(c);
    }
    return changeSet.hunks.map((hunk) => {
      const entry = byHunk.get(hunk.index) ?? { removed: [], added: [] };
      // Same interleave order as reconstructFile: removed[i], added[i].
      const rows: LineChange[] = [];
      const n = Math.max(entry.removed.length, entry.added.length);
      for (let i = 0; i < n; i++) {
        if (entry.removed[i]) rows.push(entry.removed[i]);
        if (entry.added[i]) rows.push(entry.added[i]);
      }
      return { hunk, rows };
    });
  }, [changeSet]);

  // FR-05: reconstruction of the reviewed file, used by Apply and the
  // FR-08 preview. Undecided lines fall back to the proposal being
  // dropped (removed kept out, added kept out), so the preview and
  // Apply only run once every line is decided.
  const reconstruction = useMemo(
    () => reconstructFile(originalContent, changeSet, decisions),
    [originalContent, changeSet, decisions],
  );

  // --- Review state --------------------------------------------------------
  const reviewable =
    status === "pending" || status === "reviewing" || status === "done";
  const [reviewOpen, setReviewOpen] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  // Keep the file status in step with the decisions: first decision moves
  // pending to reviewing, the last one moves it to done. Never moves it
  // backwards past reviewing (the card may have set reviewing already).
  useEffect(() => {
    if (!reviewable || counts.total === 0) return;
    if (counts.decided === counts.total && status !== "done") {
      onSetStatus("done");
    } else if (counts.decided > 0 && status === "pending") {
      onSetStatus("reviewing");
    } else if (counts.decided < counts.total && status === "done") {
      onSetStatus("reviewing");
    }
  }, [counts.decided, counts.total, status, reviewable, onSetStatus]);

  // Re-highlight the preview's decided lines whenever the reconstruction
  // changes (the doc may have shifted under the old decorations).
  useEffect(() => {
    const view = previewRef.current?.view;
    if (!view || !showPreview) return;
    view.dispatch({
      effects: setDecidedLinesEffect.of(reconstruction.decidedLines),
    });
  }, [showPreview, reconstruction]);

  const decideAll = (decision: LineDecision) => {
    for (const c of changeSet.changes) {
      onSetLineDecision(c.index, decision);
    }
  };
  const decideHunk = (hunk: LineHunk, decision: LineDecision) => {
    for (const c of changeSet.changes) {
      if (c.hunkIndex === hunk.index) onSetLineDecision(c.index, decision);
    }
  };
  const decideRemaining = (decision: LineDecision) => {
    for (const c of changeSet.changes) {
      if (decisions.get(c.index) !== "accepted" &&
        decisions.get(c.index) !== "rejected") {
        onSetLineDecision(c.index, decision);
      }
    }
  };

  const handleApply = async () => {
    if (!allDecided || applying || status === "conflict") return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyReviewedEdit({
        approvalId,
        path,
        isNewFile,
        originalContent,
        reconstructedContent: reconstruction.content,
      });
      if (result.outcome === "applied") {
        onSetStatus("applied");
      } else if (result.outcome === "discarded") {
        onSetStatus("rejected");
      } else if (result.outcome === "conflict") {
        setConflict(result.reason);
        onSetStatus("conflict");
      } else {
        setApplyError(result.reason);
      }
    } finally {
      setApplying(false);
    }
  };

  const handleCheckAgain = async () => {
    const result = await checkDiskConflict(
      { path, originalContent, isNewFile },
      defaultReviewApplyIo(),
    );
    if (result.status === "ok") {
      setConflict(null);
      onSetStatus("done");
    } else {
      setConflict(result.reason);
    }
  };

  const handleDiscard = () => {
    discardReviewedProposal(approvalId);
    setConflict(null);
    onSetStatus("rejected");
  };

  // --- FR-11 fallback: per-file review -------------------------------------
  // With per-line review off, there are no line decisions to collect, so
  // Accept file builds the all-accepted reconstruction inline instead of
  // going through decideAll + handleApply (the state update from decideAll
  // would not have landed yet when Apply reads `allDecided`).
  const acceptAllReconstruction = useMemo(() => {
    const allAccepted = new Map<number, LineDecision>();
    for (const c of changeSet.changes) allAccepted.set(c.index, "accepted");
    return reconstructFile(originalContent, changeSet, allAccepted);
  }, [originalContent, changeSet]);

  // --- FR-11: keyboard navigation -----------------------------------------
  // Focus lives in the review list only: the container (or a row in it)
  // must be focused for Arrow/A/R to act, so typing in the composer,
  // editor, or terminal is never affected. Rows are focusable so a click
  // also sets the keyboard focus.
  const flatRows = useMemo(
    () => hunkGroups.flatMap(({ rows }) => rows),
    [hunkGroups],
  );
  const [focusedRow, setFocusedRow] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  // biome-ignore lint/correctness/useExhaustiveDependencies(approvalId): approvalId is a manual reset trigger — the keyboard focus resets when the proposal changes
  useEffect(() => {
    setFocusedRow(null);
    rowRefs.current.clear();
  }, [approvalId]);
  const onReviewKeyDown = (e: React.KeyboardEvent) => {
    if (!perLineEnabled || !reviewable) return;
    const action = reviewKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action === "move-next" || action === "move-prev") {
      const next = nextReviewFocus(
        focusedRow,
        flatRows.length,
        action === "move-next" ? 1 : -1,
      );
      if (next === null) return;
      setFocusedRow(next);
      rowRefs.current.get(next)?.focus();
      return;
    }
    if (focusedRow === null) return;
    const change = flatRows[focusedRow];
    if (!change) return;
    const decision = action === "accept" ? "accepted" : "rejected";
    const current = decisions.get(change.index);
    onSetLineDecision(
      change.index,
      current === decision ? "undecided" : decision,
    );
  };

  const handleAcceptFile = async () => {
    if (applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyReviewedEdit({
        approvalId,
        path,
        isNewFile,
        originalContent,
        reconstructedContent: acceptAllReconstruction.content,
      });
      if (result.outcome === "applied") {
        onSetStatus("applied");
      } else if (result.outcome === "discarded") {
        onSetStatus("rejected");
      } else if (result.outcome === "conflict") {
        setConflict(result.reason);
        onSetStatus("conflict");
      } else {
        setApplyError(result.reason);
      }
    } finally {
      setApplying(false);
    }
  };

  const handleRejectFile = () => {
    handleDiscard();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            className="text-[11px] px-2.5 py-2.5"
            variant={AI_DIFF_STATUS_BADGE[status]}
          >
            {AI_DIFF_STATUS_LABEL[status]}
          </Badge>
          {isNewFile ? (
            <span className="shrink-0 rounded-full border border-border/60 bg-accent/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              New file
            </span>
          ) : null}
          <span
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={path}
          >
            {path}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{stats.added}
            </span>
            <span className="text-rose-600 dark:text-rose-400">
              −{stats.removed}
            </span>
          </span>
          {perLineEnabled && counts.total > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {counts.decided}/{counts.total} decided
            </span>
          ) : null}
        </div>
        {reviewable ? (
          perLineEnabled && counts.total > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => decideAll("accepted")}
                className="h-7 gap-1"
                title="Accept every changed line"
              >
                <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
                Accept all
              </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => decideAll("rejected")}
              className="h-7 gap-1"
              title="Reject every changed line"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
              Reject all
            </Button>
            {counts.decided > 0 && counts.decided < counts.total ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => decideRemaining("rejected")}
                className="h-7"
                title="Reject every line not decided yet"
              >
                Reject remaining
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowPreview((v) => !v)}
              disabled={!allDecided}
              className="h-7"
              title={
                allDecided
                  ? "Show the file as it will look after applying"
                  : "Decide every line to preview the result"
              }
            >
              {showPreview ? "Hide preview" : "Preview result"}
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={handleApply}
              disabled={!allDecided || applying}
              className="h-7 gap-1.5"
              title={
                allDecided
                  ? "Write the reviewed file to disk"
                  : "Decide every line before applying"
              }
            >
              {applying ? "Applying…" : allRejected ? "Discard" : "Apply"}
            </Button>
            </div>
          ) : (
            // FR-11 fallback: per-file review when per-line is off. Accept
            // writes the whole proposal (the all-accepted reconstruction);
            // Reject discards it. The per-file buttons that existed before
            // Fase 2 live on here as the fallback, not as a second path.
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="sm"
                variant="default"
                onClick={handleAcceptFile}
                disabled={applying}
                className="h-7 gap-1"
                title="Accept the whole file"
              >
                <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
                {applying ? "Applying…" : "Accept file"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRejectFile}
                disabled={applying}
                className="h-7 gap-1"
                title="Reject the whole file"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
                Reject file
              </Button>
            </div>
          )
        ) : null}
      </div>

      {conflict ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
          <span>
            File changed on disk since this proposal was made ({conflict}).
            The write was blocked.
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={handleCheckAgain} className="h-7">
              Check again
            </Button>
            <Button size="sm" variant="ghost" onClick={handleDiscard} className="h-7">
              Discard proposal
            </Button>
          </span>
        </div>
      ) : null}

      {applyError ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[12px] text-rose-800 dark:text-rose-200">
          <span>Could not apply the reviewed file: {applyError}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setApplyError(null)}
            className="h-7"
          >
            Dismiss
          </Button>
        </div>
      ) : null}

      {perLineEnabled && counts.total > 0 ? (
        <div className="shrink-0 border-b border-border/60">
          <button
            type="button"
            onClick={() => setReviewOpen((v) => !v)}
            className="flex h-8 w-full items-center gap-2 px-3 text-left text-[11.5px] font-medium hover:bg-accent/40"
          >
            <HugeiconsIcon
              icon={reviewOpen ? ChevronDownIcon : ChevronRightIcon}
              size={13}
              strokeWidth={2}
            />
            Review lines
            <span className="font-normal tabular-nums text-muted-foreground">
              {counts.decided}/{counts.total} decided · {counts.accepted}{" "}
              accepted · {counts.rejected} rejected
            </span>
            <span className="ml-auto font-normal text-muted-foreground">
              ↑ ↓ move · A accept · R reject
            </span>
            {splitPairIds.size > 0 ? (
              <span className="font-normal text-amber-600 dark:text-amber-400">
                {splitPairIds.size} replacement pair
                {splitPairIds.size === 1 ? "" : "s"} decided differently
              </span>
            ) : null}
          </button>
          {reviewOpen ? (
            <div
              className="max-h-64 overflow-y-auto border-t border-border/40 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              tabIndex={0}
              role="listbox"
              onKeyDown={onReviewKeyDown}
              aria-label="Changed lines review. Use arrow keys to move, A to accept, R to reject."
            >
              {hunkGroups.map(({ hunk, rows }, hi) => {
                const flatStart = hunkGroups
                  .slice(0, hi)
                  .reduce((n, g) => n + g.rows.length, 0);
                const hunkDecided = rows.filter((c) => {
                  const d = decisions.get(c.index);
                  return d === "accepted" || d === "rejected";
                }).length;
                return (
                  <div key={hunk.index} className="mb-1 last:mb-0">
                    <div className="flex items-center justify-between gap-2 px-3 py-1">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Hunk {hi + 1} ·{" "}
                        {hunk.baseFrom === hunk.baseTo
                          ? `insert after line ${hunk.baseFrom}`
                          : `lines ${hunk.baseFrom + 1}–${hunk.baseTo}`}{" "}
                        · {hunkDecided}/{rows.length} decided
                      </span>
                      {reviewable ? (
                        <span className="flex items-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => decideHunk(hunk, "accepted")}
                            className="h-6 px-2 text-[11px]"
                          >
                            Accept hunk
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => decideHunk(hunk, "rejected")}
                            className="h-6 px-2 text-[11px]"
                          >
                            Reject hunk
                          </Button>
                        </span>
                      ) : null}
                    </div>
                    {rows.map((change, ri) => (
                      <ReviewLineRow
                        key={change.index}
                        change={change}
                        decision={decisions.get(change.index) ?? "undecided"}
                        pairSplit={
                          change.pairId !== null &&
                          splitPairIds.has(change.pairId)
                        }
                        disabled={!reviewable}
                        focused={focusedRow === flatStart + ri}
                        onFocus={() => setFocusedRow(flatStart + ri)}
                        rowRef={(el) => {
                          const pos = flatStart + ri;
                          if (el) rowRefs.current.set(pos, el);
                          else rowRefs.current.delete(pos);
                        }}
                        onDecide={(decision) =>
                          onSetLineDecision(change.index, decision)
                        }
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            "min-h-0 overflow-hidden",
            showPreview ? "min-w-0 flex-1" : "flex-1",
          )}
        >
          <CodeMirror
            ref={cmRef}
            value={proposedContent}
            theme={themeExt}
            extensions={extensions}
            editable={false}
            height="100%"
            className="h-full"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              searchKeymap: true,
            }}
          />
        </div>
        {showPreview ? (
          <div className="flex min-w-0 flex-1 flex-col border-l border-border/60">
            <div className="flex h-8 shrink-0 items-center border-b border-border/40 px-3 text-[11px] font-medium text-muted-foreground">
              Result preview · decided lines highlighted
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <CodeMirror
                ref={previewRef}
                value={reconstruction.content}
                theme={themeExt}
                extensions={[
                  ...SHARED_EXT,
                  DEFAULT_INDENT,
                  languageCompartment.of(lang ?? []),
                  ...READONLY_EXT,
                  decidedLinesField,
                  PREVIEW_THEME,
                ]}
                editable={false}
                height="100%"
                className="h-full"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: false,
                  highlightActiveLineGutter: false,
                  searchKeymap: true,
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewLineRow({
  change,
  decision,
  pairSplit,
  disabled,
  focused,
  onFocus,
  rowRef,
  onDecide,
}: {
  change: LineChange;
  decision: LineDecision;
  pairSplit: boolean;
  disabled: boolean;
  /** FR-11: keyboard focus position in the review list. */
  focused: boolean;
  onFocus: () => void;
  rowRef: (el: HTMLDivElement | null) => void;
  onDecide: (decision: LineDecision) => void;
}) {
  const lineNo =
    change.kind === "removed"
      ? (change.baseLine ?? 0) + 1
      : (change.proposedLine ?? 0) + 1;
  const accepted = decision === "accepted";
  const rejected = decision === "rejected";
  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      role="option"
      aria-selected={decision !== "undecided"}
      onFocus={onFocus}
      className={cn(
        "flex items-center gap-2 border-l-2 px-3 py-1 font-mono text-[12px] focus-visible:outline-none",
        accepted && "border-emerald-500/70 bg-emerald-500/8",
        rejected && "border-rose-500/70 bg-rose-500/8",
        !accepted && !rejected && "border-transparent",
        pairSplit && "bg-amber-500/8",
        focused && "bg-accent/50 ring-1 ring-inset ring-ring/60",
      )}
    >
      <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">
        {lineNo}
      </span>
      <span
        className={cn(
          "w-3 shrink-0 text-center font-bold",
          change.kind === "removed"
            ? "text-rose-600 dark:text-rose-400"
            : "text-emerald-600 dark:text-emerald-400",
        )}
      >
        {change.kind === "removed" ? "−" : "+"}
      </span>
      <span className="min-w-0 flex-1 truncate whitespace-pre">
        {change.text}
      </span>
      {pairSplit ? (
        <span
          className="shrink-0 text-[10.5px] text-amber-600 dark:text-amber-400"
          title="Its replacement line was decided differently"
        >
          split pair
        </span>
      ) : null}
      <span className="flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant={accepted ? "default" : "ghost"}
          disabled={disabled}
          onClick={() => onDecide(accepted ? "undecided" : "accepted")}
          className="h-6 w-6 p-0"
          title={accepted ? "Accepted — click to clear" : "Accept this line"}
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
        </Button>
        <Button
          size="sm"
          variant={rejected ? "default" : "ghost"}
          disabled={disabled}
          onClick={() => onDecide(rejected ? "undecided" : "rejected")}
          className="h-6 w-6 p-0"
          title={rejected ? "Rejected — click to clear" : "Reject this line"}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
        </Button>
      </span>
    </div>
  );
}
