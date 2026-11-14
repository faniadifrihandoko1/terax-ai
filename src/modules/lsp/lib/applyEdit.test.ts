import { describe, expect, it } from "vitest";
import {
  handleApplyEditRequest,
  registerApplyEditHandler,
} from "./applyEdit";

const URI = "file:///proj/src/a.ts";

describe("handleApplyEditRequest", () => {
  it("routes an edit to the handler registered for its uri", async () => {
    const received: unknown[] = [];
    const unregister = registerApplyEditHandler(URI, async (edit) => {
      received.push(edit);
      return { applied: true };
    });
    try {
      const res = await handleApplyEditRequest({
        edit: {
          documentChanges: [
            {
              textDocument: { uri: URI, version: 3 },
              edits: [
                {
                  range: {
                    start: { line: 0, character: 0 },
                    end: { line: 0, character: 1 },
                  },
                  newText: "X",
                },
              ],
            },
          ],
        },
      });
      expect(res).toEqual({ applied: true });
      expect(received).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  it("returns applied:false when no handler is registered for the uri", async () => {
    const res = await handleApplyEditRequest({
      edit: {
        changes: {
          [URI]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              newText: "X",
            },
          ],
        },
      },
    });
    expect(res).toEqual({ applied: false });
  });

  it("tries the next handler when the first declines", async () => {
    const calls: string[] = [];
    const un1 = registerApplyEditHandler(URI, async () => {
      calls.push("first");
      return { applied: false, reason: "stale" };
    });
    const un2 = registerApplyEditHandler(URI, async () => {
      calls.push("second");
      return { applied: true };
    });
    try {
      const res = await handleApplyEditRequest({
        edit: { changes: { [URI]: [] } },
      });
      expect(res).toEqual({ applied: true });
      expect(calls).toEqual(["first", "second"]);
    } finally {
      un1();
      un2();
    }
  });

  it("returns applied:false for malformed params without throwing", async () => {
    await expect(handleApplyEditRequest(null)).resolves.toEqual({
      applied: false,
    });
    await expect(handleApplyEditRequest({})).resolves.toEqual({
      applied: false,
    });
    await expect(handleApplyEditRequest({ edit: {} })).resolves.toEqual({
      applied: false,
    });
  });
});
