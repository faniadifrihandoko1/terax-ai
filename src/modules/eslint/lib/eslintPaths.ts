import { IS_WINDOWS } from "@/lib/platform";

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

/**
 * Map-key form of a file path. Forward slashes, and on Windows folded
 * to lowercase: the filesystem is case-insensitive but case-preserving,
 * so the same file can arrive as `C:\Proj\…` from one source and
 * `c:/proj/…` from another, and those must not become two different
 * listeners, store entries, or run statuses. Only ever a map key —
 * never displayed, and never passed to a fs command.
 */
export function eslintPathKey(path: string, windows: boolean = IS_WINDOWS): string {
  const slash = canonicalPath(path);
  return windows ? slash.toLowerCase() : slash;
}

export function dirnameOf(path: string): string {
  const clean = canonicalPath(path);
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return clean.slice(0, idx);
}

/** Maximum ancestor levels `detectEslint` climbs looking for a binary. */
export const ANCESTOR_MAX_DEPTH = 12;

/**
 * Ancestor directories of a file, innermost first, bounded so a walk
 * never climbs past the filesystem root.
 */
export function ancestorDirs(
  filePath: string,
  maxDepth = ANCESTOR_MAX_DEPTH,
): string[] {
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
