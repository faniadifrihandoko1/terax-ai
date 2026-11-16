import { describe, expect, it } from "vitest";
import { decideOpenFileDiff } from "./openFileDiffAction";

/**
 * Fase 20: a click on a Changed Files row always opens the ai-diff tab
 * (like Antigravity). The old Fase 4 behaviour — opening the file in the
 * editor when inline review is on — is deliberately gone: with the
 * inline decorations hidden for already-reviewed files, the click
 * landed on a plain file with no diff at all. The inline review itself
 * (Fase 4) still renders in the editor; only the card's click routing
 * changed.
 */
describe("decideOpenFileDiff (Fase 20)", () => {
  it("activates the ai-diff tab for an edit even when inline review is on", () => {
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: true,
        mutationKind: "edit",
      }),
    ).toEqual({ kind: "activate-ai-diff" });
  });

  it("activates the ai-diff tab when inline review is off", () => {
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: false,
        mutationKind: "edit",
      }),
    ).toEqual({ kind: "activate-ai-diff" });
  });

  it("activates the ai-diff tab for delete proposals even with inline on", () => {
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: true,
        mutationKind: "delete",
      }),
    ).toEqual({ kind: "activate-ai-diff" });
  });

  it("activates the ai-diff tab for rename proposals even with inline on", () => {
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: true,
        mutationKind: "rename",
      }),
    ).toEqual({ kind: "activate-ai-diff" });
  });

  it("falls back to editor plus toast when the ai-diff tab does not exist yet", () => {
    expect(
      decideOpenFileDiff({
        tabExists: false,
        aiReviewInline: true,
        mutationKind: "edit",
      }),
    ).toEqual({ kind: "fallback-editor-toast" });
  });

  it("falls back even when inline review is off and there is no tab", () => {
    expect(
      decideOpenFileDiff({
        tabExists: false,
        aiReviewInline: false,
        mutationKind: "delete",
      }),
    ).toEqual({ kind: "fallback-editor-toast" });
  });

  it("reports an error toast when activation was attempted and failed", () => {
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: false,
        mutationKind: "edit",
        activateSucceeded: false,
      }),
    ).toEqual({ kind: "error-toast" });
  });

  it("still activates the ai-diff tab when activation succeeded", () => {
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: false,
        mutationKind: "edit",
        activateSucceeded: true,
      }),
    ).toEqual({ kind: "activate-ai-diff" });
  });
});
