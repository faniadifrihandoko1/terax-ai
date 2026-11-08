import { describe, expect, it } from "vitest";
import {
  buildDeleteCheckpoint,
  buildEditCheckpoint,
  buildRenameCheckpoint,
  clearAllCheckpoints,
  ensureWriteCheckpoint,
  getCheckpoint,
  isFileCheckpoint,
  listCheckpoints,
  MAX_CHECKPOINTS_PER_SESSION,
  recordToolWriteCheckpoint,
  restoreCheckpoint,
  saveCheckpoint,
  updateCheckpointAfter,
  type CheckpointIo,
  type FileCheckpoint,
} from "./reviewCheckpoint";
import { djb2Hash } from "./reviewApply";

type Files = Map<string, string>;

function fakeIo(files: Files): CheckpointIo {
  return {
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error("No such file");
      return { kind: "text", content, size: content.length };
    },
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    deleteFile: async (path) => {
      files.delete(path);
    },
    renameFile: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error("No such file");
      files.delete(from);
      files.set(to, content);
    },
  };
}

describe("checkpoint builders", () => {
  it("edit checkpoint records before/after hashes", () => {
    const cp = buildEditCheckpoint({
      approvalId: "a1",
      path: "/x/f.ts",
      originalContent: "a\n",
      reconstructedContent: "b\n",
      appliedHunks: [0, 2],
      appliedAt: 1000,
    });
    expect(cp.kind).toBe("edit");
    expect(cp.hashBefore).toBe(djb2Hash("a\n"));
    expect(cp.hashAfter).toBe(djb2Hash("b\n"));
    expect(cp.appliedHunks).toEqual([0, 2]);
    expect(cp.appliedAt).toBe(1000);
  });

  it("delete checkpoint has no after content", () => {
    const cp = buildDeleteCheckpoint({
      approvalId: "a2",
      path: "/x/f.ts",
      content: "gone\n",
    });
    expect(cp.kind).toBe("delete");
    expect(cp.contentAfter).toBeNull();
    expect(cp.hashAfter).toBeNull();
  });

  it("rename checkpoint keeps the same content on both sides", () => {
    const cp = buildRenameCheckpoint({
      approvalId: "a3",
      path: "/x/old.ts",
      targetPath: "/x/new.ts",
      content: "same\n",
    });
    expect(cp.kind).toBe("rename");
    expect(cp.targetPath).toBe("/x/new.ts");
    expect(cp.contentAfter).toBe("same\n");
    expect(cp.hashBefore).toBe(cp.hashAfter);
  });
});

describe("checkpoint registry bound", () => {
  it("keeps at most MAX_CHECKPOINTS_PER_SESSION, dropping the oldest", () => {
    clearAllCheckpoints();
    for (let i = 0; i < MAX_CHECKPOINTS_PER_SESSION + 5; i++) {
      saveCheckpoint(
        buildEditCheckpoint({
          approvalId: `a${i}`,
          path: `/x/f${i}.ts`,
          originalContent: "a",
          reconstructedContent: "b",
          appliedHunks: [],
        }),
      );
    }
    expect(listCheckpoints().size).toBe(MAX_CHECKPOINTS_PER_SESSION);
    expect(getCheckpoint("a0")).toBeUndefined();
    expect(getCheckpoint("a4")).toBeUndefined();
    expect(getCheckpoint(`a${MAX_CHECKPOINTS_PER_SESSION + 4}`)).toBeDefined();
    clearAllCheckpoints();
  });

  it("saving the same approval again refreshes it instead of duplicating", () => {
    clearAllCheckpoints();
    const mk = (content: string) =>
      buildEditCheckpoint({
        approvalId: "a1",
        path: "/x/f.ts",
        originalContent: "a",
        reconstructedContent: content,
        appliedHunks: [],
      });
    saveCheckpoint(mk("b"));
    saveCheckpoint(mk("c"));
    expect(listCheckpoints().size).toBe(1);
    expect(getCheckpoint("a1")?.contentAfter).toBe("c");
    clearAllCheckpoints();
  });
});

