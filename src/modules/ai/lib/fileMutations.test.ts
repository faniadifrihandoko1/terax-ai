import { describe, expect, it } from "vitest";
import {
  applyEditsLocally,
  deriveProposed,
  extractFileMutation,
  type ToolPartLike,
} from "./fileMutations";

function part(over: Partial<ToolPartLike>): ToolPartLike {
  return { state: "approval-requested", approval: { id: "a1" }, ...over };
}

describe("extractFileMutation", () => {
  it("reads a write_file proposal literally", () => {
    const m = extractFileMutation(
      part({
        type: "tool-write_file",
        input: { path: "x.ts", content: "hello" },
      }),
    );
    expect(m?.path).toBe("x.ts");
    expect(m?.derive).toEqual({ kind: "literal", content: "hello" });
  });

  it("turns an edit into one edit op", () => {
    const m = extractFileMutation(
      part({
        type: "tool-edit",
        input: { path: "x.ts", old_string: "a", new_string: "b" },
      }),
    );
    expect(m?.derive).toEqual({
      kind: "edits",
      edits: [{ old_string: "a", new_string: "b", replace_all: false }],
    });
  });

  it("reads a delete_file proposal", () => {
    const m = extractFileMutation(
      part({ type: "tool-delete_file", input: { path: "x.ts" } }),
    );
    expect(m?.path).toBe("x.ts");
    expect(m?.derive).toEqual({ kind: "delete" });
  });

  it("reads a rename_file proposal with its target", () => {
    const m = extractFileMutation(
      part({
        type: "tool-rename_file",
        input: { path: "x.ts", to: "y.ts" },
      }),
    );
    expect(m?.path).toBe("x.ts");
    expect(m?.derive).toEqual({ kind: "rename", to: "y.ts" });
  });

  it("drops a rename without a target", () => {
    expect(
      extractFileMutation(
        part({ type: "tool-rename_file", input: { path: "x.ts" } }),
      ),
    ).toBeNull();
  });

  it("drops a delete without a path", () => {
    expect(
      extractFileMutation(
        part({ type: "tool-delete_file", input: {} }),
      ),
    ).toBeNull();
  });

  it("drops multi_edit ops with an empty old_string", () => {
    const m = extractFileMutation(
      part({
        type: "tool-multi_edit",
        input: {
          path: "x.ts",
          edits: [
            { old_string: "", new_string: "b" },
            { old_string: "a", new_string: "c" },
          ],
        },
      }),
    );
    expect(m?.derive).toEqual({
      kind: "edits",
      edits: [{ old_string: "a", new_string: "c", replace_all: false }],
    });
  });

  it("returns null for non-mutation parts and missing paths", () => {
    expect(
      extractFileMutation(part({ type: "tool-read_file", input: {} })),
    ).toBeNull();
    expect(
      extractFileMutation(
        part({ type: "tool-write_file", input: { content: "x" } }),
      ),
    ).toBeNull();
  });

  it("keys a proposal by its tool call id when there is no approval (Fase 6)", () => {
    const m = extractFileMutation({
      type: "tool-edit",
      state: "output-available",
      toolCallId: "call-9",
      input: { path: "x.ts", old_string: "a", new_string: "b" },
    });
    expect(m?.approvalId).toBe("call-9");
  });

  it("prefers the approval id over the tool call id for legacy parts", () => {
    const m = extractFileMutation(
      part({
        type: "tool-edit",
        toolCallId: "call-9",
        input: { path: "x.ts", old_string: "a", new_string: "b" },
      }),
    );
    expect(m?.approvalId).toBe("a1");
  });

  it("has no proposal id when neither approval nor tool call id exists", () => {
    const m = extractFileMutation({
      type: "tool-edit",
      state: "output-available",
      input: { path: "x.ts", old_string: "a", new_string: "b" },
    });
    expect(m?.approvalId).toBeNull();
  });
});

describe("applyEditsLocally", () => {
  it("applies a unique replacement", () => {
    expect(applyEditsLocally("a\nb\nc\n", [
      { old_string: "b", new_string: "B" },
    ])).toEqual({ ok: true, content: "a\nB\nc\n" });
  });

  it("fails when the old string is missing or not unique", () => {
    expect(
      applyEditsLocally("a\n", [{ old_string: "z", new_string: "Z" }]),
    ).toEqual({ ok: false });
    expect(
      applyEditsLocally("a\na\n", [{ old_string: "a", new_string: "b" }]),
    ).toEqual({ ok: false });
  });

  it("replaces all occurrences with replace_all", () => {
    expect(
      applyEditsLocally("a\na\n", [
        { old_string: "a", new_string: "b", replace_all: true },
      ]),
    ).toEqual({ ok: true, content: "b\nb\n" });
  });
});

describe("deriveProposed", () => {
  it("returns literal content unchanged", () => {
    const m = extractFileMutation(
      part({
        type: "tool-write_file",
        input: { path: "x.ts", content: "new" },
      }),
    );
    expect(m && deriveProposed("old", m.derive)).toEqual({
      ok: true,
      content: "new",
    });
  });

  it("derives empty content for a delete", () => {
    const m = extractFileMutation(
      part({ type: "tool-delete_file", input: { path: "x.ts" } }),
    );
    expect(m && deriveProposed("old", m.derive)).toEqual({
      ok: true,
      content: "",
    });
  });

  it("derives the original content for a rename", () => {
    const m = extractFileMutation(
      part({
        type: "tool-rename_file",
        input: { path: "x.ts", to: "y.ts" },
      }),
    );
    expect(m && deriveProposed("old", m.derive)).toEqual({
      ok: true,
      content: "old",
    });
  });
});
