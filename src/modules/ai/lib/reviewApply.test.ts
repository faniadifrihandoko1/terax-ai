import { describe, expect, it } from "vitest";
import {
  allHunksDecided,
  allLinesDecided,
  applyReviewedDelete,
  applyReviewedEdit,
  applyReviewedRename,
  checkDiskConflict,
  discardReviewedProposal,
  djb2Hash,
  type HunkDecisions,
  type LineDecisions,
  type ReviewApplyIo,
} from "./reviewApply";
import type { FileCheckpoint } from "./reviewCheckpoint";

function makeIo(
  opts: {
    disk?: Record<string, string>;
    missing?: boolean;
    binary?: boolean;
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
      if (opts.missing || !disk.has(path)) throw new Error("not found");
      if (opts.binary) return { kind: "binary", size: 1 };
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

describe("allHunksDecided (Fase 4)", () => {
  it("requires every hunk to be accepted or rejected", () => {
    const d: HunkDecisions = new Map([
      [0, "accepted" as const],
      [1, "undecided" as const],
    ]);
    expect(allHunksDecided(d, [0, 1])).toBe(false);
    expect(allHunksDecided(d, [0])).toBe(true);
    d.set(1, "rejected");
    expect(allHunksDecided(d, [0, 1])).toBe(true);
    expect(allHunksDecided(new Map(), [])).toBe(true);
  });
});

describe("djb2Hash", () => {
  it("is deterministic and distinguishes content", () => {
    expect(djb2Hash("")).toBe(5381);
    expect(djb2Hash("hello")).toBe(djb2Hash("hello"));
    expect(djb2Hash("hello")).not.toBe(djb2Hash("hallo"));
  });
});

describe("checkDiskConflict", () => {
  const base = {
    path: "/x/a.ts",
    originalContent: "a\nb\n",
    isNewFile: false,
  };

  it("is ok when disk matches the original", async () => {
    const { io } = makeIo({ disk: { "/x/a.ts": "a\nb\n" } });
    await expect(checkDiskConflict(base, io)).resolves.toEqual({
      status: "ok",
    });
  });

  it("conflicts when disk changed", async () => {
    const { io } = makeIo({ disk: { "/x/a.ts": "a\nCHANGED\n" } });
    const result = await checkDiskConflict(base, io);
    expect(result.status).toBe("conflict");
  });

  it("conflicts when the file is gone", async () => {
    const { io } = makeIo({ missing: true });
    const result = await checkDiskConflict(base, io);
    expect(result.status).toBe("conflict");
  });

  it("is ok when a new file is missing", async () => {
    const { io } = makeIo({ missing: true });
    await expect(
      checkDiskConflict({ ...base, isNewFile: true }, io),
    ).resolves.toEqual({ status: "ok" });
  });

  it("conflicts when the file is binary now", async () => {
    const { io } = makeIo({ disk: { "/x/a.ts": "x" }, binary: true });
    const result = await checkDiskConflict(base, io);
    expect(result.status).toBe("conflict");
  });
});

describe("applyReviewedEdit", () => {
  const input = {
    approvalId: "ap1",
    path: "/x/a.ts",
    isNewFile: false,
    originalContent: "a\nb\n",
    reconstructedContent: "a\nB\n",
  };

  it("writes the reconstruction and clears the pending proposal", async () => {
    const { io, calls, written } = makeIo({ disk: { "/x/a.ts": "a\nb\n" } });
    const result = await applyReviewedEdit(input, io);
    expect(result).toEqual({ outcome: "applied", path: "/x/a.ts" });
    expect(written.get("/x/a.ts")).toBe("a\nB\n");
    // The pending proposal is cleared only after the write succeeds.
    expect(calls.indexOf("clear-pending:/x/a.ts")).toBeGreaterThan(
      calls.indexOf("write:/x/a.ts"),
    );
  });

  it("discards without writing when nothing changed", async () => {
    const { io, calls, written } = makeIo({ disk: { "/x/a.ts": "a\nb\n" } });
    const result = await applyReviewedEdit(
      { ...input, reconstructedContent: "a\nb\n" },
      io,
    );
    expect(result).toEqual({ outcome: "discarded", path: "/x/a.ts" });
    expect(written.size).toBe(0);
    expect(calls).toContain("clear-pending:/x/a.ts");
  });

  it("blocks the write on conflict and keeps the proposal pending", async () => {
    const { io, calls, written } = makeIo({
      disk: { "/x/a.ts": "a\nCHANGED\n" },
    });
    const result = await applyReviewedEdit(input, io);
    expect(result.outcome).toBe("conflict");
    expect(written.size).toBe(0);
    expect(calls).not.toContain("clear-pending:/x/a.ts");
  });

  it("blocks the write when the file was deleted", async () => {
    const { io, written } = makeIo({ missing: true });
    const result = await applyReviewedEdit(input, io);
    expect(result.outcome).toBe("conflict");
    expect(written.size).toBe(0);
  });

  it("writes a new file that does not exist yet", async () => {
    const { io, written } = makeIo({ missing: true });
    const result = await applyReviewedEdit(
      { ...input, isNewFile: true, originalContent: "" },
      io,
    );
    expect(result.outcome).toBe("applied");
    expect(written.get("/x/a.ts")).toBe("a\nB\n");
  });

  it("reports write-failed and keeps the proposal pending for retry", async () => {
    const { io, calls } = makeIo({
      disk: { "/x/a.ts": "a\nb\n" },
      writeFails: true,
    });
    const result = await applyReviewedEdit(input, io);
    expect(result.outcome).toBe("write-failed");
    expect(calls).not.toContain("clear-pending:/x/a.ts");
  });

  it("reports not-writable and keeps the proposal pending", async () => {
    const { io, calls } = makeIo({
      disk: { "/x/a.ts": "a\nb\n" },
      writable: false,
    });
    const result = await applyReviewedEdit(input, io);
    expect(result.outcome).toBe("not-writable");
    expect(calls).not.toContain("clear-pending:/x/a.ts");
  });

  it("saves a checkpoint before the write, with the accepted hunks", async () => {
    const { io, calls, checkpoints } = makeIo({
      disk: { "/x/a.ts": "a\nb\n" },
    });
    const result = await applyReviewedEdit(
      { ...input, sessionId: "s-1", appliedHunks: [0, 2] },
      io,
    );
    expect(result.outcome).toBe("applied");
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      approvalId: "ap1",
      sessionId: "s-1",
      kind: "edit",
      path: "/x/a.ts",
      contentBefore: "a\nb\n",
      contentAfter: "a\nB\n",
      appliedHunks: [0, 2],
    });
    expect(calls.indexOf("checkpoint:ap1")).toBeLessThan(
      calls.indexOf("write:/x/a.ts"),
    );
  });

  it("saves no checkpoint when nothing changed", async () => {
    const { io, checkpoints } = makeIo({ disk: { "/x/a.ts": "a\nb\n" } });
    await applyReviewedEdit(
      { ...input, reconstructedContent: "a\nb\n" },
      io,
    );
    expect(checkpoints).toHaveLength(0);
  });
});

