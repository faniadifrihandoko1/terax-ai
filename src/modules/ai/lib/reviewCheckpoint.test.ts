import { describe, expect, it } from "vitest";
import {
  buildDeleteCheckpoint,
  buildEditCheckpoint,
  buildRenameCheckpoint,
  clearAllCheckpoints,
  getCheckpoint,
  isFileCheckpoint,
  listCheckpoints,
  MAX_CHECKPOINTS_PER_SESSION,
  restoreCheckpoint,
  saveCheckpoint,
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
