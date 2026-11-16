import { describe, expect, it } from "vitest";
import type { ReviewApplyIo } from "@/modules/ai/lib/reviewApply";
import type { FileCheckpoint } from "@/modules/ai/lib/reviewCheckpoint";
import type { AiDiffTab } from "@/modules/tabs";
import { computeLineChanges } from "./lineDiff";
import { confirmAcceptedReview } from "./confirmAcceptedReview";

/**
 * Fake disk IO, mirrored from reviewApply.test.ts: an in-memory disk
 * plus call/write/delete/rename/checkpoint recording.
 */
function makeIo(
  opts: {
    disk?: Record<string, string>;
    writable?: boolean;
    writeFails?: boolean;
    deleteFails?: boolean;
    renameFails?: boolean;
    workspaceRoot?: string | null;
  } = {},
): {
  io: ReviewApplyIo;
  calls: string[];
  written: Map<string, string>;
  deleted: string[];
  renamed: [string, string][];
  checkpoints: FileCheckpoint[];
} {
  const calls: string[] = [];
  const written = new Map<string, string>();
  const deleted: string[] = [];
  const renamed: [string, string][] = [];
  const checkpoints: FileCheckpoint[] = [];
  const disk = new Map(Object.entries(opts.disk ?? {}));
  const io: ReviewApplyIo = {
    clearPendingProposal: (path) => {
      calls.push(`clear-pending:${path}`);
    },
    readFile: async (path) => {
      calls.push(`read:${path}`);
      if (!disk.has(path)) throw new Error("not found");
      const content = disk.get(path) ?? "";
      return { kind: "text", content, size: content.length };
    },
    writeFile: async (path, content) => {
      calls.push(`write:${path}`);
      if (opts.writeFails) throw new Error("disk full");
      written.set(path, content);
    },
    deleteFile: async (path) => {
      calls.push(`delete:${path}`);
      if (opts.deleteFails) throw new Error("permission denied");
      deleted.push(path);
      disk.delete(path);
    },
    renameFile: async (from, to) => {
      calls.push(`rename:${from}:${to}`);
      if (opts.renameFails) throw new Error("permission denied");
      renamed.push([from, to]);
      const content = disk.get(from);
      if (content !== undefined) {
        disk.delete(from);
        disk.set(to, content);
      }
    },
    saveCheckpoint: (cp) => {
      calls.push(`checkpoint:${cp.approvalId}`);
      checkpoints.push(cp);
    },
    getWorkspaceRoot: () =>
      opts.workspaceRoot === undefined ? "/ws" : opts.workspaceRoot,
    checkWritable: async (path) => {
      calls.push("checkWritable");
      if (opts.writable === false) {
        return { ok: false as const, reason: "read-only" };
      }
      return { ok: true as const, canonical: path };
    },
    canonicalize: async (p) => p,
  };
  return { io, calls, written, deleted, renamed, checkpoints };
}

function makeTab(overrides: Partial<AiDiffTab> = {}): AiDiffTab {
  return {
    spaceId: "space-1",
    id: 1,
    kind: "ai-diff",
    title: "a.ts",
    path: "/x/a.ts",
    originalContent: "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
    proposedContent: "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n",
    approvalId: "appr-1",
    status: "pending",
    isNewFile: false,
    mutationKind: "edit",
    hunkDecisions: {},
    written: true,
    ...overrides,
  };
}

