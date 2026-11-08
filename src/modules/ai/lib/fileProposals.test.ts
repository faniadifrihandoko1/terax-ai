import { describe, expect, it } from "vitest";
import { collectPendingFileProposals } from "./fileProposals";
import type { ToolPartLike } from "./fileMutations";

function editPart(over: Partial<ToolPartLike>): ToolPartLike {
  return {
    type: "tool-edit",
    state: "output-available",
    toolCallId: "call-1",
    input: { path: "x.ts", old_string: "a", new_string: "b" },
    ...over,
  };
}

describe("collectPendingFileProposals", () => {
  it("picks a finished edit proposal keyed by tool call id", () => {
    const out = collectPendingFileProposals(
      [editPart({ output: { ok: true, written: true, path: "/ws/x.ts" } })],
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      proposalId: "call-1",
      path: "x.ts",
      mutationKind: "edit",
      resultPath: "/ws/x.ts",
    });
  });

  it("skips a part that already opened a tab", () => {
    const out = collectPendingFileProposals(
      [editPart({ output: { ok: true, path: "/ws/x.ts" } })],
      new Set(["call-1"]),
    );
    expect(out).toHaveLength(0);
  });

  it("skips a tool call whose output is an error", () => {
    const out = collectPendingFileProposals(
      [editPart({ output: { error: "old_string not found" } })],
      new Set(),
    );
    expect(out).toHaveLength(0);
  });

  it("skips output-error and input-available parts", () => {
    const out = collectPendingFileProposals(
      [
        editPart({ state: "output-error", toolCallId: "call-2" }),
        editPart({ state: "input-available", toolCallId: "call-3" }),
      ],
      new Set(),
    );
    expect(out).toHaveLength(0);
  });

  it("still picks legacy approval-requested parts (pre-Fase 6 sessions)", () => {
    const out = collectPendingFileProposals(
      [
        editPart({
          state: "approval-requested",
          approval: { id: "ap-1" },
          toolCallId: "call-4",
        }),
      ],
      new Set(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].proposalId).toBe("ap-1");
    expect(out[0].resultPath).toBeUndefined();
  });

  it("reads delete and rename kinds with the rename target", () => {
    const out = collectPendingFileProposals(
      [
        {
          type: "tool-delete_file",
          state: "output-available",
          toolCallId: "call-d",
          input: { path: "gone.ts" },
          output: { ok: true, written: true, path: "/ws/gone.ts" },
        },
        {
          type: "tool-rename_file",
          state: "output-available",
          toolCallId: "call-r",
          input: { path: "old.ts", to: "new.ts" },
          output: { ok: true, written: true, path: "/ws/old.ts" },
        },
      ],
      new Set(),
    );
    expect(out).toHaveLength(2);
    expect(out[0].mutationKind).toBe("delete");
    expect(out[1]).toMatchObject({
      mutationKind: "rename",
      targetPath: "new.ts",
    });
  });

  it("ignores non-mutation parts and parts without an id", () => {
    const out = collectPendingFileProposals(
      [
        { type: "tool-read_file", state: "output-available", input: {} },
        editPart({ toolCallId: undefined }),
      ],
      new Set(),
    );
    expect(out).toHaveLength(0);
  });
});
