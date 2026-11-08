/**
 * Reviewed-apply path (Opsi B, FR-03..FR-08; Fase 6: no approval).
 *
 * Why this exists: the user reviews each proposal per hunk and applies
 * only the accepted part. The agent tool itself never writes — its
 * `execute` only records a proposal — so this module is the one place
 * that writes reviewed content to disk:
 *
 * - Input carries the full reconstructed content, never a diff. Exactly
 *   that content is written, atomically, via native.writeFile (which
 *   already uses write_atomic on the Rust side).
 * - Before writing, the file is re-read and compared with
 *   originalContent (FR-07 conflict guard). A mismatch means conflict,
 *   never a silent overwrite.
 * - One call applies one file. Per-line decisions live on the caller side
 *   (AiDiffPane + the review store) and are already folded into
 *   reconstructedContent before the call.
 * - After a successful apply or a discard, the pending proposal for the
 *   path is cleared, so the next agent edit starts from the new on-disk
 *   content instead of composing onto a resolved proposal.
 *
 * This is deliberately NOT exposed as an AI SDK tool: the model must never
 * be able to write arbitrary content without review. Only the review UI
 * invokes it, after the user has decided every changed line.
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

/** Input for `apply_reviewed_edit`. */
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

/** Input for `apply_reviewed_delete`. */
export type ReviewDeleteInput = {
  /** Approval id of the original delete_file call being reviewed. */
  approvalId: string;
  /** Owning session, stamped on the checkpoint for session-delete cleanup. */
  sessionId?: string;
  path: string;
  /** On-disk content the proposal was derived from (conflict baseline). */
  originalContent: string;
};

/** Input for `apply_reviewed_rename`. */
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

// ---------------------------------------------------------------------------
// Apply / discard
// ---------------------------------------------------------------------------

/**
 * Applies a reviewed edit (FR-05/FR-07). Order matters:
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
 * Applies a reviewed delete (Fase 5, Opsi B for delete_file). Same order
 * as applyReviewedEdit: writability and conflict guards first,
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
 * Applies a reviewed rename (Fase 5, Opsi B for rename_file). Same order
 * as the delete: guards first, checkpoint, then rename via the existing
 * Rust fs_rename backend. The target must not exist and must stay inside
 * the workspace; a rename that would overwrite another file or escape
 * the workspace is a conflict, never executed.
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

/**
 * Discards a proposal without writing (e.g. the conflict banner's
 * "Discard proposal"). The pending proposal for the path is dropped so
 * a later agent edit starts from the on-disk content.
 */
export function discardReviewedProposal(
  path: string,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): void {
  io.clearPendingProposal(path);
}
