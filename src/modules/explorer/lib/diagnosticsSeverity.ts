import { useDiagnosticsStore } from "@/modules/editor";
import { useMemo } from "react";
import type { DiagnosticCounts } from "./diagnosticsAggregate";
import { diagnosticsForEntry } from "./diagnosticsAggregate";

export type DiagnosticsSeverity = "error" | "warning";

/**
 * Most severe level for a counts object: one error beats any number
 * of warnings. Null when there is nothing to show.
 */
export function severityForCounts(
  counts: DiagnosticCounts | null,
): DiagnosticsSeverity | null {
  if (!counts) return null;
  if (counts.errors > 0) return "error";
  if (counts.warnings > 0) return "warning";
  return null;
}

/**
 * Label text color for a severity — the same red/amber the count
 * badge (DiagnosticsMark) already uses, so the number and the name
 * always agree. Undefined when there is nothing to show.
 */
export function diagnosticsSeverityClass(
  severity: DiagnosticsSeverity | null,
): string | undefined {
  if (severity === "error") return "text-destructive";
  if (severity === "warning") return "text-amber-700 dark:text-amber-400";
  return undefined;
}

/**
 * Shared store lookup for one explorer entry: the exact file for a
 * file row, the worst severity underneath for a folder row (via
 * diagnosticsForEntry). Used by both the count badge and the row
 * label, so they can never disagree about an entry's severity.
 */
export function useDiagnosticsSeverity(
  path: string,
  isDir: boolean,
): DiagnosticsSeverity | null {
  const byPath = useDiagnosticsStore((s) => s.byPath);
  return useMemo(
    () => severityForCounts(diagnosticsForEntry(byPath, path, isDir)),
    [byPath, path, isDir],
  );
}
