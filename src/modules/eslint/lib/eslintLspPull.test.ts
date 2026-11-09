import { describe, expect, it } from "vitest";
import type { DocLike } from "./eslintJson";
import { mergeDiagnostics } from "./eslintMerge";
import { mapLspDiagnosticsToCodeMirror } from "./eslintLspPull";

/** Minimal Text-like doc built from raw text (1-based lines). */
function docFromText(text: string): DocLike {
  const lines = text.split("\n");
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  return {
    length: text.length,
    lines: lines.length,
    line(n: number) {
      const from = starts[n - 1];
      const to = n < lines.length ? starts[n] - 1 : text.length;
      return { from, to };
    },
  };
}

const doc = docFromText(
  "const a = 1;\nconst b = 2;\nconst unused = 3;\nconst d = 4;",
);

describe("mapLspDiagnosticsToCodeMirror", () => {
  it("maps an error with a rule id to the same shape as the CLI mapper", () => {
    const diags = mapLspDiagnosticsToCodeMirror(doc, [
      {
        range: {
          start: { line: 2, character: 6 },
          end: { line: 2, character: 12 },
        },
        severity: 1,
        code: "@typescript-eslint/no-unused-vars",
        message: "'unused' is assigned a value but never used",
      },
    ]);
    expect(diags).toEqual([
      {
        from: 32,
        to: 38,
        severity: "error",
        message:
          "'unused' is assigned a value but never used (@typescript-eslint/no-unused-vars)",
        source: "eslint",
      },
    ]);
  });

  it("maps warning and info severities, and a message without a rule", () => {
    const diags = mapLspDiagnosticsToCodeMirror(doc, [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        severity: 2,
        message: "warn",
      },
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 5 },
        },
        severity: 3,
        message: "info",
      },
    ]);
    expect(diags.map((d) => [d.severity, d.message])).toEqual([
      ["warning", "warn"],
      ["info", "info"],
    ]);
  });

  it("reads a rule id from a numeric or object code", () => {
    const diags = mapLspDiagnosticsToCodeMirror(doc, [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        severity: 1,
        code: 123,
        message: "numeric",
      },
      {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 5 },
        },
        severity: 1,
        code: { value: "object-rule" },
        message: "object",
      },
    ]);
    expect(diags.map((d) => d.message)).toEqual([
      "numeric (123)",
      "object (object-rule)",
    ]);
  });

  it("clamps out-of-range positions and widens a zero-length range", () => {
    const diags = mapLspDiagnosticsToCodeMirror(doc, [
      {
        range: {
          start: { line: 99, character: 99 },
          end: { line: 99, character: 99 },
        },
        severity: 1,
        message: "past the end",
      },
    ]);
    // Last line is "const d = 4;" (from 44 to 56); a zero-length
    // range at its end underlines the last character (";").
    expect(diags).toHaveLength(1);
    expect(diags[0].from).toBe(55);
    expect(diags[0].to).toBe(56);
  });
});

describe("pull results merged with the other server's diagnostics", () => {
  it("a second pull replaces the first pull's entries, TS entries survive", () => {
    const ts = {
      from: 0,
      to: 5,
      severity: "error" as const,
      message: "Cannot find name 'x'",
    };
    const pullV1 = mapLspDiagnosticsToCodeMirror(doc, [
      {
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 7 },
        },
        severity: 1,
        code: "rule-a",
        message: "first",
      },
    ]);
    const mergedV1 = mergeDiagnostics([ts], pullV1);
    expect(mergedV1).toHaveLength(2);

    const pullV2 = mapLspDiagnosticsToCodeMirror(doc, [
      {
        range: {
          start: { line: 1, character: 6 },
          end: { line: 1, character: 7 },
        },
        severity: 2,
        code: "rule-b",
        message: "second",
      },
    ]);
    const mergedV2 = mergeDiagnostics(mergedV1, pullV2);
    expect(mergedV2).toHaveLength(2);
    expect(mergedV2[0]).toBe(ts);
    expect(mergedV2[1].message).toBe("second (rule-b)");
  });
});
