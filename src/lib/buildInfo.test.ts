import { describe, expect, it } from "vitest";
import { BUILD_COMMIT } from "./buildInfo";

describe("BUILD_COMMIT", () => {
  it("is a short git hash, or 'dev' without git", () => {
    expect(BUILD_COMMIT).toMatch(/^[0-9a-f]{7,40}$|^dev$/);
  });
});
