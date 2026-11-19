import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { AiDiffStatus } from "@/modules/tabs";
import { AI_DIFF_STATUS_BADGE } from "@/modules/tabs/lib/aiDiffStatus";
import { computeLineStats } from "@/modules/editor/lib/diffStats";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  File01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { UIMessagePart } from "ai";
import { memo, useEffect, useMemo, useState } from "react";
import {
  deriveProposed,
  extractFileMutation,
  readOriginal,
  resolveMutationPath,
  type FileMutation,
  type ToolPartLike,
} from "../lib/fileMutations";
import { getCheckpoint } from "../lib/reviewCheckpoint";
import { getPendingProposal } from "../lib/pendingProposals";
import {
  deriveTabLessStatus,
  pickRevertApprovalId,
} from "../lib/cardRevert";
import { useChatStore } from "../store/chatStore";

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

export type ChangedFileEntry = {
  key: string;
  path: string;
  approvalId: string | null;
  kind: "write_file" | "edit" | "multi_edit" | "delete_file" | "rename_file";
  /** Rename destination. Only set for rename_file entries. */
  targetPath?: string;
  editCount: number;
  /**
   * Every tool call behind this row, in message order. One entry per
   * part, except edit proposals for one file (Fase 6), which compose
   * into a single row — the row's stats chain all of them.
   */
  mutations: FileMutation[];
  status: AiDiffStatus;
  /**
   * Fase 28: whether an ai-diff tab exists for this row. The status
   * map is built from the tabs, so a missing entry means no tab — and
   * such a row must not claim "Pending" as if it were reviewable, nor
   * be offered to Accept all (there is nothing to confirm through).
   */
  hasTab: boolean;
};

type Props = {
  parts: AnyPart[];
  reviewStatusByApproval?: Map<string, AiDiffStatus>;
  /**
   * Opens the review for a file. The path is the resolved absolute path
   * of the file, so the handler can open the file in the editor as a
   * fallback when the ai-diff tab does not exist yet. The approval ids
   * are every mutation id behind the row (Fase 33): a composed row
   * chains several tool calls, and the rebuild must try them all.
   */
  onOpenFileDiff?: (
    approvalId: string,
    path: string,
    approvalIds?: string[],
  ) => void;
  /** Approval ids with a checkpoint, so their Restore button can show. */
  restorableApprovals?: ReadonlySet<string>;
  onRestoreFile?: (approvalId: string) => void;
  /**
   * Fase 35: revert one file from its checkpoint, in one click
   * (Antigravity-style "undo this change"). Receives the approval id
   * from `revertButtonFor`; the handler reports the result with toasts.
   */
  onRevertFile?: (approvalId: string) => void | Promise<void>;
  /**
   * Fase 20: confirm every file that still needs review, in one click
   * (Antigravity-style Accept all). Receives the approval ids from
   * `acceptAllApprovalIds`; the handler reports the result with toasts.
   */
  onAcceptAll?: (approvalIds: string[]) => void | Promise<void>;
};

/**
 * Approval ids the card's Accept all button confirms (Fase 20): files
 * that still need review (pending, reviewing, or done — decided but not
 * yet confirmed). Already-resolved files — applied, rejected, conflict,
 * restored — and rows without an approval id are never touched.
 */
export function acceptAllApprovalIds(
  entries: ChangedFileEntry[],
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.approvalId === null) continue;
    // Fase 28: a row without a review tab is not confirmable — the
    // old code offered it anyway, and the handler skipped it with a
    // toast claiming it was already done or rejected.
    if (!e.hasTab) continue;
    if (
      e.status !== "pending" &&
      e.status !== "reviewing" &&
      e.status !== "done"
    ) {
      continue;
    }
    out.push(e.approvalId);
  }
  return out;
}

/**
 * True status for card rows without a review tab (Fase 35). The
 * status map is built from the open tabs, so a tab-less row defaults
 * to "pending" — which lies for a confirmed file whose tab was
 * closed. The resolver reads the live sources (see
 * `deriveTabLessStatus` in cardRevert) and returns the corrected
 * status, or undefined to keep the row as-is. Rows with a tab are
 * never touched: the tab is the live source of truth for them.
 */
