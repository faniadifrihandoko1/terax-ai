import { describe, expect, it } from "vitest";
import {
  buildReferenceTree,
  extractLinePreview,
  formatReferenceItemLabel,
  groupReferenceLocations,
  toggleReferenceGroup,
  visibleReferenceRows,
  type ReferenceLocationInput,
} from "./referenceTree";

const ROOT = "C:/Users/fania/OneDrive/文档/fix-recruitment/recruitment_FE";
const DEF_URI =
  "file:///C:/Users/fania/OneDrive/%E6%96%87%E6%A1%A3/fix-recruitment/recruitment_FE/src/view/(admin)/vacancies/modal/add-module/index.tsx";
const PAGE_A_URI =
  "file:///C:/Users/fania/OneDrive/%E6%96%87%E6%A1%A3/fix-recruitment/recruitment_FE/src/view/(admin)/vacancies/page-a.tsx";
const PAGE_B_URI =
  "file:///C:/Users/fania/OneDrive/%E6%96%87%E6%A1%A3/fix-recruitment/recruitment_FE/src/view/(admin)/vacancies/page-b.tsx";
const PAGE_C_URI =
  "file:///C:/Users/fania/OneDrive/%E6%96%87%E6%A1%A3/fix-recruitment/recruitment_FE/src/view/(admin)/vacancies/page-c.tsx";

// The user's real shape, from the tsserver probe: the declaration plus one
// import-specifier and one JSX usage per importing file (7 locations).
function fixtureLocations(): ReferenceLocationInput[] {
  return [
    { uri: DEF_URI, line: 6, character: 13, preview: "export const AddPositionModuleModal = ({" },
    { uri: PAGE_A_URI, line: 0, character: 9, preview: 'import { AddPositionModuleModal } from "./modal/add-module";' },
    { uri: PAGE_A_URI, line: 3, character: 10, preview: '<AddPositionModuleModal openModal toggle={() => {}} vacanciesId="1" />' },
    { uri: PAGE_B_URI, line: 0, character: 9, preview: 'import { AddPositionModuleModal } from "./modal/add-module";' },
    { uri: PAGE_B_URI, line: 3, character: 10, preview: '<AddPositionModuleModal openModal toggle={() => {}} vacanciesId="1" />' },
    { uri: PAGE_C_URI, line: 0, character: 9, preview: 'import { AddPositionModuleModal } from "./modal/add-module";' },
    { uri: PAGE_C_URI, line: 3, character: 10, preview: '<AddPositionModuleModal openModal toggle={() => {}} vacanciesId="1" />' },
  ];
}

describe("groupReferenceLocations", () => {
  it("groups by file, sorted by relative path, items sorted by line then character", () => {
    const groups = groupReferenceLocations(fixtureLocations(), ROOT);
    expect(groups.map((g) => g.fileName)).toEqual([
      "index.tsx",
      "page-a.tsx",
      "page-b.tsx",
      "page-c.tsx",
    ]);
    expect(groups.map((g) => g.items.length)).toEqual([1, 2, 2, 2]);
    expect(groups[0].relPath).toBe(
      "src/view/(admin)/vacancies/modal/add-module/index.tsx",
    );
    expect(groups[1].items.map((i) => i.line)).toEqual([0, 3]);
  });

  it("dedups by full position (uri + line + character), not by label", () => {
    const locs: ReferenceLocationInput[] = [
      { uri: PAGE_A_URI, line: 3, character: 10 },
      { uri: PAGE_A_URI, line: 3, character: 10 },
      { uri: PAGE_A_URI, line: 3, character: 22 },
    ];
    const groups = groupReferenceLocations(locs, ROOT);
    expect(groups).toHaveLength(1);
    // Same line, different column is a different reference: the old
    // flat panel dropped it because it deduped by `file:line`.
    expect(groups[0].items).toHaveLength(2);
  });

  it("falls back to the full path for locations outside the project root", () => {
    const outside: ReferenceLocationInput[] = [
      { uri: "file:///C:/other/lib.tsx", line: 0, character: 0 },
    ];
    const groups = groupReferenceLocations(outside, ROOT);
    expect(groups[0].relPath).toBe("C:/other/lib.tsx");
    expect(groups[0].fileName).toBe("lib.tsx");
  });

  it("returns no groups for no locations", () => {
    expect(groupReferenceLocations([], ROOT)).toEqual([]);
  });
});

