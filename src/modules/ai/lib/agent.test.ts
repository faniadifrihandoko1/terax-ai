import { convertToModelMessages, type UIMessage } from "ai";
import { describe, expect, it } from "vitest";

function historyWithIncompleteToolCall(): UIMessage[] {
  return [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Do it" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        // A tool call whose result never came back (stream died mid-call).
        {
          type: "tool-edit",
          toolCallId: "call-1",
          state: "input-available",
          input: { path: "x.ts", old_string: "a", new_string: "b" },
        },
      ],
    },
  ] as unknown as UIMessage[];
}

describe("convertToModelMessages with incomplete tool calls (Fase 9)", () => {
  it("drops the incomplete call with ignoreIncompleteToolCalls", async () => {
    const messages = await convertToModelMessages(
      historyWithIncompleteToolCall(),
      { ignoreIncompleteToolCalls: true },
    );
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("call-1");
  });

  it("keeps the dangling tool call without the option (the old behaviour)", async () => {
    const messages = await convertToModelMessages(
      historyWithIncompleteToolCall(),
    );
    expect(JSON.stringify(messages)).toContain("call-1");
  });
});