describe("updateCheckpointAfter / ensureWriteCheckpoint (Fase 8)", () => {
  const mk = (after: string, hunks: number[] = []) =>
    buildEditCheckpoint({
      approvalId: "w1",
      path: "/x/f.ts",
      originalContent: "a\n",
      reconstructedContent: after,
      appliedHunks: hunks,
    });

  it("advances only the written state, never the baseline", () => {
    clearAllCheckpoints();
    saveCheckpoint(mk("b\n"));
    expect(updateCheckpointAfter("w1", "c\n")).toBe(true);
    const cp = getCheckpoint("w1");
    expect(cp?.contentBefore).toBe("a\n");
    expect(cp?.hashBefore).toBe(djb2Hash("a\n"));
    expect(cp?.contentAfter).toBe("c\n");
    expect(cp?.hashAfter).toBe(djb2Hash("c\n"));
    expect(cp?.appliedHunks).toEqual([]);
    clearAllCheckpoints();
  });

  it("records accepted hunks when given", () => {
    clearAllCheckpoints();
    saveCheckpoint(mk("b\n"));
    updateCheckpointAfter("w1", "b\n", [0, 2]);
    expect(getCheckpoint("w1")?.appliedHunks).toEqual([0, 2]);
    clearAllCheckpoints();
  });

  it("returns false when no checkpoint exists", () => {
    clearAllCheckpoints();
    expect(updateCheckpointAfter("missing", "b\n")).toBe(false);
    clearAllCheckpoints();
  });

  it("refuses to give a delete checkpoint an after-content", () => {
    clearAllCheckpoints();
    saveCheckpoint(
      buildDeleteCheckpoint({ approvalId: "d1", path: "/x/g.ts", content: "x\n" }),
    );
    expect(updateCheckpointAfter("d1", "back\n")).toBe(false);
    expect(getCheckpoint("d1")?.contentAfter).toBeNull();
    expect(updateCheckpointAfter("d1", null)).toBe(true);
    clearAllCheckpoints();
  });

  it("ensureWriteCheckpoint saves a fresh checkpoint as-is", () => {
    clearAllCheckpoints();
    const saved = ensureWriteCheckpoint(mk("b\n", [1]));
    expect(saved).toEqual(getCheckpoint("w1"));
    expect(saved.appliedHunks).toEqual([1]);
    clearAllCheckpoints();
  });

  it("ensureWriteCheckpoint on a composed write keeps baseline and hunks", () => {
    clearAllCheckpoints();
    saveCheckpoint(mk("b\n", [0, 2]));
    const advanced = ensureWriteCheckpoint(mk("c\n"));
    expect(advanced.contentBefore).toBe("a\n");
    expect(advanced.contentAfter).toBe("c\n");
    expect(advanced.hashAfter).toBe(djb2Hash("c\n"));
    // The accepted hunks of the earlier state survive the advance.
    expect(advanced.appliedHunks).toEqual([0, 2]);
    clearAllCheckpoints();
  });
});

describe("recordToolWriteCheckpoint (Fase 9, slice 2)", () => {
  const first = () =>
    buildEditCheckpoint({
      approvalId: "tool-1",
      path: "/x/f.ts",
      originalContent: "a\n",
      reconstructedContent: "b\n",
      appliedHunks: [],
    });
  const second = () =>
    buildEditCheckpoint({
      approvalId: "tool-2",
      path: "/x/f.ts",
      originalContent: "b\n",
      reconstructedContent: "c\n",
      appliedHunks: [],
    });

  it("records a first write's checkpoint under its tool call id", () => {
    clearAllCheckpoints();
    recordToolWriteCheckpoint(undefined, first());
    const cp = getCheckpoint("tool-1");
    expect(cp?.contentBefore).toBe("a\n");
    expect(cp?.contentAfter).toBe("b\n");
    expect(listCheckpoints().size).toBe(1);
    clearAllCheckpoints();
  });

  it("advances only the written state on a second write to the same path", () => {
    clearAllCheckpoints();
    recordToolWriteCheckpoint(undefined, first());
    recordToolWriteCheckpoint("tool-1", second());
    // No second checkpoint: the second write advanced the first one.
    expect(listCheckpoints().size).toBe(1);
    const cp = getCheckpoint("tool-1");
    expect(cp?.contentBefore).toBe("a\n");
    expect(cp?.contentAfter).toBe("c\n");
    expect(cp?.hashAfter).toBe(djb2Hash("c\n"));
    expect(getCheckpoint("tool-2")).toBeUndefined();
    clearAllCheckpoints();
  });

  it("records a fresh checkpoint when the prior one is gone", () => {
    clearAllCheckpoints();
    recordToolWriteCheckpoint(undefined, first());
    // The prior checkpoint was consumed (e.g. by a Restore).
    clearAllCheckpoints();
    recordToolWriteCheckpoint("tool-1", second());
    expect(getCheckpoint("tool-1")).toBeUndefined();
    const cp = getCheckpoint("tool-2");
    expect(cp?.contentBefore).toBe("b\n");
    expect(cp?.contentAfter).toBe("c\n");
    clearAllCheckpoints();
  });

  it("leaves a delete checkpoint alone when the file is recreated", () => {
    clearAllCheckpoints();
    saveCheckpoint(
      buildDeleteCheckpoint({
        approvalId: "del-1",
        path: "/x/g.ts",
        content: "gone\n",
      }),
    );
    // The file was deleted, then recreated in the same run: the
    // delete checkpoint cannot advance to content, and no second
    // checkpoint is created — the bridge owns this path.
    recordToolWriteCheckpoint(
      "del-1",
      buildEditCheckpoint({
        approvalId: "tool-9",
        path: "/x/g.ts",
        originalContent: "",
        reconstructedContent: "back\n",
        appliedHunks: [],
      }),
    );
    expect(listCheckpoints().size).toBe(1);
    expect(getCheckpoint("del-1")?.contentAfter).toBeNull();
    expect(getCheckpoint("tool-9")).toBeUndefined();
    clearAllCheckpoints();
  });
});

