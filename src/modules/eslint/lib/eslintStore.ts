import type { Diagnostic } from "@codemirror/lint";
import { create } from "zustand";

export type EslintRootStatus =
  | { kind: "unknown" }
  | { kind: "found"; root: string; binary: string }
  | { kind: "npx"; root: string }
  | { kind: "missing-binary"; root: string }
  | { kind: "missing-config"; root: string }
  | { kind: "error"; root: string; message: string };

type State = {
  /** Latest ESLint diagnostics per file path (canonical forward-slash). */
  byPath: Record<string, Diagnostic[]>;
  /** Detection / run status per project root. */
  rootStatus: Record<string, EslintRootStatus>;
  /** Roots already shown a missing-ESLint toast this session. */
  notifiedRoots: Record<string, true>;
  setPathDiagnostics: (path: string, diags: Diagnostic[]) => void;
  clearPath: (path: string) => void;
  setRootStatus: (root: string, status: EslintRootStatus) => void;
  markRootNotified: (root: string) => void;
};

export const useEslintStore = create<State>((set) => ({
  byPath: {},
  rootStatus: {},
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
  markRootNotified: (root) =>
    set((s) => ({ notifiedRoots: { ...s.notifiedRoots, [root]: true } })),
}));
