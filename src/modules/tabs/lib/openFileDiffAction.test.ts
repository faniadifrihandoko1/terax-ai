import { describe, expect, it } from "vitest";
import { decideOpenFileDiff } from "./openFileDiffAction";

describe("decideOpenFileDiff", () => {
  it("opens the editor when inline review is on and the proposal is an edit", () => {
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: true,
        mutationKind: "edit",
      }),
    ).toEqual({ kind: "open-editor" });
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

  it("prefers the editor for an inline edit even when activation failed before", () => {
    // The inline branch never attempts activation, so a stale failure
    // must not turn an inline open into an error toast.
    expect(
      decideOpenFileDiff({
        tabExists: true,
        aiReviewInline: true,
        mutationKind: "edit",
        activateSucceeded: false,
      }),
    ).toEqual({ kind: "open-editor" });
  });
});
