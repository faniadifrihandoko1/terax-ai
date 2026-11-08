import { describe, expect, it } from "vitest";
import { djb2Hash } from "./hash";

describe("djb2Hash — output is locked", () => {
  it("returns the djb2 seed for the empty string", () => {
    expect(djb2Hash("")).toBe(5381);
  });

  it("locks known values (changing the algorithm breaks stored checkpoints)", () => {
    expect(djb2Hash("a")).toBe(177670);
    expect(djb2Hash("hello")).toBe(261238937);
    expect(djb2Hash("The quick brown fox jumps over the lazy dog")).toBe(
      885799134,
    );
    expect(djb2Hash("héllo wörld")).toBe(1259250924);
    expect(djb2Hash("x".repeat(1000))).toBe(2570149573);
  });

  it("is deterministic and distinguishes small changes", () => {
    expect(djb2Hash("hello")).toBe(djb2Hash("hello"));
    expect(djb2Hash("hello")).not.toBe(djb2Hash("hellp"));
    expect(djb2Hash("hello\n")).not.toBe(djb2Hash("hello"));
  });
});
