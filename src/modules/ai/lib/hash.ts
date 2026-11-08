/**
 * Shared djb2 hash.
 *
 * Previously this function lived in three places at once
 * (`reviewApply.ts`, `reviewCheckpoint.ts`, `tools/fs.ts`), each copy
 * carrying a "kept in sync by hand" comment. A hash that drifts between
 * copies silently breaks the guards that depend on it: the FR-07
 * conflict guard compares a freshly read hash against a stored one, and
 * the checkpoint guards do the same. One copy, imported everywhere,
 * removes that drift risk.
 *
 * The output is part of persisted review state (v1-v3 checkpoints store
 * hashes), so this function must NEVER change its output for the same
 * input. `hash.test.ts` locks known values; changing the algorithm
 * requires a persistence migration, not a silent edit.
 *
 * djb2 is enough here because the comparison is always against content
 * we read back a moment later, not against untrusted input — it is a
 * change detector, not a security hash.
 */
export function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}
