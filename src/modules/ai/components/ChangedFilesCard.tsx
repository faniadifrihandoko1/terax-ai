import { Badge } from "@/components/ui/badge";
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
import { ArrowRight01Icon, File01Icon } from "@hugeicons/core-free-icons";
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
};

type Props = {
  parts: AnyPart[];
  reviewStatusByApproval?: Map<string, AiDiffStatus>;
  /**
   * Opens the review for a file. The path is the resolved absolute path
   * of the file, so the handler can open the file in the editor as a
   * fallback when the ai-diff tab does not exist yet.
   */
  onOpenFileDiff?: (approvalId: string, path: string) => void;
  /** Approval ids with a checkpoint, so their Restore button can show. */
  restorableApprovals?: ReadonlySet<string>;
  onRestoreFile?: (approvalId: string) => void;
};

/**
 * Antigravity-style "Changed Files" summary (FR-01) for one assistant
 * message: every file the agent proposed to change, with +added/-removed
 * and its per-file review status (FR-06). Clicking a file opens its
 * ai-diff tab (FR-02), or the file in the editor when inline review is
 * on. When the ai-diff tab does not exist yet (the agent is still
 * working), the click still opens the file in the editor and says so
 * with a toast, instead of doing nothing.
 */
export const ChangedFilesCard = memo(function ChangedFilesCard({
  parts,
  reviewStatusByApproval,
  onOpenFileDiff,
  restorableApprovals,
  onRestoreFile,
}: Props) {
  const entries = useMemo(
    () => buildEntries(parts, reviewStatusByApproval),
    [parts, reviewStatusByApproval],
  );
  if (entries.length === 0) return null;

  const allResolved = entries.every((e) =>
    ["applied", "rejected", "conflict", "restored"].includes(e.status),
  );

  return (
    <Collapsible className="group/changes overflow-hidden rounded-md border border-border/50 bg-card/50">
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12px]",
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
}: {
  entry: ChangedFileEntry;
  onOpenFileDiff?: (approvalId: string, path: string) => void;
  restorable?: boolean;
  onRestoreFile?: (approvalId: string) => void;
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
      >
        {statusShortLabel(entry.status)}
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

  if (!clickable) {
    return (
      <li className="flex items-center gap-1.5 rounded-md px-1 py-1 font-mono text-[11px] text-muted-foreground">
        {row}
        {restoreButton}
      </li>
    );
  }
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onOpenFileDiff(entry.approvalId as string, absPath)}
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
 * Stats for one proposed change, derived with the same shared functions
 * AgentRunBridge uses to open the diff tab. Reads the on-disk original
 * once; while it loads the row shows an ellipsis.
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
      const original = await readOriginal(abs);
      if (cancelled) return;
      let content = original.content;
      let isNewFile = original.isNewFile;
      // An applied delete leaves nothing on disk at the old path; the
      // checkpoint still holds what was removed, so stats come from it.
      if (entry.kind === "delete_file" && entry.approvalId) {
        const cp = getCheckpoint(entry.approvalId);
        if (cp && cp.kind === "delete") {
          content = cp.contentBefore;
          isNewFile = false;
        }
      }
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
    };
    if (composable) composedByPath.set(mutation.path, entry);
    out.push(entry);
  }
  return out;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
