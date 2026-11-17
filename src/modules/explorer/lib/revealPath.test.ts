import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  normalizeExplorerPath,
  relativeSegments,
} from "./revealPath";

describe("normalizeExplorerPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeExplorerPath("C:\\Users\\fania\\proj\\src\\a.ts")).toBe(
      "C:/Users/fania/proj/src/a.ts",
    );
  });

  it("strips trailing slashes", () => {
    expect(normalizeExplorerPath("/repo/src/")).toBe("/repo/src");
    expect(normalizeExplorerPath("C:\\proj\\")).toBe("C:/proj");
  });

  it("leaves the filesystem root alone", () => {
    expect(normalizeExplorerPath("/")).toBe("/");
  });

  it("leaves an already-normal path untouched", () => {
    expect(normalizeExplorerPath("/repo/src/a.ts")).toBe("/repo/src/a.ts");
  });
});

describe("relativeSegments", () => {
  it("returns the segments below the root", () => {
    expect(
      relativeSegments("/repo/src/app/a.ts", "/repo"),
    ).toEqual(["src", "app", "a.ts"]);
  });

  it("returns an empty list when the file is the root itself", () => {
    expect(relativeSegments("/repo", "/repo")).toEqual([]);
  });

  it("returns null when the file is outside the root", () => {
    expect(relativeSegments("/other/x.ts", "/repo")).toBeNull();
  });

  it("does not match a sibling whose name merely starts with the root", () => {
    expect(relativeSegments("/repo2/x.ts", "/repo")).toBeNull();
  });

  it("tolerates a trailing slash on the root", () => {
    expect(relativeSegments("/repo/src/a.ts", "/repo/")).toEqual([
      "src",
      "a.ts",
    ]);
  });

  it("matches across separator styles and drive-letter case", () => {
    expect(
      relativeSegments("C:/Users/fania/proj/src/a.ts", "c:\\Users\\fania\\proj"),
    ).toEqual(["src", "a.ts"]);
  });
});

describe("ancestorDirs", () => {
  it("lists every ancestor dir top-down, excluding root and file", () => {
    expect(ancestorDirs("/repo/src/app/a.ts", "/repo")).toEqual([
      "/repo/src",
      "/repo/src/app",
    ]);
  });

  it("returns an empty list for a file directly under the root", () => {
    expect(ancestorDirs("/repo/a.ts", "/repo")).toEqual([]);
  });

  it("returns an empty list when the file is the root itself", () => {
    expect(ancestorDirs("/repo", "/repo")).toEqual([]);
  });

  it("returns an empty list for a file outside the root", () => {
    expect(ancestorDirs("/other/x.ts", "/repo")).toEqual([]);
    expect(ancestorDirs("/repo2/x.ts", "/repo")).toEqual([]);
  });

  it("rebuilds ancestors from the root string, so keys match the tree", () => {
    // The tree builds child paths with joinPath(rootPath, name); a Windows
    // root that still carries backslashes must be preserved verbatim or
    // expanded.has() will never match the row keys.
    expect(
      ancestorDirs(
        "C:/Users/fania/proj/src/app/a.ts",
        "C:\\Users\\fania\\proj",
      ),
    ).toEqual([
      "C:\\Users\\fania\\proj/src",
      "C:\\Users\\fania\\proj/src/app",
    ]);
  });

  it("matches a root whose drive letter differs only in case", () => {
    expect(ancestorDirs("C:/proj/src/a.ts", "c:/proj")).toEqual([
      "c:/proj/src",
    ]);
  });

  it("replicates the reported case: a deep Next.js route file", () => {
    expect(
      ancestorDirs(
        "/repo/src/app/[locale]/(global)/(online-test)/online-test/session/_page/components/type-test/numeric/container.tsx",
        "/repo",
      ),
    ).toEqual([
      "/repo/src",
      "/repo/src/app",
      "/repo/src/app/[locale]",
      "/repo/src/app/[locale]/(global)",
      "/repo/src/app/[locale]/(global)/(online-test)",
      "/repo/src/app/[locale]/(global)/(online-test)/online-test",
      "/repo/src/app/[locale]/(global)/(online-test)/online-test/session",
      "/repo/src/app/[locale]/(global)/(online-test)/online-test/session/_page",
      "/repo/src/app/[locale]/(global)/(online-test)/online-test/session/_page/components",
      "/repo/src/app/[locale]/(global)/(online-test)/online-test/session/_page/components/type-test",
      "/repo/src/app/[locale]/(global)/(online-test)/online-test/session/_page/components/type-test/numeric",
    ]);
  });
});
