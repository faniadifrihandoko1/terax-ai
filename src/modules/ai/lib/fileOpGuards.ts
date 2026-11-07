/**
 * Pure guards for the delete/rename file operations (Fase 5).
 *
 * The AI tools in fs.ts and the reviewed-apply path in reviewApply.ts
 * share these decisions, so a guard failure means the same thing in
 * both places: the operation is refused with a reason, never executed.
 * Nothing here touches the disk; callers supply what they read.
 */

export type GuardResult = { ok: true } | { ok: false; reason: string };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

/**
 * Delete guard: the file must exist and its current content hash must
 * still match what the agent saw when it proposed the delete (the
 * readCache hash from its prior read_file, or the proposal baseline).
 * A mismatch means someone changed the file after the proposal, so
 * deleting it now would destroy unseen work.
 */
export function checkDeleteGuard(input: {
  exists: boolean;
  currentHash: number | null;
  seenHash: number | null;
}): GuardResult {
  if (!input.exists) return fail("file no longer exists");
  if (input.seenHash === null) {
    return fail("read the file before deleting it");
  }
  if (input.currentHash === null) {
    return fail("could not read the file to verify it");
  }
  if (input.currentHash !== input.seenHash) {
    return fail("file changed since it was read");
  }
  return { ok: true };
}

/**
 * Rename guard: the source must exist, the target must not exist (never
 * silently overwrite another file), and the target must stay inside the
 * workspace.
 */
export function checkRenameGuard(input: {
  sourceExists: boolean;
  targetExists: boolean;
  targetInsideWorkspace: boolean;
}): GuardResult {
  if (!input.sourceExists) return fail("source file no longer exists");
  if (input.targetExists) {
    return fail("target already exists, refusing to overwrite it");
  }
  if (!input.targetInsideWorkspace) {
    return fail("target is outside the workspace");
  }
  return { ok: true };
}

/**
 * Lexical containment check on already-canonical paths: true when
 * `candidate` is the root itself or lives under it, compared segment by
 * segment so `/workspace2` is not "inside" `/workspace`.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const split = (p: string) =>
    p
      .replace(/\\/g, "/")
      .replace(/^[a-zA-Z]:/, "")
      .split("/")
      .filter((seg) => seg.length > 0 && seg !== ".");
  const resolve = (segs: string[]): string[] => {
    const out: string[] = [];
    for (const seg of segs) {
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return out;
  };
  const rootSegs = resolve(split(root));
  const candSegs = resolve(split(candidate));
  if (candSegs.length < rootSegs.length) return false;
  return rootSegs.every((seg, i) => candSegs[i] === seg);
}