export function applyTabLessStatuses(
  entries: ChangedFileEntry[],
  resolve: (entry: ChangedFileEntry) => AiDiffStatus | undefined,
): ChangedFileEntry[] {
  return entries.map((e) => {
    if (e.hasTab) return e;
    const status = resolve(e);
    if (status === undefined || status === e.status) return e;
    return { ...e, status };
  });
}

/**
 * Approval id the Revert button runs under for one row (Fase 35), or
 * undefined when the row must not offer Revert. Only rows that still
 * need review (pending, reviewing, done) revert: applied rows keep
 * Restore, and resolved rows have nothing left to undo. The row id
 * comes first, then any other mutation id behind the row — a composed
 * row's checkpoint lives under the first write's id.
 */
export function revertButtonFor(
  entry: ChangedFileEntry,
  restorableApprovals: ReadonlySet<string> | undefined,
): string | undefined {
  if (
    entry.status !== "pending" &&
    entry.status !== "reviewing" &&
    entry.status !== "done"
  ) {
    return undefined;
  }
  if (restorableApprovals === undefined) return undefined;
  return pickRevertApprovalId(
    [entry.approvalId, ...entry.mutations.map((m) => m.approvalId)],
    restorableApprovals,
  );
}

/**
 * Antigravity-style "Changed Files" summary (FR-01) for one assistant
 * message: every file the agent proposed to change, with +added/-removed
 * and its per-file review status (FR-06). Clicking a file opens its
 * ai-diff tab (FR-02, Fase 20 — always the tab, whether inline review
 * is on or off, and whether the file was already reviewed). When the
 * ai-diff tab does not exist yet (the agent is still working), the
 * click still opens the file in the editor and says so with a toast,
 * instead of doing nothing.
 */
