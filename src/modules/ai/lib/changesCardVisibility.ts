/**
 * Fase 7: the Changed Files card only appears once the run that produced
 * a message is over.
 *
 * Before Fase 7 the card rendered as soon as the first file proposal
 * landed, so mid-run the chat showed "Perlu review" while the agent was
 * still working through its todos. Review is an end-of-run activity, so
 * the card stays hidden while the run that produced the message is still
 * active, and appears when that run is done — finished, errored, stopped,
 * or cut off by the step cap.
 *
 * A run is still active for a message when either:
 * - the message is the one currently streaming (`streaming`), or
 * - the message holds a part waiting on a terminal-command approval
 *   (`state === "approval-requested"`). The approval wait needs its own
 *   check: while the stream is suspended for approval the chat status is
 *   "ready" (the SDK only auto-resends after an approval answer when the
 *   status is neither "streaming" nor "submitted"), so `streaming` alone
 *   would let the card appear mid-run.
 *
 * This is deliberately per-message, not global: an older turn's card must
 * stay visible while the agent works on a new task. Reviews restored from
 * a previous session have no streaming flag and no approval-requested
 * parts, so they always show.
 *
 * Corner case, kept on purpose: if the user stops the run while a bash
 * approval is still outstanding, the `approval-requested` part stays in
 * the message, so the card stays hidden until the approval is answered
 * (Approve/Deny lets the run conclude and the card appears). Nothing is
 * lost in the meantime — the ai-diff tabs already exist in the background
 * and the approval card itself stays visible.
 */
type PartWithState = {
  readonly state?: unknown;
};

function isApprovalRequested(part: unknown): boolean {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as PartWithState).state === "approval-requested"
  );
}

export function shouldShowChangesCard(
  parts: readonly unknown[],
  streaming: boolean,
): boolean {
  if (streaming) return false;
  for (const part of parts) {
    if (isApprovalRequested(part)) return false;
  }
  return true;
}
