import { describe, expect, it } from "vitest";
import {
  buildMinimapGutters,
  diagnosticMinimapGutter,
  hunkMinimapGutter,
  minimapGuttersEqual,
  minimapMarkerColors,
  resolveMinimapDark,
} from "./minimap";

// Fase 22: minimap ala Antigravity. Marker dihitung murni dari data
// yang sudah ada (diagnostik per baris + hunk review); render dan
// scroll/drag ditangani @replit/codemirror-minimap dan tidak bisa
// diuji tanpa DOM env, jadi yang diuji di sini adalah pemetaannya.

describe("minimapMarkerColors", () => {
  it("uses the destructive red + amber-700 in light mode", () => {
    const c = minimapMarkerColors(false);
    expect(c.error).toBe("#c0392f");
    expect(c.warning).toBe("#b45309");
  });

  it("uses the dark destructive red + amber-400 in dark mode", () => {
    const c = minimapMarkerColors(true);
    expect(c.error).toBe("#e35d5d");
    expect(c.warning).toBe("#fbbf24");
  });

  it("prefers an explicit destructive color (theme override)", () => {
    expect(minimapMarkerColors(false, "#ff0000").error).toBe("#ff0000");
    expect(minimapMarkerColors(true, "#ff0000").error).toBe("#ff0000");
  });

  it("uses the hunk-bar hexes in both modes", () => {
    for (const dark of [false, true]) {
      const c = minimapMarkerColors(dark);
      expect(c.hunkUndecided).toBe("#22c55e");
      expect(c.hunkAccepted).toBe("#16a34a");
      expect(c.hunkRejected).toBe("#e11d48");
    }
  });
});

describe("diagnosticMinimapGutter", () => {
  it("maps each diagnostic line to its severity color", () => {
    const colors = minimapMarkerColors(false);
    expect(
      diagnosticMinimapGutter(
        [
          { line: 3, severity: "error" },
          { line: 7, severity: "warning" },
        ],
        colors,
      ),
    ).toEqual({ 3: "#c0392f", 7: "#b45309" });
  });

  it("lets an error beat a warning on the same line", () => {
    const colors = minimapMarkerColors(false);
    expect(
      diagnosticMinimapGutter(
        [
          { line: 5, severity: "warning" },
          { line: 5, severity: "error" },
        ],
        colors,
      ),
    ).toEqual({ 5: "#c0392f" });
  });

  it("ignores info diagnostics and invalid lines", () => {
    const colors = minimapMarkerColors(false);
    expect(
      diagnosticMinimapGutter(
        [
          { line: 2, severity: "info" },
          { line: 0, severity: "error" },
          { line: -1, severity: "warning" },
        ],
        colors,
      ),
    ).toEqual({});
  });

  it("returns an empty gutter when there is nothing to show", () => {
    expect(diagnosticMinimapGutter([], minimapMarkerColors(true))).toEqual(
      {},
    );
  });
});

describe("hunkMinimapGutter", () => {
  it("marks the proposed lines of a hunk (0-based [from, to) -> 1-based)", () => {
    const colors = minimapMarkerColors(false);
    expect(
      hunkMinimapGutter(
        [{ proposedFrom: 4, proposedTo: 7, state: "undecided" }],
        colors,
        20,
      ),
    ).toEqual({ 5: "#22c55e", 6: "#22c55e", 7: "#22c55e" });
  });

  it("colors by hunk decision, like the hunk bars", () => {
    const colors = minimapMarkerColors(false);
    expect(
      hunkMinimapGutter(
        [
          { proposedFrom: 0, proposedTo: 1, state: "accepted" },
          { proposedFrom: 2, proposedTo: 3, state: "rejected" },
        ],
        colors,
        20,
      ),
    ).toEqual({ 1: "#16a34a", 3: "#e11d48" });
  });

  it("marks one line at the deletion point for a pure-deletion hunk", () => {
    const colors = minimapMarkerColors(false);
    // Empty proposed range: nothing added, so there is no proposed
    // line to mark — mark the line where the removed box sits.
    expect(
      hunkMinimapGutter(
        [{ proposedFrom: 9, proposedTo: 9, state: "undecided" }],
        colors,
        20,
      ),
    ).toEqual({ 10: "#22c55e" });
  });

  it("clamps markers to the document", () => {
    const colors = minimapMarkerColors(false);
    expect(
      hunkMinimapGutter(
        [{ proposedFrom: 18, proposedTo: 25, state: "undecided" }],
        colors,
        20,
      ),
    ).toEqual({ 19: "#22c55e", 20: "#22c55e" });
    expect(
      hunkMinimapGutter(
        [{ proposedFrom: 25, proposedTo: 25, state: "undecided" }],
        colors,
        20,
      ),
    ).toEqual({ 20: "#22c55e" });
  });

  it("returns an empty gutter without hunks or without lines", () => {
    const colors = minimapMarkerColors(false);
    expect(hunkMinimapGutter([], colors, 20)).toEqual({});
    expect(
      hunkMinimapGutter(
        [{ proposedFrom: 0, proposedTo: 2, state: "undecided" }],
        colors,
        0,
      ),
    ).toEqual({});
  });
});

describe("buildMinimapGutters", () => {
  it("returns diagnostics first, hunks second, omitting empty ones", () => {
    const gutters = buildMinimapGutters({
      diagnostics: [{ line: 2, severity: "warning" }],
      hunks: [{ proposedFrom: 5, proposedTo: 6, state: "undecided" }],
      lineCount: 10,
      dark: true,
    });
    expect(gutters).toEqual([{ 2: "#fbbf24" }, { 6: "#22c55e" }]);
  });

  it("returns an empty array when there is nothing to mark", () => {
    expect(
      buildMinimapGutters({
        diagnostics: [],
        hunks: [],
        lineCount: 10,
        dark: false,
      }),
    ).toEqual([]);
  });
});

describe("minimapGuttersEqual", () => {
  it("is true for identical gutters regardless of key order", () => {
    expect(
      minimapGuttersEqual(
        [{ 2: "#fbbf24" }, { 6: "#22c55e" }],
        [{ 2: "#fbbf24" }, { 6: "#22c55e" }],
      ),
    ).toBe(true);
  });

  it("is false when a color, a line, or a column differs", () => {
    expect(
      minimapGuttersEqual([{ 2: "#fbbf24" }], [{ 2: "#c0392f" }]),
    ).toBe(false);
    expect(
      minimapGuttersEqual([{ 2: "#fbbf24" }], [{ 3: "#fbbf24" }]),
    ).toBe(false);
    expect(minimapGuttersEqual([{ 2: "#fbbf24" }], [])).toBe(false);
    expect(minimapGuttersEqual([], [])).toBe(true);
  });
});

describe("resolveMinimapDark", () => {
  it("is false without a DOM (node test env)", () => {
    expect(resolveMinimapDark()).toBe(false);
  });
});
