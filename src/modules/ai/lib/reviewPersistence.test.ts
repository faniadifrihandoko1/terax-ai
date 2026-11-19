import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseReviewState,
  restoreStatus,
  snapshotReviewState,
  serializeReviewState,
  type PersistedReviewState,
  type ReviewTabSnapshot,
} from "./reviewPersistence";

// The LazyStore mock must be in place before `./sessions` is imported.
const storeData = vi.hoisted(() => new Map<string, unknown>());
const toasts = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    get = async (key: string) => storeData.get(key);
    set = async (key: string, value: unknown) => {
      storeData.set(key, value);
    };
    delete = async (key: string) => {
      storeData.delete(key);
    };
    has = async (key: string) => storeData.has(key);
    keys = async () => [...storeData.keys()];
    entries = async () => [...storeData.entries()];
    save = async () => undefined;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));
vi.mock("sonner", () => ({ toast: toasts }));

async function reloadSessions() {
  vi.resetModules();
  return import("./sessions");
}

const tab = (overrides: Partial<ReviewTabSnapshot>): ReviewTabSnapshot => ({
  approvalId: "a1",
  path: "src/a.ts",
  isNewFile: false,
  status: "pending",
  mutationKind: "edit",
  hunkDecisions: {},
  ...overrides,
});

describe("snapshotReviewState (FR-10, Fase 4)", () => {
  it("keeps only restorable proposals and only decided hunks", () => {
    const state = snapshotReviewState(
      "s-1",
      [
        tab({
          status: "reviewing",
          hunkDecisions: { 0: "accepted", 1: "undecided", 2: "rejected" },
        }),
        tab({ approvalId: "a2", status: "applied" }),
        tab({ approvalId: "a3", status: "rejected" }),
        tab({ approvalId: "a4", status: "conflict" }),
      ],
      123,
    );
    expect(state).toEqual({
      version: 3,
      sessionId: "s-1",
      proposals: [
        {
          approvalId: "a1",
          path: "src/a.ts",
          isNewFile: false,
          status: "reviewing",
          hunkDecisions: { "0": "accepted", "2": "rejected" },
          savedAt: 123,
        },
        {
          approvalId: "a4",
          path: "src/a.ts",
          isNewFile: false,
          status: "conflict",
          hunkDecisions: {},
          savedAt: 123,
        },
      ],
    });
  });

  it("round-trips through serialize/parse", () => {
    const state = snapshotReviewState("s-1", [
      tab({ status: "done", hunkDecisions: { 3: "accepted" } }),
    ]);
    expect(parseReviewState(JSON.parse(serializeReviewState(state)))).toEqual(
      state,
    );
  });
});

describe("snapshotReviewState (FR-10, Fase 5)", () => {
  it("keeps an applied proposal only when it has a checkpoint", () => {
    const checkpoint = {
      approvalId: "a2",
      path: "src/a.ts",
      kind: "edit" as const,
      contentBefore: "a\n",
      contentAfter: "b\n",
      hashBefore: 1,
      hashAfter: 2,
      appliedAt: 5,
      appliedHunks: [0],
    };
    const state = snapshotReviewState(
      "s-1",
      [
        tab({ approvalId: "a2", status: "applied" }),
        tab({ approvalId: "a3", status: "applied" }),
      ],
      123,
      new Map([["a2", checkpoint]]),
    );
    expect(state).toEqual({
      version: 3,
      sessionId: "s-1",
      proposals: [
        {
          approvalId: "a2",
          path: "src/a.ts",
          isNewFile: false,
          status: "applied",
          hunkDecisions: {},
          checkpoint,
          savedAt: 123,
        },
      ],
    });
  });

  it("keeps delete/rename fields on the proposal", () => {
    const state = snapshotReviewState("s-1", [
      tab({
        approvalId: "d1",
        status: "done",
        mutationKind: "delete",
        fileDecision: "accepted",
      }),
      tab({
        approvalId: "r1",
        status: "reviewing",
        mutationKind: "rename",
        targetPath: "src/b.ts",
      }),
    ]);
    expect(state.proposals).toEqual([
      {
        approvalId: "d1",
        path: "src/a.ts",
        isNewFile: false,
        status: "done",
        hunkDecisions: {},
        mutationKind: "delete",
        fileDecision: "accepted",
        savedAt: expect.any(Number),
      },
      {
        approvalId: "r1",
        path: "src/a.ts",
        isNewFile: false,
        status: "reviewing",
        hunkDecisions: {},
        mutationKind: "rename",
        targetPath: "src/b.ts",
        savedAt: expect.any(Number),
      },
    ]);
  });
});

