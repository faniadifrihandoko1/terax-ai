import { useDiagnosticsStore } from "@/modules/editor";
import { cn } from "@/lib/utils";
import { useMemo } from "react";
import { diagnosticsForEntry } from "./lib/diagnosticsAggregate";
import {
  diagnosticsSeverityClass,
  useDiagnosticsSeverity,
} from "./lib/diagnosticsSeverity";

/**
 * Red error count (amber warning count when there are no errors) at
 * the end of an explorer row. Only open files report diagnostics, so
 * badges appear for open files and their ancestor folders. The color
 * comes from the same shared severity lookup as the row label
 * (Fase 19), so the number and the name always agree.
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
  const severity = useDiagnosticsSeverity(path, isDir);
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
        diagnosticsSeverityClass(severity),
      )}
    >
      {counts.errors > 0 ? counts.errors : counts.warnings}
    </span>
  );
}
