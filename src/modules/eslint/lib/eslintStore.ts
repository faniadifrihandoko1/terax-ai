import type { Diagnostic } from "@codemirror/lint";
import { create } from "zustand";

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
  /** Latest ESLint diagnostics per file path (canonical forward-slash). */
  byPath: Record<string, Diagnostic[]>;
  /** Detection / run status per project root. */
  rootStatus: Record<string, EslintRootStatus>;
  /** Last run outcome per file path (canonical forward-slash). */
  runStatus: Record<string, EslintRunStatus>;
  /** Roots already shown an ESLint-problem toast this session
   * (missing binary/config, or a failed run). */
  notifiedRoots: Record<string, true>;
  setPathDiagnostics: (path: string, diags: Diagnostic[]) => void;
  clearPath: (path: string) => void;
  setRootStatus: (root: string, status: EslintRootStatus) => void;
  setRunStatus: (path: string, status: EslintRunStatus) => void;
  clearRunStatus: (path: string) => void;
  markRootNotified: (root: string) => void;
};

export const useEslintStore = create<State>((set) => ({
  byPath: {},
  rootStatus: {},
  runStatus: {},
  notifiedRoots: {},
  setPathDiagnostics: (path, diags) =>
    set((s) => ({ byPath: { ...s.byPath, [path]: diags } })),
  clearPath: (path) =>
    set((s) => {
      if (!(path in s.byPath)) return s;
      const byPath = { ...s.byPath };
      delete byPath[path];
      return { byPath };
    }),
  setRootStatus: (root, status) =>
    set((s) => ({ rootStatus: { ...s.rootStatus, [root]: status } })),
  setRunStatus: (path, status) =>
    set((s) => ({ runStatus: { ...s.runStatus, [path]: status } })),
  clearRunStatus: (path) =>
    set((s) => {
      if (!(path in s.runStatus)) return s;
      const runStatus = { ...s.runStatus };
      delete runStatus[path];
      return { runStatus };
    }),
  markRootNotified: (root) =>
    set((s) => ({ notifiedRoots: { ...s.notifiedRoots, [root]: true } })),
}));
