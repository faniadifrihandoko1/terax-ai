import { describe, expect, it } from "vitest";
import {
  computeLineChanges,
  countDecisions,
  reconstructFile,
  splitLines,
  splitPairs,
  type LineDecisions,
} from "./lineDiff";

function decide(
  pairs: Array<[number, "accepted" | "rejected"]>,
): LineDecisions {
  return new Map(pairs);
}

function acceptAll(cs: ReturnType<typeof computeLineChanges>): LineDecisions {
  return new Map(cs.changes.map((c) => [c.index, "accepted" as const]));
}

function rejectAll(cs: ReturnType<typeof computeLineChanges>): LineDecisions {
  return new Map(cs.changes.map((c) => [c.index, "rejected" as const]));
}

describe("splitLines", () => {
  it("handles empty, single-line, and trailing-newline docs", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual([
      { text: "a", terminator: "", start: 0, end: 1 },
    ]);
    expect(splitLines("a\n")).toEqual([
      { text: "a", terminator: "\n", start: 0, end: 2 },
    ]);
    expect(splitLines("a\n\n")).toEqual([
      { text: "a", terminator: "\n", start: 0, end: 2 },
      { text: "", terminator: "\n", start: 2, end: 3 },
    ]);
  });

  it("keeps CRLF terminators out of the text", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual([
      { text: "a", terminator: "\r\n", start: 0, end: 3 },
      { text: "b", terminator: "\r\n", start: 3, end: 6 },
    ]);
  });
});

