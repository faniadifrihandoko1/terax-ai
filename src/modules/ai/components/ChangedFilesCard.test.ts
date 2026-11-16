import { describe, expect, it } from "vitest";
import {
  acceptAllApprovalIds,
  type ChangedFileEntry,
} from "./ChangedFilesCard";

function entry(overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return {
    key: "k",
    path: "/x/a.ts",
    approvalId: "appr-1",
    kind: "edit",
    editCount: 1,
    mutations: [],
    status: "pending",
    ...overrides,
  };
}

describe("acceptAllApprovalIds (Fase 20)", () => {
  it("includes pending, reviewing, and done files", () => {
    expect(
      acceptAllApprovalIds([
        entry({ key: "a", approvalId: "a1", status: "pending" }),
        entry({ key: "b", approvalId: "a2", status: "reviewing" }),
        entry({ key: "c", approvalId: "a3", status: "done" }),
      ]),
    ).toEqual(["a1", "a2", "a3"]);
  });

  it("excludes already-resolved files", () => {
    expect(
      acceptAllApprovalIds([
        entry({ key: "a", approvalId: "a1", status: "applied" }),
        entry({ key: "b", approvalId: "a2", status: "rejected" }),
        entry({ key: "c", approvalId: "a3", status: "conflict" }),
        entry({ key: "d", approvalId: "a4", status: "restored" }),
      ]),
    ).toEqual([]);
  });

  it("excludes rows without an approval id", () => {
    expect(
      acceptAllApprovalIds([
        entry({ key: "a", approvalId: null, status: "pending" }),
        entry({ key: "b", approvalId: "a2", status: "pending" }),
      ]),
    ).toEqual(["a2"]);
  });

  it("returns an empty list when nothing is left to confirm", () => {
    expect(acceptAllApprovalIds([])).toEqual([]);
  });
});
