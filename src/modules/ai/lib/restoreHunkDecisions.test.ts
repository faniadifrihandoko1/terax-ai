import { describe, expect, it } from "vitest";
import type { PersistedReviewProposal } from "./reviewPersistence";
import { restoreHunkDecisions } from "./restoreHunkDecisions";

describe("restoreHunkDecisions (Fase 33)", () => {
  const saved = (
    overrides: Partial<PersistedReviewProposal> = {},
  ): PersistedReviewProposal => ({
    approvalId: "a1",
    path: "src/a.ts",
    isNewFile: false,
    status: "reviewing",
    hunkDecisions: {},
    savedAt: 0,
    ...overrides,
  });

  it("returns an empty map without saved state", () => {
    expect(restoreHunkDecisions(undefined, "old\n", "new\n")).toEqual({});
  });

  it("copies decided hunks from v2 states", () => {
    expect(
      restoreHunkDecisions(
        saved({ hunkDecisions: { "0": "accepted", "2": "rejected" } }),
        "old\n",
        "new\n",
      ),
    ).toEqual({ 0: "accepted", 2: "rejected" });
  });

  it("migrates v1 line decisions to hunks against the rebuilt change set", () => {
    // One hunk: line 2 changed. v1 decisions are keyed by change-list
    // position (0 = removed "b", 1 = added "B"); deciding both migrates
    // to a decision on hunk 0, deciding one leaves it undecided.
    expect(
      restoreHunkDecisions(
        saved({ lineDecisions: { "0": "accepted", "1": "accepted" } }),
        "a\nb\nc\n",
        "a\nB\nc\n",
      ),
    ).toEqual({ 0: "accepted" });
    expect(
      restoreHunkDecisions(
        saved({ lineDecisions: { "1": "accepted" } }),
        "a\nb\nc\n",
        "a\nB\nc\n",
      ),
    ).toEqual({});
  });
});