describe("snapshotReviewState checkpoint-only proposals (Fase 9, slice 2)", () => {
  const editCheckpoint = {
    approvalId: "c1",
    path: "src/a.ts",
    kind: "edit" as const,
    contentBefore: "a\n",
    contentAfter: "b\n",
    hashBefore: 1,
    hashAfter: 2,
    appliedAt: 5,
    appliedHunks: [],
  };

  it("persists a checkpoint with no open tab as a pending proposal", () => {
    const state = snapshotReviewState(
      "s-1",
      [],
      123,
      new Map([["c1", editCheckpoint]]),
    );
    expect(state.proposals).toEqual([
      {
        approvalId: "c1",
        path: "src/a.ts",
        isNewFile: false,
        status: "pending",
        hunkDecisions: {},
        checkpoint: editCheckpoint,
        savedAt: 123,
      },
    ]);
    // The synthesized proposal round-trips through parse.
    expect(
      parseReviewState(JSON.parse(serializeReviewState(state))),
    ).toEqual(state);
  });

  it("marks an edit checkpoint with an empty baseline as a new file", () => {
    const state = snapshotReviewState(
      "s-1",
      [],
      123,
      new Map([
        [
          "c2",
          { ...editCheckpoint, approvalId: "c2", contentBefore: "" },
        ],
      ]),
    );
    expect(state.proposals[0]?.isNewFile).toBe(true);
  });

  it("keeps delete/rename fields on checkpoint-only proposals", () => {
    const state = snapshotReviewState(
      "s-1",
      [],
      123,
      new Map([
        [
          "d1",
          {
            approvalId: "d1",
            path: "src/a.ts",
            kind: "delete" as const,
            contentBefore: "gone\n",
            contentAfter: null,
            hashBefore: 1,
            hashAfter: null,
            appliedAt: 5,
            appliedHunks: [],
          },
        ],
        [
          "r1",
          {
            approvalId: "r1",
            path: "src/a.ts",
            kind: "rename" as const,
            contentBefore: "same\n",
            contentAfter: "same\n",
            hashBefore: 1,
            hashAfter: 1,
            targetPath: "src/b.ts",
            appliedAt: 5,
            appliedHunks: [],
          },
        ],
      ]),
    );
    expect(state.proposals).toEqual([
      {
        approvalId: "d1",
        path: "src/a.ts",
        isNewFile: false,
        status: "pending",
        hunkDecisions: {},
        mutationKind: "delete",
        checkpoint: expect.objectContaining({ kind: "delete" }),
        savedAt: 123,
      },
      {
        approvalId: "r1",
        path: "src/a.ts",
        isNewFile: false,
        status: "pending",
        hunkDecisions: {},
        mutationKind: "rename",
        targetPath: "src/b.ts",
        checkpoint: expect.objectContaining({ kind: "rename" }),
        savedAt: 123,
      },
    ]);
  });

  it("lets an open tab win over its checkpoint instead of duplicating", () => {
    const state = snapshotReviewState(
      "s-1",
      [tab({ approvalId: "c1", status: "reviewing" })],
      123,
      new Map([
        ["c1", editCheckpoint],
        [
          "c9",
          { ...editCheckpoint, approvalId: "c9", path: "src/z.ts" },
        ],
      ]),
    );
    expect(state.proposals.map((p) => p.approvalId)).toEqual(["c1", "c9"]);
    expect(state.proposals[0]?.status).toBe("reviewing");
    expect(state.proposals[1]?.status).toBe("pending");
  });

  it("saves nothing when there are no tabs and no checkpoints", () => {
    expect(snapshotReviewState("s-1", [], 123).proposals).toEqual([]);
  });
});

