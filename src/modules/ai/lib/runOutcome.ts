/**
 * What the last agent run ended as — recorded from the AI SDK Chat
 * `onFinish` callback (Fase 9). The SDK distinguishes the three ways a
 * stream can end, but Terax used to throw that signal away: Stop was
 * indistinguishable from a clean finish, and a dropped connection
 * collapsed into a generic `status: "error"`.
 *
 * - "finished": the model ended the response normally.
 * - "stopped": the user pressed Stop (SDK `isAbort`).
 * - "interrupted": the request ended in a network error (SDK
 *   `isDisconnect` — a TypeError mentioning fetch/network).
 * - "error": any other provider/transport error (SDK `isError`).
 */
export type LastRunOutcome = "finished" | "stopped" | "interrupted" | "error";

export function resolveRunOutcome(flags: {
  isAbort: boolean;
  isDisconnect: boolean;
  isError: boolean;
}): LastRunOutcome {
  if (flags.isAbort) return "stopped";
  if (flags.isDisconnect) return "interrupted";
  if (flags.isError) return "error";
  return "finished";
}

/** Outcomes where the run did not finish on its own terms. */
export function isAbnormalOutcome(
  outcome: LastRunOutcome | null,
): outcome is "stopped" | "interrupted" | "error" {
  return outcome === "stopped" || outcome === "interrupted" || outcome === "error";
}

/** Short Indonesian label for UI copy. */
export function runOutcomeLabel(outcome: LastRunOutcome): string {
  switch (outcome) {
    case "stopped":
      return "dihentikan";
    case "interrupted":
      return "terputus karena koneksi";
    case "error":
      return "gagal";
    case "finished":
      return "selesai";
  }
}
