import { describe, expect, it } from "vitest";
import {
  buildPendingReviewByPath,
  hasPendingReviewDescendant,
  pendingReviewForPath,
  pendingReviewPathKey,
  shouldOpenReview,
  type PendingReviewRef,
  type PendingReviewRegistryEntry,
  type PendingReviewTab,
} from "./pendingReview";

const FILE = "/workspace/src/a.tsx";
const OTHER = "/workspace/src/b.tsx";

function tab(
  overrides: Partial<PendingReviewTab> = {},
): PendingReviewTab {
  return {
    approvalId: "tool-call-1",
    path: FILE,
    status: "pending",
    mutationKind: "edit",
    ...overrides,
  };
}

function registryEntry(
  overrides: Partial<PendingReviewRegistryEntry> = {},
): PendingReviewRegistryEntry {
  return {
    path: FILE,
    proposal: {
      originalContent: "one",
      proposedContent: "one two",
      isNewFile: false,
      kind: "edit",
      approvalId: "tool-call-1",
    },
    ...overrides,
  };
}

describe("pendingReviewPathKey", () => {
  it("matches backslash and slash spellings of the same path", () => {
    expect(pendingReviewPathKey("C:\\Users\\fania\\a.tsx", true)).toBe(
      pendingReviewPathKey("C:/Users/fania/a.tsx", true),
    );
  });

  it("is case-insensitive on Windows, case-sensitive elsewhere", () => {
    expect(pendingReviewPathKey("C:/Users/Fania/A.tsx", true)).toBe(
      pendingReviewPathKey("c:/users/fania/a.tsx", true),
    );
    expect(pendingReviewPathKey("/Workspace/A.tsx", false)).not.toBe(
      pendingReviewPathKey("/workspace/a.tsx", false),
    );
  });
});

describe("buildPendingReviewByPath", () => {
  it("includes a registry edit entry under its first-write id", () => {
    const map = buildPendingReviewByPath({
      tabs: [],
      registry: [registryEntry()],
    });
    expect(map.get(pendingReviewPathKey(FILE))).toEqual({
      approvalId: "tool-call-1",
      approvalIds: ["tool-call-1"],
    } satisfies PendingReviewRef);
  });

  it("skips registry entries without an approval id (nothing to open a tab under)", () => {
    const entry = registryEntry();
    delete entry.proposal.approvalId;
    const map = buildPendingReviewByPath({ tabs: [], registry: [entry] });
    expect(map.size).toBe(0);
  });

  it("skips registry delete/rename entries (their path is not a live tree file)", () => {
    const map = buildPendingReviewByPath({
      tabs: [],
      registry: [
        registryEntry({
          proposal: {
            originalContent: "gone\n",
            proposedContent: "",
            isNewFile: false,
            kind: "delete",
            approvalId: "tool-call-2",
          },
        }),
        registryEntry({
          path: OTHER,
          proposal: {
            originalContent: "same\n",
            proposedContent: "same\n",
            isNewFile: false,
            kind: "rename",
            targetPath: "/workspace/src/c.tsx",
            approvalId: "tool-call-3",
          },
        }),
      ],
    });
    expect(map.size).toBe(0);
  });

  it("includes an open tab with a reviewable status", () => {
    for (const status of ["pending", "reviewing", "done", "conflict"] as const) {
      const map = buildPendingReviewByPath({
        tabs: [tab({ status })],
        registry: [],
      });
      expect(map.get(pendingReviewPathKey(FILE))).toEqual({
        approvalId: "tool-call-1",
        approvalIds: ["tool-call-1"],
      });
    }
  });

  it("excludes open tabs whose review is terminal", () => {
    for (const status of ["applied", "rejected", "restored"] as const) {
      const map = buildPendingReviewByPath({
        tabs: [tab({ status })],
        registry: [],
      });
      expect(map.has(pendingReviewPathKey(FILE))).toBe(false);
    }
  });

  it("skips delete/rename tabs (their path is not a live tree file)", () => {
    const map = buildPendingReviewByPath({
      tabs: [tab({ mutationKind: "delete" }), tab({ path: OTHER, mutationKind: "rename" })],
      registry: [],
    });
    expect(map.size).toBe(0);
  });

  it("prefers the open tab id and keeps both mutation ids for a composed file", () => {
    const map = buildPendingReviewByPath({
      tabs: [tab({ approvalId: "tool-call-2" })],
      registry: [registryEntry()],
    });
    expect(map.get(pendingReviewPathKey(FILE))).toEqual({
      approvalId: "tool-call-2",
      approvalIds: ["tool-call-2", "tool-call-1"],
    });
  });

  it("keeps the entry when the tab is closed but the registry survives (Fase 33 lesson)", () => {
    const map = buildPendingReviewByPath({
      tabs: [],
      registry: [registryEntry()],
    });
    expect(map.get(pendingReviewPathKey(FILE))).toEqual({
      approvalId: "tool-call-1",
      approvalIds: ["tool-call-1"],
    });
  });

  it("drops the entry once the registry is cleared and the tab is applied", () => {
    const map = buildPendingReviewByPath({
      tabs: [tab({ status: "applied" })],
      registry: [],
    });
    expect(map.has(pendingReviewPathKey(FILE))).toBe(false);
  });

  it("keeps the badge from a still-pending second tab when the first is applied", () => {
    const map = buildPendingReviewByPath({
      tabs: [
        tab({ approvalId: "tool-call-1", status: "applied" }),
        tab({ approvalId: "tool-call-2", status: "reviewing" }),
      ],
      registry: [],
    });
    expect(map.get(pendingReviewPathKey(FILE))).toEqual({
      approvalId: "tool-call-2",
      approvalIds: ["tool-call-2"],
    });
  });
});