describe("restore edit", () => {
  it("writes the old content back when the disk still matches the apply", async () => {
    clearAllCheckpoints();
    const files: Files = new Map([["/x/f.ts", "b\n"]]);
    const io = fakeIo(files);
    saveCheckpoint(
      buildEditCheckpoint({
        approvalId: "a1",
        path: "/x/f.ts",
        originalContent: "a\n",
        reconstructedContent: "b\n",
        appliedHunks: [0],
      }),
    );
    const result = await restoreCheckpoint("a1", {}, io);
    expect(result.outcome).toBe("restored");
    expect(files.get("/x/f.ts")).toBe("a\n");
    expect(getCheckpoint("a1")).toBeUndefined();
    clearAllCheckpoints();
  });

  it("refuses when the file changed on disk since the apply", async () => {
    clearAllCheckpoints();
    const files: Files = new Map([["/x/f.ts", "edited by hand\n"]]);
    const io = fakeIo(files);
    saveCheckpoint(
      buildEditCheckpoint({
        approvalId: "a1",
        path: "/x/f.ts",
        originalContent: "a\n",
        reconstructedContent: "b\n",
        appliedHunks: [0],
      }),
    );
    const result = await restoreCheckpoint("a1", {}, io);
    expect(result.outcome).toBe("conflict");
    expect(files.get("/x/f.ts")).toBe("edited by hand\n");
    expect(getCheckpoint("a1")).toBeDefined();
    clearAllCheckpoints();
  });

  it("force restore overwrites the changed file", async () => {
    clearAllCheckpoints();
    const files: Files = new Map([["/x/f.ts", "edited by hand\n"]]);
    const io = fakeIo(files);
    saveCheckpoint(
      buildEditCheckpoint({
        approvalId: "a1",
        path: "/x/f.ts",
        originalContent: "a\n",
        reconstructedContent: "b\n",
        appliedHunks: [0],
      }),
    );
    const result = await restoreCheckpoint("a1", { force: true }, io);
    expect(result.outcome).toBe("restored");
    expect(files.get("/x/f.ts")).toBe("a\n");
    clearAllCheckpoints();
  });

  it("reports no-checkpoint when nothing was saved", async () => {
    clearAllCheckpoints();
    const result = await restoreCheckpoint("missing", {}, fakeIo(new Map()));
    expect(result.outcome).toBe("no-checkpoint");
    clearAllCheckpoints();
  });
});

