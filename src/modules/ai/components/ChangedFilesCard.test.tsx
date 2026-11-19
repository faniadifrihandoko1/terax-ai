import { describe, expect, it } from "vitest";
import {
  applyTabLessStatuses,
  buildEntries,
  revertButtonFor,
  type ChangedFileEntry,
} from "./ChangedFilesCard";

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

function entry(overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    key: "k",
    path: "/x/a.ts",
    approvalId: "appr-1",
    kind: "edit",
    editCount: 1,
    mutations: [],
    status: "pending",
    hasTab: true,
    ...overrides,
  };
}

describe("applyTabLessStatuses (Fase 35)", () => {
  it("overrides the status of tab-less rows from the resolver", () => {
    const entries = applyTabLessStatuses(
      [
        entry({ key: "a", approvalId: "a1", hasTab: false }),
        entry({ key: "b", approvalId: "a2", hasTab: false }),
      ],
      (e) => (e.approvalId === "a1" ? "applied" : undefined),
    );
    expect(entries[0].status).toBe("applied");
    expect(entries[1].status).toBe("pending");
  });

  it("never overrides a row that has a tab", () => {
    const entries = applyTabLessStatuses(
      [entry({ key: "a", approvalId: "a1", hasTab: true, status: "pending" })],
      () => "applied",
    );
    expect(entries[0].status).toBe("pending");
  });

  it("returns the same entries when nothing changes", () => {
    const input = [entry({ key: "a", approvalId: "a1", hasTab: false })];
    const entries = applyTabLessStatuses(input, () => undefined);
    expect(entries[0]).toBe(input[0]);
  });
});

describe("revertButtonFor (Fase 35)", () => {
  const restorable = new Set(["appr-1", "call-1"]);

  it("shows Revert for pending, reviewing, and done rows with a checkpoint", () => {
    for (const status of ["pending", "reviewing", "done"] as const) {
      expect(
        revertButtonFor(entry({ status, approvalId: "appr-1" }), restorable),
      ).toBe("appr-1");
    }
  });

  it("never shows Revert for resolved rows", () => {
    for (const status of [
      "applied",
      "rejected",
      "conflict",
      "restored",
    ] as const) {
      expect(
        revertButtonFor(entry({ status, approvalId: "appr-1" }), restorable),
      ).toBeUndefined();
    }
  });

  it("never shows Revert without a checkpoint", () => {
    expect(
      revertButtonFor(entry({ status: "pending", approvalId: "no-cp" }), restorable),
    ).toBeUndefined();
    expect(
      revertButtonFor(entry({ status: "pending", approvalId: null }), restorable),
    ).toBeUndefined();
  });

  it("falls back to a mutation id with a checkpoint for composed rows", () => {
    expect(
      revertButtonFor(
        entry({
          status: "pending",
          approvalId: "call-2",
          mutations: [
            { approvalId: "call-2" },
            { approvalId: "call-1" },
          ] as never,
        }),
        restorable,
      ),
    ).toBe("call-1");
  });
});