describe("pendingReviewForPath / hasPendingReviewDescendant", () => {
  const map = buildPendingReviewByPath({
    tabs: [],
    registry: [registryEntry()],
  });

  it("finds an exact file match and misses other paths", () => {
    expect(pendingReviewForPath(map, FILE)).toEqual({
      approvalId: "tool-call-1",
      approvalIds: ["tool-call-1"],
    });
    expect(pendingReviewForPath(map, OTHER)).toBeUndefined();
  });

  it("matches a backslash-spelled lookup against a slash-spelled entry", () => {
    const winMap = buildPendingReviewByPath({
      tabs: [],
      registry: [registryEntry({ path: "C:\\workspace\\src\\a.tsx" })],
    });
    expect(pendingReviewForPath(winMap, "C:/workspace/src/a.tsx", true)).toEqual({
      approvalId: "tool-call-1",
      approvalIds: ["tool-call-1"],
    });
  });

  it("reports a pending descendant for a folder, not for unrelated folders", () => {
    expect(hasPendingReviewDescendant(map, "/workspace/src")).toBe(true);
    expect(hasPendingReviewDescendant(map, "/workspace")).toBe(true);
    expect(hasPendingReviewDescendant(map, "/workspace/other")).toBe(false);
    expect(hasPendingReviewDescendant(map, FILE)).toBe(false);
  });
});

describe("shouldOpenReview", () => {
  const ref: PendingReviewRef = {
    approvalId: "tool-call-1",
    approvalIds: ["tool-call-1"],
  };

  it("opens the review for a plain click on a pending file", () => {
    expect(
      shouldOpenReview({ isDir: false, shift: false, mod: false, pendingReview: ref }),
    ).toBe(true);
  });

  it("keeps selection behaviour for shift/mod clicks even on a pending file", () => {
    expect(
      shouldOpenReview({ isDir: false, shift: true, mod: false, pendingReview: ref }),
    ).toBe(false);
    expect(
      shouldOpenReview({ isDir: false, shift: false, mod: true, pendingReview: ref }),
    ).toBe(false);
  });

  it("never routes a folder click to the review", () => {
    expect(
      shouldOpenReview({ isDir: true, shift: false, mod: false, pendingReview: ref }),
    ).toBe(false);
  });

  it("opens an ordinary file normally", () => {
    expect(
      shouldOpenReview({ isDir: false, shift: false, mod: false, pendingReview: undefined }),
    ).toBe(false);
    expect(
      shouldOpenReview({ isDir: false, shift: false, mod: false, pendingReview: null }),
    ).toBe(false);
  });
});
