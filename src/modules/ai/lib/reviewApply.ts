/**
 * Reviewed-confirm path (Fase 8, write-first; legacy apply kept for
 * pre-Fase-8 proposals).
 *
 * Since Fase 8 the agent's file tools write to disk immediately — the
 * file is already changed when the review opens, and git shows the
 * change at once, like Antigravity's write-first model. The review no
 * longer writes the accepted content; it only decides what stays:
 *
 * - Accept is bookkeeping only: the hunk is marked done, nothing is
 *   written. The checkpoint (taken at write time, see
 *   reviewCheckpoint) keeps the file restorable afterwards.
 * - Reject reverts that hunk from the checkpoint: the reconstruction
 *   (accepted hunks from the written content, rejected hunks from the
 *   baseline) is written atomically, with the same FR-07 conflict
 *   guard — now comparing the disk against the *written* content
 *   instead of the baseline.
 * - One call confirms one file. Per-hunk decisions live on the caller
 *   side (AiDiffPane + the review store) and are already folded into
 *   reconstructedContent before the call.
 * - After a successful confirm, the pending proposal for the path is
 *   cleared, so the next agent edit starts from the new on-disk
 *   content instead of composing onto a resolved proposal.
 *
 * The pre-Fase-8 `applyReviewed*` functions are kept for proposals
 * recorded before write-first, where the agent never wrote to disk:
 * those tabs still write the reconstruction on Apply. The pane picks
 * the path from the tab's `written` flag.
 *
 * This is deliberately NOT exposed as an AI SDK tool: the model must
 * never be able to write arbitrary content without review. Only the
 * review UI invokes it, after the user has decided every changed line.
 *
 * Fase 6 removed the old approval round-trip: previously the original
 * edit/write_file approval was answered `false` first so the agent tool
 * would not write. There is no approval to answer anymore (file tools
 * are not approval-gated), and a failed write no longer leaves the
 * agent believing its edit was denied — the proposal simply stays
 * pending and the user can retry.
 */
import { clearPendingProposal } from "./pendingProposals";
import { checkWritableCanonical } from "./security";
import { native, type ReadResult } from "./native";
import { useChatStore } from "../store/chatStore";
import {
  buildDeleteCheckpoint,
  buildEditCheckpoint,
  buildRenameCheckpoint,
  saveCheckpoint,
  type FileCheckpoint,
} from "./reviewCheckpoint";
import { checkRenameGuard, isPathInside } from "./fileOpGuards";

/** Per-line review decision, keyed by line number in the proposed content. */
export type LineDecision = "accepted" | "rejected" | "undecided";

export type LineDecisions = Map<number, LineDecision>;

/**
 * Per-hunk review decision (Fase 4, Antigravity-style): the hunk, not
 * the line, is the unit of decision. One decision covers every changed
 * line inside the hunk.
 */
export type HunkDecision = "accepted" | "rejected" | "undecided";

/** Per-hunk decisions, keyed by LineHunk index. */
export type HunkDecisions = Map<number, HunkDecision>;

/** Input for `apply_reviewed_edit` (legacy, pre-Fase-8). */
export type ReviewApplyInput = {
  /** Approval id of the original edit/write_file call being reviewed. */
  approvalId: string;
  /** Owning session, stamped on the checkpoint for session-delete cleanup. */
  sessionId?: string;
  path: string;
  /** True when the proposal creates the file (no on-disk baseline). */
  isNewFile: boolean;
  /** On-disk content the proposal was derived from (conflict baseline). */
  originalContent: string;
  /** Content after folding every accepted line decision in. */
  reconstructedContent: string;
  /** Hunk indexes accepted by the apply, recorded on the checkpoint. */
  appliedHunks?: number[];
};

/** Input for `apply_reviewed_delete` (legacy, pre-Fase-8). */
export type ReviewDeleteInput = {
  /** Approval id of the original delete_file call being reviewed. */
  approvalId: string;
  /** Owning session, stamped on the checkpoint for session-delete cleanup. */
  sessionId?: string;
  path: string;
  /** On-disk content the proposal was derived from (conflict baseline). */
  originalContent: string;
};

/** Input for `apply_reviewed_rename` (legacy, pre-Fase-8). */
export type ReviewRenameInput = {
  /** Approval id of the original rename_file call being reviewed. */
  approvalId: string;
  /** Owning session, stamped on the checkpoint for session-delete cleanup. */
  sessionId?: string;
  path: string;
  /** Rename destination. */
  targetPath: string;
  /** On-disk content the proposal was derived from (conflict baseline). */
  originalContent: string;
};

