/**
 * Why one file was skipped by Accept all (Fase 28).
 *
 * Before Fase 28 the handler lumped every skip together and reported
 * "Semua file sudah selesai atau sudah ditolak" — which was false
 * whenever the real reason was a missing review tab. The card shows
 * such a file as "Pending" (its default when no tab exists), so the
 * toast contradicted the card on screen. Each skip now carries its
 * reason, and the toast reports the actual reasons.
 */
export type AcceptAllSkipReason =
  /** No ai-diff tab exists for the approval (yet, or anymore). */
  | "missing-tab"
  /** The tab is already applied / rejected / conflict / restored. */
  | "already-resolved"
  /** The tab's original and proposed content are identical. */
  | "no-changes"
  /** A delete/rename the user already rejected in its tab. */
  | "file-rejected";

export const ACCEPT_ALL_SKIP_LABEL: Record<AcceptAllSkipReason, string> = {
  "missing-tab": "tab review belum ada",
  "already-resolved": "sudah selesai/ditolak",
  "no-changes": "tidak ada perubahan",
  "file-rejected": "sudah ditolak — konfirmasi dari tab-nya",
};

/**
 * One-line breakdown of skipped files for the Accept-all toast, e.g.
 * "Dilewati: tab review belum ada (2), sudah selesai/ditolak (1)".
 * Reasons are grouped in first-seen order. Undefined when nothing
 * was skipped.
 */
export function describeAcceptAllSkips(
  skipped: readonly { reason: AcceptAllSkipReason }[],
): string | undefined {
  if (skipped.length === 0) return undefined;
  const counts = new Map<AcceptAllSkipReason, number>();
  for (const s of skipped) {
    counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(
    ([reason, n]) => `${ACCEPT_ALL_SKIP_LABEL[reason]} (${n})`,
  );
  return `Dilewati: ${parts.join(", ")}`;
}
