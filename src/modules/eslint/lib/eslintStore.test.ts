import { beforeEach, describe, expect, it } from "vitest";
import {
  isLspEslintActiveForPath,
  useEslintStore,
} from "./eslintStore";

beforeEach(() => {
  useEslintStore.setState({
    byPath: {},
    rootStatus: {},
    runStatus: {},
    projectLint: { status: { kind: "idle" }, files: [] },
    lspActivePaths: {},
  });
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

describe("projectLint", () => {
  it("records a run status and its files together", () => {
    const store = useEslintStore.getState();
    store.setProjectLintStatus({ kind: "running", root: "/proj", startedAt: 7 });
    expect(useEslintStore.getState().projectLint.status).toEqual({
      kind: "running",
      root: "/proj",
      startedAt: 7,
    });
    store.setProjectLintResults(
      { kind: "ok", root: "/proj", errors: 1, warnings: 0, files: 1, at: 8 },
      [
        {
          path: "/proj/a.ts",
          errors: 1,
          warnings: 0,
          messages: [
            {
              ruleId: "r",
              severity: 2,
              message: "e",
              line: 1,
              column: 1,
            },
          ],
        },
      ],
    );
    expect(useEslintStore.getState().projectLint.files).toHaveLength(1);
    store.clearProjectLint();
    expect(useEslintStore.getState().projectLint).toEqual({
      status: { kind: "idle" },
      files: [],
    });
  });
});

describe("lspActivePaths (Fase 12)", () => {
  it("is a refcount: two activations need two deactivations", () => {
    const store = useEslintStore.getState();
    expect(isLspEslintActiveForPath("/proj/a.ts")).toBe(false);
    store.setLspActive("/proj/a.ts", true);
    expect(isLspEslintActiveForPath("/proj/a.ts")).toBe(true);
    store.setLspActive("/proj/a.ts", true);
    store.setLspActive("/proj/a.ts", false);
    expect(isLspEslintActiveForPath("/proj/a.ts")).toBe(true);
    store.setLspActive("/proj/a.ts", false);
    expect(isLspEslintActiveForPath("/proj/a.ts")).toBe(false);
  });

  it("never goes negative and is per path", () => {
    const store = useEslintStore.getState();
    store.setLspActive("/proj/a.ts", false);
    expect(isLspEslintActiveForPath("/proj/a.ts")).toBe(false);
    store.setLspActive("/proj/a.ts", true);
    expect(isLspEslintActiveForPath("/proj/b.ts")).toBe(false);
  });
});
