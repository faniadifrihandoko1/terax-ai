import { cn } from "@/lib/utils";
import {
  Alert02Icon,
  CancelCircleIcon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { eslintPathKey } from "../lib/eslintPaths";
import {
  relativeProjectPath,
  type EslintProjectLintFile,
} from "../lib/eslintProjectLint";
import { useEslintStore } from "../lib/eslintStore";
import { describeEslintProjectLintStatus } from "../lib/eslintStatusText";

type Props = {
  /** Current project root (the explorer root), or null when none is open. */
  root: string | null;
  /** Opens the file in the editor at the given 1-based line. */
  onOpenFile: (path: string, line: number) => void;
  /** Starts a project-wide lint run for the current root. */
  onRunProjectLint: () => void;
};

function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => eslintPathKey(p).replace(/\/+$/, "");
  return norm(a) === norm(b);
}

function countsText(file: EslintProjectLintFile): string {
  const parts: string[] = [];
  if (file.errors > 0)
    parts.push(`${file.errors} error${file.errors === 1 ? "" : "s"}`);
  if (file.warnings > 0)
    parts.push(`${file.warnings} warning${file.warnings === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * Sidebar "Problems" view: the last project-wide ESLint snapshot,
 * grouped by file and sorted by path then line. A row click opens
 * the file in the editor at the reported line (`gotoLine` is
 * 1-based, like ESLint positions). The snapshot survives closing
 * and reopening the view; it is replaced only by the next run, so
 * it can go stale when files change — the header re-run button
 * refreshes it.
 */
export function EslintProblemsPanel({
  root,
  onOpenFile,
  onRunProjectLint,
}: Props) {
  const projectLint = useEslintStore((s) => s.projectLint);
  const status = projectLint.status;
  const text = describeEslintProjectLintStatus(status);
  const running = status.kind === "running";
  const stale =
    root !== null &&
    status.kind !== "idle" &&
    status.kind !== "running" &&
    !sameRoot(status.root, root);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-[11px] font-semibold">Problems</span>
        {status.kind === "ok" && (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[11px] tabular-nums",
              status.errors > 0
                ? "text-destructive"
                : status.warnings > 0
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-emerald-700 dark:text-emerald-400",
            )}
          >
            {text.label}
          </span>
        )}
        {status.kind !== "ok" && <span className="flex-1" />}
        <button
          type="button"
          onClick={onRunProjectLint}
          disabled={running}
          aria-label="Jalankan ulang lint project"
          title="Jalankan ulang lint project"
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-default disabled:opacity-40"
        >
          <HugeiconsIcon
            icon={running ? Loading03Icon : RefreshIcon}
            size={13}
            strokeWidth={2}
            className={running ? "animate-spin" : undefined}
          />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status.kind === "idle" && (
          <PanelEmpty
            title="Belum ada hasil lint project"
            detail={text.detail}
            actionLabel="Jalankan lint project"
            onAction={onRunProjectLint}
          />
        )}
        {running && (
          <PanelEmpty
            title="Memeriksa seluruh project…"
            detail="ESLint sedang memeriksa semua file. Hasilnya muncul di sini saat run selesai."
          />
        )}
        {stale && (
          <PanelEmpty
            title="Hasil ini untuk project lain"
            detail="Project yang terbuka sudah berganti sejak run terakhir. Jalankan lint lagi untuk project ini."
            actionLabel="Jalankan lint project"
            onAction={onRunProjectLint}
          />
        )}
        {!running &&
          !stale &&
          (status.kind === "failed" ||
            status.kind === "timeout" ||
            status.kind === "missing-binary" ||
            status.kind === "missing-config" ||
            status.kind === "truncated") && (
            <PanelEmpty
              title={text.label}
              detail={text.detail}
              actionLabel="Coba lagi"
              onAction={onRunProjectLint}
            />
          )}
        {status.kind === "ok" && projectLint.files.length === 0 && (
          <PanelEmpty
            title="Tidak ada masalah ESLint di project ini"
            detail="Run terakhir tidak menemukan error atau warning."
          />
        )}
        {status.kind === "ok" &&
          projectLint.files.map((file) => (
            <div key={eslintPathKey(file.path)}>
              <div className="flex items-baseline gap-2 px-3 pb-1 pt-2">
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                  {relativeProjectPath(root ?? "", file.path)}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-[10.5px] tabular-nums",
                    file.errors > 0
                      ? "text-destructive"
                      : "text-amber-700 dark:text-amber-400",
                  )}
                >
                  {countsText(file)}
                </span>
              </div>
              {file.messages.map((message, index) => (
                <button
                  // A file can hold two identical messages on
                  // different lines; the index keeps keys unique.
                  key={`${message.line}:${message.column}:${index}`}
                  type="button"
                  onClick={() => onOpenFile(file.path, message.line)}
                  title={`${file.path}:${message.line}:${message.column}`}
                  className="flex w-full cursor-pointer items-start gap-1.5 px-3 py-1 text-left text-[11px] outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60"
                >
                  <HugeiconsIcon
                    icon={
                      message.severity === 2 ? CancelCircleIcon : Alert02Icon
                    }
                    size={12}
                    strokeWidth={2}
                    className={cn(
                      "mt-px shrink-0",
                      message.severity === 2
                        ? "text-destructive"
                        : "text-amber-700 dark:text-amber-400",
                    )}
                  />
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {message.line}:{message.column}
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    {message.message}
                    {message.ruleId ? (
                      <span className="text-muted-foreground">
                        {" "}
                        ({message.ruleId})
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ))}
      </div>
    </div>
  );
}

function PanelEmpty({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-4">
      <span className="text-[11px] font-medium">{title}</span>
      <span className="text-[11px] leading-relaxed text-muted-foreground">
        {detail}
      </span>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-1 cursor-pointer rounded-md border border-border/60 bg-accent/50 px-2.5 py-1 text-[11px] font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
