import { EditorState, type Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { EslintRawDiagnostic } from "./eslintStore";
import {
  findRawDiagnosticsAt,
  pickFixAllAction,
  pickQuickFixAction,
  workspaceEditToChanges,
  type LspCodeAction,
} from "./eslintCodeAction";

function doc(text: string): Text {
  return EditorState.create({ doc: text }).doc;
}

const URI = "file:///proj/src/a.ts";

function textEdit(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string,
) {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    newText,
  };
}

describe("workspaceEditToChanges", () => {
  it("replaces a range (documentChanges form)", () => {
    const d = doc("const x = 1;\n");
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        {
          textDocument: { uri: URI, version: 0 },
          edits: [textEdit(0, 6, 0, 7, "y")],
        },
      ],
    }, URI);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes).toEqual([{ from: 6, to: 7, insert: "y" }]);
    const next = EditorState.create({ doc: d }).update({
      changes: res.changes,
    }).state.doc;
    expect(next.toString()).toBe("const y = 1;\n");
  });

  it("inserts at a point (empty range) and deletes (empty newText)", () => {
    const d = doc("ab\n");
    const insert = workspaceEditToChanges(d, {
      documentChanges: [
        {
          textDocument: { uri: URI },
          edits: [textEdit(0, 1, 0, 1, "X")],
        },
      ],
    }, URI);
    expect(insert.ok).toBe(true);
    if (insert.ok) {
      expect(insert.changes).toEqual([{ from: 1, to: 1, insert: "X" }]);
    }
    const del = workspaceEditToChanges(d, {
      changes: { [URI]: [textEdit(0, 0, 0, 1, "")] },
    }, URI);
    expect(del.ok).toBe(true);
    if (del.ok) {
      expect(del.changes).toEqual([{ from: 0, to: 1, insert: "" }]);
    }
  });

  it("applies several edits, sorted even when given out of order", () => {
    const d = doc("aaaa bbbb cccc\n");
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        {
          textDocument: { uri: URI },
          edits: [
            textEdit(0, 10, 0, 14, "CCCC"),
            textEdit(0, 0, 0, 4, "AAAA"),
            textEdit(0, 5, 0, 9, "BBBB"),
          ],
        },
      ],
    }, URI);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes).toEqual([
      { from: 0, to: 4, insert: "AAAA" },
      { from: 5, to: 9, insert: "BBBB" },
      { from: 10, to: 14, insert: "CCCC" },
    ]);
    const next = EditorState.create({ doc: d }).update({
      changes: res.changes,
    }).state.doc;
    expect(next.toString()).toBe("AAAA BBBB CCCC\n");
  });

  it("uses UTF-16 offsets for astral characters", () => {
    // "a" = 1 unit, "😀" = 2 units, "b" = 1 unit: b sits at offset 3.
    const d = doc("a\u{1F600}b\n");
    expect(d.length).toBe(5); // a + surrogate pair + b + \n
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        {
          textDocument: { uri: URI },
          edits: [
            textEdit(0, 3, 0, 4, "B"),
            textEdit(0, 1, 0, 3, "\u{1F601}"),
          ],
        },
      ],
    }, URI);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes).toEqual([
      { from: 1, to: 3, insert: "\u{1F601}" },
      { from: 3, to: 4, insert: "B" },
    ]);
    const next = EditorState.create({ doc: d }).update({
      changes: res.changes,
    }).state.doc;
    expect(next.toString()).toBe("a\u{1F601}B\n");
  });

  it("rejects overlapping edits", () => {
    const d = doc("abcdefgh\n");
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        {
          textDocument: { uri: URI },
          edits: [textEdit(0, 1, 0, 5, "X"), textEdit(0, 3, 0, 6, "Y")],
        },
      ],
    }, URI);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/overlap/i);
  });

  it("rejects edits for another uri", () => {
    const d = doc("ab\n");
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        {
          textDocument: { uri: "file:///proj/src/other.ts" },
          edits: [textEdit(0, 0, 0, 1, "X")],
        },
      ],
    }, URI);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/another file/i);
  });

  it("rejects non-TextDocumentEdit documentChanges entries", () => {
    const d = doc("ab\n");
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        { kind: "create", uri: URI } as unknown as never,
      ],
    }, URI);
    expect(res.ok).toBe(false);
  });

  it("clamps out-of-range positions instead of throwing", () => {
    const d = doc("ab\ncd\n");
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        {
          textDocument: { uri: URI },
          edits: [textEdit(0, 50, 9, 99, "X")],
        },
      ],
    }, URI);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Line 0 is "ab" (offsets 0-2); the last line is the empty line
    // after the final newline (offset 6): the edit clamps to
    // from=2, to=6.
    expect(res.changes).toEqual([{ from: 2, to: 6, insert: "X" }]);
  });

  it("accepts an edit with no version (version is not the guard)", () => {
    const d = doc("ab\n");
    const res = workspaceEditToChanges(d, {
      documentChanges: [
        { textDocument: { uri: URI }, edits: [textEdit(0, 0, 0, 1, "X")] },
      ],
    }, URI);
    expect(res.ok).toBe(true);
  });
});