describe("restore delete", () => {
  it("recreates the deleted file", async () => {
    clearAllCheckpoints();
    const files: Files = new Map();
    const io = fakeIo(files);
    saveCheckpoint(
      buildDeleteCheckpoint({
        approvalId: "a1",
        path: "/x/f.ts",
        content: "was here\n",
      }),
    );
    const result = await restoreCheckpoint("a1", {}, io);
    expect(result.outcome).toBe("restored");
    expect(files.get("/x/f.ts")).toBe("was here\n");
    clearAllCheckpoints();
  });

  it("refuses when the file was recreated on disk", async () => {
    clearAllCheckpoints();
    const files: Files = new Map([["/x/f.ts", "new file\n"]]);
    const io = fakeIo(files);
    saveCheckpoint(
      buildDeleteCheckpoint({
        approvalId: "a1",
        path: "/x/f.ts",
        content: "was here\n",
      }),
    );
    const result = await restoreCheckpoint("a1", {}, io);
    expect(result.outcome).toBe("conflict");
    expect(files.get("/x/f.ts")).toBe("new file\n");
    clearAllCheckpoints();
  });
});

describe("restore rename", () => {
  it("renames the file back to the old path", async () => {
    clearAllCheckpoints();
    const files: Files = new Map([["/x/new.ts", "same\n"]]);
    const io = fakeIo(files);
    saveCheckpoint(
      buildRenameCheckpoint({
        approvalId: "a1",
        path: "/x/old.ts",
        targetPath: "/x/new.ts",
        content: "same\n",
      }),
    );
    const result = await restoreCheckpoint("a1", {}, io);
    expect(result.outcome).toBe("restored");
    expect(files.get("/x/old.ts")).toBe("same\n");
    expect(files.has("/x/new.ts")).toBe(false);
    clearAllCheckpoints();
  });

  it("refuses when the old path is occupied", async () => {
    clearAllCheckpoints();
    const files: Files = new Map([
      ["/x/new.ts", "same\n"],
      ["/x/old.ts", "someone else\n"],
    ]);
    const io = fakeIo(files);
    saveCheckpoint(
      buildRenameCheckpoint({
        approvalId: "a1",
        path: "/x/old.ts",
        targetPath: "/x/new.ts",
        content: "same\n",
      }),
    );
    const result = await restoreCheckpoint("a1", {}, io);
    expect(result.outcome).toBe("conflict");
    expect(files.get("/x/new.ts")).toBe("same\n");
    expect(files.get("/x/old.ts")).toBe("someone else\n");
    clearAllCheckpoints();
  });

  it("refuses when the renamed file is gone", async () => {
    clearAllCheckpoints();
    const files: Files = new Map();
    const io = fakeIo(files);
    saveCheckpoint(
      buildRenameCheckpoint({
        approvalId: "a1",
        path: "/x/old.ts",
        targetPath: "/x/new.ts",
        content: "same\n",
      }),
    );
    const result = await restoreCheckpoint("a1", {}, io);
    expect(result.outcome).toBe("conflict");
    clearAllCheckpoints();
  });

  it("force restore recreates the old file when the renamed one is gone", async () => {
    clearAllCheckpoints();
    const files: Files = new Map();
    const io = fakeIo(files);
    saveCheckpoint(
      buildRenameCheckpoint({
        approvalId: "a1",
        path: "/x/old.ts",
        targetPath: "/x/new.ts",
        content: "same\n",
      }),
    );
    const result = await restoreCheckpoint("a1", { force: true }, io);
    expect(result.outcome).toBe("restored");
    expect(files.get("/x/old.ts")).toBe("same\n");
    clearAllCheckpoints();
  });
});

describe("isFileCheckpoint", () => {
  it("accepts a well-formed checkpoint and rejects malformed ones", () => {
    const good: FileCheckpoint = buildEditCheckpoint({
      approvalId: "a1",
      path: "/x/f.ts",
      originalContent: "a",
      reconstructedContent: "b",
      appliedHunks: [0],
    });
    expect(isFileCheckpoint(good)).toBe(true);
    expect(isFileCheckpoint({ ...good, kind: "explode" })).toBe(false);
    expect(isFileCheckpoint({ ...good, contentAfter: 42 })).toBe(false);
    expect(isFileCheckpoint({ ...good, hashAfter: "x" })).toBe(false);
    expect(isFileCheckpoint({ ...good, appliedHunks: ["0"] })).toBe(false);
    expect(
      isFileCheckpoint({ ...good, kind: "delete", contentAfter: "x" }),
    ).toBe(false);
    expect(
      isFileCheckpoint({ ...good, kind: "rename", targetPath: undefined }),
    ).toBe(false);
    expect(isFileCheckpoint(null)).toBe(false);
    expect(isFileCheckpoint("nope")).toBe(false);
  });
});
