import { describe, expect, it } from "vitest";
import {
  checkDeleteGuard,
  checkRenameGuard,
  isPathInside,
} from "./fileOpGuards";

describe("checkDeleteGuard", () => {
  it("passes when the file is unchanged since the agent read it", () => {
    expect(
      checkDeleteGuard({ exists: true, currentHash: 42, seenHash: 42 }),
    ).toEqual({ ok: true });
  });

  it("refuses a missing file", () => {
    expect(
      checkDeleteGuard({ exists: false, currentHash: null, seenHash: 42 }),
    ).toEqual({ ok: false, reason: "file no longer exists" });
  });

  it("refuses when the agent never read the file", () => {
    expect(
      checkDeleteGuard({ exists: true, currentHash: 42, seenHash: null }),
    ).toEqual({ ok: false, reason: "read the file before deleting it" });
  });

  it("refuses when the content changed after the read", () => {
    expect(
      checkDeleteGuard({ exists: true, currentHash: 7, seenHash: 42 }),
    ).toEqual({ ok: false, reason: "file changed since it was read" });
  });
});

describe("checkRenameGuard", () => {
  it("passes when the source exists and the target is free and inside", () => {
    expect(
      checkRenameGuard({
        sourceExists: true,
        targetExists: false,
        targetInsideWorkspace: true,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a missing source", () => {
    expect(
      checkRenameGuard({
        sourceExists: false,
        targetExists: false,
        targetInsideWorkspace: true,
      }),
    ).toEqual({ ok: false, reason: "source file no longer exists" });
  });

  it("refuses to overwrite an existing target", () => {
    expect(
      checkRenameGuard({
        sourceExists: true,
        targetExists: true,
        targetInsideWorkspace: true,
      }),
    ).toEqual({
      ok: false,
      reason: "target already exists, refusing to overwrite it",
    });
  });

  it("refuses a target outside the workspace", () => {
    expect(
      checkRenameGuard({
        sourceExists: true,
        targetExists: false,
        targetInsideWorkspace: false,
      }),
    ).toEqual({ ok: false, reason: "target is outside the workspace" });
  });
});

describe("isPathInside", () => {
  it("accepts the root itself and descendants", () => {
    expect(isPathInside("/ws", "/ws")).toBe(true);
    expect(isPathInside("/ws", "/ws/src/a.ts")).toBe(true);
    expect(isPathInside("/ws/", "/ws/src/../a.ts")).toBe(true);
  });

  it("rejects siblings and parents, not just string prefixes", () => {
    expect(isPathInside("/ws", "/workspace/a.ts")).toBe(false);
    expect(isPathInside("/ws", "/ws2/a.ts")).toBe(false);
    expect(isPathInside("/ws/src", "/ws/a.ts")).toBe(false);
    expect(isPathInside("/ws/src", "/ws/src/../../etc/passwd")).toBe(false);
  });

  it("handles Windows separators and drive letters", () => {
    expect(isPathInside("C:\\ws", "C:\\ws\\src\\a.ts")).toBe(true);
    expect(isPathInside("C:/ws", "C:/other/a.ts")).toBe(false);
  });
});
