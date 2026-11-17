import { describe, expect, it } from "vitest";
import { buildEntries } from "./ChangedFilesCard";

function part(over: Record<string, unknown>) {
  return {
    type: "tool-edit",
    state: "output-available",
    toolCallId: "call-1",
    input: { path: "x.ts", old_string: "a", new_string: "b" },
    ...over,
  } as never;
}

describe("buildEntries (Fase 6 composition)", () => {
  it("shows one row per file for composed edit proposals", () => {
    const entries = buildEntries([
      part({ toolCallId: "call-1" }),
      part({
        toolCallId: "call-2",
        input: { path: "x.ts", old_string: "b", new_string: "c" },
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].approvalId).toBe("call-1");
    expect(entries[0].editCount).toBe(2);
    expect(entries[0].mutations).toHaveLength(2);
  });

  it("keeps separate rows for different files", () => {
    const entries = buildEntries([
      part({ toolCallId: "call-1" }),
      part({
        toolCallId: "call-2",
        input: { path: "y.ts", old_string: "a", new_string: "b" },
      }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it("composes write_file into the same row as edits", () => {
    const entries = buildEntries([
      part({ toolCallId: "call-1" }),
      part({
        type: "tool-write_file",
        toolCallId: "call-2",
        input: { path: "x.ts", content: "whole new" },
      }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0].mutations).toHaveLength(2);
  });

  it("never composes delete proposals", () => {
    const entries = buildEntries([
      part({
        type: "tool-delete_file",
        toolCallId: "call-d1",
        input: { path: "x.ts" },
      }),
      part({
        type: "tool-delete_file",
        toolCallId: "call-d2",
        input: { path: "x.ts" },
      }),
    ]);
    expect(entries).toHaveLength(2);
  });

  it("takes the row status from the first proposal's id", () => {
    const entries = buildEntries(
      [
        part({ toolCallId: "call-1" }),
        part({
          toolCallId: "call-2",
          input: { path: "x.ts", old_string: "b", new_string: "c" },
        }),
      ],
      new Map([["call-1", "reviewing"]]),
    );
    expect(entries[0].status).toBe("reviewing");
  });

  it("marks hasTab false when no review tab exists for the row (Fase 28)", () => {
    // No entry in the status map means no ai-diff tab — the row must
    // not claim "Pending" as if it were reviewable.
    const entries = buildEntries([part({ toolCallId: "call-1" })]);
    expect(entries[0].hasTab).toBe(false);
    expect(entries[0].status).toBe("pending");
    const withTab = buildEntries(
      [part({ toolCallId: "call-1" })],
      new Map([["call-1", "pending"]]),
    );
    expect(withTab[0].hasTab).toBe(true);
  });

  it("row follows the latest tabbed proposal for a composed file (Fase 28)", () => {
    // Two proposals for one file, both with tabs (the second tab was
    // opened because the first could not absorb the update): the row
    // must point at the latest content, not the stale first tab.
    const entries = buildEntries(
      [
        part({ toolCallId: "call-1" }),
        part({
          toolCallId: "call-2",
          input: { path: "x.ts", old_string: "b", new_string: "c" },
        }),
      ],
      new Map([
        ["call-1", "reviewing"],
        ["call-2", "pending"],
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].approvalId).toBe("call-2");
    expect(entries[0].status).toBe("pending");
    expect(entries[0].hasTab).toBe(true);
  });

  it("row keeps the first proposal's id when only it has a tab (Fase 28)", () => {
    const entries = buildEntries(
      [
        part({ toolCallId: "call-1" }),
        part({
          toolCallId: "call-2",
          input: { path: "x.ts", old_string: "b", new_string: "c" },
        }),
      ],
      new Map([["call-1", "reviewing"]]),
    );
    expect(entries[0].approvalId).toBe("call-1");
    expect(entries[0].status).toBe("reviewing");
    expect(entries[0].hasTab).toBe(true);
  });
});
