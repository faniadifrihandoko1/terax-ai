import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  ESLINT_SOURCE,
  eslintMessagesToDiagnostics,
  findResultForFile,
  parseEslintJsonOutput,
  type EslintMessage,
} from "./eslintJson";

describe("parseEslintJsonOutput", () => {
  it("parses a normal result list", () => {
    const out = parseEslintJsonOutput(
      JSON.stringify([
        {
          filePath: "/proj/a.ts",
          messages: [
            {
              ruleId: "no-unused-vars",
              severity: 2,
              message: "'x' is defined but never used.",
              line: 1,
              column: 5,
              endLine: 1,
              endColumn: 6,
            },
          ],
          errorCount: 1,
          warningCount: 0,
          fatalErrorCount: 0,
        },
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe("/proj/a.ts");
    expect(out[0].messages[0].ruleId).toBe("no-unused-vars");
  });

  it("parses an empty result list", () => {
    expect(parseEslintJsonOutput("[]")).toEqual([]);
  });

  it("throws on non-JSON output", () => {
    expect(() => parseEslintJsonOutput("not json")).toThrow(
      "not valid JSON",
    );
  });

  it("throws on a non-array document", () => {
    expect(() => parseEslintJsonOutput("{}")).toThrow("not an array");
  });

  it("defaults missing counts and tolerates a null ruleId", () => {
    const out = parseEslintJsonOutput(
      JSON.stringify([
        {
          filePath: "/proj/a.ts",
          messages: [
            {
              ruleId: null,
              severity: 1,
              message: "Unexpected console statement.",
              line: 2,
              column: 3,
            },
          ],
        },
      ]),
    );
    expect(out[0].errorCount).toBe(0);
    expect(out[0].messages[0].ruleId).toBeNull();
  });
});

describe("eslintMessagesToDiagnostics", () => {
  const doc = Text.of(["const x = 1;", "  console.log(x);", ""]);

  const msg = (over: Partial<EslintMessage>): EslintMessage => ({
    ruleId: "no-console",
    severity: 2,
    message: "Unexpected console statement.",
    line: 2,
    column: 3,
    ...over,
  });

  it("maps error severity and 1-based positions", () => {
    const diags = eslintMessagesToDiagnostics(doc, [
      msg({ endLine: 2, endColumn: 14 }),
    ]);
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].source).toBe(ESLINT_SOURCE);
    expect(diags[0].message).toContain("no-console");
    expect(diags[0].from).toBe(doc.line(2).from + 2);
    expect(diags[0].to).toBe(doc.line(2).from + 13);
  });

  it("maps severity 1 to warning and extends a missing end by one char", () => {
    const diags = eslintMessagesToDiagnostics(doc, [
      msg({ severity: 1, endLine: undefined, endColumn: undefined }),
    ]);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].to).toBe(diags[0].from + 1);
  });

  it("clamps out-of-range lines and columns", () => {
    const diags = eslintMessagesToDiagnostics(doc, [
      msg({ line: 2, column: 99, endLine: undefined, endColumn: undefined }),
      msg({ line: 0, column: 0 }),
    ]);
    expect(diags).toHaveLength(2);
    for (const d of diags) {
      expect(d.from).toBeGreaterThanOrEqual(0);
      expect(d.to).toBeLessThanOrEqual(doc.length);
      expect(d.to).toBeGreaterThan(d.from);
    }
  });

  it("skips a message that clamps onto an empty line", () => {
    const diags = eslintMessagesToDiagnostics(doc, [msg({ line: 99 })]);
    expect(diags).toHaveLength(0);
  });

  it("skips a message on an empty line", () => {
    const diags = eslintMessagesToDiagnostics(doc, [msg({ line: 3 })]);
    expect(diags).toHaveLength(0);
  });

  it("sorts by position", () => {
    const diags = eslintMessagesToDiagnostics(doc, [
      msg({ line: 2, column: 10 }),
      msg({ line: 1, column: 1 }),
    ]);
    expect(diags[0].from).toBeLessThan(diags[1].from);
  });

  it("keeps the raw message when ruleId is null", () => {
    const diags = eslintMessagesToDiagnostics(doc, [msg({ ruleId: null })]);
    expect(diags[0].message).toBe("Unexpected console statement.");
  });
});

describe("findResultForFile", () => {
  const results = [
    {
      filePath: "C:\\proj\\src\\a.ts",
      messages: [],
      errorCount: 0,
      warningCount: 0,
      fatalErrorCount: 0,
    },
  ];

  it("matches across Windows separators", () => {
    expect(findResultForFile(results, "C:/proj/src/a.ts")).toBe(
      results[0],
    );
  });

  it("returns undefined when ESLint reports a different path", () => {
    expect(findResultForFile(results, "C:/proj/src/b.ts")).toBeUndefined();
    expect(findResultForFile([], "C:/proj/src/a.ts")).toBeUndefined();
  });

  it("does not match across case differences off Windows", () => {
    // On a case-sensitive filesystem a case-different echo means the
    // result is for a different spelling of the path, and the plugin
    // must say so instead of silently showing zero diagnostics.
    expect(findResultForFile(results, "c:/proj/src/a.ts", false)).toBeUndefined();
  });

  it("matches across case differences on Windows", () => {
    // Windows is case-insensitive but case-preserving: ESLint may
    // echo the drive letter or a segment with different casing.
    expect(findResultForFile(results, "c:/proj/src/a.ts", true)).toBe(
      results[0],
    );
    expect(findResultForFile(results, "C:/PROJ/SRC/A.TS", true)).toBe(
      results[0],
    );
    expect(findResultForFile(results, "C:\\PROJ\\src\\a.ts", true)).toBe(
      results[0],
    );
  });

  it("still rejects a genuinely different file on Windows", () => {
    expect(findResultForFile(results, "C:/proj/src/b.ts", true)).toBeUndefined();
    expect(findResultForFile(results, "C:/other/src/a.ts", true)).toBeUndefined();
  });
});
