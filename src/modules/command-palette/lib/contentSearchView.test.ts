import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTENT_SEARCH_OPTIONS,
  findMatchRanges,
  groupContentHits,
  summarizeContentSearch,
  type ContentHit,
  type ContentSearchOptions,
} from "./contentSearchView";

const hit = (path: string, rel: string, line: number, text: string): ContentHit => ({
  path,
  rel,
  line,
  text,
});

describe("groupContentHits", () => {
  it("returns no groups for no hits", () => {
    expect(groupContentHits([])).toEqual([]);
  });

  it("groups hits by file in first-appearance order", () => {
    const groups = groupContentHits([
      hit("/root/a.ts", "a.ts", 3, "foo"),
      hit("/root/b.ts", "b.ts", 1, "foo"),
      hit("/root/a.ts", "a.ts", 9, "foo bar"),
    ]);
    expect(groups.map((g) => g.rel)).toEqual(["a.ts", "b.ts"]);
    expect(groups[0].hits.map((h) => h.line)).toEqual([3, 9]);
    expect(groups[1].hits.map((h) => h.line)).toEqual([1]);
  });

  it("exposes the file name and full path per group", () => {
    const [group] = groupContentHits([
      hit("/root/src/app/index.tsx", "src/app/index.tsx", 5, "foo"),
    ]);
    expect(group.path).toBe("/root/src/app/index.tsx");
    expect(group.rel).toBe("src/app/index.tsx");
    expect(group.name).toBe("index.tsx");
  });
});

describe("summarizeContentSearch", () => {
  it("uses singular forms for one result in one file", () => {
    expect(summarizeContentSearch(1, 1, false)).toBe("1 result in 1 file");
  });

  it("uses plural forms for several results and files", () => {
    expect(summarizeContentSearch(5, 2, false)).toBe("5 results in 2 files");
    expect(summarizeContentSearch(5, 1, false)).toBe("5 results in 1 file");
  });

  it("notes truncated results", () => {
    expect(summarizeContentSearch(80, 4, true)).toBe(
      "80 results in 4 files (partial results)",
    );
  });
});

describe("findMatchRanges", () => {
  const literal: ContentSearchOptions = { ...DEFAULT_CONTENT_SEARCH_OPTIONS };
  const matchCase: ContentSearchOptions = {
    ...DEFAULT_CONTENT_SEARCH_OPTIONS,
    matchCase: true,
  };
  const wholeWord: ContentSearchOptions = {
    ...DEFAULT_CONTENT_SEARCH_OPTIONS,
    wholeWord: true,
  };
  const regex: ContentSearchOptions = {
    ...DEFAULT_CONTENT_SEARCH_OPTIONS,
    useRegex: true,
  };

  it("returns no ranges for an empty query", () => {
    expect(findMatchRanges("some text", "", literal)).toEqual([]);
  });

  it("finds a literal match case-insensitively by default (smart-case)", () => {
    expect(findMatchRanges("Instruksi Suitable Test", "suitable", literal)).toEqual([
      { start: 10, end: 18 },
    ]);
  });

  it("is case-sensitive when the query contains an uppercase letter (smart-case)", () => {
    expect(findMatchRanges("suitable test Suitable", "Suitable", literal)).toEqual([
      { start: 14, end: 22 },
    ]);
    expect(findMatchRanges("suitable", "Suitable", literal)).toEqual([]);
  });

  it("is always case-sensitive with matchCase on", () => {
    expect(findMatchRanges("Suitable", "suitable", matchCase)).toEqual([]);
    expect(findMatchRanges("Suitable", "Suitable", matchCase)).toEqual([
      { start: 0, end: 8 },
    ]);
  });

  it("treats the query as a literal, not a regex", () => {
    expect(findMatchRanges("a.b aab", "a.b", literal)).toEqual([{ start: 0, end: 3 }]);
  });

  it("finds every occurrence", () => {
    expect(findMatchRanges("test test test", "test", literal)).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ]);
  });

  it("matches whole words only with wholeWord on", () => {
    expect(findMatchRanges("latest test testing", "test", wholeWord)).toEqual([
      { start: 7, end: 11 },
    ]);
    expect(findMatchRanges("test.", "test", wholeWord)).toEqual([
      { start: 0, end: 4 },
    ]);
  });

  it("evaluates the query as a regex with useRegex on", () => {
    expect(findMatchRanges("test", "t.st", regex)).toEqual([{ start: 0, end: 4 }]);
    expect(findMatchRanges("suitable", "sui.*ble", regex)).toEqual([
      { start: 0, end: 8 },
    ]);
  });

  it("returns no ranges for an invalid regex", () => {
    expect(findMatchRanges("test", "a(", regex)).toEqual([]);
  });

  it("never loops on a zero-length regex match", () => {
    expect(findMatchRanges("abc", "x*", regex)).toEqual([]);
  });

  it("combines wholeWord with regex", () => {
    expect(findMatchRanges("testing test", "test", { ...regex, wholeWord: true })).toEqual([
      { start: 8, end: 12 },
    ]);
  });
});
