import { native, type ReadResult } from "./native";
import { djb2Hash } from "./hash";

// djb2 hash lives in `./hash` (single copy); used for the checkpoint
// guards. A hash is enough here because the comparison is against
// content we read back a moment later, not against untrusted input.
export { djb2Hash };

/**
 * Checkpoint for one applied AI file operation (Fase 5).
 *
 * Every reviewed apply first records what the file looked like before
 * the write, so the user can undo it later ("Restore" / "Undo apply")
 * the way Antigravity checkpoints let you step back. A checkpoint is
 * one file, one apply: the latest apply per file replaces the older
 * one, and at most MAX_CHECKPOINTS_PER_SESSION checkpoints are kept
 * per session (oldest dropped first).
 *
 * The checkpoint holds full file contents, never a diff, so restore is
 * exact: write the old content back atomically. Contents are bounded
 * by the checkpoint count, not by size; checkpointing a huge file
 * costs that file's size in memory and in the persisted review state.
 */

export type CheckpointKind = "edit" | "delete" | "rename";

export type FileCheckpoint = {
  approvalId: string;
  /** Owning session, when known. Used to drop checkpoints on session delete. */
  sessionId?: string;
  /** Path the proposal was about (the old path for a rename). */
  path: string;
  kind: CheckpointKind;
  /** Content before the apply. */
  contentBefore: string;
  /**
   * Content after the apply, or null when the file is gone after the
   * apply (delete). For a rename this is the same content as before,
   * now living at targetPath.
   */
  contentAfter: string | null;
  hashBefore: number;
  /** Null when the file is gone after the apply (delete). */
  hashAfter: number | null;
  /** Rename destination. Only set when kind is "rename". */
  targetPath?: string;
  appliedAt: number;
  /** Hunk indexes that were accepted by the apply (edits only). */
  appliedHunks: number[];
};

/** Latest apply per file wins; oldest checkpoint is dropped past this. */
export const MAX_CHECKPOINTS_PER_SESSION = 20;

export function buildEditCheckpoint(input: {
  approvalId: string;
  sessionId?: string;
  path: string;
  originalContent: string;
  reconstructedContent: string;
  appliedHunks: number[];
  appliedAt?: number;
}): FileCheckpoint {
  return {
    approvalId: input.approvalId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    path: input.path,
    kind: "edit",
    contentBefore: input.originalContent,
    contentAfter: input.reconstructedContent,
    hashBefore: djb2Hash(input.originalContent),
    hashAfter: djb2Hash(input.reconstructedContent),
    appliedAt: input.appliedAt ?? Date.now(),
    appliedHunks: [...input.appliedHunks],
  };
}

export function buildDeleteCheckpoint(input: {
  approvalId: string;
  sessionId?: string;
  path: string;
  content: string;
  appliedAt?: number;
}): FileCheckpoint {
  return {
    approvalId: input.approvalId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    path: input.path,
    kind: "delete",
    contentBefore: input.content,
    contentAfter: null,
    hashBefore: djb2Hash(input.content),
    hashAfter: null,
    appliedAt: input.appliedAt ?? Date.now(),
    appliedHunks: [],
  };
}

export function buildRenameCheckpoint(input: {
  approvalId: string;
  sessionId?: string;
  path: string;
  targetPath: string;
  content: string;
  appliedAt?: number;
}): FileCheckpoint {
  return {
    approvalId: input.approvalId,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    path: input.path,
    kind: "rename",
    contentBefore: input.content,
    contentAfter: input.content,
    hashBefore: djb2Hash(input.content),
    hashAfter: djb2Hash(input.content),
    targetPath: input.targetPath,
    appliedAt: input.appliedAt ?? Date.now(),
    appliedHunks: [],
  };
}

// ---------------------------------------------------------------------------
// Registry (mirrors the reviewHistory pattern: module-level, keyed by
// approval id, outside React so the pane, the card and the bridge share
// one source of truth for the same proposal).
// ---------------------------------------------------------------------------

const checkpoints = new Map<string, FileCheckpoint>();