export const ChangedFilesCard = memo(function ChangedFilesCard({
  parts,
  reviewStatusByApproval,
  onOpenFileDiff,
  restorableApprovals,
  onRestoreFile,
  onRevertFile,
  onAcceptAll,
}: Props) {
  const live = useChatStore((s) => s.live);
  // Fase 35: rows without a review tab get their true status from the
  // live sources (registry = still pending, checkpoint without a
  // registry entry = confirmed) instead of the "pending" default —
  // otherwise a confirmed file whose tab was closed shows Pending
  // and its Restore button never appears. The lookup runs when the
  // props change, which is also when the registry or the checkpoints
  // change (a write, a confirm, a card action all re-render the card
  // through parts or the status map).
  const entries = useMemo(
    () =>
      applyTabLessStatuses(
        buildEntries(parts, reviewStatusByApproval),
        (entry) => {
          if (entry.approvalId === null) return undefined;
          const abs = resolveMutationPath(entry.path, live.getCwd());
          const status = deriveTabLessStatus({
            hasRegistryProposal: getPendingProposal(abs) !== undefined,
            checkpoint: getCheckpoint(entry.approvalId),
          });
          return status === entry.status ? undefined : status;
        },
      ),
    [parts, reviewStatusByApproval, live],
  );
  // Fase 20: the ids Accept all will confirm. Memoized so the button
  // only appears while there is actually something left to confirm.
  // Hooks stay above the early return below (Rules of Hooks).
  const pendingIds = useMemo(
    () => acceptAllApprovalIds(entries),
    [entries],
  );
  // While a run is in flight the button disables itself: the statuses
  // only flip to applied once the confirms land, so a second click
  // before that would re-confirm the same files.
  const [accepting, setAccepting] = useState(false);
  // Fase 35: the row being reverted, so its Revert button disables
  // itself until the handler settles — a second click would find the
  // checkpoint already consumed and report a confusing failure.
  const [revertingId, setRevertingId] = useState<string | null>(null);
  const handleRevert = (approvalId: string) => {
    if (!onRevertFile || revertingId !== null) return;
    setRevertingId(approvalId);
    void (async () => {
      try {
        await onRevertFile(approvalId);
      } catch {
        // The handler reports failures with toasts; the card only
        // needs to re-enable the button.
      } finally {
        setRevertingId(null);
      }
    })();
  };
  if (entries.length === 0) return null;

  const allResolved = entries.every((e) =>
    ["applied", "rejected", "conflict", "restored"].includes(e.status),
  );
  const handleAcceptAll = () => {
    if (!onAcceptAll || accepting || pendingIds.length === 0) return;
    setAccepting(true);
    void (async () => {
      try {
        await onAcceptAll(pendingIds);
      } catch {
        // The handler reports failures with toasts; the card only
        // needs to re-enable the button.
      } finally {
        setAccepting(false);
      }
    })();
  };

  return (
    <Collapsible className="group/changes overflow-hidden rounded-md border border-border/50 bg-card/50">
      <div className="flex items-center gap-1 pr-1">
        <CollapsibleTrigger
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[12px]",
            "transition-colors hover:bg-muted/50",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          size={11}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            "group-data-[state=open]/changes:rotate-90",
          )}
        />
        <HugeiconsIcon
          icon={File01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">Changed</span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {entries.length} file{entries.length === 1 ? "" : "s"}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80 group-data-[state=open]/changes:invisible">
          · {entries.map((e) => basename(e.path)).join(", ")}
        </span>
        <Badge
          variant={allResolved ? "secondary" : "outline"}
          className="shrink-0 text-[10.5px]"
        >
          {allResolved ? "Selesai" : "Perlu review"}
        </Badge>
        </CollapsibleTrigger>
        {pendingIds.length > 0 && onAcceptAll ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={handleAcceptAll}
            disabled={accepting}
            className="h-7 shrink-0 gap-1"
            title="Confirm every file that still needs review"
          >
            <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
            {accepting ? "Confirming…" : "Accept all"}
          </Button>
        ) : null}
      </div>
      <CollapsibleContent className="terax-collapsible-content border-t border-border/30">
        <ul className="flex flex-col gap-0.5 px-2 py-1.5">
          {entries.map((entry) => (
            <ChangedFileRow
              key={entry.key}
              entry={entry}
              onOpenFileDiff={onOpenFileDiff}
              restorable={
                entry.approvalId !== null &&
                entry.status === "applied" &&
                restorableApprovals?.has(entry.approvalId)
              }
              onRestoreFile={onRestoreFile}
              revertId={revertButtonFor(entry, restorableApprovals)}
              onRevertFile={onRevertFile ? handleRevert : undefined}
              reverting={
                revertingId !== null &&
                revertButtonFor(entry, restorableApprovals) === revertingId
              }
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
});

const ChangedFileRow = memo(function ChangedFileRow({
  entry,
  onOpenFileDiff,
  restorable,
  onRestoreFile,
  revertId,
  onRevertFile,
  reverting,
}: {
  entry: ChangedFileEntry;
  onOpenFileDiff?: (
    approvalId: string,
    path: string,
    approvalIds?: string[],
  ) => void;
  restorable?: boolean;
  onRestoreFile?: (approvalId: string) => void;
  /** Approval id the Revert button runs under, if the row is revertible. */
  revertId?: string;
  onRevertFile?: (approvalId: string) => void;
  reverting?: boolean;
}) {
  const { stats, failed } = useChangedFileStats(entry);
  const live = useChatStore((s) => s.live);
  // Absolute path of the file, for the editor fallback when the ai-diff
  // tab does not exist yet. Resolved the same way as the stats above.
  const absPath = useMemo(
    () => resolveMutationPath(entry.path, live.getCwd()),
    [entry.path, live],
  );
  const clickable = entry.approvalId !== null && onOpenFileDiff !== undefined;
  const isFileOp =
    entry.kind === "delete_file" || entry.kind === "rename_file";
  const row = (
    <>
      <HugeiconsIcon
        icon={File01Icon}
        size={10}
        strokeWidth={1.75}
        className="shrink-0 opacity-60"
      />
      <span className="truncate font-medium text-foreground">
        {entry.kind === "rename_file" && entry.targetPath
          ? `${basename(entry.path)} → ${basename(entry.targetPath)}`
          : basename(entry.path)}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground opacity-60">
        {entry.kind === "rename_file" && entry.targetPath
          ? `${entry.path} → ${entry.targetPath}`
          : entry.path}
      </span>
      {!isFileOp && entry.kind !== "write_file" ? (
        <span className="shrink-0 text-[10.5px] text-muted-foreground">
          {entry.editCount} edit{entry.editCount === 1 ? "" : "s"}
        </span>
      ) : null}
      {entry.kind === "delete_file" ? (
        <span className="shrink-0 rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
          Deleted
        </span>
      ) : null}
      {entry.kind === "rename_file" ? (
        <span className="shrink-0 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
          Renamed
        </span>
      ) : null}
      {stats?.isNewFile && entry.kind !== "delete_file" ? (
        <span className="shrink-0 rounded-full border border-border/60 bg-accent/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          New file
        </span>
      ) : null}
      {stats && !failed ? (
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{stats.added}
          </span>
          <span className="text-rose-600 dark:text-rose-400">
            −{stats.removed}
          </span>
        </span>
      ) : (
        <span className="shrink-0 text-[10.5px] text-muted-foreground">
          …
        </span>
      )}
      <Badge
        variant={AI_DIFF_STATUS_BADGE[entry.status]}
        className="shrink-0 text-[10.5px]"
        title={
          entry.hasTab
            ? undefined
            : "Tab review belum terbentuk untuk file ini — klik baris untuk membukanya kembali bila bisa, atau buka file di editor."
        }
      >
        {entry.hasTab ? statusShortLabel(entry.status) : "Tanpa tab"}
      </Badge>
    </>
  );
  const restoreButton =
    restorable && entry.approvalId !== null && onRestoreFile ? (
      <button
        type="button"
        onClick={() => onRestoreFile(entry.approvalId as string)}
        title="Undo this apply: write back the content from before it"
        className="shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        Restore
      </button>
    ) : null;
  // Fase 35: one-click revert for a file that still needs review —
  // reject all hunks and write the file back to before the agent
  // change, through the same checkpoint restore the tab uses. Only
  // shown while a checkpoint exists for the row (no checkpoint, no
  // button); resolved rows never show it, applied rows keep Restore.
  const revertButton =
    revertId !== undefined && onRevertFile ? (
      <button
        type="button"
        disabled={reverting}
        onClick={() => onRevertFile(revertId)}
        title="Reject all hunks and restore the file to before the agent change"
        className="shrink-0 rounded-md border border-border/60 px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
      >
        {reverting ? "Reverting…" : "Revert"}
      </button>
    ) : null;

  if (!clickable) {
    return (
      <li className="flex items-center gap-1.5 rounded-md px-1 py-1 font-mono text-[11px] text-muted-foreground">
        {row}
        {restoreButton}
        {revertButton}
      </li>
    );
  }
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={() =>
          onOpenFileDiff(
            entry.approvalId as string,
            absPath,
            entry.mutations
              .map((m) => m.approvalId)
              .filter((id): id is string => id !== null),
          )
        }
        title={`Review ${entry.path}`}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left font-mono text-[11px] text-muted-foreground",
          "transition-colors hover:bg-muted/50",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
      >
        {row}
      </button>
      {restoreButton}
      {revertButton}
    </li>
  );
});

function statusShortLabel(status: AiDiffStatus): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "reviewing":
      return "Reviewing";
    case "done":
      return "Selesai";
    case "applied":
      return "Dikonfirmasi";
    case "rejected":
      return "Ditolak";
    case "conflict":
      return "Konflik";
    case "restored":
      return "Dipulihkan";
  }
}

