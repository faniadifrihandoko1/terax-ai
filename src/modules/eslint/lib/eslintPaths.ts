/** Extensions ESLint can lint with a stock JS/TS setup. */
export const LINTABLE_EXTENSIONS: readonly string[] = [
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
];

export function isLintablePath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return LINTABLE_EXTENSIONS.includes(base.slice(dot + 1).toLowerCase());
}

/** Forward-slash canonical form, matching the rest of the frontend. */
export function canonicalPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function dirnameOf(path: string): string {
  const clean = canonicalPath(path);
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return clean.slice(0, idx);
}

/**
 * Ancestor directories of a file, innermost first, bounded so a walk
 * never climbs past the filesystem root.
 */
export function ancestorDirs(filePath: string, maxDepth = 12): string[] {
  const out: string[] = [];
  let dir = dirnameOf(filePath);
  while (dir && out.length < maxDepth) {
    out.push(dir);
    const parent = dirnameOf(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function eslintBinaryFileName(windows: boolean): string {
  return windows ? "eslint.cmd" : "eslint";
}

export function joinPosix(...parts: string[]): string {
  return parts
    .map((p, i) => {
      const clean = canonicalPath(p);
      if (i === 0) return clean.replace(/\/+$/, "");
      return clean.replace(/^\/+|\/+$/g, "");
    })
    .filter((p) => p !== "")
    .join("/");
}
