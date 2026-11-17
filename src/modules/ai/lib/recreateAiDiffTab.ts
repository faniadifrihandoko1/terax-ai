import type { DiffOpenInput } from "../components/AgentRunBridge";
import { resolveMutationPath } from "./fileMutations";
import type { PendingProposal } from "./pendingProposals";
import type { FileCheckpoint } from "./reviewCheckpoint";

/**
 * Rebuilds a missing ai-diff tab from what is still on record
 * (Fase 28).
 *
 * A review tab can go missing while its Changed Files row stays on
 * screen: the bridge only creates tabs for tool parts that reached
 * `output-available`, a derive failure skips the tab without a trace,
 * and closing the tab removes it from the store while the row keeps
 * showing "Pending". Without a tab there is no way back into the
 * review — Accept all skips the file and the row click only opens the
 * editor. This builder recovers the tab's inputs from the written
 * baseline (the pending-proposal registry) or, failing that, from the
 * checkpoint, so a row click can re-open the review instead of
 * giving up.
 *
 * Identity matters: the registry is keyed by path, not by proposal,
 * so its entry is only used when it belongs to the same first write
 * as the row (`registry.approvalId === approvalId`). A newer write
 * for the same file must not be shown under the old row's id. The
 * checkpoint is keyed by approval id, so it always belongs to the
 * row. Returns null when neither source can rebuild the tab.
 */
export function buildRecreatedAiDiffTab(input: {
  approvalId: string;
  /** Absolute path of the file, as resolved for the card row. */
  absPath: string;
  cwd: string | null;
  registry?: PendingProposal;
  checkpoint?: FileCheckpoint;
}): DiffOpenInput | null {
  const { approvalId, absPath, cwd, registry, checkpoint } = input;
  if (
    registry !== undefined &&
    registry.approvalId !== undefined &&
    registry.approvalId === approvalId
  ) {
    return {
      path: absPath,
      originalContent: registry.originalContent,
      proposedContent: registry.proposedContent,
      approvalId,
      isNewFile: registry.isNewFile,
      mutationKind: registry.kind,
      ...(registry.targetPath !== undefined
        ? { targetPath: resolveMutationPath(registry.targetPath, cwd) }
        : {}),
      written: true,
      activate: true,
    };
  }
  if (checkpoint !== undefined) {
    return {
      path: absPath,
      originalContent: checkpoint.contentBefore,
      proposedContent: checkpoint.contentAfter ?? "",
      approvalId,
      // A checkpoint has no isNewFile flag; a baseline of "" means the
      // agent created the file (same heuristic as the card stats).
      isNewFile:
        checkpoint.kind === "edit" && checkpoint.contentBefore === "",
      mutationKind: checkpoint.kind,
      ...(checkpoint.targetPath !== undefined
        ? { targetPath: resolveMutationPath(checkpoint.targetPath, cwd) }
        : {}),
      written: true,
      activate: true,
    };
  }
  return null;
}