function rawDiag(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  code: string,
): EslintRawDiagnostic {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    severity: 1,
    code,
    message: "msg",
    source: "eslint",
  };
}

describe("findRawDiagnosticsAt", () => {
  it("returns diagnostics whose range contains the cursor", () => {
    const d = doc("const unused = 1;\n");
    const items = [
      rawDiag(0, 6, 0, 12, "@typescript-eslint/no-unused-vars"),
      rawDiag(0, 0, 0, 5, "other-rule"),
    ];
    expect(findRawDiagnosticsAt(items, d, 8)).toHaveLength(1);
    expect(findRawDiagnosticsAt(items, d, 8)[0]?.code).toBe(
      "@typescript-eslint/no-unused-vars",
    );
    expect(findRawDiagnosticsAt(items, d, 2)).toHaveLength(1);
    expect(findRawDiagnosticsAt(items, d, 2)[0]?.code).toBe("other-rule");
  });

  it("includes the range boundaries and returns empty elsewhere", () => {
    const d = doc("abcdef\n");
    const items = [rawDiag(0, 1, 0, 4, "r")];
    expect(findRawDiagnosticsAt(items, d, 1)).toHaveLength(1);
    expect(findRawDiagnosticsAt(items, d, 4)).toHaveLength(1);
    expect(findRawDiagnosticsAt(items, d, 5)).toHaveLength(0);
  });
});

function action(partial: Partial<LspCodeAction>): LspCodeAction {
  return { title: "fix", ...partial };
}

describe("pickQuickFixAction", () => {
  it("prefers the applySingleFix command over suggestions and disables", () => {
    const suggestion = action({
      title: "suggestion",
      kind: "quickfix",
      command: {
        title: "s",
        command: "eslint.applySuggestion",
        arguments: [],
      },
    });
    const disable = action({
      title: "disable",
      kind: "quickfix",
      command: {
        title: "d",
        command: "eslint.applyDisableLine",
        arguments: [],
      },
    });
    const fix = action({
      title: "Fix x",
      kind: "quickfix",
      isPreferred: true,
      command: {
        title: "f",
        command: "eslint.applySingleFix",
        arguments: [],
      },
    });
    expect(pickQuickFixAction([suggestion, disable, fix])).toBe(fix);
  });

  it("accepts an inline edit action and returns null when only suggestions exist", () => {
    const withEdit = action({
      title: "Fix inline",
      kind: "quickfix",
      edit: { documentChanges: [] },
    });
    expect(pickQuickFixAction([withEdit])).toBe(withEdit);
    expect(
      pickQuickFixAction([
        action({
          title: "s",
          kind: "quickfix",
          command: {
            title: "s",
            command: "eslint.applySuggestion",
            arguments: [],
          },
        }),
      ]),
    ).toBeNull();
  });
});

describe("pickFixAllAction", () => {
  it("finds the source.fixAll.eslint action and ignores plain quickfix", () => {
    const fixAll = action({
      title: "Fix all fixable ESLint issues",
      kind: "source.fixAll.eslint",
      edit: { documentChanges: [] },
    });
    const quick = action({
      title: "Fix x",
      kind: "quickfix",
      command: {
        title: "f",
        command: "eslint.applySingleFix",
        arguments: [],
      },
    });
    expect(pickFixAllAction([quick, fixAll])).toBe(fixAll);
    expect(pickFixAllAction([quick])).toBeNull();
  });
});