export function saveCheckpoint(cp: FileCheckpoint): void {
  checkpoints.delete(cp.approvalId);
  checkpoints.set(cp.approvalId, cp);
  while (checkpoints.size > MAX_CHECKPOINTS_PER_SESSION) {
    const oldest = checkpoints.keys().next().value;
    if (oldest === undefined) break;
    checkpoints.delete(oldest);
  }
}

export function getCheckpoint(
  approvalId: string,
): FileCheckpoint | undefined {
  return checkpoints.get(approvalId);
}

export function clearCheckpoint(approvalId: string): void {
  checkpoints.delete(approvalId);
}

/** Drops every checkpoint stamped with the deleted session id. */
export function clearCheckpointsForSession(sessionId: string): void {
  for (const [id, cp] of checkpoints) {
    if (cp.sessionId === sessionId) checkpoints.delete(id);
  }
}

export function clearAllCheckpoints(): void {
  checkpoints.clear();
}

/** Read-only view for the persistence snapshot (App effect). */
export function listCheckpoints(): ReadonlyMap<string, FileCheckpoint> {
  return checkpoints;
}

/**
 * Strict shape check for a checkpoint loaded from persisted state.
 * Anything malformed is rejected so a damaged entry cannot corrupt a
 * restore; the caller drops the checkpoint and keeps the proposal.
 */
export function isFileCheckpoint(value: unknown): value is FileCheckpoint {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (typeof c.approvalId !== "string" || !c.approvalId) return false;
  if (
    c.sessionId !== undefined &&
    (typeof c.sessionId !== "string" || !c.sessionId)
  )
    return false;
  if (typeof c.path !== "string" || !c.path) return false;
  if (c.kind !== "edit" && c.kind !== "delete" && c.kind !== "rename")
    return false;
  if (typeof c.contentBefore !== "string") return false;
  if (c.contentAfter !== null && typeof c.contentAfter !== "string")
    return false;
  if (typeof c.hashBefore !== "number" || Number.isNaN(c.hashBefore))
    return false;
  if (c.hashAfter !== null && typeof c.hashAfter !== "number") return false;
  if (c.kind === "delete" && c.contentAfter !== null) return false;
  if (c.kind === "delete" && c.hashAfter !== null) return false;
  if (c.kind === "rename" && typeof c.targetPath !== "string") return false;
  if (
    c.targetPath !== undefined &&
    (typeof c.targetPath !== "string" || !c.targetPath)
  )
    return false;
  if (typeof c.appliedAt !== "number" || Number.isNaN(c.appliedAt))
    return false;
  if (
    !Array.isArray(c.appliedHunks) ||
    c.appliedHunks.some((h) => typeof h !== "number" || !Number.isInteger(h))
  )
    return false;
  return true;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export type CheckpointIo = {
  readFile: (path: string) => Promise<ReadResult>;
  writeFile: (path: string, content: string) => Promise<void>;
  deleteFile: (path: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
};

export function defaultCheckpointIo(): CheckpointIo {
  return {
    readFile: (path) => native.readFile(path),
    writeFile: (path, content) => native.writeFile(path, content),
    deleteFile: (path) => native.deleteFile(path),
    renameFile: (from, to) => native.renameFile(from, to),
  };
}

export type RestoreOutcome =
  | { outcome: "restored"; approvalId: string; path: string }
  | {
      outcome: "conflict";
      approvalId: string;
      path: string;
      reason: string;
    }
  | {
      outcome: "restore-failed";
      approvalId: string;
      path: string;
      reason: string;
    }
  | { outcome: "no-checkpoint"; approvalId: string; path: string };

function isNotFoundError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes("no such file") ||
    msg.includes("not found") ||
    msg.includes("os error 2")
  );
}

type ExistingFile = { exists: true; content: string } | { exists: false };

/**
 * Reads a file for the restore guard. A missing file reports
 * exists:false; any other read failure is surfaced so a permission
 * problem is never mistaken for a deletion.
 */
