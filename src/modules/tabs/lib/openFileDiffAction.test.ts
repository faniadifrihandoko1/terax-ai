import { describe, expect, it } from "vitest";
import { decideOpenFileDiff } from "./openFileDiffAction";

/**
 * Fase 20: a click on a Changed Files row always opens the ai-diff tab
 * (like Antigravity). The old Fase 4 behaviour — opening the file in the
 * editor when inline review is on — is deliberately gone, so the
 * decision no longer takes an inline-review flag or a mutation kind at
 * all: with the tab present, the answer is always the tab.
 */
describe("decideOpenFileDiff (Fase 20)", () => {
  it("activates the ai-diff tab when it exists", () => {
    expect(decideOpenFileDiff({ tabExists: true })).toEqual({
      kind: "activate-ai-diff",
    });
  });

  it("falls back to editor plus toast when the ai-diff tab does not exist yet", () => {
    expect(decideOpenFileDiff({ tabExists: false })).toEqual({
      kind: "fallback-editor-toast",
    });
  });

  it("reports an error toast when activation was attempted and failed", () => {
    expect(
      decideOpenFileDiff({ tabExists: true, activateSucceeded: false }),
    ).toEqual({ kind: "error-toast" });
  });

  it("still activates the ai-diff tab when activation succeeded", () => {
    expect(
      decideOpenFileDiff({ tabExists: true, activateSucceeded: true }),
    ).toEqual({ kind: "activate-ai-diff" });
  });
});
