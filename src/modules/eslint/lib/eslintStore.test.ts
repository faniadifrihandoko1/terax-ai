import { beforeEach, describe, expect, it } from "vitest";
import { useEslintStore } from "./eslintStore";

beforeEach(() => {
  useEslintStore.setState({ byPath: {}, rootStatus: {}, runStatus: {} });
});

describe("runStatus", () => {
  it("records and replaces the last run outcome per path", () => {
    const store = useEslintStore.getState();
    store.setRunStatus("/proj/a.ts", { kind: "running" });
    expect(useEslintStore.getState().runStatus["/proj/a.ts"]).toEqual({
      kind: "running",
    });
    store.setRunStatus("/proj/a.ts", { kind: "ok", errors: 1, warnings: 0 });
    expect(useEslintStore.getState().runStatus["/proj/a.ts"]).toEqual({
      kind: "ok",
      errors: 1,
      warnings: 0,
    });
    store.setRunStatus("/proj/b.ts", { kind: "skipped-dirty" });
    expect(
      useEslintStore.getState().runStatus["/proj/a.ts"],
    ).toEqual({ kind: "ok", errors: 1, warnings: 0 });
  });

  it("clears one path without touching the others", () => {
    const store = useEslintStore.getState();
    store.setRunStatus("/proj/a.ts", { kind: "skipped-dirty" });
    store.setRunStatus("/proj/b.ts", { kind: "disk-read-failed" });
    store.clearRunStatus("/proj/a.ts");
    expect(useEslintStore.getState().runStatus).toEqual({
      "/proj/b.ts": { kind: "disk-read-failed" },
    });
    // Clearing an unknown path is a no-op.
    store.clearRunStatus("/proj/nope.ts");
    expect(useEslintStore.getState().runStatus).toEqual({
      "/proj/b.ts": { kind: "disk-read-failed" },
    });
  });
});
