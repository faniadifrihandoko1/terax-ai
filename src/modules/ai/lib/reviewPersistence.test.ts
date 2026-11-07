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
      version: 2,
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
      version: 2,
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
      version: 2,
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
          status: "applied",
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
  });
});

describe("review state storage in sessions.ts (FR-10)", () => {
  beforeEach(() => {
    storeData.clear();
    toasts.warning.mockClear();
    toasts.error.mockClear();
  });

  const state: PersistedReviewState = {
    version: 2,
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
