import type { DiffOpenInput } from "../components/AgentRunBridge";
import { resolveMutationPath } from "./fileMutations";
import type { PendingProposal } from "./pendingProposals";
import type { FileCheckpoint } from "./reviewCheckpoint";
import {
  restoreStatus,
  type PersistedReviewProposal,
} from "./reviewPersistence";
import { restoreHunkDecisions } from "./restoreHunkDecisions";

/**
 * Rebuilds a missing ai-diff tab from what is still on record
 * (Fase 28, extended Fase 33).
 *
 * A review tab can go missing while its Changed Files row stays on
 * screen: the bridge only creates tabs for tool parts that reached
 * `output-available`, a derive failure skips the tab without a trace,
 * and closing the tab removes it from the store while the row keeps
 * showing "Pending". Without a tab there is no way back into the
 * review — Accept all skips the file and the row click only opens the
 * editor. This builder recovers the tab's inputs from the written
 * baseline (the pending-proposal registry), the in-memory checkpoint,
 * or — Fase 33 — the persisted review state on disk, so a row click
 * can re-open the review instead of giving up.
 *
 * Identity matters: the registry is keyed by path, not by proposal,
 * so its entry is only used when it belongs to one of the row's
 * mutations (`approvalIds`). A composed row chains several tool calls
 * for one file (Fase 6), and the registry keeps the first write's id
 * while the row may point at a later one — so the builder tries every
 * mutation id of the row, not just the row's own id. The tab is always
 * opened under an id that belongs to the row, so the card recognises
 * it (its Fase 28 loop follows the latest tabbed mutation) and Accept
 * all can confirm through it. Returns null when no source can rebuild
 * the tab.
 *
 * Sources, in order:
 * 1. The registry (live baseline while the run's session is alive).
 * 2. An in-memory checkpoint, tried for every mutation id.
 * 3. A persisted proposal (survives a restart: the in-memory maps
 *    are gone, but the checkpoint on disk is not). A persisted
 *    proposal without a checkpoint cannot rebuild the tab — its
 *    contents were never recorded — and returns null.
 *
 * The proposed side is the recorded content, unless `diskContent` is
 * given: write-first means the disk already holds the change, so the
 * current disk content is the honest proposed side when it moved
 * since the write was recorded (see `resolveProposedContent`).
 */
export function buildRecreatedAiDiffTab(input: {
  approvalId: string;
  /** Every mutation id behind the row, in message order. */
  approvalIds?: string[];
  /** Absolute path of the file, as resolved for the card row. */
  absPath: string;
  cwd: string | null;
  registry?: PendingProposal;
  /** Single checkpoint, for the row id (kept for Fase 28 callers). */
  checkpoint?: FileCheckpoint;
  /** Checkpoints by approval id; tried in `approvalIds` order. */
  checkpoints?: ReadonlyMap<string, FileCheckpoint>;
  /** Matched persisted proposal; only its checkpoint is used. */
  persisted?: PersistedReviewProposal | null;
  /** Current disk content for the proposed side, when read already. */
  diskContent?: string | null;
}): DiffOpenInput | null {
  const {
    approvalId,
    absPath,
    cwd,
    registry,
    checkpoint,
    checkpoints,
    persisted,
    diskContent,
  } = input;
  const approvalIds =
    input.approvalIds !== undefined && input.approvalIds.length > 0
      ? input.approvalIds
      : [approvalId];

  if (
    registry !== undefined &&
    registry.approvalId !== undefined &&
    approvalIds.includes(registry.approvalId)
  ) {
    return {
      path: absPath,
      originalContent: registry.originalContent,
      proposedContent: diskContent ?? registry.proposedContent,
      approvalId: registry.approvalId,
      isNewFile: registry.isNewFile,
      mutationKind: registry.kind,
      ...(registry.targetPath !== undefined
        ? { targetPath: resolveMutationPath(registry.targetPath, cwd) }
        : {}),
      written: true,
      activate: true,
    };
  }

  const checkpointById = (id: string): FileCheckpoint | undefined => {
    if (id === approvalId && checkpoint !== undefined) return checkpoint;
    return checkpoints?.get(id);
  };
  for (const id of approvalIds) {
    const cp = checkpointById(id);
    if (cp === undefined) continue;
    return checkpointToDiffInput(cp, {
      absPath,
      cwd,
      diskContent: diskContent ?? null,
    });
  }

  if (persisted?.checkpoint !== undefined) {
    const cp = persisted.checkpoint;
    const proposed = diskContent ?? cp.contentAfter ?? "";
    const effectiveId = approvalIds.includes(persisted.approvalId)
      ? persisted.approvalId
      : approvalIds[0];
    return {
      path: absPath,
      originalContent: cp.contentBefore,
      proposedContent: proposed,
      approvalId: effectiveId,
      isNewFile:
        cp.kind === "edit" ? cp.contentBefore === "" : persisted.isNewFile,
      status: restoreStatus(persisted.status),
      mutationKind: persisted.mutationKind ?? cp.kind,
      ...(persisted.targetPath !== undefined
        ? { targetPath: resolveMutationPath(persisted.targetPath, cwd) }
        : cp.targetPath !== undefined
          ? { targetPath: resolveMutationPath(cp.targetPath, cwd) }
          : {}),
      ...(persisted.fileDecision !== undefined
        ? { fileDecision: persisted.fileDecision }
        : {}),
      hunkDecisions: restoreHunkDecisions(
        persisted,
        cp.contentBefore,
        proposed,
      ),
      written: true,
      activate: true,
    };
  }
  return null;
}

function checkpointToDiffInput(
  checkpoint: FileCheckpoint,
  opts: { absPath: string; cwd: string | null; diskContent: string | null },
): DiffOpenInput {
  const { absPath, cwd, diskContent } = opts;
  return {
    path: absPath,
    originalContent: checkpoint.contentBefore,
    proposedContent: diskContent ?? checkpoint.contentAfter ?? "",
    approvalId: checkpoint.approvalId,
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

/**
 * Picks the proposed content for a rebuilt tab from the current disk
 * read. The disk is the truth for a write-first change — but a read
 * that comes back empty for a file that still exists is not a real
 * empty file: `readOriginal` returns "" for binary, oversized, or
 * unreadable files too. Only an empty read for a file that is really
 * gone (`isNewFile`) may wipe the recorded proposal.
 */
export function resolveProposedContent(
  recorded: string,
  disk: { content: string; isNewFile: boolean } | null,
): string {
  if (disk === null) return recorded;
  if (disk.content === "" && !disk.isNewFile && recorded !== "") {
    return recorded;
  }
  return disk.content;
}
