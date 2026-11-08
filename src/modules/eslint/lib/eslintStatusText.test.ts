import { describe, expect, it } from "vitest";
import {
  describeEslintProjectLintStatus,
  describeEslintRunStatus,
  isTerminalEslintRunStatus,
} from "./eslintStatusText";

describe("describeEslintRunStatus", () => {
  it("reports a clean run", () => {
    const text = describeEslintRunStatus({
      kind: "ok",
      errors: 0,
      warnings: 0,
    });
    expect(text.label).toBe("ESLint: bersih");
    expect(text.tone).toBe("ok");
  });

  it("counts errors and warnings", () => {
    const text = describeEslintRunStatus({
      kind: "ok",
      errors: 1,
      warnings: 1,
    });
    expect(text.label).toBe("ESLint: 1 error · 1 warning");
    expect(text.tone).toBe("error");
    const warnOnly = describeEslintRunStatus({
      kind: "ok",
      errors: 0,
      warnings: 2,
    });
    expect(warnOnly.label).toBe("ESLint: 2 warning");
    expect(warnOnly.tone).toBe("warn");
  });

  it("explains a truncated ancestor walk", () => {
    const text = describeEslintRunStatus({
      kind: "missing-binary",
      root: "/proj/src",
      searchedLevels: 12,
      truncatedByCap: true,
      controlStatFailed: false,
    });
    expect(text.detail).toContain("12 level");
    expect(text.detail).toContain("mencapai batas");
    expect(text.tone).toBe("warn");
  });

  it("calls out a failed control stat", () => {
    const text = describeEslintRunStatus({
      kind: "missing-binary",
      root: "/proj/src",
      searchedLevels: 12,
      truncatedByCap: false,
      controlStatFailed: true,
    });
    expect(text.detail).toContain("fs_stat gagal");
    expect(text.detail).toContain("OneDrive");
  });

  it("names both paths on a result mismatch", () => {
    const text = describeEslintRunStatus({
      kind: "no-result-match",
      filePath: "/proj/src/a.ts",
      returnedPaths: ["/PROJ/src/a.ts"],
    });
    expect(text.detail).toContain("/proj/src/a.ts");
    expect(text.detail).toContain("/PROJ/src/a.ts");
    expect(text.tone).toBe("error");
  });

  it("covers the silent exits", () => {
    expect(
      describeEslintRunStatus({ kind: "skipped-dirty" }).label,
    ).toContain("menunggu save");
    expect(
      describeEslintRunStatus({ kind: "disk-read-failed" }).tone,
    ).toBe("error");
    expect(
      describeEslintRunStatus({ kind: "aborted-doc-changed" }).tone,
    ).toBe("muted");
    expect(
      describeEslintRunStatus({ kind: "timeout", root: "/proj" }).tone,
    ).toBe("error");
  });
});

describe("isTerminalEslintRunStatus", () => {
  it("only 'running' is non-terminal", () => {
    expect(isTerminalEslintRunStatus({ kind: "running" })).toBe(false);
    expect(
      isTerminalEslintRunStatus({ kind: "ok", errors: 0, warnings: 0 }),
    ).toBe(true);
    expect(isTerminalEslintRunStatus({ kind: "skipped-dirty" })).toBe(
      true,
    );
    expect(isTerminalEslintRunStatus({ kind: "aborted-doc-changed" })).toBe(
      true,
    );
  });
});

describe("describeEslintProjectLintStatus", () => {
  it("summarizes totals for a finished run", () => {
    const text = describeEslintProjectLintStatus({
      kind: "ok",
      root: "/proj",
      errors: 2,
      warnings: 1,
      files: 2,
      at: 1,
    });
    expect(text.label).toBe("2 error · 1 warning di 2 file");
    expect(text.tone).toBe("error");
    expect(
      describeEslintProjectLintStatus({
        kind: "ok",
        root: "/proj",
        errors: 0,
        warnings: 0,
        files: 0,
        at: 1,
      }).label,
    ).toBe("ESLint project bersih");
  });

  it("names the truncated outcome as incomplete", () => {
    const text = describeEslintProjectLintStatus({
      kind: "truncated",
      root: "/proj",
      at: 1,
    });
    expect(text.label).toContain("tidak lengkap");
    expect(text.detail).toContain("256 KiB");
    expect(text.tone).toBe("warn");
  });

  it("reuses the per-file wording for missing binary and config", () => {
    const missing = describeEslintProjectLintStatus({
      kind: "missing-binary",
      root: "/proj",
      searchedLevels: 1,
      truncatedByCap: false,
      controlStatFailed: false,
      at: 1,
    });
    expect(missing.label).toBe("ESLint: binary tidak ditemukan");
    expect(
      describeEslintProjectLintStatus({
        kind: "missing-config",
        root: "/proj",
        at: 1,
      }).label,
    ).toBe("ESLint: tidak ada config");
  });
});