/**
 * Stats for one changed file. Fase 8 (write-first): the disk already
 * holds the new content, so the baseline comes from the written
 * baseline — the registry while the run is live, the checkpoint after
 * a restore or a confirm — and only legacy pre-Fase-8 proposals still
 * derive from disk. While it loads the row shows an ellipsis.
 */
function useChangedFileStats(entry: ChangedFileEntry) {
  const [stats, setStats] = useState<{
    added: number;
    removed: number;
    isNewFile: boolean;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const live = useChatStore((s) => s.live);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setFailed(false);
    void (async () => {
      const abs = resolveMutationPath(entry.path, live.getCwd());
      // The registry is the live source of truth: the first write for
      // the path set the baseline, later writes only advanced the
      // written content.
      const registry = getPendingProposal(abs);
      if (registry) {
        setStats({
          ...computeLineStats(
            registry.originalContent,
            registry.proposedContent,
          ),
          isNewFile: registry.isNewFile,
        });
        return;
      }
      // Restored or confirmed: the checkpoint holds the reviewed
      // baseline and the final content (null after-content = deleted).
      if (entry.approvalId) {
        const cp = getCheckpoint(entry.approvalId);
        if (cp) {
          setStats({
            ...computeLineStats(cp.contentBefore, cp.contentAfter ?? ""),
            // A checkpoint has no isNewFile flag; a baseline of "" means
            // the agent created the file (an empty file edited to
            // non-empty mislabels, rare enough to accept).
            isNewFile: cp.kind === "edit" && cp.contentBefore === "",
          });
          return;
        }
      }
      // Legacy (pre-Fase-8): the agent never wrote, so the on-disk
      // content is still the original and the proposal derives from it.
      const original = await readOriginal(abs);
      if (cancelled) return;
      let content = original.content;
      let isNewFile = original.isNewFile;
      // An applied rename leaves nothing at the old path either; the
      // content now lives at the target.
      if (entry.kind === "rename_file" && entry.targetPath) {
        const target = await readOriginal(
          resolveMutationPath(entry.targetPath, live.getCwd()),
        );
        if (cancelled) return;
        if (!target.isNewFile) {
          content = target.content;
          isNewFile = false;
        }
      }
      // Fase 6: a composed proposal chains every mutation for the path,
      // in message order — the same derivation the bridge uses for the
      // tab, so the row's +/− counts match the accumulated diff.
      let proposed = content;
      let ok = true;
      for (const m of entry.mutations) {
        const r = deriveProposed(proposed, m.derive);
        if (!r.ok) {
          ok = false;
          break;
        }
        proposed = r.content;
      }
      if (!ok) {
        setFailed(true);
        return;
      }
      setStats({
        ...computeLineStats(content, proposed),
        isNewFile,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    entry.path,
    entry.kind,
    entry.targetPath,
    entry.approvalId,
    entry.mutations,
    live,
  ]);

  return { stats, failed };
}

export function buildEntries(
  parts: AnyPart[],
  reviewStatusByApproval?: Map<string, AiDiffStatus>,
): ChangedFileEntry[] {
  const seen = new Set<string>();
  const out: ChangedFileEntry[] = [];
  // Fase 6: edit proposals for one file compose into a single review tab,
  // so the card shows one row per file for them (first proposal's id and
  // status, edit counts summed). Delete/rename proposals never compose,
  // so each keeps its own row.
  const composedByPath = new Map<string, ChangedFileEntry>();
  for (const p of parts) {
    const mutation = extractFileMutation(p as unknown as ToolPartLike);
    if (!mutation) continue;
    const key = mutation.approvalId ?? `path:${mutation.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const type = (p as { type?: string }).type ?? "";
    const kind =
      type === "tool-write_file"
        ? "write_file"
        : type === "tool-edit"
          ? "edit"
          : type === "tool-multi_edit"
            ? "multi_edit"
            : type === "tool-delete_file"
              ? "delete_file"
              : "rename_file";
    const editCount =
      mutation.derive.kind === "edits" ? mutation.derive.edits.length : 1;
    const composable =
      kind === "edit" || kind === "multi_edit" || kind === "write_file";
    if (composable) {
      const existing = composedByPath.get(mutation.path);
      if (existing) {
        existing.editCount += editCount;
        existing.mutations.push(mutation);
        continue;
      }
    }
    const entry: ChangedFileEntry = {
      key,
      path: mutation.path,
      approvalId: mutation.approvalId,
      kind,
      ...(mutation.derive.kind === "rename"
        ? { targetPath: mutation.derive.to }
        : {}),
      editCount,
      mutations: [mutation],
      status: mutation.approvalId
        ? (reviewStatusByApproval?.get(mutation.approvalId) ?? "pending")
        : "pending",
      hasTab:
        mutation.approvalId !== null &&
        (reviewStatusByApproval?.has(mutation.approvalId) ?? false),
    };
    if (composable) composedByPath.set(mutation.path, entry);
    out.push(entry);
  }
  // Fase 28: a composed row acts on the latest proposal that actually
  // has a review tab. The bridge opens a second tab when the first
  // cannot absorb a newer proposal (it is already being reviewed), so
  // the first id would point Accept all and the row click at stale
  // content while the newest change hides in a tab the card never
  // references. When no mutation has a tab, the row keeps the first
  // id and reports hasTab false.
  for (const e of out) {
    const tabbed = [...e.mutations].reverse().find(
      (m) =>
        m.approvalId !== null &&
        (reviewStatusByApproval?.has(m.approvalId) ?? false),
    );
    if (tabbed?.approvalId) {
      e.approvalId = tabbed.approvalId;
      e.status = reviewStatusByApproval?.get(tabbed.approvalId) ?? "pending";
    }
    e.hasTab =
      e.approvalId !== null &&
      (reviewStatusByApproval?.has(e.approvalId) ?? false);
  }
  return out;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
