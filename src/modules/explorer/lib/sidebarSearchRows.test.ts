import { describe, expect, it } from "vitest";
import type { ContentFileGroup } from "@/modules/command-palette/lib/contentSearchView";
import {
  buildSidebarSearchRows,
  toggleCollapsed,
} from "./sidebarSearchRows";

function group(
  path: string,
  rel: string,
  lines: number[],
): ContentFileGroup {
  return {
    path,
    rel,
    name: rel.split("/").pop() ?? rel,
    hits: lines.map((line) => ({
      path,
      rel,
      line,
      text: `line ${line} content`,
    })),
  };
}

describe("buildSidebarSearchRows", () => {
  it("returns no rows for no groups", () => {
    expect(buildSidebarSearchRows([], new Set())).toEqual([]);
  });

  it("expands a group into a header row plus one row per hit, in order", () => {
    const groups = [group("/r/a.ts", "a.ts", [3, 7])];
    const rows = buildSidebarSearchRows(groups, new Set());
    expect(rows.map((r) => r.kind)).toEqual(["group", "hit", "hit"]);
    expect(rows[0]).toMatchObject({ kind: "group", path: "/r/a.ts" });
    expect(rows[1]).toMatchObject({ kind: "hit", path: "/r/a.ts", line: 3 });
    expect(rows[2]).toMatchObject({ kind: "hit", path: "/r/a.ts", line: 7 });
  });

  it("a collapsed group contributes only its header row", () => {
    const groups = [
      group("/r/a.ts", "a.ts", [3]),
      group("/r/b.ts", "b.ts", [1, 2]),
    ];
    const rows = buildSidebarSearchRows(groups, new Set(["/r/a.ts"]));
    expect(rows.map((r) => r.kind)).toEqual(["group", "group", "hit", "hit"]);
    expect(rows[2]).toMatchObject({ kind: "hit", path: "/r/b.ts", line: 1 });
  });

  it("keeps groups in first-appearance order", () => {
    const groups = [
      group("/r/z.ts", "z.ts", [1]),
      group("/r/a.ts", "a.ts", [1]),
    ];
    const rows = buildSidebarSearchRows(groups, new Set());
    expect(rows.map((r) => r.path)).toEqual([
      "/r/z.ts",
      "/r/z.ts",
      "/r/a.ts",
      "/r/a.ts",
    ]);
  });
});

describe("toggleCollapsed", () => {
  it("adds a path that is not collapsed", () => {
    const next = toggleCollapsed(new Set(), "/r/a.ts");
    expect(next.has("/r/a.ts")).toBe(true);
  });

  it("removes a path that is collapsed", () => {
    const next = toggleCollapsed(new Set(["/r/a.ts"]), "/r/a.ts");
    expect(next.has("/r/a.ts")).toBe(false);
  });

  it("does not mutate the input set", () => {
    const prev = new Set(["/r/a.ts"]);
    const next = toggleCollapsed(prev, "/r/b.ts");
    expect(prev.has("/r/b.ts")).toBe(false);
    expect(next.has("/r/a.ts")).toBe(true);
    expect(next.has("/r/b.ts")).toBe(true);
  });
});
