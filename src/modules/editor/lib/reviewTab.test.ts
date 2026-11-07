import { describe, expect, it } from "vitest";
import type { AiDiffTab, Tab } from "@/modules/tabs";
import { normalizeReviewPath, reviewTabFor } from "./reviewTab";

function aiDiffTab(
  overrides: Partial<AiDiffTab> & { approvalId: string; path: string },
): AiDiffTab {
  return {
    id: 1,
    kind: "ai-diff",
    spaceId: null,
    title: "a.ts (AI diff)",
    originalContent: "a\n",
    proposedContent: "b\n",
    status: "pending",
    isNewFile: false,
    mutationKind: "edit",
    hunkDecisions: {},
    ...overrides,
  } as AiDiffTab;
}

describe("normalizeReviewPath", () => {
  it("canonicalizes Windows separators to forward slashes", () => {
    expect(normalizeReviewPath("C:\\work\\a.ts")).toBe("C:/work/a.ts");
    expect(normalizeReviewPath("/work/a.ts")).toBe("/work/a.ts");
  });
});

describe("reviewTabFor (Fase 4)", () => {
  it("finds the proposal for a file by path", () => {
    const tabs: Tab[] = [
      aiDiffTab({ id: 2, approvalId: "x", path: "/work/b.ts" }),
      aiDiffTab({ id: 3, approvalId: "y", path: "/work/a.ts" }),
    ];
    expect(reviewTabFor(tabs, "/work/a.ts")?.approvalId).toBe("y");
    expect(reviewTabFor(tabs, "/work/c.ts")).toBeNull();
  });

  it("matches across separator styles", () => {
    const tabs: Tab[] = [
      aiDiffTab({ approvalId: "w", path: "C:\\work\\a.ts" }),
    ];
    expect(reviewTabFor(tabs, "C:/work/a.ts")?.approvalId).toBe("w");
  });

  it("returns the first proposal when a file has several", () => {
    const tabs: Tab[] = [
      aiDiffTab({ id: 2, approvalId: "first", path: "/work/a.ts" }),
      aiDiffTab({ id: 3, approvalId: "second", path: "/work/a.ts" }),
    ];
    expect(reviewTabFor(tabs, "/work/a.ts")?.approvalId).toBe("first");
  });

  it("returns applied and rejected proposals too (caller gates status)", () => {
    const tabs: Tab[] = [
      aiDiffTab({ approvalId: "done", path: "/work/a.ts", status: "applied" }),
    ];
    expect(reviewTabFor(tabs, "/work/a.ts")?.approvalId).toBe("done");
  });

  it("ignores non-ai-diff tabs", () => {
    const tabs = [
      { id: 9, kind: "editor", path: "/work/a.ts" } as unknown as Tab,
    ];
    expect(reviewTabFor(tabs, "/work/a.ts")).toBeNull();
  });

  it("ignores delete/rename proposals, which have no inline editor view", () => {
    const tabs: Tab[] = [
      aiDiffTab({
        approvalId: "del",
        path: "/work/a.ts",
        mutationKind: "delete",
      }),
      aiDiffTab({
        approvalId: "ren",
        path: "/work/a.ts",
        mutationKind: "rename",
        targetPath: "/work/b.ts",
      }),
    ];
    expect(reviewTabFor(tabs, "/work/a.ts")).toBeNull();
    expect(reviewTabFor(tabs, "/work/b.ts")).toBeNull();
  });
});
