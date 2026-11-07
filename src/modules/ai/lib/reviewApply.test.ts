import { describe, expect, it } from "vitest";
import { allLinesDecided, type LineDecisions } from "./reviewApply";

describe("allLinesDecided", () => {
  it("is true when every changed line has a decision", () => {
    const decisions: LineDecisions = new Map([
      [3, "accepted"],
      [4, "rejected"],
    ]);
    expect(allLinesDecided(decisions, [3, 4])).toBe(true);
  });

  it("is false when a line is undecided or missing", () => {
    const decisions: LineDecisions = new Map([
      [3, "accepted"],
      [4, "undecided"],
    ]);
    expect(allLinesDecided(decisions, [3, 4])).toBe(false);
    expect(allLinesDecided(new Map([[3, "accepted"]]), [3, 4])).toBe(false);
  });

  it("is true when nothing changed", () => {
    expect(allLinesDecided(new Map(), [])).toBe(true);
  });
});
