import type { Diagnostic } from "@codemirror/lint";
import { describe, expect, it } from "vitest";
import { ESLINT_SOURCE } from "./eslintJson";
import {
  countDiagnostics,
  diagnosticsEqual,
  mergeDiagnostics,
} from "./eslintMerge";
import { useEslintStore } from "./eslintStore";

const diag = (
  from: number,
  to: number,
  source?: string,
  severity: Diagnostic["severity"] = "error",
): Diagnostic => ({ from, to, severity, message: `m${from}`, source });

describe("mergeDiagnostics", () => {
  it("keeps non-ESLint diagnostics and replaces ESLint ones", () => {
    const existing = [
      diag(0, 5),
      diag(10, 12, ESLINT_SOURCE),
      diag(20, 25, "tsls"),
    ];
    const merged = mergeDiagnostics(existing, [diag(10, 14, ESLINT_SOURCE)]);
    expect(merged.map((d) => [d.from, d.to, d.source])).toEqual([
      [0, 5, undefined],
      [10, 14, ESLINT_SOURCE],
      [20, 25, "tsls"],
    ]);
  });

  it("clears ESLint diagnostics when the new run is clean", () => {
    const merged = mergeDiagnostics([diag(0, 5), diag(10, 12, ESLINT_SOURCE)], []);
    expect(merged).toEqual([diag(0, 5)]);
  });

  it("sorts by position", () => {
    const merged = mergeDiagnostics([diag(20, 25)], [diag(2, 4, ESLINT_SOURCE)]);
    expect(merged[0].from).toBe(2);
    expect(merged[1].from).toBe(20);
  });
});

describe("diagnosticsEqual", () => {
  it("compares by value, not identity", () => {
    expect(diagnosticsEqual([diag(0, 5)], [diag(0, 5)])).toBe(true);
    expect(diagnosticsEqual([diag(0, 5)], [diag(0, 6)])).toBe(false);
    expect(
      diagnosticsEqual([diag(0, 5, ESLINT_SOURCE)], [diag(0, 5)]),
    ).toBe(false);
    expect(diagnosticsEqual([], [])).toBe(true);
  });
});

describe("countDiagnostics", () => {
  it("counts errors and warnings, ignores info", () => {
    expect(
      countDiagnostics([
        diag(0, 1, undefined, "error"),
        diag(2, 3, undefined, "warning"),
        diag(4, 5, undefined, "info"),
      ]),
    ).toEqual({ errors: 1, warnings: 1 });
  });
});

describe("useEslintStore", () => {
  it("sets, clears and tracks root status", () => {
    const s = useEslintStore.getState();
    s.setPathDiagnostics("/proj/a.ts", [diag(0, 5, ESLINT_SOURCE)]);
    expect(useEslintStore.getState().byPath["/proj/a.ts"]).toHaveLength(1);
    s.clearPath("/proj/a.ts");
    expect(useEslintStore.getState().byPath["/proj/a.ts"]).toBeUndefined();
    s.setRootStatus("/proj", { kind: "missing-binary", root: "/proj" });
    expect(useEslintStore.getState().rootStatus["/proj"].kind).toBe(
      "missing-binary",
    );
    s.markRootNotified("/proj");
    expect(useEslintStore.getState().notifiedRoots["/proj"]).toBe(true);
  });
});
