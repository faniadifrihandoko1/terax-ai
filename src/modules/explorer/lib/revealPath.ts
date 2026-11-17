/**
 * Auto-reveal helpers (Fase 27): expand the sidebar to the active file.
 *
 * The explorer already syncs selection + scroll for the active file, but
 * only when the file is already visible in the tree (its ancestors are
 * expanded and loaded). For a file inside collapsed folders the sync
 * effect silently did nothing — there was no step that expands the
 * ancestors first. These pure helpers compute that step.
 *
 * Separator convention: the tree builds child paths with joinPath
 * (forward slashes) from whatever rootPath string it was given, so
 * ancestor keys must be rebuilt from that same rootPath string verbatim.
 * Only the *comparison* normalizes separators (and drive-letter case):
 * tab paths on Windows may still carry backslashes.
 */

/** Backslashes to slashes, trailing separators stripped ("/" stays "/"). */
export function normalizeExplorerPath(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  if (slashed.length > 1) return slashed.replace(/\/+$/, "");
  return slashed;
}

/**
 * The path segments of `filePath` below `rootPath`, or null when the file
 * is not under the root. The root-prefix match is case-insensitive (a
 * Windows `C:` vs `c:` must not block the reveal); the returned segments
 * keep the file path's own casing.
 */
export function relativeSegments(
  filePath: string,
  rootPath: string,
): string[] | null {
  const file = normalizeExplorerPath(filePath);
  const root = normalizeExplorerPath(rootPath);
  if (file.toLowerCase() === root.toLowerCase()) return [];
  const prefix = root === "/" ? "/" : `${root}/`;
  if (file.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return null;
  }
  return file.slice(prefix.length).split("/");
}

/**
 * Every ancestor directory of `filePath` below `rootPath`, top-down,
 * excluding the root itself and the file. Built from the rootPath string
 * verbatim (only trailing separators stripped) so the result matches the
 * keys the tree uses (`joinPath(rootPath, name)`). Returns [] when the
 * file is the root, sits directly under it, or is outside it.
 */
export function ancestorDirs(filePath: string, rootPath: string): string[] {
  const segments = relativeSegments(filePath, rootPath);
  if (!segments || segments.length <= 1) return [];
  const base = rootPath.replace(/[\\/]+$/, "") || "/";
  const out: string[] = [];
  let curr = base;
  for (const segment of segments.slice(0, -1)) {
    curr = curr.endsWith("/") ? `${curr}${segment}` : `${curr}/${segment}`;
    out.push(curr);
  }
  return out;
}
