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

describe("write_file proposals (Fase 6: no disk writes)", () => {
  it("proposes new content without writing", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("old"));
    const result = await runTool(makeContext(new Map()), "write_file", {
      path: FILE,
      content: "new",
    });
    expect(result.proposed).toBe(true);
    expect(result.ok).toBe(true);
    expect(nativeMock.writeFile).not.toHaveBeenCalled();
    expect(getPendingProposal(FILE)).toEqual({
      originalContent: "old",
      proposedContent: "new",
      isNewFile: false,
    });
  });

  it("marks a missing file as new", async () => {
    nativeMock.readFile.mockRejectedValue(new Error("no such file"));
    const result = await runTool(makeContext(new Map()), "write_file", {
      path: FILE,
      content: "fresh",
    });
    expect(result.proposed).toBe(true);
    expect(getPendingProposal(FILE)?.isNewFile).toBe(true);
    expect(getPendingProposal(FILE)?.originalContent).toBe("");
  });

  it("replaces a pending edit proposal with the literal content", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("one"));
    const ctx = makeContext(new Map([[FILE, { size: 3, hash: djb2("one") }]]));
    // A pending edit proposal already exists (via the edit tool path).
    const { composePendingProposal } = await import(
      "../lib/pendingProposals"
    );
    composePendingProposal(FILE, "one", "one two", false);
    const result = await runTool(ctx, "write_file", {
      path: FILE,
      content: "brand new",
    });
    expect(result.proposed).toBe(true);
    expect(getPendingProposal(FILE)?.proposedContent).toBe("brand new");
    expect(getPendingProposal(FILE)?.originalContent).toBe("one");
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

describe("delete_file proposals (Fase 6: no disk deletes)", () => {
  function readCtx() {
    return makeContext(
      new Map([[FILE, { size: 7, hash: djb2("content") }]]),
    );
  }

  it("proposes the delete without deleting", async () => {
    nativeMock.readFile.mockResolvedValue(textFile("content"));
    const result = await runTool(readCtx(), "delete_file", { path: FILE });
    expect(result.proposed).toBe(true);
    expect(result.ok).toBe(true);
    expect(nativeMock.deleteFile).not.toHaveBeenCalled();
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

describe("rename_file proposals (Fase 6: no disk renames)", () => {
  it("proposes the rename without renaming", async () => {
    nativeMock.readFile.mockImplementation(async (p: string) => {
      if (p === FILE) return textFile("content");
      throw new Error("no such file");
    });
    const result = await runTool(makeContext(new Map()), "rename_file", {
      path: FILE,
      to: TARGET,
    });
    expect(result.proposed).toBe(true);
    expect(result.ok).toBe(true);
    expect(nativeMock.renameFile).not.toHaveBeenCalled();
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