/** Input for `confirm_reviewed_edit` (Fase 8, write-first). */
export type ReviewConfirmInput = {
  /** Proposal id of the edit/write_file call being reviewed. */
  approvalId: string;
  /** Owning session, stamped on the checkpoint for session-delete cleanup. */
  sessionId?: string;
  path: string;
  /** True when the proposal created the file (no on-disk baseline). */
  isNewFile: boolean;
  /** Baseline content (the checkpoint's contentBefore). */
  originalContent: string;
  /** Content the agent wrote (the expected on-disk state). */
  proposedContent: string;
  /** Content after folding every accepted hunk decision in. */
  reconstructedContent: string;
  /** Hunk indexes accepted by the confirm, recorded on the checkpoint. */
  appliedHunks?: number[];
};

export type ReviewApplyOutcome =
  | { outcome: "applied"; path: string }
  | { outcome: "discarded"; path: string }
  | { outcome: "conflict"; path: string; reason: string }
  | { outcome: "not-writable"; path: string; reason: string }
  | { outcome: "write-failed"; path: string; reason: string };

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

/** True when every hunk has an accept or reject decision (Fase 4). */
export function allHunksDecided(
  decisions: HunkDecisions,
  hunkIndexes: number[],
): boolean {
  return hunkIndexes.every((index) => {
    const d = decisions.get(index);
    return d === "accepted" || d === "rejected";
  });
}

/**
 * djb2 hash, shared implementation in `./hash` (single copy — the old
 * "kept in sync by hand" triplicate across reviewApply, reviewCheckpoint
 * and tools/fs is gone). Used for the FR-07 conflict guard; a hash is
 * enough here because the comparison is against content we read back
 * a moment later, not against untrusted input.
 *
 * Re-exported so existing imports (`./reviewApply`) keep working.
 */
export { djb2Hash } from "./hash";
import { djb2Hash } from "./hash";

// ---------------------------------------------------------------------------
// Injectable IO (the real implementation talks to Tauri + the chat store)
// ---------------------------------------------------------------------------

export type ReviewApplyIo = {
  readFile: (path: string) => Promise<ReadResult>;
  writeFile: (path: string, content: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  /** Records the pre-apply checkpoint, before the destructive call. */
  saveCheckpoint: (cp: FileCheckpoint) => void;
  /** Drops the pending proposal for a resolved path (apply / discard). */
  clearPendingProposal: (path: string) => void;
  /** Workspace root, for the rename containment guard. */
  getWorkspaceRoot: () => string | null;
  checkWritable: (
    path: string,
    canonicalize: (p: string) => Promise<string>,
  ) => Promise<{ ok: true; canonical: string } | { ok: false; reason: string }>;
  canonicalize: (p: string) => Promise<string>;
};

export function defaultReviewApplyIo(): ReviewApplyIo {
  return {
    readFile: (path) => native.readFile(path),
    writeFile: (path, content) => native.writeFile(path, content),
    deleteFile: (path) => native.deleteFile(path),
    renameFile: (from, to) => native.renameFile(from, to),
    saveCheckpoint: (cp) => saveCheckpoint(cp),
    clearPendingProposal: (path) => clearPendingProposal(path),
    getWorkspaceRoot: () =>
      useChatStore.getState().live.getWorkspaceRoot(),
    checkWritable: (path, canonicalize) =>
      checkWritableCanonical(path, canonicalize),
    canonicalize: (path) => native.canonicalize(path),
  };
}

// ---------------------------------------------------------------------------
// FR-07 conflict guard
// ---------------------------------------------------------------------------

export type DiskConflict =
  | { status: "ok" }
  | { status: "conflict"; reason: string };

/**
 * Re-reads the file and compares its hash with the hash of
 * originalContent. Shared by Apply and "Check again". A new file that
 * does not exist on disk yet is fine; a file that existed when the
 * proposal was made but is now missing (or unreadable as text, or
 * changed) is a conflict.
 */
export async function checkDiskConflict(
  input: Pick<ReviewApplyInput, "path" | "originalContent" | "isNewFile">,
  io: ReviewApplyIo,
): Promise<DiskConflict> {
  let current: ReadResult;
  try {
    current = await io.readFile(input.path);
  } catch {
    return input.isNewFile
      ? { status: "ok" }
      : { status: "conflict", reason: "file no longer exists on disk" };
  }
  if (current.kind !== "text") {
    return { status: "conflict", reason: "file is no longer readable as text" };
  }
  if (djb2Hash(current.content) !== djb2Hash(input.originalContent)) {
    return {
      status: "conflict",
      reason: "file changed on disk since the proposal was made",
    };
  }
  return { status: "ok" };
}

/**
 * Re-reads the file and compares its hash with the hash of
 * expectedContent. Used by the Fase 8 confirm path: the disk must still
 * hold exactly what the agent wrote. A missing or unreadable file is
 * always a conflict here — unlike checkDiskConflict, there is no "new
 * file not written yet" case, because the agent already wrote it.
 */
export async function checkDiskAgainst(
  input: { path: string; expectedContent: string },
  io: ReviewApplyIo,
): Promise<DiskConflict> {
  let current: ReadResult;
  try {
    current = await io.readFile(input.path);
  } catch {
    return { status: "conflict", reason: "file no longer exists on disk" };
  }
  if (current.kind !== "text") {
    return { status: "conflict", reason: "file is no longer readable as text" };
  }
  if (djb2Hash(current.content) !== djb2Hash(input.expectedContent)) {
    return {
      status: "conflict",
      reason: "file changed on disk since the agent wrote it",
    };
  }
  return { status: "ok" };
}

/** True when the error means the path does not exist (any OS wording). */
function isNotFoundError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("no such file") ||
    msg.includes("not found") ||
    msg.includes("os error 2")
  );
}

