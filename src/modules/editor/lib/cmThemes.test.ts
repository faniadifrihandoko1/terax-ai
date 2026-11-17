import { describe, expect, it } from "vitest";
import { githubDarkPalette, githubLightPalette } from "./cmThemes";

// Fase 23: the default editor theme (github-dark / github-light, raw
// @uiw) made code read as plain white. Its palette is pastel and
// several token groups share one color: dark string #a5d6ff vs
// variable/number/operator #79c0ff (one pale blue), keyword =
// typeName #ff7b72, func = property = className #d2a8ff. The
// enriched palettes below keep the GitHub hue family but give every
// common token group its own hue, so code reads as colorful at a
// glance. These tests lock that distinctness in data form — the repo
// has no DOM env, so the rendered colors themselves cannot be
// asserted here; the palette values are the single source of truth
// for both the editor and the minimap probe.
const KEY_GROUPS = [
  "keyword",
  "string",
  "number",
  "constant",
  "func",
  "variable",
  "property",
  "type",
] as const;

function assertDistinct(
  palette: Record<string, string | undefined>,
  label: string,
) {
  const colors = KEY_GROUPS.map((g) => palette[g]);
  expect(new Set(colors).size, `${label}: key groups must differ`).toBe(
    KEY_GROUPS.length,
  );
  for (const g of KEY_GROUPS) {
    expect(palette[g], `${label}: ${g} must be set`).toBeTruthy();
    expect(palette[g], `${label}: ${g} must differ from the foreground`).not.toBe(
      palette.fg,
    );
    expect(
      palette[g],
      `${label}: ${g} must differ from the operator gray`,
    ).not.toBe(palette.operator);
  }
}

describe("githubDarkPalette (Fase 23, enriched)", () => {
  it("gives every common token group its own hue", () => {
    assertDistinct(githubDarkPalette, "github-dark");
  });

  it("breaks the @uiw collisions that made code read white", () => {
    // @uiw dark: string #a5d6ff vs variable/number/operator #79c0ff.
    expect(githubDarkPalette.string).not.toBe("#a5d6ff");
    expect(githubDarkPalette.string).not.toBe(githubDarkPalette.variable);
    expect(githubDarkPalette.variable).not.toBe(githubDarkPalette.number);
    // @uiw dark: keyword = typeName #ff7b72.
    expect(githubDarkPalette.type).not.toBe("#ff7b72");
    expect(githubDarkPalette.type).not.toBe(githubDarkPalette.keyword);
    // @uiw dark: func = property = className #d2a8ff.
    expect(githubDarkPalette.property).not.toBe("#d2a8ff");
    expect(githubDarkPalette.property).not.toBe(githubDarkPalette.func);
  });

  it("keeps the @uiw chrome (same theme, only token colors change)", () => {
    expect(githubDarkPalette.bg).toBe("#0d1117");
    expect(githubDarkPalette.fg).toBe("#c9d1d9");
    expect(githubDarkPalette.caret).toBe("#c9d1d9");
    expect(githubDarkPalette.selection).toBe("#003d73");
    expect(githubDarkPalette.lineHighlight).toBe("#36334280");
  });
});

describe("githubLightPalette (Fase 23, enriched)", () => {
  it("gives every common token group its own hue", () => {
    assertDistinct(githubLightPalette, "github-light");
  });

  it("breaks the @uiw collisions", () => {
    // @uiw light: string #032f62 (near-black) and
    // variable/number/operator #005cc5 (one blue), keyword = type #d73a49.
    expect(githubLightPalette.string).not.toBe("#032f62");
    expect(githubLightPalette.variable).not.toBe(githubLightPalette.number);
    expect(githubLightPalette.type).not.toBe("#d73a49");
    expect(githubLightPalette.type).not.toBe(githubLightPalette.keyword);
    expect(githubLightPalette.property).not.toBe(githubLightPalette.func);
  });

  it("keeps the @uiw chrome (same theme, only token colors change)", () => {
    expect(githubLightPalette.bg).toBe("#fff");
    expect(githubLightPalette.fg).toBe("#24292e");
    expect(githubLightPalette.selection).toBe("#BBDFFF");
    expect(githubLightPalette.gutterFg).toBe("#6e7781");
  });
});
