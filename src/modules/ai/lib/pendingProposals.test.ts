import { describe, expect, it, beforeEach } from "vitest";
import {
  clearAllPendingProposals,
  clearPendingProposal,
  composePendingProposal,
  getPendingProposal,
} from "./pendingProposals";

const FILE = "/workspace/a.txt";

beforeEach(() => {
  clearAllPendingProposals();
});

describe("pendingProposals", () => {
  it("records a first proposal with its on-disk original", () => {
    const p = composePendingProposal(FILE, "hello", "hello world", false);
    expect(p).toEqual({
      originalContent: "hello",
      proposedContent: "hello world",
      isNewFile: false,
      kind: "edit",
    });
    expect(getPendingProposal(FILE)).toEqual(p);
  });

  it("keeps the first original when a later proposal composes on top", () => {
    composePendingProposal(FILE, "one", "one two", false);
    const p = composePendingProposal(FILE, "one two", "one two three", false);
    expect(p.originalContent).toBe("one");
    expect(p.proposedContent).toBe("one two three");
  });

  it("records a delete with its kind and an empty written content", () => {
    const p = composePendingProposal(FILE, "gone\n", "", false, "delete");
    expect(p).toEqual({
      originalContent: "gone\n",
      proposedContent: "",
      isNewFile: false,
      kind: "delete",
    });
  });

  it("records a rename with its kind and target path", () => {
    const p = composePendingProposal(
      FILE,
      "same\n",
      "same\n",
      false,
      "rename",
      "/workspace/b.txt",
    );
    expect(p.kind).toBe("rename");
    expect(p.targetPath).toBe("/workspace/b.txt");
    expect(p.proposedContent).toBe("same\n");
  });

  it("keeps the first kind when a later write composes on top", () => {
    composePendingProposal(FILE, "one", "one two", false, "delete");
    const p = composePendingProposal(FILE, "one two", "one two three", false);
    expect(p.kind).toBe("delete");
    expect(p.originalContent).toBe("one");
  });

  it("lets a whole-file write replace the composed content", () => {
    composePendingProposal(FILE, "one", "one two", false);
    const p = composePendingProposal(FILE, "one", "brand new", false);
    expect(p.originalContent).toBe("one");
    expect(p.proposedContent).toBe("brand new");
  });

  it("returns undefined for paths with no proposal", () => {
    expect(getPendingProposal(FILE)).toBeUndefined();
  });

  it("clears one path without touching the others", () => {
    composePendingProposal(FILE, "a", "b", false);
    composePendingProposal("/workspace/c.txt", "x", "y", true);
    clearPendingProposal(FILE);
    expect(getPendingProposal(FILE)).toBeUndefined();
    expect(getPendingProposal("/workspace/c.txt")).toEqual({
      originalContent: "x",
      proposedContent: "y",
      isNewFile: true,
      kind: "edit",
    });
  });

  it("clears everything", () => {
    composePendingProposal(FILE, "a", "b", false);
    clearAllPendingProposals();
    expect(getPendingProposal(FILE)).toBeUndefined();
  });
});