describe("buildReferenceTree", () => {
  it("keeps the title and total, and starts with every group expanded (VS Code default)", () => {
    const tree = buildReferenceTree(
      "References",
      fixtureLocations(),
      ROOT,
    );
    expect(tree.title).toBe("References");
    expect(tree.total).toBe(7);
    expect(tree.groups).toHaveLength(4);
    expect(tree.groups.every((g) => g.collapsed === false)).toBe(true);
  });
});

describe("toggleReferenceGroup", () => {
  it("flips only the named group and leaves the tree immutable", () => {
    const tree = buildReferenceTree("References", fixtureLocations(), ROOT);
    const toggled = toggleReferenceGroup(tree, PAGE_B_URI);
    expect(toggled.groups[2].collapsed).toBe(true);
    expect(toggled.groups.filter((g) => g.collapsed)).toHaveLength(1);
    expect(tree.groups[2].collapsed).toBe(false);
  });

  it("ignores unknown uris", () => {
    const tree = buildReferenceTree("References", fixtureLocations(), ROOT);
    expect(toggleReferenceGroup(tree, "file:///nope.tsx")).toBe(tree);
  });
});

describe("visibleReferenceRows", () => {
  it("lists group headers plus items of expanded groups, in order", () => {
    const tree = buildReferenceTree("References", fixtureLocations(), ROOT);
    const rows = visibleReferenceRows(tree);
    // 4 group headers + 7 items.
    expect(rows).toHaveLength(11);
    expect(rows[0]).toMatchObject({ kind: "group", groupUri: DEF_URI });
    expect(rows[1]).toMatchObject({ kind: "item", groupUri: DEF_URI });
    expect(rows[2]).toMatchObject({ kind: "group", groupUri: PAGE_A_URI });
  });

  it("hides the items of a collapsed group", () => {
    const tree = buildReferenceTree("References", fixtureLocations(), ROOT);
    const collapsed = toggleReferenceGroup(tree, PAGE_A_URI);
    const rows = visibleReferenceRows(collapsed);
    expect(rows).toHaveLength(9);
    expect(rows.some((r) => r.kind === "item" && r.groupUri === PAGE_A_URI)).toBe(
      false,
    );
    expect(rows.some((r) => r.kind === "group" && r.groupUri === PAGE_A_URI)).toBe(
      true,
    );
  });
});

describe("extractLinePreview", () => {
  it("returns the trimmed line text", () => {
    expect(
      extractLinePreview("line one\n  export const X = 1;  \nline three", 1),
    ).toBe("export const X = 1;");
  });

  it("returns null for out-of-range lines and blank lines", () => {
    expect(extractLinePreview("one\ntwo", 5)).toBeNull();
    expect(extractLinePreview("one\n   \ntwo", 1)).toBeNull();
    expect(extractLinePreview(null, 0)).toBeNull();
  });

  it("truncates very long lines", () => {
    const long = "x".repeat(300);
    const preview = extractLinePreview(long, 0);
    expect(preview).not.toBeNull();
    expect(preview!.length).toBeLessThanOrEqual(161);
    expect(preview!.endsWith("…")).toBe(true);
  });
});

describe("formatReferenceItemLabel", () => {
  it("prefers the line preview, and falls back to file:line", () => {
    expect(
      formatReferenceItemLabel(
        { uri: PAGE_A_URI, line: 3, character: 10, preview: "<AddPositionModuleModal />" },
        ROOT,
      ),
    ).toBe("<AddPositionModuleModal />");
    expect(
      formatReferenceItemLabel({ uri: PAGE_A_URI, line: 3, character: 10 }, ROOT),
    ).toBe("src/view/(admin)/vacancies/page-a.tsx:4");
  });
});
