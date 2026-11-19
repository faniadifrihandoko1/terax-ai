import { describe, expect, it } from "vitest";
import {
  deriveTabLessStatus,
  mergeCardStatuses,
  pickRevertApprovalId,
  revertReviewedFile,
  type CardRevertIo,
} from "./cardRevert";
import {
  buildDeleteCheckpoint,
  buildEditCheckpoint,
  buildRenameCheckpoint,
  type FileCheckpoint,
} from "./reviewCheckpoint";

function editCheckpoint(
  over: Partial<Parameters<typeof buildEditCheckpoint>[0]> = {},
): FileCheckpoint {
  return buildEditCheckpoint({
    approvalId: "appr-1",
    path: "/x/a.ts",
    originalContent: "line1\nline2\n",
    reconstructedContent: "line1\nCHANGED\n",
    appliedHunks: [],
    ...over,
  });
}

function fakeIo(over: Partial<CardRevertIo> = {}): {
  io: CardRevertIo;
  cleared: string[];
  restored: string[];
} {
  const cleared: string[] = [];
  const restored: string[] = [];
  const cp = editCheckpoint();
  return {
    io: {
      getCheckpoint: () => cp,
      restore: async (approvalId: string) => {
        restored.push(approvalId);
        return { outcome: "restored", approvalId, path: cp.path };
      },
      clearPendingProposal: (path: string) => {
        cleared.push(path);
      },
      ...over,
    },
    cleared,
    restored,
  };
}

describe("revertReviewedFile (Fase 35)", () => {
  it("restores the file to the checkpoint baseline and clears the pending proposal", async () => {
    const { io, cleared, restored } = fakeIo();
    const result = await revertReviewedFile("appr-1", io);
    expect(result).toEqual({
      outcome: "restored",
      approvalId: "appr-1",
      path: "/x/a.ts",
    });
    expect(restored).toEqual(["appr-1"]);
    // The registry entry must go too: otherwise the sidebar badge
    // (Fase 34) keeps marking the file pending and the bridge could
    // re-collect the proposal on a later run.
    expect(cleared).toEqual(["/x/a.ts"]);
  });

  it("reports no-checkpoint and touches nothing when no checkpoint exists", async () => {
    const { io, cleared, restored } = fakeIo({
      getCheckpoint: () => undefined,
    });
    const result = await revertReviewedFile("appr-1", io);
    expect(result).toEqual({
      outcome: "no-checkpoint",
      approvalId: "appr-1",
      path: "",
    });
    expect(restored).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("reports a conflict honestly and keeps the proposal when the disk moved", async () => {
    const { io, cleared, restored } = fakeIo({
      restore: async (approvalId: string) => {
        restored.push(approvalId);
        return {
          outcome: "conflict",
          approvalId,
          path: "/x/a.ts",
          reason: "file changed on disk since the apply",
        };
      },
    });
    const result = await revertReviewedFile("appr-1", io);
    expect(result.outcome).toBe("conflict");
    expect(restored).toEqual(["appr-1"]);
    // No revert happened, so the proposal stays: the user can fix the
    // disk and retry instead of losing the review.
    expect(cleared).toEqual([]);
  });

  it("reports restore-failed and keeps the proposal", async () => {
    const { io, cleared } = fakeIo({
      restore: async (approvalId: string) => ({
        outcome: "restore-failed",
        approvalId,
        path: "/x/a.ts",
        reason: "permission denied",
      }),
    });
    const result = await revertReviewedFile("appr-1", io);
    expect(result.outcome).toBe("restore-failed");
    expect(cleared).toEqual([]);
  });

  it("reports no-checkpoint when the checkpoint vanished mid-revert", async () => {
    const { io, cleared } = fakeIo({
      restore: async (approvalId: string) => ({
        outcome: "no-checkpoint",
        approvalId,
        path: "/x/a.ts",
      }),
    });
    const result = await revertReviewedFile("appr-1", io);
    expect(result.outcome).toBe("no-checkpoint");
    expect(cleared).toEqual([]);
  });
});

describe("deriveTabLessStatus (Fase 35)", () => {
  it("is pending while the registry still holds the proposal", () => {
    expect(
      deriveTabLessStatus({
        hasRegistryProposal: true,
        checkpoint: editCheckpoint(),
      }),
    ).toBe("pending");
  });

  it("is applied for a confirmed edit whose tab is closed", () => {
    // Registry cleared by Confirm; checkpoint kept, with the written
    // content differing from the baseline.
    expect(
      deriveTabLessStatus({
        hasRegistryProposal: false,
        checkpoint: editCheckpoint(),
      }),
    ).toBe("applied");
  });

  it("is rejected for an edit fully rejected in its tab", () => {
    // A full reject confirms with the reconstruction equal to the
    // baseline, so the checkpoint's written content is the baseline.
    expect(
      deriveTabLessStatus({
        hasRegistryProposal: false,
        checkpoint: editCheckpoint({ reconstructedContent: "line1\nline2\n" }),
      }),
    ).toBe("rejected");
  });

  it("is applied for a confirmed delete or rename whose tab is closed", () => {
    expect(
      deriveTabLessStatus({
        hasRegistryProposal: false,
        checkpoint: buildDeleteCheckpoint({
          approvalId: "appr-d",
          path: "/x/a.ts",
          content: "line1\n",
        }),
      }),
    ).toBe("applied");
    expect(
      deriveTabLessStatus({
        hasRegistryProposal: false,
        checkpoint: buildRenameCheckpoint({
          approvalId: "appr-r",
          path: "/x/a.ts",
          targetPath: "/x/b.ts",
          content: "line1\n",
        }),
      }),
    ).toBe("applied");
  });

  it("is pending when neither the registry nor a checkpoint knows the file", () => {
    // Legacy proposal with no checkpoint: the card cannot tell it
    // apart from a pending one, so it keeps the old default.
    expect(
      deriveTabLessStatus({ hasRegistryProposal: false }),
    ).toBe("pending");
  });
});

describe("pickRevertApprovalId (Fase 35)", () => {
  const restorable = new Set(["call-1", "call-3"]);

  it("prefers the row id when it has a checkpoint", () => {
    expect(pickRevertApprovalId(["call-1", "call-2"], restorable)).toBe(
      "call-1",
    );
  });

  it("falls back to a mutation id with a checkpoint", () => {
    // A composed row whose row id never got a checkpoint (the
    // checkpoint lives under the first write's id).
    expect(pickRevertApprovalId(["call-2", "call-3"], restorable)).toBe(
      "call-3",
    );
  });

  it("returns undefined when no id has a checkpoint", () => {
    expect(pickRevertApprovalId(["call-2", null], restorable)).toBeUndefined();
    expect(pickRevertApprovalId([], restorable)).toBeUndefined();
  });
});

describe("mergeCardStatuses (Fase 35)", () => {
  it("lets an open tab win over a card-resolved status", () => {
    const merged = mergeCardStatuses(
      new Map([["a", "applied"]]),
      new Map([["a", "rejected"]]),
    );
    expect(merged.get("a")).toBe("applied");
  });

  it("keeps a card-resolved status for a closed tab", () => {
    const merged = mergeCardStatuses(
      new Map(),
      new Map([["a", "rejected"]]),
    );
    expect(merged.get("a")).toBe("rejected");
  });
});
