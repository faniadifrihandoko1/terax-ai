import { cn } from "@/lib/utils";

/**
 * Pending-review dot at the end of an explorer row (Fase 34): the file
 * itself has an AI change waiting for review, or — for a folder — one
 * of its descendants does. Mirrors DiagnosticsMark: the dot is only a
 * marker, the review itself opens from the row click or the context
 * menu. Primary color on purpose: red/amber belong to diagnostics.
 */
export function PendingReviewMark({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      title="Pending AI review — click to review"
      className={cn("size-1.5 shrink-0 rounded-full bg-primary")}
    />
  );
}
