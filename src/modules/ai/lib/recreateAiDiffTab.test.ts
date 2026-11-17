import { describe, expect, it } from "vitest";
import type { FileCheckpoint } from "./reviewCheckpoint";
import type { PendingProposal } from "./pendingProposals";
import { buildRecreatedAiDiffTab } from "./recreateAiDiffTab";

function checkpoint(
  overrides: Partial<FileCheckpoint> = {},
): FileCheckpoint {
  return {
    approvalId: "appr-1",
    path: "/x/a.ts",
    kind: "edit",
    contentBefore: "old\n",
    contentAfter: "new\n",
    hashBefore: 1,
    hashAfter: 2,
    appliedAt: 0,
    appliedHunks: [],
    ...overrides,
  };
}

function registry(overrides: Partial<PendingProposal> = {}): PendingProposal {
  return {
    originalContent: "old\n",
    proposedContent: "new\n",
    isNewFile: false,
    kind: "edit",
    approvalId: "appr-1",
    ...overrides,
  };
}

describe("buildRecreatedAiDiffTab (Fase 28)", () => {
  it("rebuilds the tab from the registry when its id matches the row", () => {
    const input = buildRecreatedAiDiffTab({
      approvalId: "appr-1",
      absPath: "/x/a.ts",
      cwd: "/ws",
      registry: registry(),
    });
    expect(input).not.toBeNull();
    expect(input?.path).toBe("/x/a.ts");
    expect(input?.originalContent).toBe("old\n");
    expect(input?.proposedContent).toBe("new\n");
    expect(input?.approvalId).toBe("appr-1");
    expect(input?.mutationKind).toBe("edit");
    expect(input?.written).toBe(true);
    expect(input?.activate).toBe(true);
  });

  it("refuses registry content whose id does not match the row", () => {
    // The registry is keyed by path, not by proposal: a later run may
    // hold a newer write for the same file. Showing it under the old
    // row's id would review the wrong change.
    const input = buildRecreatedAiDiffTab({
      approvalId: "appr-1",
      absPath: "/x/a.ts",
      cwd: "/ws",
      registry: registry({ approvalId: "appr-2" }),
    });
    expect(input).toBeNull();
  });

  it("falls back to the checkpoint when the registry id is unknown", () => {
    const input = buildRecreatedAiDiffTab({
      approvalId: "appr-1",
      absPath: "/x/a.ts",
      cwd: "/ws",
      registry: registry({ approvalId: undefined }),
      checkpoint: checkpoint(),
    });
    expect(input?.originalContent).toBe("old\n");
    expect(input?.proposedContent).toBe("new\n");
  });

  it("rebuilds an edit from the checkpoint when the registry is gone", () => {
    const input = buildRecreatedAiDiffTab({
      approvalId: "appr-1",
      absPath: "/x/a.ts",
      cwd: "/ws",
      checkpoint: checkpoint(),
    });
    expect(input?.mutationKind).toBe("edit");
    expect(input?.isNewFile).toBe(false);
    expect(input?.written).toBe(true);
  });

  it("marks a checkpoint with an empty baseline as a new file", () => {
    const input = buildRecreatedAiDiffTab({
      approvalId: "appr-1",
      absPath: "/x/a.ts",
      cwd: "/ws",
      checkpoint: checkpoint({ contentBefore: "", contentAfter: "new\n" }),
    });
    expect(input?.isNewFile).toBe(true);
  });

  it("rebuilds a delete from the checkpoint with empty proposed content", () => {
    const input = buildRecreatedAiDiffTab({
      approvalId: "appr-1",
      absPath: "/x/a.ts",
      cwd: "/ws",
      checkpoint: checkpoint({
        kind: "delete",
        contentAfter: null,
      }),
    });
    expect(input?.mutationKind).toBe("delete");
    expect(input?.proposedContent).toBe("");
  });

  it("rebuilds a rename from the checkpoint with a resolved target", () => {
    const input = buildRecreatedAiDiffTab({
      approvalId: "appr-1",
      absPath: "/x/old.ts",
      cwd: "/ws",
      checkpoint: checkpoint({
        kind: "rename",
        contentAfter: "old\n",
        targetPath: "sub/new.ts",
      }),
    });
    expect(input?.mutationKind).toBe("rename");
    expect(input?.targetPath).toBe("/ws/sub/new.ts");
  });

  it("returns null when neither registry nor checkpoint can rebuild it", () => {
    expect(
      buildRecreatedAiDiffTab({
        approvalId: "appr-1",
        absPath: "/x/a.ts",
        cwd: "/ws",
      }),
    ).toBeNull();
  });
});
