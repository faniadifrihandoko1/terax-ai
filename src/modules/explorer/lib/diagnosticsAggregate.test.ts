import { describe, expect, it } from "vitest";
import { diagnosticsForEntry } from "./diagnosticsAggregate";

const byPath = {
  "/proj/src/a.ts": { errors: 2, warnings: 1 },
  "/proj/src/deep/b.ts": { errors: 0, warnings: 3 },
  "/proj/other/c.ts": { errors: 0, warnings: 0 },
};

describe("diagnosticsForEntry", () => {
  it("returns the exact counts for a file", () => {
    expect(diagnosticsForEntry(byPath, "/proj/src/a.ts", false)).toEqual({
      errors: 2,
      warnings: 1,
    });
  });

  it("returns null for a clean file or an unknown path", () => {
    expect(diagnosticsForEntry(byPath, "/proj/other/c.ts", false)).toBeNull();
    expect(diagnosticsForEntry(byPath, "/proj/nope.ts", false)).toBeNull();
  });

  it("sums everything underneath a folder", () => {
    expect(diagnosticsForEntry(byPath, "/proj/src", true)).toEqual({
      errors: 2,
      warnings: 4,
    });
    expect(diagnosticsForEntry(byPath, "/proj", true)).toEqual({
      errors: 2,
      warnings: 4,
    });
  });

  it("returns null for a folder with nothing underneath", () => {
    expect(diagnosticsForEntry(byPath, "/proj/other", true)).toBeNull();
  });

  it("does not match a sibling prefix", () => {
    expect(diagnosticsForEntry(byPath, "/proj/sr", true)).toBeNull();
  });

  it("normalizes backslashes and trailing slashes", () => {
    expect(diagnosticsForEntry(byPath, "C:\\proj\\src", true)).toBeNull();
    expect(
      diagnosticsForEntry(
        { "C:/proj/src/a.ts": { errors: 1, warnings: 0 } },
        "C:\\proj\\src\\",
        true,
      ),
    ).toEqual({ errors: 1, warnings: 0 });
  });
});
