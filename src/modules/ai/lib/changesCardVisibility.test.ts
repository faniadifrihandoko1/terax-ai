import { describe, expect, it } from "vitest";
import { shouldShowChangesCard } from "./changesCardVisibility";

function filePart(over: Record<string, unknown> = {}) {
  return {
    type: "tool-edit",
    state: "output-available",
    toolCallId: "call-1",
    input: { path: "x.ts", old_string: "a", new_string: "b" },
    ...over,
  };
}

function bashApprovalPart() {
  return {
    type: "tool-bash_run",
    state: "approval-requested",
    toolCallId: "call-bash",
    approval: { id: "appr-1" },
    input: { command: "pnpm build" },
  };
}

describe("shouldShowChangesCard (Fase 7)", () => {
  it("hides the card while the message is still streaming", () => {
    expect(shouldShowChangesCard([filePart()], true)).toBe(false);
  });

  it("hides the card while a terminal-command approval is outstanding", () => {
    // The stream is suspended for approval, so `streaming` is false here:
    // the approval-requested part is what marks the run as still active.
    expect(
      shouldShowChangesCard([filePart(), bashApprovalPart()], false),
    ).toBe(false);
  });

  it("hides the card when both streaming and an approval are pending", () => {
    expect(
      shouldShowChangesCard([filePart(), bashApprovalPart()], true),
    ).toBe(false);
  });

  it("shows the card once the run finished", () => {
    expect(shouldShowChangesCard([filePart()], false)).toBe(true);
  });

  it("shows the card for a restored review from a previous session", () => {
    // Restored parts are output-available; nothing streams, nothing waits.
    expect(
      shouldShowChangesCard(
        [
          filePart(),
          {
            type: "text",
            text: "Done — see the changes below.",
          },
        ],
        false,
      ),
    ).toBe(true);
  });

  it("shows the card for a stopped or errored run (no approval outstanding)", () => {
    // A stop or an error ends the stream with no approval-requested part,
    // so the proposals so far must stay reachable instead of vanishing.
    expect(shouldShowChangesCard([filePart()], false)).toBe(true);
  });

  it("returns true for a message with no parts (no changes group renders anyway)", () => {
    expect(shouldShowChangesCard([], false)).toBe(true);
    expect(shouldShowChangesCard([], true)).toBe(false);
  });
});