describe("confirmAcceptedReview (Fase 20)", () => {
  it("confirms a written edit with all hunks accepted and writes nothing", async () => {
    const tab = makeTab();
    const { io, written, checkpoints } = makeIo({
      disk: { "/x/a.ts": tab.proposedContent },
    });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("applied");
    expect(result.acceptFileOp).toBe(false);
    expect(written.size).toBe(0);
    // The checkpoint records every hunk as accepted, so Restore still
    // works after the confirm (same as the pane's Confirm).
    expect(checkpoints).toHaveLength(1);
    const expectedHunks = computeLineChanges(
      tab.originalContent,
      tab.proposedContent,
    ).hunks.map((h) => h.index);
    expect(expectedHunks).toHaveLength(2);
    expect(checkpoints[0]?.appliedHunks).toEqual(expectedHunks);
    expect([...result.hunkDecisions.values()]).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  it("keeps a pre-rejected hunk rejected and writes the reconstruction", async () => {
    const hunks = computeLineChanges(
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n",
      "1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n",
    ).hunks;
    expect(hunks).toHaveLength(2);
    const tab = makeTab({
      hunkDecisions: { [hunks[0]?.index ?? 0]: "rejected" },
    });
    const { io, written, checkpoints } = makeIo({
      disk: { "/x/a.ts": tab.proposedContent },
    });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("applied");
    // The rejected hunk reverts to the original; the accepted one stays.
    expect(written.get("/x/a.ts")).toBe(
      "1\n2\n3\n4\n5\n6\n7\n8\nNINE\n10\n",
    );
    expect(result.hunkDecisions.get(hunks[0]?.index ?? 0)).toBe("rejected");
    expect(result.hunkDecisions.get(hunks[1]?.index ?? 1)).toBe("accepted");
    expect(checkpoints[0]?.appliedHunks).toEqual([hunks[1]?.index ?? 1]);
  });

  it("refuses a written edit whose disk content changed (conflict)", async () => {
    const tab = makeTab();
    const { io, written } = makeIo({
      disk: { "/x/a.ts": "1\n2\nCHANGED\n4\n5\n6\n7\n8\n9\n10\n" },
    });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("conflict");
    expect(result.reason).toMatch(/changed on disk/);
    expect(written.size).toBe(0);
  });

  it("applies a legacy (unwritten) edit by writing the proposal", async () => {
    const tab = makeTab({ written: false });
    const { io, written } = makeIo({
      disk: { "/x/a.ts": tab.originalContent },
    });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("applied");
    expect(written.get("/x/a.ts")).toBe(tab.proposedContent);
  });

  it("reports a write failure instead of applying", async () => {
    const tab = makeTab({ written: false });
    const { io } = makeIo({
      disk: { "/x/a.ts": tab.originalContent },
      writeFails: true,
    });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("write-failed");
  });

  it("confirms a written delete when the file is already gone", async () => {
    const tab = makeTab({
      mutationKind: "delete",
      originalContent: "old\n",
      proposedContent: "",
    });
    const { io, deleted } = makeIo({ disk: {} });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("applied");
    expect(result.acceptFileOp).toBe(true);
    expect(deleted).toHaveLength(0);
  });

  it("skips a delete the user already rejected instead of flipping it", async () => {
    const tab = makeTab({
      mutationKind: "delete",
      originalContent: "old\n",
      proposedContent: "",
      fileDecision: "rejected",
    });
    const { io, calls } = makeIo({ disk: {} });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("skipped");
    expect(result.acceptFileOp).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("confirms a written rename when the target holds the content", async () => {
    const tab = makeTab({
      mutationKind: "rename",
      path: "/x/old.ts",
      targetPath: "/x/new.ts",
      originalContent: "old\n",
      proposedContent: "old\n",
    });
    const { io } = makeIo({ disk: { "/x/new.ts": "old\n" } });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("applied");
    expect(result.acceptFileOp).toBe(true);
  });

  it("skips an edit with no hunks (nothing to confirm)", async () => {
    const tab = makeTab({
      originalContent: "same\n",
      proposedContent: "same\n",
    });
    const { io, calls } = makeIo({ disk: { "/x/a.ts": "same\n" } });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("skips a tab that is already resolved", async () => {
    const tab = makeTab({ status: "applied" });
    const { io, calls } = makeIo({
      disk: { "/x/a.ts": tab.proposedContent },
    });
    const result = await confirmAcceptedReview(tab, "sess-1", io);
    expect(result.outcome).toBe("skipped");
    expect(calls).toHaveLength(0);
  });
});
