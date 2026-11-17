import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { atomone } from "@uiw/codemirror-theme-atomone";
import { githubDark } from "@uiw/codemirror-theme-github";
import {
  buildMinimapGutters,
  buildMinimapSnapshot,
  diagnosticMinimapGutter,
  hunkMinimapGutter,
  minimapGuttersEqual,
  minimapHighlightChanged,
  minimapMarkerColors,
  resolveMinimapDark,
  shouldSyncMinimap,
  type MinimapAppliedConfig,
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

describe("buildMinimapSnapshot", () => {
  it("maps hunks to marker inputs with their decision", () => {
    expect(
      buildMinimapSnapshot({
        enabled: true,
        syntaxColors: true,
        reviewChangeSet: {
          hunks: [
            { index: 0, proposedFrom: 4, proposedTo: 7 },
            { index: 1, proposedFrom: 10, proposedTo: 10 },
          ],
        },
        reviewDecisions: new Map([[1, "rejected"]]),
        reviewable: true,
      }),
    ).toEqual({
      enabled: true,
      syntaxColors: true,
      hunks: [
        { proposedFrom: 4, proposedTo: 7, state: "undecided" },
        { proposedFrom: 10, proposedTo: 10, state: "rejected" },
      ],
    });
  });

  it("drops hunks when there is no review or it is not reviewable", () => {
    const base = {
      enabled: false,
      syntaxColors: false,
      reviewChangeSet: {
        hunks: [{ index: 0, proposedFrom: 0, proposedTo: 1 }],
      },
      reviewDecisions: new Map(),
      reviewable: true,
    } as const;
    // Disabled only hides the minimap; the hunks are still in the
    // snapshot, so toggling it back on needs no new review data.
    expect(buildMinimapSnapshot(base)).toEqual({
      enabled: false,
      syntaxColors: false,
      hunks: [{ proposedFrom: 0, proposedTo: 1, state: "undecided" }],
    });
    expect(buildMinimapSnapshot({ ...base, reviewable: false })).toEqual({
      enabled: false,
      syntaxColors: false,
      hunks: [],
    });
    expect(
      buildMinimapSnapshot({ ...base, reviewChangeSet: null }),
    ).toEqual({ enabled: false, syntaxColors: false, hunks: [] });
  });

  it("defaults syntaxColors to on when the caller omits it", () => {
    expect(
      buildMinimapSnapshot({
        enabled: true,
        reviewChangeSet: null,
        reviewDecisions: new Map(),
        reviewable: true,
      }),
    ).toEqual({ enabled: true, syntaxColors: true, hunks: [] });
  });
});

describe("resolveMinimapDark", () => {
  it("is false without a DOM (node test env)", () => {
    expect(resolveMinimapDark()).toBe(false);
  });
});

// Fase 23: the minimap is built before the language arrives (the
// editor mounts with an empty language compartment; the language
// resolves async), and the package's TextState only re-highlights
// on doc/config/theme/fold changes — never on a language or
// highlighter change. Terax must therefore notice when the
// highlight inputs change and force a minimap reconfigure, or the
// minimap stays plain white (default foreground) forever on clean
// files. These tests prove the detector on real EditorStates: no
// DOM is needed, only facets.
describe("minimapHighlightChanged", () => {
  const doc = "const answer = 42;\n";
  const js = javascript();
  const py = python();

  function stateWith(theme: unknown, lang?: unknown): EditorState {
    return EditorState.create({
      doc,
      extensions: [
        theme as never,
        ...(lang ? [lang as never] : []),
      ],
    });
  }

  it("is false for the same state", () => {
    const state = stateWith(githubDark, js);
    expect(minimapHighlightChanged(state, state)).toBe(false);
  });

  it("is false when nothing changed (separately built, same inputs)", () => {
    expect(
      minimapHighlightChanged(
        stateWith(githubDark, js),
        stateWith(githubDark, js),
      ),
    ).toBe(false);
  });

  it("is true when the language arrives (the Fase 23 race)", () => {
    expect(
      minimapHighlightChanged(stateWith(githubDark), stateWith(githubDark, js)),
    ).toBe(true);
  });

  it("is true when the language switches", () => {
    expect(
      minimapHighlightChanged(stateWith(githubDark, js), stateWith(githubDark, py)),
    ).toBe(true);
  });

  it("is true when the theme changes (same language)", () => {
    expect(
      minimapHighlightChanged(stateWith(githubDark, js), stateWith(atomone, js)),
    ).toBe(true);
  });
});

// Fase 23: the sync guard must let a forced reconfigure through
// (that is what wakes the package's TextState after the language
// arrives) and must notice the new syntaxColors flag, so toggling
// the color setting re-renders the minimap.
describe("shouldSyncMinimap", () => {
  const config = (over: Partial<MinimapAppliedConfig> = {}): MinimapAppliedConfig => ({
    enabled: true,
    gutters: [],
    syntaxColors: true,
    ...over,
  });

  it("syncs the first time (no previous config)", () => {
    expect(shouldSyncMinimap(undefined, config(), false)).toBe(true);
  });

  it("skips an identical config", () => {
    expect(shouldSyncMinimap(config(), config(), false)).toBe(false);
  });

  it("forces through an identical config when asked", () => {
    expect(shouldSyncMinimap(config(), config(), true)).toBe(true);
  });

  it("syncs when the gutters change", () => {
    expect(
      shouldSyncMinimap(config(), config({ gutters: [{ 3: "#c0392f" }] }), false),
    ).toBe(true);
  });

  it("syncs when syntaxColors flips", () => {
    expect(
      shouldSyncMinimap(config(), config({ syntaxColors: false }), false),
    ).toBe(true);
  });

  it("syncs when enabled flips", () => {
    expect(shouldSyncMinimap(config(), config({ enabled: false }), false)).toBe(
      true,
    );
  });
});
