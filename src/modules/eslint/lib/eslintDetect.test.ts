import { describe, expect, it } from "vitest";
import { detectEslint } from "./eslintDetect";
import {
  ancestorDirs,
  canonicalPath,
  dirnameOf,
  isLintablePath,
  joinPosix,
} from "./eslintPaths";

describe("isLintablePath", () => {
  it("accepts the JS/TS family", () => {
    for (const ext of ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"]) {
      expect(isLintablePath(`/proj/a.${ext}`)).toBe(true);
    }
  });

  it("rejects other files and extensionless paths", () => {
    expect(isLintablePath("/proj/a.py")).toBe(false);
    expect(isLintablePath("/proj/a.json")).toBe(false);
    expect(isLintablePath("/proj/a.css")).toBe(false);
    expect(isLintablePath("/proj/Makefile")).toBe(false);
    expect(isLintablePath("/proj/.eslintrc")).toBe(false);
  });

  it("handles Windows separators and case", () => {
    expect(isLintablePath("C:\\proj\\a.TSX")).toBe(true);
  });
});

describe("ancestorDirs", () => {
  it("lists innermost first and stops at the root", () => {
    expect(ancestorDirs("/a/b/c/d.ts")).toEqual(["/a/b/c", "/a/b", "/a", "/"]);
    expect(ancestorDirs("C:/proj/src/a.ts")).toEqual([
      "C:/proj/src",
      "C:/proj",
      "C:",
    ]);
  });

  it("respects the depth bound", () => {
    expect(ancestorDirs("/a/b/c/d/e/f.ts", 2)).toEqual(["/a/b/c/d/e", "/a/b/c/d"]);
  });
});

describe("dirnameOf / joinPosix / canonicalPath", () => {
  it("splits and joins forward-slash paths", () => {
    expect(dirnameOf("/a/b/c.ts")).toBe("/a/b");
    expect(dirnameOf("C:\\a\\b.ts")).toBe("C:/a");
    expect(canonicalPath("C:\\a\\b.ts")).toBe("C:/a/b.ts");
    expect(joinPosix("/a/", "/b/", "c")).toBe("/a/b/c");
    expect(joinPosix("C:", "proj", "x")).toBe("C:/proj/x");
  });
});

describe("detectEslint", () => {
  const statFor = (existing: Set<string>) => async (p: string) =>
    existing.has(p);

  it("finds the binary at the project root", async () => {
    const res = await detectEslint("/proj/src/deep/a.ts", {
      stat: statFor(new Set(["/proj/node_modules/.bin/eslint"])),
      windows: false,
    });
    expect(res).toEqual({
      status: "found",
      root: "/proj",
      binary: "/proj/node_modules/.bin/eslint",
    });
  });

  it("prefers the nearest node_modules in a monorepo", async () => {
    const res = await detectEslint("/proj/packages/web/src/a.ts", {
      stat: statFor(
        new Set([
          "/proj/node_modules/.bin/eslint",
          "/proj/packages/web/node_modules/.bin/eslint",
        ]),
      ),
      windows: false,
    });
    expect(res.status).toBe("found");
    if (res.status === "found") {
      expect(res.root).toBe("/proj/packages/web");
    }
  });

  it("looks for eslint.cmd on Windows", async () => {
    const res = await detectEslint("C:/proj/src/a.ts", {
      stat: statFor(new Set(["C:/proj/node_modules/.bin/eslint.cmd"])),
      windows: true,
    });
    expect(res).toEqual({
      status: "found",
      root: "C:/proj",
      binary: "C:/proj/node_modules/.bin/eslint.cmd",
    });
  });

  it("reports missing with a diagnosis when no binary exists", async () => {
    const res = await detectEslint("/proj/src/a.ts", {
      // The file's own directory is visible; only the binary is absent.
      stat: statFor(new Set(["/proj/src"])),
      windows: false,
    });
    expect(res).toEqual({
      status: "missing",
      searchedLevels: 3,
      truncatedByCap: false,
      controlStatFailed: false,
    });
  });

  it("reports a failed control stat when even the file's directory is invisible", async () => {
    const res = await detectEslint("/proj/src/a.ts", {
      stat: statFor(new Set()),
      windows: false,
    });
    expect(res).toEqual({
      status: "missing",
      searchedLevels: 3,
      truncatedByCap: false,
      controlStatFailed: true,
    });
  });

  it("reports a truncated walk for a very deep file", async () => {
    const res = await detectEslint(
      "/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o.ts",
      {
        // Directories exist, but no binary anywhere in the walk.
        stat: async (p) => !p.includes("node_modules"),
        windows: false,
      },
    );
    expect(res.status).toBe("missing");
    if (res.status === "missing") {
      expect(res.searchedLevels).toBe(12);
      expect(res.truncatedByCap).toBe(true);
      expect(res.controlStatFailed).toBe(false);
    }
  });
});
