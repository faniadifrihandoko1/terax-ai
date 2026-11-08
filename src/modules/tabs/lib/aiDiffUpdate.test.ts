import { describe, expect, it } from "vitest";
import { updateAiDiffTabState } from "./aiDiffUpdate";
import type { AiDiffTab } from "./useTabs";

function tab(over: Partial<AiDiffTab> = {}): AiDiffTab {
  return {
    id: 1,
    kind: "ai-diff",
    spaceId: "s1",
    title: "a.ts (AI diff)",
    path: "/ws/a.ts",
    originalContent: "a\n",
    proposedContent: "a\nb\n",
    approvalId: "call-1",
    status: "pending",
    isNewFile: false,
    mutationKind: "edit",
    hunkDecisions: {},
    written: false,
    ...over,
  };
}

describe("updateAiDiffTabState", () => {
  it("absorbs newer composed content and resets hunk decisions", () => {
    const next = updateAiDiffTabState(
      tab({ hunkDecisions: { 0: "accepted" } }),
      "a\nb\nc\n",
    );
    expect(next).not.toBeNull();
    expect(next?.proposedContent).toBe("a\nb\nc\n");
    expect(next?.hunkDecisions).toEqual({});
    expect(next?.originalContent).toBe("a\n");
  });

  it("leaves the tab alone when the content is identical", () => {
    const t = tab({ hunkDecisions: { 0: "accepted" } });
    const next = updateAiDiffTabState(t, "a\nb\n");
    expect(next).toBe(t);
  });

  it("refuses a tab the user has started reviewing", () => {
    for (const status of ["reviewing", "done", "applied"] as const) {
      expect(updateAiDiffTabState(tab({ status }), "a\nb\nc\n")).toBeNull();
    }
  });

  it("refuses delete/rename tabs", () => {
    expect(
      updateAiDiffTabState(
        tab({ mutationKind: "delete", proposedContent: "" }),
        "",
      ),
    ).toBeNull();
    expect(
      updateAiDiffTabState(
        tab({ mutationKind: "rename", targetPath: "/ws/b.ts" }),
        "a\n",
      ),
    ).toBeNull();
  });
});
