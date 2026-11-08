import {
  ancestorDirs,
  eslintBinaryFileName,
  joinPosix,
} from "./eslintPaths";

export type EslintDetection =
  | { status: "found"; root: string; binary: string }
  | { status: "missing" };

export type StatFn = (path: string) => Promise<boolean>;

/**
 * Finds the project-installed ESLint for a file by walking up from its
 * directory looking for node_modules/.bin/eslint. Returns the first hit,
 * so a nested monorepo package wins over the workspace root. No install,
 * no network, no global lookup.
 */
export async function detectEslint(
  filePath: string,
  deps: { stat: StatFn; windows: boolean },
): Promise<EslintDetection> {
  const binaryName = eslintBinaryFileName(deps.windows);
  for (const dir of ancestorDirs(filePath)) {
    const binary = joinPosix(dir, "node_modules", ".bin", binaryName);
    if (await deps.stat(binary)) {
      return { status: "found", root: dir, binary };
    }
  }
  return { status: "missing" };
}