async function readExisting(
  io: CheckpointIo,
  path: string,
): Promise<ExistingFile | { error: string }> {
  try {
    const r = await io.readFile(path);
    if (r.kind !== "text") return { error: "file is not readable as text" };
    return { exists: true, content: r.content };
  } catch (error) {
    if (isNotFoundError(error)) return { exists: false };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function hashOf(content: string): number {
  return djb2Hash(content);
}

/**
 * Restores one applied file operation from its checkpoint.
 *
 * Guard (skipped only with force, an explicit second user action):
 * the on-disk state must still be exactly what the apply produced,
 * otherwise the restore is refused instead of silently overwriting
 * the user's later changes.
 * - edit: the file must exist with hashAfter.
 * - delete: the file must still be gone.
 * - rename: the new path must exist with hashAfter and the old path
 *   must still be gone.
 *
 * On success the checkpoint is consumed (a second restore would fail
 * its guard anyway, since the disk no longer matches the applied
 * state).
 */
export async function restoreCheckpoint(
  approvalId: string,
  opts: { force?: boolean },
  io: CheckpointIo = defaultCheckpointIo(),
): Promise<RestoreOutcome> {
  const cp = checkpoints.get(approvalId);
  if (!cp) return { outcome: "no-checkpoint", approvalId, path: "" };
  const force = opts.force === true;
  try {
    if (cp.kind === "edit") {
      const current = await readExisting(io, cp.path);
      if ("error" in current) {
        return {
          outcome: "restore-failed",
          approvalId,
          path: cp.path,
          reason: current.error,
        };
      }
      if (!force) {
        if (!current.exists) {
          return {
            outcome: "conflict",
            approvalId,
            path: cp.path,
            reason: "file no longer exists on disk",
          };
        }
        if (hashOf(current.content) !== cp.hashAfter) {
          return {
            outcome: "conflict",
            approvalId,
            path: cp.path,
            reason: "file changed on disk since the apply",
          };
        }
      }
      await io.writeFile(cp.path, cp.contentBefore);
    } else if (cp.kind === "delete") {
      const current = await readExisting(io, cp.path);
      if ("error" in current) {
        return {
          outcome: "restore-failed",
          approvalId,
          path: cp.path,
          reason: current.error,
        };
      }
      if (!force && current.exists) {
        return {
          outcome: "conflict",
          approvalId,
          path: cp.path,
          reason: "file was recreated on disk since the delete",
        };
      }
      await io.writeFile(cp.path, cp.contentBefore);
    } else {
      const target = cp.targetPath as string;
      const atTarget = await readExisting(io, target);
      if ("error" in atTarget) {
        return {
          outcome: "restore-failed",
          approvalId,
          path: cp.path,
          reason: atTarget.error,
        };
      }
      const atOld = await readExisting(io, cp.path);
      if ("error" in atOld) {
        return {
          outcome: "restore-failed",
          approvalId,
          path: cp.path,
          reason: atOld.error,
        };
      }
      if (!force) {
        if (!atTarget.exists) {
          return {
            outcome: "conflict",
            approvalId,
            path: cp.path,
            reason: "renamed file no longer exists on disk",
          };
        }
        if (hashOf(atTarget.content) !== cp.hashAfter) {
          return {
            outcome: "conflict",
            approvalId,
            path: cp.path,
            reason: "renamed file changed on disk since the rename",
          };
        }
        if (atOld.exists) {
          return {
            outcome: "conflict",
            approvalId,
            path: cp.path,
            reason: "a file already exists at the old path",
          };
        }
      }
      if (atTarget.exists) {
        await io.renameFile(target, cp.path);
        const back = await readExisting(io, cp.path);
        if ("error" in back) {
          return {
            outcome: "restore-failed",
            approvalId,
            path: cp.path,
            reason: back.error,
          };
        }
        if (!back.exists || hashOf(back.content) !== cp.hashBefore) {
          await io.writeFile(cp.path, cp.contentBefore);
        }
      } else {
        await io.writeFile(cp.path, cp.contentBefore);
      }
    }
  } catch (error) {
    return {
      outcome: "restore-failed",
      approvalId,
      path: cp.path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  checkpoints.delete(approvalId);
  return { outcome: "restored", approvalId, path: cp.path };
}
