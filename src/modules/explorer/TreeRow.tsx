import { cn } from "@/lib/utils";
import { isPrimaryModifierPressed } from "@/lib/platform";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo } from "react";
import { DiagnosticsMark } from "./DiagnosticsMark";
import { InlineInput } from "./InlineInput";
import {
  diagnosticsSeverityClass,
  useDiagnosticsSeverity,
} from "./lib/diagnosticsSeverity";
import { explorerGitTextClass } from "./lib/gitStatusColor";
import type { GitStatusCode } from "./lib/gitStatusUtils";
import { FileIcon, FolderIcon } from "./FileIcon";

export type SelectModifiers = { shift: boolean; mod: boolean };

export type RowActions = {
  toggle: (path: string) => void;
  beginRename: (path: string) => void;
  commitRename: (newName: string) => void | Promise<void>;
  cancelRename: () => void;
};

export type EntryRowProps = {
  path: string;
  name: string;
  isDir: boolean;
  isExpanded: boolean;
  depth: number;
  actions: RowActions;
  renameInProgress: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  isDropTarget?: boolean;
  /** True when more than one row is selected: rename doesn't generalize to
   * a batch, so double-click-to-rename is disabled while it's active. */
  multiSelectActive?: boolean;
  onOpenFile: (path: string, pin?: boolean) => void;
  onSelectPath: (path: string, modifiers: SelectModifiers) => void;
  gitStatusCode?: GitStatusCode | null;
  gitignored?: boolean;
};

function EntryRowImpl(props: EntryRowProps) {
  const {
    path,
    name,
    isDir,
    isExpanded,
    depth,
    actions,
    renameInProgress,
    isSelected,
    isRenaming,
    isDropTarget = false,
    multiSelectActive = false,
    onOpenFile,
    onSelectPath,
    gitStatusCode,
    gitignored = false,
  } = props;

  const paddingLeft = 6 + depth * 12;
  // Fase 19: worst diagnostics severity for this entry (exact file,
  // worst child for a folder) — shared with the count badge, so the
  // label color and the number can never disagree.
  const severity = useDiagnosticsSeverity(path, isDir);

  if (isRenaming) {
    return (
      <div
        className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
        style={{ paddingLeft }}
      >
        <span className="size-3.5 shrink-0" />
        {isDir ? (
          <FolderIcon
            name={name}
            expanded={isExpanded}
            className="size-4 shrink-0"
          />
        ) : (
          <FileIcon name={name} className="size-4 shrink-0" />
        )}
        <InlineInput
          initial={name}
          onCommit={actions.commitRename}
          onCancel={actions.cancelRename}
        />
      </div>
    );
  }

  const handleClick = (e: React.MouseEvent) => {
    if (renameInProgress) return;
    const shift = e.shiftKey;
    const mod = isPrimaryModifierPressed(e);
    if (shift || mod) {
      e.preventDefault();
      onSelectPath(path, { shift, mod });
      return;
    }
    onSelectPath(path, { shift: false, mod: false });
    if (isDir) actions.toggle(path);
    else onOpenFile(path);
  };

  return (
    <button
      type="button"
      data-fs-path={path}
      onClick={handleClick}
      onDoubleClick={() =>
        !isDir && !multiSelectActive && actions.beginRename(path)
      }
      className={cn(
        "group flex h-6 w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 text-left text-[13px] transition-colors hover:bg-accent/70",
        isSelected
          ? "bg-accent text-foreground"
          : gitignored
            ? "text-muted-foreground/70"
            : "text-foreground/85",
        isDropTarget && "bg-primary/10 ring-1 ring-inset ring-primary/60",
      )}
      style={{ paddingLeft }}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {isDir ? (
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2.25}
            className={cn("transition-transform", isExpanded && "rotate-90")}
          />
        ) : null}
      </span>
      {isDir ? (
        <FolderIcon
          name={name}
          expanded={isExpanded}
          className="size-4 shrink-0"
        />
      ) : (
        <FileIcon name={name} className="size-4 shrink-0" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          // Fase 19: diagnostics color wins over the git status color
          // (error > warning), so an errored file is red even when it
          // is also modified. Gitignored rows keep their muted color.
          // The color also applies on the selected row: the span's own
          // class overrides the button's inherited text-foreground,
          // and red/amber stay readable on the accent background.
          !gitignored && diagnosticsSeverityClass(severity),
          !isSelected &&
            !gitignored &&
            !severity &&
            gitStatusCode &&
            explorerGitTextClass(gitStatusCode),
        )}
      >
        {name}
      </span>
      <DiagnosticsMark path={path} isDir={isDir} />
    </button>
  );
}

export const EntryRow = memo(EntryRowImpl);

export type PendingRowProps = {
  depth: number;
  kind: "file" | "dir";
  onCommit: (name: string) => void | Promise<void>;
  onCancel: () => void;
};

export function PendingRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: PendingRowProps) {
  return (
    <div
      className="flex h-6 w-full min-w-0 items-center gap-2 px-1.5 text-[13px]"
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <span className="size-3.5 shrink-0" />
      {kind === "dir" ? (
        <FolderIcon name="" className="size-4 shrink-0 opacity-70" />
      ) : (
        <FileIcon name="untitled" className="size-4 shrink-0 opacity-70" />
      )}
      <InlineInput
        initial=""
        placeholder={kind === "dir" ? "New folder" : "New file"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function StatusRow({
  depth,
  message,
  tone,
}: {
  depth: number;
  message: string;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={cn(
        "h-6 truncate px-2 text-[11px] leading-6",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
      style={{ paddingLeft: 6 + depth * 12 + 18 }}
    >
      {message}
    </div>
  );
}
