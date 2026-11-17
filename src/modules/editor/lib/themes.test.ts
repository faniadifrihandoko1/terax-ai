import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { highlightingFor } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { githubDark, githubLight } from "./cmThemes";
import { EDITOR_THEME_EXT } from "./themes";

// Fase 23: the "github-dark" / "github-light" ids must resolve to the
// locally enriched builds (same ids, same labels, richer token
// colors) — not to the raw @uiw themes, whose pastel palette made
// code read as plain white.
describe("EDITOR_THEME_EXT github themes (Fase 23)", () => {
  it("maps github-dark to the enriched local build", () => {
    expect(EDITOR_THEME_EXT["github-dark"]).toBe(githubDark);
  });

  it("maps github-light to the enriched local build", () => {
    expect(EDITOR_THEME_EXT["github-light"]).toBe(githubLight);
  });

  it("resolves every registered theme id to an extension", () => {
    for (const [id, ext] of Object.entries(EDITOR_THEME_EXT)) {
      expect(ext, `theme ${id} must resolve`).toBeTruthy();
    }
  });

  it("mounts a HighlightStyle the minimap probe can read", () => {
    const state = EditorState.create({
      doc: "const x = 1;\n",
      extensions: [githubDark, javascript()],
    });
    // The minimap colors its canvas from these very classes
    // (getFontInfo probes tok-* spans in the editor DOM), so a
    // non-empty class here is the unit-level proof that the enriched
    // colors reach the minimap's single source of truth.
    // highlightingFor takes an ARRAY of tags (its HighlightStyle
    // iterates them); a bare Tag throws "tags is not iterable".
    expect(highlightingFor(state, [tags.keyword])).toBeTruthy();
    expect(highlightingFor(state, [tags.string])).toBeTruthy();
    expect(highlightingFor(state, [tags.comment])).toBeTruthy();
  });
});
