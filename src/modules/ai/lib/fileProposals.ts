import {
  extractFileMutation,
  type FileMutation,
  type ToolPartLike,
} from "./fileMutations";

/** One file proposal found in the chat messages, ready for a review tab. */
export type PendingFileProposal = {
  /** Proposal key: the tool call id (Fase 6) or a legacy approval id. */
  proposalId: string;
  /** Path as the model passed it. */
  path: string;
  derive: FileMutation["derive"];
  mutationKind: "edit" | "delete" | "rename";
  /** Rename destination. Only set for rename proposals. */
  targetPath?: string;
  /**
   * Canonical absolute path from the tool result, when the tool call
   * finished (Fase 6). The execute returns the canonical path it
   * proposed for, which is the key the pending-proposal registry uses.
   */
  resultPath?: string;
};

function outputHasError(part: ToolPartLike): boolean {
  const output = part.output;
  return (
    output !== null &&
    typeof output === "object" &&
    "error" in output &&
    (output as { error?: unknown }).error !== undefined
  );
}

/**
 * Picks the file-mutation tool parts that need a review tab and have not
 * opened one yet.
 *
 * Fase 6: file tools are not approval-gated, so a proposal is ready once
 * its tool call finished (`output-available`) without an error — the
 * execute only recorded the proposal, it wrote nothing. `approval-requested`
 * is still accepted for legacy parts recorded before Fase 6, when the
 * tool call was approval-gated and the approval was never answered
 * (e.g. the app was closed mid-approval). `input-available` is skipped:
 * the execute has not run yet, so there is no proposal to show — the
 * fingerprint changes again when the output lands.
 */
export function collectPendingFileProposals(
  parts: readonly ToolPartLike[],
  openedIds: ReadonlySet<string>,
): PendingFileProposal[] {
  const out: PendingFileProposal[] = [];
  for (const part of parts) {
    const info = extractFileMutation(part);
    if (!info) continue;
    const { state, approvalId, path, derive } = info;
    if (!approvalId) continue;
    if (openedIds.has(approvalId)) continue;
    const finished = state === "output-available" && !outputHasError(part);
    const legacy = state === "approval-requested";
    if (!finished && !legacy) continue;
    const mutationKind =
      derive.kind === "delete"
        ? "delete"
        : derive.kind === "rename"
          ? "rename"
          : "edit";
    const output = part.output;
    const resultPath =
      output !== null &&
      typeof output === "object" &&
      typeof (output as { path?: unknown }).path === "string"
        ? ((output as { path: string }).path as string)
        : undefined;
    out.push({
      proposalId: approvalId,
      path,
      derive,
      mutationKind,
      ...(derive.kind === "rename" ? { targetPath: derive.to } : {}),
      ...(resultPath !== undefined ? { resultPath } : {}),
    });
  }
  return out;
}
