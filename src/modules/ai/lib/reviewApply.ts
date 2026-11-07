/**
 * Reviewed-apply path (Opsi B, FR-03..FR-08).
 *
 * Why this exists: an AI SDK approval is a boolean and cannot carry edited
 * content. Answering an edit/write_file approval `true` writes the whole
 * proposed content, so per-line decisions cannot flow through the existing
 * tool. This module therefore applies the user's reviewed reconstruction
 * directly, instead of letting the agent tool write:
 *
 * - Input carries the full reconstructed content, never a diff. Exactly
 *   that content is written, atomically, via native.writeFile (which
 *   already uses write_atomic on the Rust side).
 * - The original edit/write_file approval that produced the proposal is
 *   answered `false` first, so the existing tool never writes anything.
 * - Before writing, the file is re-read and compared with
 *   originalContent (FR-07 conflict guard). A mismatch means conflict,
 *   never a silent overwrite.
 * - One call applies one file. Per-line decisions live on the caller side
 *   (AiDiffPane + the review store) and are already folded into
 *   reconstructedContent before the call.
 *
 * This is deliberately NOT exposed as an AI SDK tool: the model must never
 * be able to write arbitrary content without approval. Only the review UI
 * invokes it, after the user has decided every changed line.
 */
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
 * djb2 hash, same function as the one in tools/edit.ts (kept in sync by
 * hand). Used for the FR-07 conflict guard; a hash is enough here because
 * the comparison is against content we read back a moment later, not
 * against untrusted input.
 */
export function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Reviewed-apply registry
// ---------------------------------------------------------------------------

/**
 * Approval ids whose write is being done (or was done) by the
 * reviewed-apply path instead of the agent tool.
 *
 * AgentRunBridge records an approval answer as applied/rejected when it
 * observes the response; for a reviewed apply that recording is wrong
 * (answering `false` means "the agent tool must not write", while the
 * pane owns the real outcome). The bridge therefore checks
 * isReviewedApply and skips its own recording for those ids.
 *
 * The entry is consumed by the bridge when it skips; clearAllReviewedApplies
 * is the backstop when the chat session changes.
 */
const reviewedApplyIds = new Set<string>();

export function markReviewedApply(approvalId: string): void {
  reviewedApplyIds.add(approvalId);
}

export function isReviewedApply(approvalId: string): boolean {
  return reviewedApplyIds.has(approvalId);
}

export function clearReviewedApply(approvalId: string): void {
  reviewedApplyIds.delete(approvalId);
}

export function clearAllReviewedApplies(): void {
  reviewedApplyIds.clear();
}

// ---------------------------------------------------------------------------
// Injectable IO (the real implementation talks to Tauri + the chat store)
// ---------------------------------------------------------------------------

export type ReviewApplyIo = {
  respondToApproval: (approvalId: string, approved: boolean) => void;
  readFile: (path: string) => Promise<ReadResult>;
  writeFile: (path: string, content: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  /** Records the pre-apply checkpoint, before the destructive call. */
  saveCheckpoint: (cp: FileCheckpoint) => void;
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
    respondToApproval: (id, approved) =>
      useChatStore.getState().respondToApproval(id, approved),
    readFile: (path) => native.readFile(path),
    writeFile: (path, content) => native.writeFile(path, content),
    deleteFile: (path) => native.deleteFile(path),
    renameFile: (from, to) => native.renameFile(from, to),
    saveCheckpoint: (cp) => saveCheckpoint(cp),
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
 * 1. If the reconstruction equals the original, nothing to write: answer
 *    the approval false and report "discarded".
 * 2. Writability check, then the conflict guard. Neither answers the
 *    approval, so the user can fix the problem and retry.
 * 3. Answer the original approval false so the agent tool never writes.
 * 4. Write the reconstruction atomically via native.writeFile.
 *
 * Known limitation: if the write fails after step 3, the agent already
 * saw a denial and the file is unchanged; the user must re-ask the agent
 * or apply the reconstruction manually.
 */
export async function applyReviewedEdit(
  input: ReviewApplyInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { approvalId, path } = input;
  markReviewedApply(approvalId);
  if (input.reconstructedContent === input.originalContent) {
    io.respondToApproval(approvalId, false);
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
  io.respondToApproval(approvalId, false);
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
  return { outcome: "applied", path };
}

/**
 * Applies a reviewed delete (Fase 5, Opsi B for delete_file). Same order
 * as applyReviewedEdit: writability and conflict guards first, answer
 * the original approval false, checkpoint the content, then delete via
 * the existing Rust fs_delete backend. The checkpoint is what makes the
 * delete restorable.
 */
export async function applyReviewedDelete(
  input: ReviewDeleteInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { approvalId, path } = input;
  markReviewedApply(approvalId);
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
  io.respondToApproval(approvalId, false);
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
  return { outcome: "applied", path };
}

/**
 * Applies a reviewed rename (Fase 5, Opsi B for rename_file). Same order
 * as the delete: guards first, answer false, checkpoint, then rename via
 * the existing Rust fs_rename backend. The target must not exist and
 * must stay inside the workspace; a rename that would overwrite another
 * file or escape the workspace is a conflict, never executed.
 */
export async function applyReviewedRename(
  input: ReviewRenameInput,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): Promise<ReviewApplyOutcome> {
  const { approvalId, path } = input;
  markReviewedApply(approvalId);
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
  io.respondToApproval(approvalId, false);
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
  return { outcome: "applied", path };
}

/**
 * Discards a proposal without writing (e.g. the conflict banner's
 * "Discard proposal"). Marks the approval as reviewed so the bridge
 * does not record its own status, then answers it false.
 */
export function discardReviewedProposal(
  approvalId: string,
  io: ReviewApplyIo = defaultReviewApplyIo(),
): void {
  markReviewedApply(approvalId);
  io.respondToApproval(approvalId, false);
}
