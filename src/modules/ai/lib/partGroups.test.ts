import { describe, expect, it } from "vitest";
import { buildPartGroups, type AnyPart } from "./partGroups";

function textPart(text: string): AnyPart {
  return { type: "text", text } as AnyPart;
}

function editPart(toolCallId: string): AnyPart {
  return {
    type: "tool-edit",
    state: "output-available",
    toolCallId,
    input: { path: "x.ts", old_string: "a", new_string: "b" },
  } as unknown as AnyPart;
}

function readPart(toolCallId: string): AnyPart {
  return {
    type: "tool-read_file",
    state: "output-available",
    toolCallId,
    input: { path: "x.ts" },
  } as unknown as AnyPart;
}

function kinds(parts: AnyPart[]): string[] {
  return buildPartGroups(parts).map((g) => g.kind);
}

describe("buildPartGroups — changes card renders last (Fase 9)", () => {
  it("moves the changes group after the summary text", () => {
    // Real message order: edits happen first, the summary text comes
    // after. The card must render below the summary, not above it.
    const groups = buildPartGroups([
      editPart("call-1"),
      textPart("Done — see the changes below."),
    ]);
    expect(kinds([editPart("call-1"), textPart("Done.")])).toEqual([
      "single",
      "changes",
    ]);
    expect(groups[groups.length - 1]?.kind).toBe("changes");
  });

  it("collapses mutation parts scattered across the message into one trailing group", () => {
    const groups = buildPartGroups([
      editPart("call-1"),
      textPart("First batch done."),
      editPart("call-2"),
      textPart("Second batch done."),
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "single",
      "single",
      "changes",
    ]);
    const changes = groups[groups.length - 1];
    expect(changes?.kind).toBe("changes");
    if (changes?.kind === "changes") {
      expect(changes.parts).toHaveLength(2);
    }
  });

  it("keeps read-file runs grouped and before the changes card", () => {
    const groups = buildPartGroups([
      readPart("call-r1"),
      readPart("call-r2"),
      editPart("call-1"),
      textPart("Done."),
    ]);
    expect(groups.map((g) => g.kind)).toEqual([
      "reads",
      "single",
      "changes",
    ]);
  });

  it("produces no changes group when nothing mutated a file", () => {
    expect(
      kinds([textPart("Hello."), readPart("call-r1"), textPart("Done.")]),
    ).toEqual(["single", "single", "single"]);
  });

  it("returns an empty list for an empty message", () => {
    expect(buildPartGroups([])).toEqual([]);
  });

  it("keeps a lone mutation-only message as a single changes group", () => {
    const groups = buildPartGroups([editPart("call-1")]);
    expect(groups.map((g) => g.kind)).toEqual(["changes"]);
  });
});
