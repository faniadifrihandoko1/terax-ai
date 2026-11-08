import type { Diagnostic } from "@codemirror/lint";
import { create } from "zustand";
import { eslintPathKey } from "./eslintPaths";
import type {
  EslintProjectLintFile,
  EslintProjectLintStatus,
} from "./eslintProjectLint";

export type EslintRootStatus =
  | { kind: "unknown" }
  | { kind: "found"; root: string; binary: string }
  | { kind: "npx"; root: string }
  | { kind: "missing-binary"; root: string }
  | { kind: "missing-config"; root: string }
  | { kind: "error"; root: string; message: string };

/**
 * Last ESLint run outcome for one file path. Every exit of
 * `EslintPlugin.run()` records one — including the silent exits
 * (skipped-dirty, disk-read-failed, aborted-doc-changed,
 * no-result-match) — so a run that produces no diagnostics still
 * leaves a visible trace in the status bar.
 */
export type EslintRunStatus =
  | { kind: "running" }
  | { kind: "ok"; errors: number; warnings: number }
  | {
      kind: "missing-binary";
      root: string;
      searchedLevels: number;
      truncatedByCap: boolean;
      controlStatFailed: boolean;
    }
  | { kind: "missing-config"; root: string }
  | { kind: "failed"; root: string; message: string }
  | { kind: "timeout"; root: string }
  | { kind: "skipped-dirty" }
  | { kind: "disk-read-failed" }
  | { kind: "aborted-doc-changed" }
  | { kind: "no-result-match"; filePath: string; returnedPaths: string[] };

type State = {
  /**
   * Latest ESLint diagnostics per file path, keyed by
   * `eslintPathKey` (forward slashes, lowercased on Windows) so a
   * path that arrives in a different form still hits the same entry.
   * Readers must look up with `eslintPathKey` too.
   */
  byPath: Record<string, Diagnostic[]>;
  /** Detection / run status per project root. */
  rootStatus: Record<string, EslintRootStatus>;
  /**
   * Last run outcome per file path, keyed by `eslintPathKey` like
   * `byPath` above.
   */
  runStatus: Record<string, EslintRunStatus>;
  /** Roots already shown an ESLint-problem toast this session
   * (missing binary/config, or a failed run). */
  notifiedRoots: Record<string, true>;
  /**
   * Last project-wide lint for one root: the outcome plus the files
   * with problems, sorted by path. The Problems panel renders this
   * directly, and the explorer counts for closed files come from it.
   * A run for another root does not clear this; the panel compares
   * `status.root` with the current root and says so.
   */
  projectLint: {
    status: EslintProjectLintStatus;
    files: EslintProjectLintFile[];
  };
  setPathDiagnostics: (path: string, diags: Diagnostic[]) => void;
  clearPath: (path: string) => void;
  setRootStatus: (root: string, status: EslintRootStatus) => void;
  setRunStatus: (path: string, status: EslintRunStatus) => void;
  clearRunStatus: (path: string) => void;
  markRootNotified: (root: string) => void;
  setProjectLintStatus: (status: EslintProjectLintStatus) => void;
  setProjectLintResults: (
    status: EslintProjectLintStatus,
    files: EslintProjectLintFile[],
  ) => void;
  clearProjectLint: () => void;
};

export const useEslintStore = create<State>((set) => ({
  byPath: {},
  rootStatus: {},
  runStatus: {},
  notifiedRoots: {},
  projectLint: { status: { kind: "idle" }, files: [] },
  setPathDiagnostics: (path, diags) =>
    set((s) => ({
      byPath: { ...s.byPath, [eslintPathKey(path)]: diags },
    })),
  clearPath: (path) =>
    set((s) => {
      const key = eslintPathKey(path);
      if (!(key in s.byPath)) return s;
      const byPath = { ...s.byPath };
      delete byPath[key];
      return { byPath };
    }),
  setRootStatus: (root, status) =>
    set((s) => ({ rootStatus: { ...s.rootStatus, [root]: status } })),
  setRunStatus: (path, status) =>
    set((s) => ({
      runStatus: { ...s.runStatus, [eslintPathKey(path)]: status },
    })),
  clearRunStatus: (path) =>
    set((s) => {
      const key = eslintPathKey(path);
      if (!(key in s.runStatus)) return s;
      const runStatus = { ...s.runStatus };
      delete runStatus[key];
      return { runStatus };
    }),
  markRootNotified: (root) =>
    set((s) => ({ notifiedRoots: { ...s.notifiedRoots, [root]: true } })),
  setProjectLintStatus: (status) =>
    set((s) => ({ projectLint: { ...s.projectLint, status } })),
  setProjectLintResults: (status, files) =>
    set(() => ({ projectLint: { status, files } })),
  clearProjectLint: () =>
    set(() => ({ projectLint: { status: { kind: "idle" }, files: [] } })),
}));