describe("computeLineChanges", () => {
  it("finds nothing for identical docs", () => {
    const cs = computeLineChanges("a\nb\n", "a\nb\n");
    expect(cs.hunks).toEqual([]);
    expect(cs.changes).toEqual([]);
  });

  it("finds a single added line at the end", () => {
    const cs = computeLineChanges("a\nb\n", "a\nb\nc\n");
    expect(cs.hunks).toHaveLength(1);
    expect(cs.changes).toEqual([
      expect.objectContaining({
        kind: "added",
        text: "c",
        baseLine: null,
        proposedLine: 2,
      }),
    ]);
    expect(
      reconstructFile("a\nb\n", cs, acceptAll(cs)).content,
    ).toBe("a\nb\nc\n");
    expect(
      reconstructFile("a\nb\n", cs, rejectAll(cs)).content,
    ).toBe("a\nb\n");
  });

  it("handles appending to a file without a trailing newline", () => {
    const cs = computeLineChanges("a", "a\nb");
    expect(
      reconstructFile("a", cs, acceptAll(cs)).content,
    ).toBe("a\nb");
    expect(
      reconstructFile("a", cs, rejectAll(cs)).content,
    ).toBe("a");
  });

  it("finds a single removed line", () => {
    const cs = computeLineChanges("a\nb\nc\n", "a\nc\n");
    expect(cs.changes).toEqual([
      expect.objectContaining({
        kind: "removed",
        text: "b",
        baseLine: 1,
        proposedLine: null,
      }),
    ]);
    expect(
      reconstructFile("a\nb\nc\n", cs, acceptAll(cs)).content,
    ).toBe("a\nc\n");
    expect(
      reconstructFile("a\nb\nc\n", cs, rejectAll(cs)).content,
    ).toBe("a\nb\nc\n");
  });

  it("pairs a replaced line and keeps both on a split decision", () => {
    const original = "a\nfoo bar\nc\n";
    const proposed = "a\nfoo baz\nc\n";
    const cs = computeLineChanges(original, proposed);
    expect(cs.hunks).toHaveLength(1);
    expect(cs.changes).toHaveLength(2);
    const [removed, added] = cs.changes;
    expect(removed.kind).toBe("removed");
    expect(added.kind).toBe("added");
    expect(removed.pairId).toBe(added.pairId);
    expect(removed.pairId).not.toBeNull();
    expect(
      reconstructFile(original, cs, acceptAll(cs)).content,
    ).toBe(proposed);
    expect(
      reconstructFile(original, cs, rejectAll(cs)).content,
    ).toBe(original);
    // Accept the addition, reject the deletion: both lines survive.
    const split = decide([
      [removed.index, "rejected"],
      [added.index, "accepted"],
    ]);
    expect(reconstructFile(original, cs, split).content).toBe(
      "a\nfoo bar\nfoo baz\nc\n",
    );
    expect(splitPairs(cs.changes, split)).toEqual([removed.pairId]);
    // Accept the deletion, reject the addition: the line is gone.
    const gone = decide([
      [removed.index, "accepted"],
      [added.index, "rejected"],
    ]);
    expect(reconstructFile(original, cs, gone).content).toBe("a\nc\n");
    expect(splitPairs(cs.changes, gone)).toEqual([removed.pairId]);
  });

  it("splits a 1-to-2 replacement into a pair plus an unpaired add", () => {
    const original = "a\nb\nc\n";
    const proposed = "a\nB1\nB2\nc\n";
    const cs = computeLineChanges(original, proposed);
    expect(cs.changes).toHaveLength(3);
    const [removed, add1, add2] = cs.changes;
    expect(removed.pairId).toBe(add1.pairId);
    expect(add2.pairId).toBeNull();
    const partial = decide([
      [removed.index, "accepted"],
      [add1.index, "accepted"],
      [add2.index, "rejected"],
    ]);
    expect(reconstructFile(original, cs, partial).content).toBe(
      "a\nB1\nc\n",
    );
  });

  it("keeps the right duplicate line when deleting", () => {
    // LCS must not match the wrong "a": deleting the first two lines
    // keeps the last two, not one of them.
    const original = "b\na\na\na\n";
    const proposed = "a\na\n";
    const cs = computeLineChanges(original, proposed);
    expect(reconstructFile(original, cs, acceptAll(cs)).content).toBe(proposed);
    expect(reconstructFile(original, cs, rejectAll(cs)).content).toBe(original);
  });

  it("pairs a line appended to an unterminated last line", () => {
    const original = "b\na";
    const proposed = "b\na'";
    const cs = computeLineChanges(original, proposed);
    expect(cs.changes).toHaveLength(2);
    expect(cs.changes[0]).toMatchObject({ kind: "removed", text: "a" });
    expect(cs.changes[1]).toMatchObject({ kind: "added", text: "a'" });
    expect(reconstructFile(original, cs, acceptAll(cs)).content).toBe(proposed);
  });

  it("finds two separate hunks", () => {
    const original = "a\nb\nc\nd\ne\nf\n";
    const proposed = "a\nB\nc\nd\nE\nf\n";
    const cs = computeLineChanges(original, proposed);
    expect(cs.hunks).toHaveLength(2);
    expect(cs.changes).toHaveLength(4);
  });

  it("handles joining two lines into one", () => {
    const original = "a\nb\n";
    const proposed = "ab\n";
    const cs = computeLineChanges(original, proposed);
    expect(
      reconstructFile(original, cs, acceptAll(cs)).content,
    ).toBe(proposed);
    expect(
      reconstructFile(original, cs, rejectAll(cs)).content,
    ).toBe(original);
  });

  it("handles splitting one line into two", () => {
    const original = "ab\n";
    const proposed = "a\nb\n";
    const cs = computeLineChanges(original, proposed);
    expect(
      reconstructFile(original, cs, acceptAll(cs)).content,
    ).toBe(proposed);
    expect(
      reconstructFile(original, cs, rejectAll(cs)).content,
    ).toBe(original);
  });

  it("handles a whole new file and a whole deleted file", () => {
    const created = computeLineChanges("", "x\ny\n");
    expect(created.changes).toHaveLength(2);
    expect(
      reconstructFile("", created, acceptAll(created)).content,
    ).toBe("x\ny\n");
    expect(
      reconstructFile("", created, rejectAll(created)).content,
    ).toBe("");
    const deleted = computeLineChanges("x\ny\n", "");
    expect(deleted.changes).toHaveLength(2);
    expect(
      reconstructFile("x\ny\n", deleted, acceptAll(deleted)).content,
    ).toBe("");
    expect(
      reconstructFile("x\ny\n", deleted, rejectAll(deleted)).content,
    ).toBe("x\ny\n");
  });

  it("keeps CRLF endings through reconstruction", () => {
    const original = "a\r\nb\r\n";
    const proposed = "a\r\nB\r\n";
    const cs = computeLineChanges(original, proposed);
    expect(
      reconstructFile(original, cs, acceptAll(cs)).content,
    ).toBe(proposed);
    expect(
      reconstructFile(original, cs, rejectAll(cs)).content,
    ).toBe(original);
  });

  it("handles a mid-line word change as one pair", () => {
    const original = "const x = 1;\nconst y = 2;\n";
    const proposed = "const x = 1;\nconst y = 3;\n";
    const cs = computeLineChanges(original, proposed);
    expect(cs.hunks).toHaveLength(1);
    expect(cs.changes).toHaveLength(2);
    expect(
      reconstructFile(original, cs, acceptAll(cs)).content,
    ).toBe(proposed);
  });

  it("reports decided lines for the preview highlight", () => {
    const original = "a\nb\nc\n";
    const proposed = "a\nB\nc\nd\n";
    const cs = computeLineChanges(original, proposed);
    const d = decide([
      [cs.changes[0].index, "accepted"],
      [cs.changes[1].index, "accepted"],
      [cs.changes[2].index, "accepted"],
    ]);
    const { content, decidedLines } = reconstructFile(original, cs, d);
    expect(content).toBe(proposed);
    expect(decidedLines).toEqual([2, 4]);
  });
});

