import { useDiagnosticsStore } from "@/modules/editor";
import { cn } from "@/lib/utils";
import { useMemo } from "react";
import { diagnosticsForEntry } from "./lib/diagnosticsAggregate";

/**
 * Red error count (amber warning count when there are no errors) at
 * the end of an explorer row. Only open files report diagnostics, so
 * badges appear for open files and their ancestor folders.
 */
export function DiagnosticsMark({
  path,
  isDir,
}: {
  path: string;
  isDir: boolean;
}) {
  const byPath = useDiagnosticsStore((s) => s.byPath);
  const counts = useMemo(
    () => diagnosticsForEntry(byPath, path, isDir),
    [byPath, path, isDir],
  );
  if (!counts) return null;
  const label =
    counts.errors > 0
      ? `${counts.errors} error${counts.errors === 1 ? "" : "s"}`
      : `${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`;
  return (
    <span
      title={label}
      className={cn(
        "shrink-0 text-[11px] font-medium tabular-nums",
        counts.errors > 0
          ? "text-destructive"
          : "text-amber-700 dark:text-amber-400",
      )}
    >
      {counts.errors > 0 ? counts.errors : counts.warnings}
    </span>
  );
}
