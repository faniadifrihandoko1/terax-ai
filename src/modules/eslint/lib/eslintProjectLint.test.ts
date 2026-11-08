import { describe, expect, it } from "vitest";
import {
  getProjectLintCounts,
  groupProjectLintResults,
  relativeProjectPath,
  summarizeProjectLintFiles,
} from "./eslintProjectLint";
import { useEslintStore } from "./eslintStore";
import type { EslintFileResult } from "./eslintJson";

function fileResult(
  filePath: string,
  messages: {
    ruleId: string | null;
    severity: 1 | 2;
    message: string;
    line: number;
    column: number;
  }[],
): EslintFileResult {
  return {
    filePath,
    messages,
    errorCount: messages.filter((m) => m.severity === 2).length,
    warningCount: messages.filter((m) => m.severity === 1).length,
    fatalErrorCount: 0,
  };
}

describe("groupProjectLintResults", () => {
  it("drops clean files and sorts files and messages", () => {
    const files = groupProjectLintResults([
      fileResult("/proj/src/b.ts", [
        { ruleId: "r2", severity: 1, message: "warn", line: 5, column: 3 },
        { ruleId: "r1", severity: 2, message: "err", line: 2, column: 1 },
      ]),
      fileResult("/proj/src/a.ts", []),
      fileResult("/proj/src/c.ts", [
        { ruleId: null, severity: 2, message: "fatal", line: 1, column: 1 },
      ]),
    ]);
    expect(files.map((f) => f.path)).toEqual([
      "/proj/src/b.ts",
      "/proj/src/c.ts",
    ]);
    expect(files[0].errors).toBe(1);
    expect(files[0].warnings).toBe(1);
    expect(files[0].messages.map((m) => m.line)).toEqual([2, 5]);
    expect(files[1].errors).toBe(1);
  });

  it("summarizes totals across files", () => {
    const files = groupProjectLintResults([
      fileResult("/proj/a.ts", [
        { ruleId: "r", severity: 2, message: "e", line: 1, column: 1 },
      ]),
      fileResult("/proj/b.ts", [
        { ruleId: "r", severity: 1, message: "w", line: 1, column: 1 },
        { ruleId: "r", severity: 1, message: "w", line: 2, column: 1 },
      ]),
    ]);
    expect(summarizeProjectLintFiles(files)).toEqual({
      errors: 1,
      warnings: 2,
      files: 2,
    });
    expect(summarizeProjectLintFiles([])).toEqual({
      errors: 0,
      warnings: 0,
      files: 0,
    });
  });
});

describe("relativeProjectPath", () => {
  it("strips the project root and normalizes separators", () => {
    expect(relativeProjectPath("/proj", "/proj/src/a.ts")).toBe("src/a.ts");
    expect(relativeProjectPath("/proj/", "/proj/src/a.ts")).toBe("src/a.ts");
    expect(relativeProjectPath("/proj", "C:\\proj\\src\\a.ts")).toBe(
      "C:/proj/src/a.ts",
    );
  });

  it("keeps the full path outside the root", () => {
    expect(relativeProjectPath("/proj", "/other/a.ts")).toBe("/other/a.ts");
    expect(relativeProjectPath("/proj", "/proj-other/a.ts")).toBe(
      "/proj-other/a.ts",
    );
  });
});

describe("getProjectLintCounts", () => {
  it("reads counts from the stored project run", () => {
    const store = useEslintStore.getState();
    store.setProjectLintResults(
      { kind: "ok", root: "/proj", errors: 1, warnings: 1, files: 1, at: 1 },
      groupProjectLintResults([
        fileResult("/proj/src/a.ts", [
          { ruleId: "r", severity: 2, message: "e", line: 1, column: 1 },
          { ruleId: "r", severity: 1, message: "w", line: 2, column: 1 },
        ]),
      ]),
    );
    expect(getProjectLintCounts("/proj/src/a.ts")).toEqual({
      errors: 1,
      warnings: 1,
    });
    expect(getProjectLintCounts("/proj/src/b.ts")).toBeNull();
    store.clearProjectLint();
    expect(getProjectLintCounts("/proj/src/a.ts")).toBeNull();
  });
});