describe("parseReviewState (FR-10, Fase 4)", () => {
  it("rejects wrong versions and malformed shapes", () => {
    expect(parseReviewState(null)).toBeNull();
    expect(parseReviewState("x")).toBeNull();
    expect(
      parseReviewState({ version: 99, sessionId: "s", proposals: [] }),
    ).toBeNull();
    expect(
      parseReviewState({ version: 0, sessionId: "s", proposals: [] }),
    ).toBeNull();
    expect(
      parseReviewState({ version: 2, sessionId: "", proposals: [] }),
    ).toBeNull();
    expect(
      parseReviewState({ version: 2, sessionId: "s", proposals: {} }),
    ).toBeNull();
    expect(
      parseReviewState({ version: 2, sessionId: "s", proposals: [] }),
    ).toEqual({
      version: 3,
      sessionId: "s",
      proposals: [],
    });
  });

  it("parses a v1 state, keeping line decisions for migration", () => {
    const parsed = parseReviewState({
      version: 1,
      sessionId: "s",
      proposals: [
        {
          approvalId: "old",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          lineDecisions: { "0": "accepted", "1": "rejected" },
          savedAt: 7,
        },
      ],
    });
    expect(parsed).toEqual({
      version: 3,
      sessionId: "s",
      proposals: [
        {
          approvalId: "old",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: {},
          lineDecisions: { "0": "accepted", "1": "rejected" },
          savedAt: 7,
        },
      ],
    });
  });

  it("migrates a v2 state to v3, defaulting new fields to edit", () => {
    const parsed = parseReviewState({
      version: 2,
      sessionId: "s",
      proposals: [
        {
          approvalId: "v2",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: { "0": "accepted" },
          savedAt: 3,
        },
      ],
    });
    expect(parsed).toEqual({
      version: 3,
      sessionId: "s",
      proposals: [
        {
          approvalId: "v2",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: { "0": "accepted" },
          savedAt: 3,
        },
      ],
    });
  });

  it("keeps a v3 applied proposal with its checkpoint", () => {
    const checkpoint = {
      approvalId: "a1",
      path: "a.ts",
      kind: "edit",
      contentBefore: "a\n",
      contentAfter: "b\n",
      hashBefore: 1,
      hashAfter: 2,
      appliedAt: 5,
      appliedHunks: [0],
    };
    const parsed = parseReviewState({
      version: 3,
      sessionId: "s",
      proposals: [
        {
          approvalId: "a1",
          path: "a.ts",
          isNewFile: false,
          status: "applied",
          hunkDecisions: {},
          checkpoint,
          savedAt: 1,
        },
      ],
    });
    expect(parsed?.proposals[0]).toMatchObject({
      status: "applied",
      checkpoint,
    });
  });

  it("drops a malformed checkpoint but keeps the proposal", () => {
    const parsed = parseReviewState({
      version: 3,
      sessionId: "s",
      proposals: [
        {
          approvalId: "a1",
          path: "a.ts",
          isNewFile: false,
          status: "applied",
          hunkDecisions: {},
          checkpoint: { approvalId: "a1", kind: "edit" },
          savedAt: 1,
        },
      ],
    });
    expect(parsed?.proposals[0]).not.toHaveProperty("checkpoint");
  });

  it("skips a rename proposal without a target path", () => {
    const parsed = parseReviewState({
      version: 3,
      sessionId: "s",
      proposals: [
        {
          approvalId: "r1",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: {},
          mutationKind: "rename",
          savedAt: 1,
        },
      ],
    });
    expect(parsed?.proposals).toEqual([]);
  });

  it("skips malformed entries instead of dropping the whole state", () => {
    const parsed = parseReviewState({
      version: 2,
      sessionId: "s",
      proposals: [
        {
          approvalId: "",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: {},
          savedAt: 1,
        },
        {
          approvalId: "bad-key",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: { "0": "accepted", x: "accepted" },
          savedAt: 1,
        },
        {
          approvalId: "bad-value",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: { "0": "maybe" },
          savedAt: 1,
        },
        {
          approvalId: "bad-status",
          path: "a.ts",
          isNewFile: false,
          status: "rejected",
          hunkDecisions: {},
          savedAt: 1,
        },
        {
          approvalId: "ok",
          path: "a.ts",
          isNewFile: false,
          status: "pending",
          hunkDecisions: { "0": "accepted" },
          savedAt: 1,
        },
      ],
    });
    expect(parsed?.proposals).toEqual([
      {
        approvalId: "ok",
        path: "a.ts",
        isNewFile: false,
        status: "pending",
        hunkDecisions: { "0": "accepted" },
        savedAt: 1,
      },
    ]);
  });
});

describe("restoreStatus (FR-10)", () => {
  it("reopens conflict as done so the disk guard re-checks at Apply", () => {
    expect(restoreStatus("conflict")).toBe("done");
    expect(restoreStatus("pending")).toBe("pending");
    expect(restoreStatus("reviewing")).toBe("reviewing");
    expect(restoreStatus("done")).toBe("done");
    expect(restoreStatus("applied")).toBe("applied");
  });
});

describe("review state storage in sessions.ts (FR-10)", () => {
  beforeEach(() => {
    storeData.clear();
    toasts.warning.mockClear();
    toasts.error.mockClear();
  });

  const state: PersistedReviewState = {
    version: 3,
    sessionId: "s-1",
    proposals: [
      {
        approvalId: "a1",
        path: "src/a.ts",
        isNewFile: false,
        status: "pending",
        hunkDecisions: { "0": "accepted" },
        savedAt: 1,
      },
    ],
  };

  it("saves and loads a review state round-trip", async () => {
    const mod = await reloadSessions();
    await mod.saveReviewState("s-1", state);
    expect(await mod.loadReviewState("s-1")).toEqual(state);
    expect(await mod.loadReviewState("s-2")).toBeNull();
  });

  it("drops a damaged entry, warns once, and loads null", async () => {
    storeData.set("review:s-1", {
      version: 99,
      sessionId: "s-1",
      proposals: [],
    });
    const mod = await reloadSessions();
    expect(await mod.loadReviewState("s-1")).toBeNull();
    expect(storeData.has("review:s-1")).toBe(false);
    expect(toasts.warning).toHaveBeenCalledOnce();
  });

  it("deletes the review state on demand and with the session", async () => {
    const mod = await reloadSessions();
    await mod.saveReviewState("s-1", state);
    await mod.deleteReviewState("s-1");
    expect(await mod.loadReviewState("s-1")).toBeNull();

    await mod.saveReviewState("s-1", state);
    await mod.deleteSessionData("s-1");
    expect(await mod.loadReviewState("s-1")).toBeNull();
  });

  it("ignores invalid session ids", async () => {
    const mod = await reloadSessions();
    await mod.saveReviewState("../evil", state);
    expect(await mod.loadReviewState("../evil")).toBeNull();
    expect(storeData.size).toBe(0);
  });
});
