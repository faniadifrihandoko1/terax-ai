import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AiDiffStatus } from "@/modules/tabs";
import {
  AI_DIFF_STATUS_BADGE,
  AI_DIFF_STATUS_LABEL,
} from "@/modules/tabs/lib/aiDiffStatus";
import {
  applyReviewedDelete,
  applyReviewedEdit,
  applyReviewedRename,
  checkDiskConflict,
  defaultReviewApplyIo,
  discardReviewedProposal,
  type HunkDecision,
  type HunkDecisions,
} from "@/modules/ai/lib/reviewApply";
import {
  getCheckpoint,
  restoreCheckpoint,
} from "@/modules/ai/lib/reviewCheckpoint";
import {
  clearReviewHistory,
  reviewHistoryFor,
  type ReviewDecisionGroup,
} from "@/modules/ai/lib/reviewHistory";
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
import { labelForHunk } from "./lib/inlineReview";
import {
  computeLineChanges,
  countHunkDecisions,
  reconstructFileFromHunks,
} from "./lib/lineDiff";
import { nextReviewFocus, reviewKeyAction } from "./lib/reviewKeyboard";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";

type Props = {
  path: string;
  originalContent: string;
  proposedContent: string;
  status: AiDiffStatus;
  isNewFile: boolean;
  approvalId: string;
  /** Owning session, stamped on checkpoints for session-delete cleanup. */
  sessionId?: string;
  /** Delete/rename proposal (Fase 5). Defaults to "edit". */
  mutationKind: "edit" | "delete" | "rename";
  /** Rename destination. Only set when mutationKind is "rename". */
  targetPath?: string;
  /** Per-file decision for delete/rename proposals. Absent = undecided. */
  fileDecision?: "accepted" | "rejected";
  hunkDecisions: Record<number, HunkDecision>;
  onSetHunkDecision: (hunkIndex: number, decision: HunkDecision) => void;
  onSetFileDecision: (
    decision: "accepted" | "rejected" | "undecided",
  ) => void;
  onSetStatus: (status: AiDiffStatus) => void;
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
  sessionId,
  mutationKind,
  targetPath,
  fileDecision,
  hunkDecisions,
  onSetHunkDecision,
  onSetFileDecision,
  onSetStatus,
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

  // --- Fase 4: per-hunk change set and decisions ---------------------------
  const changeSet = useMemo(
    () => computeLineChanges(originalContent, proposedContent),
    [originalContent, proposedContent],
  );
  const decisions = useMemo<HunkDecisions>(() => {
    const m = new Map<number, HunkDecision>();
    for (const [k, v] of Object.entries(hunkDecisions)) {
      m.set(Number(k), v);
    }
    return m;
  }, [hunkDecisions]);
  const counts = useMemo(
    () => countHunkDecisions(changeSet.hunks, decisions),
    [changeSet, decisions],
  );
  const allDecided = counts.total > 0 && counts.decided === counts.total;
  const allRejected = counts.total > 0 && counts.rejected === counts.total;

  // FR-05: reconstruction of the reviewed file, used by Apply and the
  // FR-08 preview. Undecided hunks fall back to the proposal being
  // dropped (removed kept, added dropped), so the preview and Apply only
  // run once every hunk is decided.
  const reconstruction = useMemo(
    () => reconstructFileFromHunks(originalContent, changeSet, decisions),
    [originalContent, changeSet, decisions],
  );

  // --- Review state --------------------------------------------------------
  const reviewable =
    status === "pending" || status === "reviewing" || status === "done";
  // Delete/rename proposals (Fase 5) have no hunks: the whole file is one
  // decision, and the merge view below only shows what would be lost.
  const isFileOp = mutationKind !== "edit";
  const [reviewOpen, setReviewOpen] = useState(true);
  const [showPreview, setShowPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreConflict, setRestoreConflict] = useState<string | null>(null);
  const restorable =
    status === "applied" && getCheckpoint(approvalId) !== undefined;
  const [focusedHunk, setFocusedHunk] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  // Bumped on every record/undo/redo so the Undo/Redo buttons re-render.
  const [historyVersion, setHistoryVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies(approvalId): approvalId is a manual reset trigger, the keyboard focus resets when the proposal changes
  useEffect(() => {
    setFocusedHunk(null);
    rowRefs.current.clear();
  }, [approvalId]);

  // Keep the file status in step with the decisions: first decision moves
  // pending to reviewing, the last one moves it to done. Never moves it
  // backwards past reviewing (the card may have set reviewing already).
  // File operations (Fase 5) have no hunks; their decision sync lives in
  // decideFile instead.
  useEffect(() => {
    if (isFileOp || !reviewable || counts.total === 0) return;
    if (counts.decided === counts.total && status !== "done") {
      onSetStatus("done");
    } else if (counts.decided > 0 && status === "pending") {
      onSetStatus("reviewing");
    } else if (counts.decided < counts.total && status === "done") {
      onSetStatus("reviewing");
    }
  }, [counts.decided, counts.total, status, reviewable, onSetStatus, isFileOp]);

  // Re-highlight the preview's decided lines whenever the reconstruction
  // changes (the doc may have shifted under the old decorations).
  useEffect(() => {
    const view = previewRef.current?.view;
    if (!view || !showPreview) return;
    view.dispatch({
      effects: setDecidedLinesEffect.of(reconstruction.decidedLines),
    });
  }, [showPreview, reconstruction]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(historyVersion): historyVersion is a manual re-render trigger, read only through the dependency array
  const { canUndo, canRedo } = useMemo(() => {
    const history = reviewHistoryFor(approvalId);
    return { canUndo: history.canUndo, canRedo: history.canRedo };
  }, [approvalId, historyVersion]);

  const focusHunk = (index: number) => {
    setFocusedHunk(index);
    rowRefs.current.get(index)?.focus();
    const view = cmRef.current?.view;
    const hunk = changeSet.hunks[index];
    if (view && hunk) {
      const line = Math.max(
        1,
        Math.min(hunk.proposedFrom + 1, view.state.doc.lines),
      );
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.doc.line(line).from, {
          y: "center",
        }),
      });
    }
  };

  const recordDecisions = (changes: ReviewDecisionGroup) => {
    if (changes.length === 0) return;
    reviewHistoryFor(approvalId).record(changes);
    setHistoryVersion((v) => v + 1);
  };

  const decideHunk = (hunkIndex: number, decision: HunkDecision) => {
    const current = decisions.get(hunkIndex) ?? "undecided";
    const next = current === decision ? "undecided" : decision;
    if (next === current) return;
    onSetHunkDecision(hunkIndex, next);
    recordDecisions([{ hunkIndex, prev: current, next }]);
  };

  const decideGroup = (decision: HunkDecision, onlyUndecided: boolean) => {
    const changes: ReviewDecisionGroup = [];
    for (const hunk of changeSet.hunks) {
      const current = decisions.get(hunk.index) ?? "undecided";
      if (current === decision) continue;
      if (onlyUndecided && current !== "undecided") continue;
      changes.push({ hunkIndex: hunk.index, prev: current, next: decision });
    }
    for (const c of changes) onSetHunkDecision(c.hunkIndex, c.next);
    recordDecisions(changes);
  };
  const decideAll = (decision: HunkDecision) => decideGroup(decision, false);
  const decideRemaining = (decision: HunkDecision) =>
    decideGroup(decision, true);

  const handleUndo = () => {
    const group = reviewHistoryFor(approvalId).undo();
    if (!group) return;
    for (const c of group) onSetHunkDecision(c.hunkIndex, c.prev);
    setHistoryVersion((v) => v + 1);
  };
  const handleRedo = () => {
    const group = reviewHistoryFor(approvalId).redo();
    if (!group) return;
    for (const c of group) onSetHunkDecision(c.hunkIndex, c.next);
    setHistoryVersion((v) => v + 1);
  };

  const handleApply = async () => {
    if (applying || status === "conflict") return;
    if (isFileOp) {
      if (!fileDecision) return;
      setApplying(true);
      setApplyError(null);
      try {
        if (fileDecision === "rejected") {
          discardReviewedProposal(approvalId);
          onSetStatus("rejected");
          return;
        }
        const result =
          mutationKind === "delete"
            ? await applyReviewedDelete({
                approvalId,
                sessionId,
                path,
                originalContent,
              })
            : await applyReviewedRename({
                approvalId,
                sessionId,
                path,
                targetPath: targetPath ?? path,
                originalContent,
              });
        if (result.outcome === "applied") {
          onSetStatus("applied");
        } else if (result.outcome === "conflict") {
          setConflict(result.reason);
          onSetStatus("conflict");
        } else if (
          result.outcome === "not-writable" ||
          result.outcome === "write-failed"
        ) {
          setApplyError(result.reason);
        }
      } finally {
        setApplying(false);
      }
      return;
    }
    if (!allDecided) return;
    setApplying(true);
    setApplyError(null);
    try {
      const acceptedHunks = [...decisions.entries()]
        .filter(([, d]) => d === "accepted")
        .map(([i]) => i);
      const result = await applyReviewedEdit({
        approvalId,
        sessionId,
        path,
        isNewFile,
        originalContent,
        reconstructedContent: reconstruction.content,
        appliedHunks: acceptedHunks,
      });
      if (result.outcome === "applied") {
        clearReviewHistory(approvalId);
        onSetStatus("applied");
      } else if (result.outcome === "discarded") {
        clearReviewHistory(approvalId);
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

  // --- Fase 5: per-file decision for delete/rename -------------------------
  // Clicking the same decision again clears it, like the hunk buttons.
  // A decision moves the file to done; clearing it moves it back to
  // reviewing so the card reflects that work is left.
  const decideFile = (decision: "accepted" | "rejected") => {
    if (!reviewable) return;
    const next = fileDecision === decision ? "undecided" : decision;
    onSetFileDecision(next);
    if (next === "undecided") {
      if (status === "done") onSetStatus("reviewing");
    } else {
      onSetStatus("done");
    }
  };

  const handleRestore = async (force: boolean) => {
    if (restoring) return;
    setRestoring(true);
    setApplyError(null);
    try {
      const result = await restoreCheckpoint(approvalId, { force });
      if (result.outcome === "restored") {
        setRestoreConflict(null);
        onSetStatus("restored");
      } else if (result.outcome === "conflict") {
        setRestoreConflict(result.reason);
      } else if (result.outcome === "restore-failed") {
        setApplyError(result.reason);
      } else {
        setApplyError("No checkpoint for this file.");
      }
    } finally {
      setRestoring(false);
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
    clearReviewHistory(approvalId);
    setConflict(null);
    onSetStatus("rejected");
  };

  // --- Fase 4: keyboard navigation -----------------------------------------
  // Focus lives in the review list only: the container must be focused
  // for the shortcuts to act, so typing in the composer, editor, or
  // terminal is never affected. Alt+Enter / Alt+Shift+Enter match
  // Antigravity; Ctrl+Z / Ctrl+Y undo and redo review decisions.
  const onReviewKeyDown = (e: React.KeyboardEvent) => {
    if (!reviewable) return;
    const action = reviewKeyAction(e);
    if (!action) return;
    e.preventDefault();
    if (action === "move-next" || action === "move-prev") {
      const next = nextReviewFocus(
        focusedHunk,
        changeSet.hunks.length,
        action === "move-next" ? 1 : -1,
      );
      if (next === null) return;
      focusHunk(next);
      return;
    }
    if (action === "undo") {
      handleUndo();
      return;
    }
    if (action === "redo") {
      handleRedo();
      return;
    }
    if (focusedHunk === null) return;
    decideHunk(focusedHunk, action === "accept" ? "accepted" : "rejected");
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
          {mutationKind === "delete" ? (
            <span className="shrink-0 rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
              Deleted
            </span>
          ) : null}
          {mutationKind === "rename" ? (
            <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
              Renamed
            </span>
          ) : null}
          <span
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={
              mutationKind === "rename" && targetPath
                ? `${path} → ${targetPath}`
                : path
            }
          >
            {mutationKind === "rename" && targetPath
              ? `${path} → ${targetPath}`
              : path}
          </span>
          {mutationKind !== "rename" ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
              <span className="text-emerald-600 dark:text-emerald-400">
                +{stats.added}
              </span>
              <span className="text-rose-600 dark:text-rose-400">
                −{stats.removed}
              </span>
            </span>
          ) : null}
          {!isFileOp && counts.total > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {counts.decided}/{counts.total} decided
            </span>
          ) : null}
        </div>
        {reviewable && isFileOp ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant={fileDecision === "accepted" ? "default" : "ghost"}
              onClick={() => decideFile("accepted")}
              className="h-7 gap-1"
              title={
                fileDecision === "accepted"
                  ? "Accepted, click to clear"
                  : mutationKind === "delete"
                    ? "Accept deleting this file"
                    : "Accept renaming this file"
              }
            >
              <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
              Accept
            </Button>
            <Button
              size="sm"
              variant={fileDecision === "rejected" ? "default" : "ghost"}
              onClick={() => decideFile("rejected")}
              className="h-7 gap-1"
              title={
                fileDecision === "rejected"
                  ? "Rejected, click to clear"
                  : "Reject this proposal"
              }
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
              Reject
            </Button>
            <Button
              size="sm"
              variant="default"
              onClick={handleApply}
              disabled={!fileDecision || applying}
              className="h-7 gap-1.5"
              title={
                fileDecision
                  ? fileDecision === "rejected"
                    ? "Discard the proposal"
                    : mutationKind === "delete"
                      ? "Delete the file from disk"
                      : "Rename the file on disk"
                  : "Accept or reject the proposal first"
              }
            >
              {applying
                ? "Applying…"
                : fileDecision === "rejected"
                  ? "Discard"
                  : mutationKind === "delete"
                    ? "Delete file"
                    : "Rename file"}
            </Button>
          </div>
        ) : null}
        {restorable ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleRestore(false)}
              disabled={restoring}
              className="h-7"
              title="Undo this apply: write back the content from before it"
            >
              {restoring ? "Restoring…" : "Restore"}
            </Button>
          </div>
        ) : null}
        {reviewable && !isFileOp && counts.total > 0 ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => decideAll("accepted")}
              className="h-7 gap-1"
              title="Accept every hunk"
            >
              <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
              Accept all
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => decideAll("rejected")}
              className="h-7 gap-1"
              title="Reject every hunk"
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
                title="Reject every hunk not decided yet"
              >
                Reject remaining
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleUndo}
              disabled={!canUndo}
              className="h-7"
              title="Undo last review decision (Ctrl+Z)"
            >
              Undo
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleRedo}
              disabled={!canRedo}
              className="h-7"
              title="Redo last undone review decision (Ctrl+Y)"
            >
              Redo
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowPreview((v) => !v)}
              disabled={!allDecided}
              className="h-7"
              title={
                allDecided
                  ? "Show the file as it will look after applying"
                  : "Decide every hunk to preview the result"
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
                  : "Decide every hunk before applying"
              }
            >
              {applying ? "Applying…" : allRejected ? "Discard" : "Apply"}
            </Button>
          </div>
        ) : null}
      </div>

      {isFileOp ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2 text-[12px] text-muted-foreground">
          {mutationKind === "delete" ? (
            <span>
              This proposal deletes the file (
              {stats.removed} line{stats.removed === 1 ? "" : "s"}). The
              content below is what would be lost; accepting removes it from
              disk, and it can be restored afterwards.
            </span>
          ) : (
            <span>
              This proposal renames the file to{" "}
              <span className="font-mono">{targetPath}</span>. Content is
              unchanged.
            </span>
          )}
        </div>
      ) : null}

      {restoreConflict ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
          <span>
            Restore refused: {restoreConflict}. The file changed since the
            apply, so restoring would overwrite those changes.
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleRestore(true)}
              disabled={restoring}
              className="h-7"
            >
              Restore anyway
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setRestoreConflict(null)}
              className="h-7"
            >
              Dismiss
            </Button>
          </span>
        </div>
      ) : null}

      {conflict ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-800 dark:text-amber-200">
          <span>
            File changed on disk since this proposal was made ({conflict}). The
            write was blocked.
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={handleCheckAgain}
              className="h-7"
            >
              Check again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleDiscard}
              className="h-7"
            >
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

      {!isFileOp && counts.total > 0 ? (
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
            Review hunks
            <span className="font-normal tabular-nums text-muted-foreground">
              {counts.decided}/{counts.total} decided · {counts.accepted}{" "}
              accepted · {counts.rejected} rejected
            </span>
            <span className="ml-auto font-normal text-muted-foreground">
              ↑ ↓ move · Alt+Enter accept · Alt+Shift+Enter reject · Ctrl+Z undo
            </span>
          </button>
          {reviewOpen ? (
            <div
              className="max-h-64 overflow-y-auto border-t border-border/40 py-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              tabIndex={0}
              role="listbox"
              onKeyDown={onReviewKeyDown}
              aria-label="Hunks review. Use arrow keys to move, Alt+Enter to accept, Alt+Shift+Enter to reject, Ctrl+Z to undo."
            >
              {changeSet.hunks.map((hunk, i) => {
                const decision = decisions.get(hunk.index) ?? "undecided";
                const accepted = decision === "accepted";
                const rejected = decision === "rejected";
                return (
                  <div
                    key={hunk.index}
                    ref={(el) => {
                      if (el) rowRefs.current.set(i, el);
                      else rowRefs.current.delete(i);
                    }}
                    tabIndex={-1}
                    role="option"
                    aria-selected={focusedHunk === i}
                    onFocus={() => focusHunk(i)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 border-l-2 px-3 py-1.5 font-mono text-[12px]",
                      accepted && "border-emerald-500/70 bg-emerald-500/8",
                      rejected && "border-rose-500/70 bg-rose-500/8",
                      !accepted && !rejected && "border-transparent",
                      focusedHunk === i &&
                        "bg-accent/50 ring-1 ring-inset ring-ring/60",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      Hunk {i + 1} · {labelForHunk(hunk)}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {accepted
                        ? "Accepted"
                        : rejected
                          ? "Rejected"
                          : "Undecided"}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant={accepted ? "default" : "ghost"}
                        disabled={!reviewable}
                        onClick={(e) => {
                          e.stopPropagation();
                          decideHunk(hunk.index, "accepted");
                        }}
                        className="h-6 px-2 text-[11px]"
                        title={
                          accepted
                            ? "Accepted, click to clear"
                            : "Accept this hunk"
                        }
                      >
                        Accept
                      </Button>
                      <Button
                        size="sm"
                        variant={rejected ? "default" : "ghost"}
                        disabled={!reviewable}
                        onClick={(e) => {
                          e.stopPropagation();
                          decideHunk(hunk.index, "rejected");
                        }}
                        className="h-6 px-2 text-[11px]"
                        title={
                          rejected
                            ? "Rejected, click to clear"
                            : "Reject this hunk"
                        }
                      >
                        Reject
                      </Button>
                    </span>
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
              Result preview · decided hunks highlighted
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
