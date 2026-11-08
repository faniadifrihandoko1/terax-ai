import { canonicalPath, eslintPathKey } from "./eslintPaths";
import { useEslintStore } from "./eslintStore";
import type { EslintFileResult, EslintMessage } from "./eslintJson";

/**
 * One file with problems from a project-wide lint run. Counts are
 * derived from the messages themselves, so the panel rows and the
 * totals can never disagree. Paths keep the form ESLint returned
 * them in (displayed as-is); lookups use `eslintPathKey`.
 */
export type EslintProjectLintFile = {
  path: string;
  errors: number;
  warnings: number;
  messages: EslintMessage[];
};

/**
 * Last project-wide lint outcome for one project root. `files` lives
 * next to the status in the store; the status alone answers "what
 * happened" and the files answer "where". `startedAt`/`at` are
 * `Date.now()` values: a stale async completion must not overwrite a
 * newer run, and the panel shows how old a snapshot is.
 */
export type EslintProjectLintStatus =
  | { kind: "idle" }
  | { kind: "running"; root: string; startedAt: number }
  | {
      kind: "ok";
      root: string;
      errors: number;
      warnings: number;
      files: number;
      at: number;
    }
  | { kind: "failed"; root: string; message: string; at: number }
  | { kind: "timeout"; root: string; at: number }
  | {
      kind: "missing-binary";
      root: string;
      searchedLevels: number;
      truncatedByCap: boolean;
      controlStatFailed: boolean;
      at: number;
    }
  | { kind: "missing-config"; root: string; at: number }
  | { kind: "truncated"; root: string; at: number };

/**
 * Turns raw `eslint --format json` results into the panel's file
 * list: only files with at least one message, files sorted by
 * canonical path, messages sorted by position. Clean files are
 * dropped here (the panel has nothing to show for them); the
 * orchestrator clears their old explorer counts separately.
 */
export function groupProjectLintResults(
  results: readonly EslintFileResult[],
): EslintProjectLintFile[] {
  const files: EslintProjectLintFile[] = [];
  for (const result of results) {
    if (result.messages.length === 0) continue;
    const messages = [...result.messages].sort(
      (a, b) => a.line - b.line || a.column - b.column,
    );
    let errors = 0;
    let warnings = 0;
    for (const m of messages) {
      if (m.severity === 2) errors += 1;
      else warnings += 1;
    }
    files.push({ path: result.filePath, errors, warnings, messages });
  }
  files.sort((a, b) =>
    eslintPathKey(a.path) < eslintPathKey(b.path) ? -1 : 1,
  );
  return files;
}

export function summarizeProjectLintFiles(
  files: readonly EslintProjectLintFile[],
): { errors: number; warnings: number; files: number } {
  let errors = 0;
  let warnings = 0;
  for (const file of files) {
    errors += file.errors;
    warnings += file.warnings;
  }
  return { errors, warnings, files: files.length };
}

/**
 * Display form of a linted path: relative to the project root when
 * the file is inside it, otherwise the full path. Never used as a
 * map key or passed to fs commands.
 */
export function relativeProjectPath(root: string, path: string): string {
  const cleanRoot = canonicalPath(root).replace(/\/+$/, "");
  const cleanPath = canonicalPath(path);
  const prefix = `${cleanRoot}/`;
  if (cleanPath.startsWith(prefix)) return cleanPath.slice(prefix.length);
  return cleanPath;
}

/**
 * Explorer counts for one path from the last project-wide run, or
 * null when the run found nothing for it. The editor's unmount
 * cleanup uses this to restore the project-wide badge instead of
 * wiping the counts when a tab closes.
 */
export function getProjectLintCounts(
  path: string,
): { errors: number; warnings: number } | null {
  const key = eslintPathKey(path);
  const file = useEslintStore
    .getState()
    .projectLint.files.find((f) => eslintPathKey(f.path) === key);
  if (!file) return null;
  return { errors: file.errors, warnings: file.warnings };
}