describe("applyReviewedDelete (Fase 5)", () => {
  const input = {
    approvalId: "del1",
    path: "/x/a.ts",
    originalContent: "gone soon\n",
  };

  it("checkpoints, deletes, then clears the pending proposal", async () => {
    const { io, calls, deleted, checkpoints } = makeIo({
      disk: { "/x/a.ts": "gone soon\n" },
    });
    const result = await applyReviewedDelete(input, io);
    expect(result).toEqual({ outcome: "applied", path: "/x/a.ts" });
    expect(deleted).toEqual(["/x/a.ts"]);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      approvalId: "del1",
      kind: "delete",
      path: "/x/a.ts",
      contentBefore: "gone soon\n",
      contentAfter: null,
    });
    expect(calls.indexOf("checkpoint:del1")).toBeLessThan(
      calls.indexOf("delete:/x/a.ts"),
    );
    expect(calls.indexOf("clear-pending:/x/a.ts")).toBeGreaterThan(
      calls.indexOf("delete:/x/a.ts"),
    );
  });

  it("refuses when the file changed since the proposal", async () => {
    const { io, deleted, checkpoints } = makeIo({
      disk: { "/x/a.ts": "edited since\n" },
    });
    const result = await applyReviewedDelete(input, io);
    expect(result.outcome).toBe("conflict");
    expect(deleted).toHaveLength(0);
    expect(checkpoints).toHaveLength(0);
  });

  it("refuses when the file is already gone", async () => {
    const { io, deleted } = makeIo({ missing: true });
    const result = await applyReviewedDelete(input, io);
    expect(result.outcome).toBe("conflict");
    expect(deleted).toHaveLength(0);
  });

  it("reports write-failed and keeps the proposal pending for retry", async () => {
    const { io, calls } = makeIo({
      disk: { "/x/a.ts": "gone soon\n" },
      deleteFails: true,
    });
    const result = await applyReviewedDelete(input, io);
    expect(result.outcome).toBe("write-failed");
    expect(calls).not.toContain("clear-pending:/x/a.ts");
  });
});