describe("reconstruction invariants on random edits", () => {
  // Deterministic pseudo-random edits over a small line alphabet (with
  // duplicates and missing trailing newlines) to shake out alignment
  // bugs: accept-all must reproduce the proposal exactly, reject-all
  // must reproduce the original exactly.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  it("holds for 200 random edit sequences", () => {
    const rand = rng(20261107);
    const alphabet = ["a", "b", "c", "a", "b"];
    for (let iter = 0; iter < 200; iter++) {
      const n = 1 + Math.floor(rand() * 8);
      const origLines: string[] = [];
      for (let i = 0; i < n; i++) {
        origLines.push(alphabet[Math.floor(rand() * alphabet.length)]);
      }
      const propLines = [...origLines];
      const edits = Math.floor(rand() * 3);
      for (let e = 0; e < edits; e++) {
        const kind = Math.floor(rand() * 3);
        const at = Math.floor(rand() * (propLines.length + 1));
        if (kind === 0) {
          propLines.splice(at, 0, alphabet[Math.floor(rand() * alphabet.length)]);
        } else if (kind === 1 && propLines.length > 0) {
          propLines.splice(Math.min(at, propLines.length - 1), 1);
        } else if (propLines.length > 0) {
          propLines[Math.min(at, propLines.length - 1)] =
            alphabet[Math.floor(rand() * alphabet.length)] + "'";
        }
      }
      const trailing = rand() < 0.5;
      const original = origLines.join("\n") + (trailing ? "\n" : "");
      const proposed = propLines.join("\n") + (trailing ? "\n" : "");
      const cs = computeLineChanges(original, proposed);
      expect(
        reconstructFile(original, cs, acceptAll(cs)).content,
        `accept-all iter ${iter}: ${JSON.stringify(original)} -> ${JSON.stringify(proposed)}`,
      ).toBe(proposed);
      expect(
        reconstructFile(original, cs, rejectAll(cs)).content,
        `reject-all iter ${iter}`,
      ).toBe(original);
    }
  });
});

describe("countDecisions", () => {
  it("counts decided, accepted, and rejected lines", () => {
    const cs = computeLineChanges("a\nb\nc\n", "a\nB\nC\n");
    const d = decide([
      [cs.changes[0].index, "accepted"],
      [cs.changes[1].index, "rejected"],
    ]);
    expect(countDecisions(cs.changes, d)).toEqual({
      decided: 2,
      total: 4,
      accepted: 1,
      rejected: 1,
    });
    expect(countDecisions(cs.changes, new Map())).toEqual({
      decided: 0,
      total: 4,
      accepted: 0,
      rejected: 0,
    });
  });
});
