import type { Extension } from "@codemirror/state";

/**
 * Index of the `autocompletion({override: [...]})` element inside the
 * array `languageServerWithTransport()` returns, pinned to
 * codemirror-languageserver 1.22.1:
 *
 * [0] languageServerPlugin.of(...), [1] hoverTooltip(),
 * [2] autocompletion(), [3] documentHighlight(),
 * [4] renameExtension(), [5] keymap.of(...), [6] mouseHandler().
 *
 * The layout is the library's internal composition, not its public
 * API — if the library is upgraded, the layout-pin test in
 * lspAutocompletion.test.ts (dropping each index in turn, only index
 * 2 may remove the conflict) fails loudly instead of silently
 * stripping the wrong element.
 */
export const LSP_AUTOCOMPLETION_INDEX = 2;

/**
 * Removes the library's per-preset `autocompletion({override: [...]})`
 * from one preset's extension set, keeping everything else untouched.
 *
 * Why: every preset's `languageServerWithTransport()` call bundles its
 * own `autocompletion({override})`, and CodeMirror's `completionConfig`
 * facet throws ("Config merge conflict for field override") when two
 * different `override` arrays coexist in one editor (Fase 16: enabling
 * the ESLint preset next to TypeScript black-screened Terax). Only the
 * first preset per document keeps its autocompletion — see
 * `acquireDocExtensions` in sessionManager.ts — so exactly one
 * `override` ever reaches the facet. A non-array extension passes
 * through unchanged.
 */
export function stripLspAutocompletion(extension: Extension): Extension {
  if (!Array.isArray(extension)) return extension;
  return extension.filter((_, i) => i !== LSP_AUTOCOMPLETION_INDEX);
}
