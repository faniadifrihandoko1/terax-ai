import type { ToolExecutionOptions } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllPendingProposals,
  getPendingProposal,
} from "../lib/pendingProposals";
import type { ToolContext } from "./context";

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const nativeMock = vi.hoisted(() => ({
  canonicalize: vi.fn(async (path: string) => path),
  readFile: vi.fn(),
  readDir: vi.fn(async () => []),
  writeFile: vi.fn(async () => undefined),
  createDir: vi.fn(async () => undefined),
  deleteFile: vi.fn(async () => undefined),
  renameFile: vi.fn(async () => undefined),
}));

const planMock = vi.hoisted(() => ({
  active: false,
  enqueue: vi.fn(),
}));

vi.mock("../lib/native", () => ({ native: nativeMock }));

vi.mock("../lib/security", () => ({
  checkWritableCanonical: vi.fn(async (path: string) => ({
    ok: true as const,
    canonical: path,
  })),
  checkReadableCanonical: vi.fn(async (path: string) => ({
    ok: true as const,
    canonical: path,
  })),
}));

vi.mock("../store/planStore", () => ({
  newQueuedEditId: () => "queued-edit",
  usePlanStore: {
    getState: () => ({ active: planMock.active, enqueue: planMock.enqueue }),
  },
}));

import { buildFsTools } from "./fs";

const toolOptions: ToolExecutionOptions = {
  toolCallId: "tool-call",
  messages: [],
};

const FILE = "/workspace/a.txt";
const TARGET = "/workspace/b.txt";

function makeContext(readCache: Map<string, { size: number; hash: number }>) {
  return {
    getCwd: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache,
    getSessionId: () => "session",
  } as unknown as ToolContext;
}

function textFile(content: string) {
  return { kind: "text", content, size: content.length };
}

type FsResult = {
  error?: string;
  proposed?: boolean;
  written?: boolean;
  ok?: boolean;
  queued_for_plan_review?: boolean;
};

async function runTool(
  ctx: ToolContext,
  name: "write_file" | "create_directory" | "delete_file" | "rename_file",
  input: Record<string, unknown>,
): Promise<FsResult> {
  const tools = buildFsTools(ctx);
  const execute = tools[name].execute;
  if (!execute) throw new Error(`${name} tool has no execute`);
  return (await execute(input as never, toolOptions)) as unknown as FsResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearAllPendingProposals();
  planMock.active = false;
  nativeMock.canonicalize.mockImplementation(async (p: string) => p);
});

describe("write_file writes to disk first (Fase 8)", () => {
  it("writes new content to disk immediately", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("old"));
    const result = await runTool(makeContext(new Map()), "write_file", {
      path: FILE,
      content: "new",
    });
    expect(result.written).toBe(true);
    expect(result.ok).toBe(true);
    expect(nativeMock.writeFile).toHaveBeenCalledWith(FILE, "new");
    expect(getPendingProposal(FILE)).toEqual({
      originalContent: "old",
      proposedContent: "new",
      isNewFile: false,
      kind: "edit",
    });
  });

  it("marks a missing file as new", async () => {
    nativeMock.readFile.mockRejectedValue(new Error("no such file"));
    const result = await runTool(makeContext(new Map()), "write_file", {
      path: FILE,
      content: "fresh",
    });
    expect(result.written).toBe(true);
    expect(nativeMock.writeFile).toHaveBeenCalledWith(FILE, "fresh");
    expect(getPendingProposal(FILE)?.isNewFile).toBe(true);
    expect(getPendingProposal(FILE)?.originalContent).toBe("");
  });

  it("replaces a pending edit proposal with the literal content", async () => {
    // The edit tool already wrote "one two" to disk; write_file replaces it.
    nativeMock.readFile.mockResolvedValue(textFile("one two"));
    const ctx = makeContext(new Map([[FILE, { size: 7, hash: djb2("one two") }]]));
    // A pending edit proposal already exists (via the edit tool path).
    const { composePendingProposal } = await import(
      "../lib/pendingProposals"
    );
    composePendingProposal(FILE, "one", "one two", false);
    const result = await runTool(ctx, "write_file", {
      path: FILE,
      content: "brand new",
    });
    expect(result.written).toBe(true);
    expect(nativeMock.writeFile).toHaveBeenCalledWith(FILE, "brand new");
    expect(getPendingProposal(FILE)?.proposedContent).toBe("brand new");
    expect(getPendingProposal(FILE)?.originalContent).toBe("one");
  });

  it("writes nothing and records nothing when the write fails", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("old"));
    nativeMock.writeFile.mockRejectedValueOnce(new Error("disk full"));
    const result = await runTool(makeContext(new Map()), "write_file", {
      path: FILE,
      content: "new",
    });
    expect(result.error).toContain("disk full");
    expect(getPendingProposal(FILE)).toBeUndefined();
  });
});

