import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getEslintEditorPresence,
  hasEslintRunListener,
  onEslintRunRequested,
  requestEslintRun,
  setEslintEditorPresence,
} from "./eslintRequests";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  // Presence entries registered by a test must not leak into the next one.
  setEslintEditorPresence("C:\\Proj\\src\\a.ts", null);
  setEslintEditorPresence("C:\\Proj\\src\\b.ts", null);
});

describe("eslint run listeners", () => {
  it("finds a listener regardless of separator form", () => {
    const cb = vi.fn();
    cleanups.push(onEslintRunRequested("C:\\Proj\\src\\a.ts", cb));
    expect(hasEslintRunListener("C:/Proj/src/a.ts")).toBe(true);
    requestEslintRun("C:/Proj/src/a.ts");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("reports no listener for a path nothing subscribed to", () => {
    expect(hasEslintRunListener("C:\\Proj\\src\\missing.ts")).toBe(false);
  });

  it("unsubscribing removes the listener", () => {
    const off = onEslintRunRequested("C:\\Proj\\src\\a.ts", () => {});
    expect(hasEslintRunListener("C:/Proj/src/a.ts")).toBe(true);
    off();
    expect(hasEslintRunListener("C:/Proj/src/a.ts")).toBe(false);
  });
});

describe("eslint editor presence", () => {
  it("records and reads presence regardless of separator form", () => {
    expect(getEslintEditorPresence("C:/Proj/src/a.ts")).toBeNull();
    setEslintEditorPresence("C:\\Proj\\src\\a.ts", "loading");
    expect(getEslintEditorPresence("C:/Proj/src/a.ts")).toBe("loading");
    setEslintEditorPresence("C:/Proj/src/a.ts", "ready");
    expect(getEslintEditorPresence("C:\\Proj\\src\\a.ts")).toBe("ready");
  });

  it("removes presence when the editor goes away", () => {
    setEslintEditorPresence("C:\\Proj\\src\\b.ts", "ready");
    setEslintEditorPresence("C:/Proj/src/b.ts", null);
    expect(getEslintEditorPresence("C:\\Proj\\src\\b.ts")).toBeNull();
  });
});