/**
 * True when a read says the path exists, false when it is missing.
 * Throws on any other read failure so a permission problem is never
 * mistaken for a deletion.
 */
async function existsOnDisk(
  io: ReviewApplyIo,
  path: string,
): Promise<boolean> {
  try {
    await io.readFile(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Apply / discard
// ---------------------------------------------------------------------------

/**
 * Applies a reviewed edit (FR-05/FR-07). Legacy (pre-Fase-8) path for
 * proposals recorded before write-first, where the agent never wrote
 * to disk: the reconstruction is written here. New proposals are
 * confirmed with confirmReviewedEdit instead. Order matters:
 * 1. If the reconstruction equals the original, nothing to write: report
 *    "discarded" and clear the pending proposal.
 * 2. Writability check, then the conflict guard. Neither resolves the
 *    proposal, so the user can fix the problem and retry.
 * 3. Checkpoint first, then write the reconstruction atomically via
 *    native.writeFile. On success the pending proposal is cleared.
 *
 * A failed write leaves the proposal pending — there is no approval
 * round-trip to confuse the agent, so the user can simply retry.
 */
export async function applyReviewedEdit(
  input: ReviewApplyInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { approvalId, path } = input;
  if (input.reconstructedContent === input.originalContent) {
    io.clearPendingProposal(path);
    return { outcome: "discarded", path };
  }
  const writable = await io.checkWritable(path, io.canonicalize);
  if (!writable.ok) {
    return { outcome: "not-writable", path, reason: writable.reason };
  }
  const conflict = await checkDiskConflict(input, io);
  if (conflict.status === "conflict") {
    return { outcome: "conflict", path, reason: conflict.reason };
  }
  // Fase 5: checkpoint first, so the apply can be undone. Saved before
  // the write, with the pre-write content and the accepted hunks.
  io.saveCheckpoint(
    buildEditCheckpoint({
      approvalId,
      sessionId: input.sessionId,
      path,
      originalContent: input.originalContent,
      reconstructedContent: input.reconstructedContent,
      appliedHunks: input.appliedHunks ?? [],
    }),
  );
  try {
    await io.writeFile(path, input.reconstructedContent);
  } catch (error) {
    return {
      outcome: "write-failed",
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  io.clearPendingProposal(path);
  return { outcome: "applied", path };
}

/**
 * Applies a reviewed delete (Fase 5, Opsi B for delete_file). Legacy
 * (pre-Fase-8) path for proposals recorded before write-first, where
 * the agent never deleted the file: the delete happens here. New
 * proposals are confirmed with confirmReviewedDelete instead. Same
 * order as applyReviewedEdit: writability and conflict guards first,
 * checkpoint the content, then delete via the existing Rust fs_delete
 * backend. The checkpoint is what makes the delete restorable.
 */
export async function applyReviewedDelete(
  input: ReviewDeleteInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { approvalId, path } = input;
  const writable = await io.checkWritable(path, io.canonicalize);
  if (!writable.ok) {
    return { outcome: "not-writable", path, reason: writable.reason };
  }
  const conflict = await checkDiskConflict(
    { ...input, isNewFile: false },
    io,
  );
  if (conflict.status === "conflict") {
    return { outcome: "conflict", path, reason: conflict.reason };
  }
  io.saveCheckpoint(
    buildDeleteCheckpoint({
      approvalId,
      sessionId: input.sessionId,
      path,
      content: input.originalContent,
    }),
  );
  try {
    await io.deleteFile(path);
  } catch (error) {
    return {
      outcome: "write-failed",
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  io.clearPendingProposal(path);
  return { outcome: "applied", path };
}

/**
 * Applies a reviewed rename (Fase 5, Opsi B for rename_file). Legacy
 * (pre-Fase-8) path for proposals recorded before write-first, where
 * the agent never renamed the file: the rename happens here. New
 * proposals are confirmed with confirmReviewedRename instead. Same
 * order as the delete: guards first, checkpoint, then rename via the
 * existing Rust fs_rename backend. The target must not exist and must
 * stay inside the workspace; a rename that would overwrite another
 * file or escape the workspace is a conflict, never executed.
 */
export async function applyReviewedRename(
  input: ReviewRenameInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { approvalId, path } = input;
  const writable = await io.checkWritable(path, io.canonicalize);
  if (!writable.ok) {
    return { outcome: "not-writable", path, reason: writable.reason };
  }
  const targetWritable = await io.checkWritable(
    input.targetPath,
    io.canonicalize,
  );
  if (!targetWritable.ok) {
    return { outcome: "not-writable", path, reason: targetWritable.reason };
  }
  const targetPath = targetWritable.canonical;
  const conflict = await checkDiskConflict(
    { ...input, isNewFile: false },
    io,
  );
  if (conflict.status === "conflict") {
    return { outcome: "conflict", path, reason: conflict.reason };
  }
  let targetExists = false;
  try {
    await io.readFile(targetPath);
    targetExists = true;
  } catch {
    targetExists = false;
  }
  const root = io.getWorkspaceRoot();
  let targetInside = false;
  if (root) {
    try {
      const canonRoot = await io.canonicalize(root);
      const lastSep = Math.max(
        targetPath.lastIndexOf("/"),
        targetPath.lastIndexOf("\\"),
      );
      const canonParent =
        lastSep > 0 ? targetPath.slice(0, lastSep) : targetPath;
      targetInside = isPathInside(canonRoot, canonParent);
    } catch {
      targetInside = false;
    }
  }
  const guard = checkRenameGuard({
    sourceExists: true,
    targetExists,
    targetInsideWorkspace: targetInside,
  });
  if (!guard.ok) {
    return { outcome: "conflict", path, reason: guard.reason };
  }
  io.saveCheckpoint(
    buildRenameCheckpoint({
      approvalId,
      sessionId: input.sessionId,
      path,
      targetPath,
      content: input.originalContent,
    }),
  );
  try {
    await io.renameFile(path, targetPath);
  } catch (error) {
    return {
      outcome: "write-failed",
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  io.clearPendingProposal(path);
  return { outcome: "applied", path };
}

// ---------------------------------------------------------------------------
// Fase 8: confirm (write-first)
// ---------------------------------------------------------------------------

/**
 * Confirms a reviewed edit that the agent already wrote to disk
 * (Fase 8). Order matters:
 * 1. The disk must still hold exactly what the agent wrote (FR-07
 *    conflict guard, now against the written content). A mismatch
 *    means conflict, never a silent revert — the proposal stays
 *    pending so the user can fix the disk and retry.
 * 2. When every hunk was accepted the reconstruction equals the
 *    written content: nothing is written, Accept is bookkeeping only.
 *    The checkpoint is refreshed with the accepted hunks so Restore
 *    still works after the confirm.
 * 3. Otherwise the reconstruction (accepted hunks from the written
 *    content, rejected hunks from the baseline) is written atomically
 *    — this is the revert of the rejected hunks — and the checkpoint
 *    is updated to the confirmed state, so Restore still works.
 *    When the reconstruction equals the baseline (every hunk
 *    rejected) the file is back to its original content: outcome
 *    "discarded".
 *
 * A failed write leaves the proposal pending — there is no approval
 * round-trip to confuse the agent, so the user can simply retry.
 */
export async function confirmReviewedEdit(
  input: ReviewConfirmInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { approvalId, path } = input;
  const conflict = await checkDiskAgainst(
    { path, expectedContent: input.proposedContent },
    io,
  );
  if (conflict.status === "conflict") {
    return { outcome: "conflict", path, reason: conflict.reason };
  }
  if (input.reconstructedContent === input.proposedContent) {
    // All accepted: nothing to write. Refresh the checkpoint with the
    // accepted hunks so the post-confirm state stays restorable.
    io.saveCheckpoint(
      buildEditCheckpoint({
        approvalId,
        sessionId: input.sessionId,
        path,
        originalContent: input.originalContent,
        reconstructedContent: input.proposedContent,
        appliedHunks: input.appliedHunks ?? [],
      }),
    );
    io.clearPendingProposal(path);
    return { outcome: "applied", path };
  }
  const writable = await io.checkWritable(path, io.canonicalize);
  if (!writable.ok) {
    return { outcome: "not-writable", path, reason: writable.reason };
  }
  try {
    await io.writeFile(path, input.reconstructedContent);
  } catch (error) {
    return {
      outcome: "write-failed",
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  // The checkpoint now describes the confirmed state, so Restore still
  // works after a confirm (including a full revert).
  io.saveCheckpoint(
    buildEditCheckpoint({
      approvalId,
      sessionId: input.sessionId,
      path,
      originalContent: input.originalContent,
      reconstructedContent: input.reconstructedContent,
      appliedHunks: input.appliedHunks ?? [],
    }),
  );
  io.clearPendingProposal(path);
  return {
    outcome:
      input.reconstructedContent === input.originalContent
        ? "discarded"
        : "applied",
    path,
  };
}

/**
 * Confirms a reviewed delete that the agent already executed (Fase 8).
 * The file is already gone: confirming is bookkeeping only, but only
 * when it is still gone. If it was recreated on disk since the delete,
 * the confirm is refused so the user decides what to do with the new
 * file first. The checkpoint (taken at delete time) is untouched, so
 * Restore still works after the confirm.
 */
export async function confirmReviewedDelete(
  input: ReviewDeleteInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { path } = input;
  let exists: boolean;
  try {
    exists = await existsOnDisk(io, path);
  } catch (error) {
    return {
      outcome: "conflict",
      path,
      reason: `could not verify the file is still deleted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (exists) {
    return {
      outcome: "conflict",
      path,
      reason: "file was recreated on disk since the delete",
    };
  }
  io.clearPendingProposal(path);
  return { outcome: "applied", path };
}

/**
 * Confirms a reviewed rename that the agent already executed (Fase 8).
 * The file already moved: confirming is bookkeeping only, but only
 * when the target still holds the renamed content and the old path is
 * still gone. The checkpoint (taken at rename time) is untouched, so
 * Restore still works after the confirm.
 */
export async function confirmReviewedRename(
  input: ReviewRenameInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { path } = input;
  const targetOk = await checkDiskAgainst(
    { path: input.targetPath, expectedContent: input.originalContent },
    io,
  );
  if (targetOk.status === "conflict") {
    return { outcome: "conflict", path, reason: targetOk.reason };
  }
  let oldExists: boolean;
  try {
    oldExists = await existsOnDisk(io, path);
  } catch (error) {
    return {
      outcome: "conflict",
      path,
      reason: `could not verify the old path is still gone: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (oldExists) {
    return {
      outcome: "conflict",
      path,
      reason: "a file already exists at the old path",
    };
  }
  io.clearPendingProposal(path);
  return { outcome: "applied", path };
}

/**
 * Discards a proposal without writing (e.g. the conflict banner's
 * "Discard proposal"). The pending proposal for the path is dropped so
 * a later agent edit starts from the on-disk content.
 *
 * Fase 8: for a written proposal this abandons the review WITHOUT
 * touching the disk — the agent's change stays exactly as written.
 * To undo it, Reject the hunks (or the file) instead.
 */
export function discardReviewedProposal(
  path: string,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): void {
  io.clearPendingProposal(path);
}
