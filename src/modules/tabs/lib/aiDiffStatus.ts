import type { AiDiffStatus } from "./useTabs";

/**
 * Display strings for AiDiffStatus, shared by the AI diff pane header and
 * the Changed Files card (FR-06) so both surfaces show the same status.
 */
export const AI_DIFF_STATUS_LABEL: Record<AiDiffStatus, string> = {
  pending: "Pending review",
  reviewing: "Reviewing",
  done: "Reviewed",
  applied: "Applied",
  rejected: "Rejected",
  conflict: "Conflict",
  restored: "Restored",
};

export const AI_DIFF_STATUS_BADGE: Record<
  AiDiffStatus,
  "outline" | "secondary" | "destructive"
> = {
  pending: "outline",
  reviewing: "secondary",
  done: "secondary",
  applied: "secondary",
  rejected: "destructive",
  conflict: "destructive",
  restored: "secondary",
};