describe("applyReviewedRename (Fase 5)", () => {
  const input = {
    approvalId: "ren1",
    path: "/ws/old.ts",
    targetPath: "/ws/new.ts",
    originalContent: "same\n",
  };

  it("checkpoints, renames, then clears the pending proposal", async () => {
    const { io, calls, renamed, checkpoints } = makeIo({
      disk: { "/ws/old.ts": "same\n" },
    });
    const result = await applyReviewedRename(input, io);
    expect(result).toEqual({ outcome: "applied", path: "/ws/old.ts" });
    expect(renamed).toEqual([["/ws/old.ts", "/ws/new.ts"]]);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({
      approvalId: "ren1",
      kind: "rename",
      path: "/ws/old.ts",
      targetPath: "/ws/new.ts",
      contentBefore: "same\n",
    });
    expect(calls.indexOf("checkpoint:ren1")).toBeLessThan(
      calls.indexOf("rename:/ws/old.ts:/ws/new.ts"),
    );
    expect(calls.indexOf("clear-pending:/ws/old.ts")).toBeGreaterThan(
      calls.indexOf("rename:/ws/old.ts:/ws/new.ts"),
    );
  });

  it("refuses when the target already exists", async () => {
    const { io, renamed, checkpoints } = makeIo({
      disk: { "/ws/old.ts": "same\n", "/ws/new.ts": "taken\n" },
    });
    const result = await applyReviewedRename(input, io);
    expect(result.outcome).toBe("conflict");
    expect(renamed).toHaveLength(0);
    expect(checkpoints).toHaveLength(0);
  });

  it("refuses when the target is outside the workspace", async () => {
    const { io, renamed } = makeIo({
      disk: { "/ws/old.ts": "same\n" },
    });
    const result = await applyReviewedRename(
      { ...input, targetPath: "/tmp/evil.ts" },
      io,
    );
    expect(result.outcome).toBe("conflict");
    expect(renamed).toHaveLength(0);
  });

  it("refuses when the source changed since the proposal", async () => {
    const { io, renamed } = makeIo({
      disk: { "/ws/old.ts": "changed\n" },
    });
    const result = await applyReviewedRename(input, io);
    expect(result.outcome).toBe("conflict");
    expect(renamed).toHaveLength(0);
  });

  it("refuses without a workspace root", async () => {
    const { io, renamed } = makeIo({
      disk: { "/ws/old.ts": "same\n" },
      workspaceRoot: null,
    });
    const result = await applyReviewedRename(input, io);
    expect(result.outcome).toBe("conflict");
    expect(renamed).toHaveLength(0);
  });
});

describe("discardReviewedProposal", () => {
  it("drops the pending proposal for the path", () => {
    const { io, calls } = makeIo();
    discardReviewedProposal("/x/a.ts", io);
    expect(calls).toContain("clear-pending:/x/a.ts");
  });
});

describe("allLinesDecided", () => {
  it("is true when every changed line has a decision", () => {
    const decisions: LineDecisions = new Map([
      [3, "accepted"],
      [4, "rejected"],
    ]);
    expect(allLinesDecided(decisions, [3, 4])).toBe(true);
  });

  it("is false when a line is undecided or missing", () => {
    const decisions: LineDecisions = new Map([
      [3, "accepted"],
      [4, "undecided"],
    ]);
    expect(allLinesDecided(decisions, [3, 4])).toBe(false);
    expect(allLinesDecided(new Map([[3, "accepted"]]), [3, 4])).toBe(false);
  });

  it("is true when nothing changed", () => {
    expect(allLinesDecided(new Map(), [])).toBe(true);
  });
});
