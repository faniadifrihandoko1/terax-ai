/**
 * Fase 2 contract for the new review-apply tool path (Opsi B, FR-03..FR-08).
 *
 * Why this exists: an AI SDK approval is a boolean and cannot carry edited
 * content. Answering an edit/write_file approval `true` writes the whole
 * proposed content, so per-line decisions cannot flow through the existing
 * tool. Fase 2 therefore adds a dedicated tool, `apply_reviewed_edit`,
 * whose input is the reconstructed file content the user actually accepted.
 *
 * Contract the tool must keep:
 * - Input carries the full reconstructed content, never a diff. The tool
 *   writes exactly that content, atomically, via native.writeFile (which
 *   already uses write_atomic on the Rust side).
 * - The original edit/write_file approval that produced the proposal is
 *   answered `false` first, so the existing tool never writes anything.
 * - Before writing, the tool re-reads the file and compares it with
 *   originalContent (FR-07 conflict guard). A mismatch means conflict,
 *   never a silent overwrite.
 * - One call applies one file. Per-line decisions live on the caller side
 *   (AiDiffPane + the review store) and are already folded into
 *   reconstructedContent before the call.
 *
 * This module only defines the contract. The tool itself, the line-decision
 * store, and the reconstruction function land in Fase 2.
 */

/** Per-line review decision, keyed by line number in the proposed content. */
export type LineDecision = "accepted" | "rejected" | "undecided";

export type LineDecisions = Map<number, LineDecision>;

/** Input for the future `apply_reviewed_edit` tool. */
export type ReviewApplyInput = {
  /** Approval id of the original edit/write_file call being reviewed. */
  approvalId: string;
  path: string;
  /** On-disk content the proposal was derived from (conflict baseline). */
  originalContent: string;
  /** Content after folding every accepted line decision in. */
  reconstructedContent: string;
};

export type ReviewApplyResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** True when every changed line has an accept or reject decision. */
export function allLinesDecided(
  decisions: LineDecisions,
  changedLines: number[],
): boolean {
  return changedLines.every((line) => {
    const d = decisions.get(line);
    return d === "accepted" || d === "rejected";
  });
}