describe("create_directory (Fase 6: runs immediately, no review)", () => {
  it("creates the directory without approval", async () => {
    const result = await runTool(makeContext(new Map()), "create_directory", {
      path: "/workspace/new-dir",
    });
    expect(result.ok).toBe(true);
    expect(nativeMock.createDir).toHaveBeenCalledWith("/workspace/new-dir");
  });
});

describe("delete_file deletes immediately (Fase 8)", () => {
  function readCtx() {
    return makeContext(
      new Map([[FILE, { size: 7, hash: djb2("content") }]]),
    );
  }

  it("deletes the file and records the baseline for review", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("content"));
    const ctx = readCtx();
    const result = await runTool(ctx, "delete_file", { path: FILE });
    expect(result.written).toBe(true);
    expect(result.ok).toBe(true);
    expect(nativeMock.deleteFile).toHaveBeenCalledWith(FILE);
    expect(getPendingProposal(FILE)).toEqual({
      originalContent: "content",
      proposedContent: "",
      isNewFile: false,
      kind: "delete",
    });
    // The read cache no longer claims the file exists.
    expect(ctx.readCache.has(FILE)).toBe(false);
  });

  it("records nothing when the delete fails", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("content"));
    nativeMock.deleteFile.mockRejectedValueOnce(new Error("permission denied"));
    const result = await runTool(readCtx(), "delete_file", { path: FILE });
    expect(result.error).toContain("permission denied");
    expect(getPendingProposal(FILE)).toBeUndefined();
  });

  it("refuses when the file changed since the read", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("changed!"));
    const result = await runTool(readCtx(), "delete_file", { path: FILE });
    expect(result.error).toBeTruthy();
    expect(nativeMock.deleteFile).not.toHaveBeenCalled();
  });

  it("refuses when the file was never read", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("content"));
    const result = await runTool(makeContext(new Map()), "delete_file", {
      path: FILE,
    });
    expect(result.error).toBeTruthy();
    expect(nativeMock.deleteFile).not.toHaveBeenCalled();
  });
});

describe("rename_file renames immediately (Fase 8)", () => {
  it("renames the file and records the baseline for review", async () => {
    nativeMock.readFile.mockImplementation(async (p: string) => {
      if (p === FILE) return textFile("content");
      throw new Error("no such file");
    });
    const ctx = makeContext(new Map());
    const result = await runTool(ctx, "rename_file", {
      path: FILE,
      to: TARGET,
    });
    expect(result.written).toBe(true);
    expect(result.ok).toBe(true);
    expect(nativeMock.renameFile).toHaveBeenCalledWith(FILE, TARGET);
    expect(getPendingProposal(FILE)).toEqual({
      originalContent: "content",
      proposedContent: "content",
      isNewFile: false,
      kind: "rename",
      targetPath: TARGET,
    });
    // The read cache follows the file to its new path.
    expect(ctx.readCache.has(FILE)).toBe(false);
    expect(ctx.readCache.get(TARGET)).toEqual({
      size: 7,
      hash: djb2("content"),
    });
  });

  it("records nothing when the rename fails", async () => {
    nativeMock.readFile.mockImplementation(async (p: string) => {
      if (p === FILE) return textFile("content");
      throw new Error("no such file");
    });
    nativeMock.renameFile.mockRejectedValueOnce(new Error("permission denied"));
    const result = await runTool(makeContext(new Map()), "rename_file", {
      path: FILE,
      to: TARGET,
    });
    expect(result.error).toContain("permission denied");
    expect(getPendingProposal(FILE)).toBeUndefined();
  });

  it("refuses when the target already exists", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("content"));
    const result = await runTool(makeContext(new Map()), "rename_file", {
      path: FILE,
      to: TARGET,
    });
    expect(result.error).toBeTruthy();
    expect(nativeMock.renameFile).not.toHaveBeenCalled();
  });

  it("refuses when the source does not exist", async () => {
    nativeMock.readFile.mockRejectedValue(new Error("no such file"));
    const result = await runTool(makeContext(new Map()), "rename_file", {
      path: FILE,
      to: TARGET,
    });
    expect(result.error).toBeTruthy();
    expect(nativeMock.renameFile).not.toHaveBeenCalled();
  });
});
