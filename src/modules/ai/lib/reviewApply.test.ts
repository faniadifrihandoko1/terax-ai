import { afterEach, describe, expect, it } from "vitest";
import {
  allHunksDecided,
  allLinesDecided,
  applyReviewedEdit,
  checkDiskConflict,
  clearReviewedApply,
  discardReviewedProposal,
  djb2Hash,
  isReviewedApply,
  type HunkDecisions,
  type LineDecisions,
  type ReviewApplyIo,
} from "./reviewApply";

function makeIo(
  opts: {
    disk?: Record<string, string>;
    missing?: boolean;
    binary?: boolean;
    writable?: boolean;
    writeFails?: boolean;
  } = {},
): {
  io: ReviewApplyIo;
  calls: string[];
  written: Map<string, string>;
} {
  const calls: string[] = [];
  const written = new Map<string, string>();
  const disk = new Map(Object.entries(opts.disk ?? {}));
  const io: ReviewApplyIo = {
    respondToApproval: (id, approved) => {
      calls.push(`respond:${id}:${approved}`);
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
    checkWritable: async () => {
      calls.push("checkWritable");
      if (opts.writable === false) {
        return { ok: false as const, reason: "read-only" };
      }
      return { ok: true as const, canonical: "/x" };
    },
    canonicalize: async (p) => p,
  };
  return { io, calls, written };
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

  afterEach(() => {
    clearReviewedApply("ap1");
  });

  it("answers the approval false, then writes the reconstruction", async () => {
    const { io, calls, written } = makeIo({ disk: { "/x/a.ts": "a\nb\n" } });
    const result = await applyReviewedEdit(input, io);
    expect(result).toEqual({ outcome: "applied", path: "/x/a.ts" });
    expect(written.get("/x/a.ts")).toBe("a\nB\n");
    expect(calls.indexOf("respond:ap1:false")).toBeLessThan(
      calls.indexOf("write:/x/a.ts"),
    );
    expect(isReviewedApply("ap1")).toBe(true);
  });

  it("discards without writing when nothing changed", async () => {
    const { io, calls, written } = makeIo({ disk: { "/x/a.ts": "a\nb\n" } });
    const result = await applyReviewedEdit(
      { ...input, reconstructedContent: "a\nb\n" },
      io,
    );
    expect(result).toEqual({ outcome: "discarded", path: "/x/a.ts" });
    expect(written.size).toBe(0);
    expect(calls).toContain("respond:ap1:false");
  });

  it("blocks the write and leaves the approval unanswered on conflict", async () => {
    const { io, calls, written } = makeIo({
      disk: { "/x/a.ts": "a\nCHANGED\n" },
    });
    const result = await applyReviewedEdit(input, io);
    expect(result.outcome).toBe("conflict");
    expect(written.size).toBe(0);
    expect(calls).not.toContain("respond:ap1:false");
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

  it("reports write-failed after answering false", async () => {
    const { io, calls } = makeIo({
      disk: { "/x/a.ts": "a\nb\n" },
      writeFails: true,
    });
    const result = await applyReviewedEdit(input, io);
    expect(result.outcome).toBe("write-failed");
    expect(calls).toContain("respond:ap1:false");
  });

  it("reports not-writable without answering", async () => {
    const { io, calls } = makeIo({
      disk: { "/x/a.ts": "a\nb\n" },
      writable: false,
    });
    const result = await applyReviewedEdit(input, io);
    expect(result.outcome).toBe("not-writable");
    expect(calls).not.toContain("respond:ap1:false");
  });
});

describe("discardReviewedProposal", () => {
  it("marks the approval and answers false", () => {
    const { io, calls } = makeIo();
    discardReviewedProposal("ap9", io);
    expect(calls).toContain("respond:ap9:false");
    expect(isReviewedApply("ap9")).toBe(true);
    clearReviewedApply("ap9");
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
