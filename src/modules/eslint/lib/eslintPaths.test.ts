import { describe, expect, it } from "vitest";
import { eslintPathKey } from "./eslintPaths";

describe("eslintPathKey", () => {
  it("converts backslashes to forward slashes", () => {
    expect(eslintPathKey("C:\\Proj\\src\\a.ts", false)).toBe(
      "C:/Proj/src/a.ts",
    );
    expect(eslintPathKey("C:/Proj/src/a.ts", false)).toBe("C:/Proj/src/a.ts");
  });

  it("folds case on Windows, where the filesystem is case-insensitive", () => {
    expect(eslintPathKey("C:\\Proj\\Src\\A.TS", true)).toBe(
      "c:/proj/src/a.ts",
    );
    expect(eslintPathKey("/proj/src/a.ts", true)).toBe("/proj/src/a.ts");
  });

  it("keeps case on case-sensitive filesystems", () => {
    expect(eslintPathKey("/Proj/Src/A.ts", false)).toBe("/Proj/Src/A.ts");
  });
});
