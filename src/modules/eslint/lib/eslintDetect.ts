import {
  ANCESTOR_MAX_DEPTH,
  ancestorDirs,
  dirnameOf,
  eslintBinaryFileName,
  joinPosix,
} from "./eslintPaths";

export type EslintDetection =
  | { status: "found"; root: string; binary: string }
  | {
      status: "missing";
      /** How many ancestor directories were checked. */
      searchedLevels: number;
      /** True when the walk hit the depth cap before the filesystem root. */
      truncatedByCap: boolean;
      /** True when even the file's own directory could not be statted. */
      controlStatFailed: boolean;
    };

export type StatFn = (path: string) => Promise<boolean>;

/**
 * Finds the project-installed ESLint for a file by walking up from its
 * directory looking for node_modules/.bin/eslint. Returns the first hit,
 * so a nested monorepo package wins over the workspace root. No install,
 * no network, no global lookup.
 *
 * A miss carries a diagnosis so the caller can tell the cases apart:
 * the walk hit the depth cap (file too deep), the filesystem could not
 * even see the file's own directory (control stat failed — non-ASCII
 * path, synced folder, permissions), or the binary is genuinely absent.
 */
export async function detectEslint(
  filePath: string,
  deps: { stat: StatFn; windows: boolean },
): Promise<EslintDetection> {
  const binaryName = eslintBinaryFileName(deps.windows);
  const dirs = ancestorDirs(filePath);
  // Control probe: the file's own directory must exist. If even that
  // stat fails, fs_stat cannot see paths under this project at all —
  // a different failure from "no eslint installed".
  const controlStatFailed =
    dirs.length > 0 && !(await deps.stat(dirs[0]));
  for (const dir of dirs) {
    const binary = joinPosix(dir, "node_modules", ".bin", binaryName);
    if (await deps.stat(binary)) {
      return { status: "found", root: dir, binary };
    }
  }
  const last = dirs[dirs.length - 1];
  const truncatedByCap =
    dirs.length >= ANCESTOR_MAX_DEPTH &&
    last !== undefined &&
    dirnameOf(last) !== last;
  return {
    status: "missing",
    searchedLevels: dirs.length,
    truncatedByCap,
    controlStatFailed,
  };
}
