import { describe, expect, it } from "vitest";
import { computeLineStats } from "./diffStats";

describe("computeLineStats", () => {
  it("counts added and removed lines", () => {
    expect(computeLineStats("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual({
      added: 2,
      removed: 1,
    });
  });

  it("returns zero for identical content", () => {
    expect(computeLineStats("a\nb\n", "a\nb\n")).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it("counts a new file as all added", () => {
    expect(computeLineStats("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
  });
});
