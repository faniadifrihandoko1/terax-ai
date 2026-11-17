import { forEachDiagnostic } from "@codemirror/lint";
import { highlightingFor, language } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { showMinimap } from "@replit/codemirror-minimap";
import type { HunkDecision } from "@/modules/ai/lib/reviewApply";
import { minimapCompartment } from "./extensions";

// Fase 22: minimap navigasi ala Antigravity di editor biasa.
//
// The overview itself (shrunken code, viewport overlay, click/drag to
// scroll) is @replit/codemirror-minimap: it renders a second scaled
// editor inside the right gutter, follows the editor font and theme,
// and handles pointer scrolling internally. This module only owns
// what Terax adds on top of it:
//   - marker gutters (diagnostics + review hunks) in the theme colors
//     the rest of the app already uses, and
//   - keeping the facet config in sync with the editor state.
//
// The package was chosen over a hand-rolled canvas overview because
// its peer ranges already match Terax's CodeMirror versions
// (@codemirror/view ^6.21.3 vs 6.43.13, state, language, lint,
// @lezer/common ^1.1.0 vs 1.5.2, @lezer/highlight ^1.1.6 vs 1.2.3),
// it is small (~104 KB unpacked, one dep: crelt), and it renders
// real miniature code text instead of plain bars.
//
// Diagnostics also get the package's built-in wash (full-width
// translucent #d11 / orange, the @codemirror/lint standard colors)
// for free — it reads the same lint diagnostics Terax feeds the
// editor. The gutters below add the exact theme colors on top of
// that, at the left edge of the minimap, VS Code overview-ruler
// style.
//
// Bundle: this module imports @codemirror/*, so it must stay behind
// the lazy editor path (EditorPane) and never be imported from eager
// code (App, settings) — see eager-budget.test.ts.
//
// Fase 23: the minimap rendered plain white. Two causes, both fixed
// here and in the editor theme (see cmThemes.ts): (1) a race — the
// editor mounts with an empty language compartment and the language
// resolves async, so the package's TextState was built with no
// parser and its shouldUpdate never fires on a language/highlighter
// change; minimapHighlightChanged + the forced sync below fix that.
// (2) The default theme's own palette was pastel with shared hues
// (string = variable blue), so even a working minimap read as
// white; the enriched github palettes fix that, and the minimap
// reads them through the editor's HighlightStyle — one source of
// truth. The `syntaxColors` setting (patched into the package)
// only gates the minimap's highlight passes; the editor stays
// colored when it is off.

export type MinimapDiagnosticInput = {
  /** 1-based line number. */
  line: number;
  severity: "error" | "warning" | "info";
};

export type MinimapHunkInput = {
  /** 0-based [from, to) range in the proposed lines (LineHunk). */
  proposedFrom: number;
  proposedTo: number;
  state: HunkDecision;
};

/** One gutter column: 1-based line number -> CSS color. */
export type MinimapGutter = Record<number, string>;

export type MinimapMarkerColors = {
  error: string;
  warning: string;
  hunkUndecided: string;
  hunkAccepted: string;
  hunkRejected: string;
};

/** React-side inputs for one sync. Diagnostics come from the view. */
export type MinimapSnapshot = {
  enabled: boolean;
  /** False draws the miniature code plain (Fase 23 setting). */
  syntaxColors: boolean;
  hunks: readonly MinimapHunkInput[];
};

/**
 * Build the snapshot from the editor's review state. Used both for
 * the ref the update listener reads at event time and for the effect
 * that syncs on React-side changes, so the two paths can never drift
 * apart.
 */
export function buildMinimapSnapshot(input: {
  enabled: boolean;
  syntaxColors?: boolean;
  reviewChangeSet: {
    hunks: readonly {
      index: number;
      proposedFrom: number;
      proposedTo: number;
    }[];
  } | null;
  reviewDecisions: ReadonlyMap<number, HunkDecision>;
  reviewable: boolean;
}): MinimapSnapshot {
  return {
    enabled: input.enabled,
    syntaxColors: input.syntaxColors ?? true,
    hunks:
      input.reviewChangeSet && input.reviewable
        ? input.reviewChangeSet.hunks.map((hunk) => ({
            proposedFrom: hunk.proposedFrom,
            proposedTo: hunk.proposedTo,
            state: input.reviewDecisions.get(hunk.index) ?? "undecided",
          }))
        : [],
  };
}

// Theme hexes, taken from the places that already use them:
// --destructive in globals.css (#c0392f light, #e35d5d dark),
// text-amber-700 / dark:text-amber-400 in diagnosticsSeverityClass,
// and the hunk-bar hexes in INLINE_REVIEW_THEME.
const DESTRUCTIVE_LIGHT = "#c0392f";
const DESTRUCTIVE_DARK = "#e35d5d";
const WARNING_LIGHT = "#b45309";
const WARNING_DARK = "#fbbf24";
const HUNK_UNDECIDED = "#22c55e";
const HUNK_ACCEPTED = "#16a34a";
const HUNK_REJECTED = "#e11d48";

export function minimapMarkerColors(
  dark: boolean,
  destructive?: string | null,
): MinimapMarkerColors {
  return {
    error: destructive ?? (dark ? DESTRUCTIVE_DARK : DESTRUCTIVE_LIGHT),
    warning: dark ? WARNING_DARK : WARNING_LIGHT,
    hunkUndecided: HUNK_UNDECIDED,
    hunkAccepted: HUNK_ACCEPTED,
    hunkRejected: HUNK_REJECTED,
  };
}

const DIAGNOSTIC_RANK = { error: 3, warning: 2, info: 1 } as const;

/**
 * One gutter column for diagnostics: worst severity wins per line.
 * Info diagnostics are not marked.
 */
export function diagnosticMinimapGutter(
  diagnostics: readonly MinimapDiagnosticInput[],
  colors: MinimapMarkerColors,
): MinimapGutter {
  const out: MinimapGutter = {};
  const rank: Record<number, number> = {};
  for (const d of diagnostics) {
    if (d.line < 1) continue;
    const r = DIAGNOSTIC_RANK[d.severity];
    if (r < 2) continue;
    if ((rank[d.line] ?? 0) >= r) continue;
    rank[d.line] = r;
    out[d.line] = d.severity === "error" ? colors.error : colors.warning;
  }
  return out;
}

/**
 * One gutter column for review hunks, colored by decision like the
 * hunk bars. A hunk covers its proposed lines; a pure-deletion hunk
 * (empty proposed range) has no proposed line, so the line where its
 * removed box sits is marked instead. Everything clamps to the doc.
 */
export function hunkMinimapGutter(
  hunks: readonly MinimapHunkInput[],
  colors: MinimapMarkerColors,
  lineCount: number,
): MinimapGutter {
  const out: MinimapGutter = {};
  if (lineCount <= 0) return out;
  for (const hunk of hunks) {
    const color =
      hunk.state === "accepted"
        ? colors.hunkAccepted
        : hunk.state === "rejected"
          ? colors.hunkRejected
          : colors.hunkUndecided;
    const start = Math.min(
      Math.max(1, hunk.proposedFrom + 1),
      lineCount,
    );
    const end =
      hunk.proposedTo > hunk.proposedFrom
        ? Math.max(start, Math.min(hunk.proposedTo, lineCount))
        : start;
    for (let line = start; line <= end; line++) out[line] = color;
  }
  return out;
}

/**
 * The gutter columns the minimap draws, diagnostics first, hunks
 * second. Empty columns are omitted (the package filters them too).
 */
export function buildMinimapGutters(input: {
  diagnostics: readonly MinimapDiagnosticInput[];
  hunks: readonly MinimapHunkInput[];
  lineCount: number;
  dark: boolean;
  destructive?: string | null;
}): MinimapGutter[] {
  const colors = minimapMarkerColors(input.dark, input.destructive ?? null);
  const out: MinimapGutter[] = [];
  const diagnostics = diagnosticMinimapGutter(input.diagnostics, colors);
  if (Object.keys(diagnostics).length > 0) out.push(diagnostics);
  const hunks = hunkMinimapGutter(input.hunks, colors, input.lineCount);
  if (Object.keys(hunks).length > 0) out.push(hunks);
  return out;
}

/** Deep equality for the sync guard (key order does not matter). */
export function minimapGuttersEqual(
  a: readonly MinimapGutter[],
  b: readonly MinimapGutter[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i];
    const rb = b[i];
    if (!ra || !rb) return false;
    const ka = Object.keys(ra);
    const kb = Object.keys(rb);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (ra[Number(k)] !== rb[Number(k)]) return false;
    }
  }
  return true;
}

/** Dark mode from the `dark` class ThemeProvider puts on <html>. */
export function resolveMinimapDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

/**
 * The effective --destructive color from the active theme (custom
 * themes can override it). Null when there is no DOM or the variable
 * is unset, so the caller falls back to the globals.css values.
 */
export function resolveDestructiveColor(): string | null {
  if (typeof document === "undefined") return null;
  if (typeof getComputedStyle === "undefined") return null;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--destructive")
    .trim();
  return value === "" ? null : value;
}

// --- Wiring (impure; thin glue over the pure builders above) ---------

/** The container the package renders its canvas into. */
function createMinimapDom(): { dom: HTMLElement } {
  return { dom: document.createElement("div") };
}

function diagnosticsForMinimap(view: EditorView): MinimapDiagnosticInput[] {
  const out: MinimapDiagnosticInput[] = [];
  forEachDiagnostic(view.state, (diagnostic, from) => {
    out.push({
      line: view.state.doc.lineAt(from).number,
      // "hint" has no marker color; it folds into "info", which the
      // gutter builder ignores.
      severity: diagnostic.severity === "hint" ? "info" : diagnostic.severity,
    });
  });
  return out;
}

export type MinimapAppliedConfig = {
  enabled: boolean;
  gutters: MinimapGutter[];
  syntaxColors: boolean;
};

const lastApplied = new WeakMap<EditorView, MinimapAppliedConfig>();

/**
 * Pure sync decision, extracted so tests can prove the guard without
 * a view: the first sync always runs, a forced sync always runs
 * (that is what wakes the package's TextState after the language
 * arrives), otherwise only a real change syncs.
 */
export function shouldSyncMinimap(
  prev: MinimapAppliedConfig | undefined,
  next: MinimapAppliedConfig,
  force: boolean,
): boolean {
  if (force) return true;
  if (!prev) return true;
  return (
    prev.enabled !== next.enabled ||
    prev.syntaxColors !== next.syntaxColors ||
    !minimapGuttersEqual(prev.gutters, next.gutters)
  );
}

/**
 * Fase 23: did the inputs the minimap highlights from change between
 * two states? The package's TextState only re-highlights on doc,
 * Config, theme-classList or fold changes — never when the language
 * or the highlighter changes — so Terax must notice that itself and
 * force a reconfigure, or the minimap stays plain white (default
 * foreground) on clean files: the editor mounts with an empty
 * language compartment and the language resolves async afterwards,
 * so the TextState is built with no parser and never wakes up.
 *
 * Two signals, both cheap and DOM-free. The `language` facet
 * identity catches the language arriving or switching (one Language
 * object per language, so identity is exact). The probe catches a
 * theme change: highlightingFor returns the concatenated generated
 * class names for three common tags, and HighlightStyle.define
 * generates globally unique class names per HighlightStyle instance,
 * so the same keyword class means the same highlighter (same
 * colors) and a different one means the colors moved. One combined
 * call (an ARRAY of tags — a bare Tag throws "tags is not
 * iterable") covers keyword, string and comment at once.
 */
export function minimapHighlightChanged(
  prev: EditorState,
  next: EditorState,
): boolean {
  if (prev.facet(language) !== next.facet(language)) return true;
  const probe = [tags.keyword, tags.string, tags.comment];
  return highlightingFor(prev, probe) !== highlightingFor(next, probe);
}

function buildAppliedConfig(
  view: EditorView,
  snapshot: MinimapSnapshot,
): MinimapAppliedConfig {
  return {
    enabled: snapshot.enabled,
    syntaxColors: snapshot.syntaxColors,
    gutters: snapshot.enabled
      ? buildMinimapGutters({
          diagnostics: diagnosticsForMinimap(view),
          hunks: snapshot.hunks,
          lineCount: view.state.doc.lines,
          dark: resolveMinimapDark(),
          destructive: resolveDestructiveColor(),
        })
      : [],
  };
}

/**
 * Reconfigure the minimap compartment when the config actually
 * changed (setting, diagnostics, hunks, theme) — or when forced,
 * which is how a language/theme arrival wakes the package's
 * TextState (see minimapHighlightChanged). The equality guard also
 * breaks the loop the reconfigure transaction itself would
 * otherwise start through the update listener below. The
 * syntaxColors flag is forwarded to the package (patched in
 * patches/@replit__codemirror-minimap@0.5.2.patch): false skips its
 * highlight passes, so the miniature code draws plain.
 */
export function syncMinimap(
  view: EditorView,
  snapshot: MinimapSnapshot,
  opts?: { force?: boolean },
): void {
  const next = buildAppliedConfig(view, snapshot);
  const prev = lastApplied.get(view);
  if (!shouldSyncMinimap(prev, next, opts?.force ?? false)) {
    return;
  }
  lastApplied.set(view, next);
  view.dispatch({
    effects: minimapCompartment.reconfigure(
      next.enabled
        ? [
            showMinimap.of({
              create: createMinimapDom,
              gutters: next.gutters,
              syntaxColors: next.syntaxColors,
            }),
          ]
        : [],
    ),
  });
}

/**
 * Update listener that keeps the markers fresh when the editor state
 * changes: diagnostics arrive via setDiagnosticsEffect, edits move
 * line numbers. It also watches for highlight-input changes (the
 * language arriving async after mount, a theme switch) and forces a
 * minimap reconfigure for those — the package itself never notices
 * them. React-side changes (setting toggle, review hunks) are synced
 * by the EditorPane effect calling syncMinimap directly.
 */
export function minimapSyncExtension(
  getSnapshot: () => MinimapSnapshot,
): Extension {
  return EditorView.updateListener.of((update) => {
    const highlightChanged = minimapHighlightChanged(
      update.startState,
      update.state,
    );
    if (
      !highlightChanged &&
      !update.docChanged &&
      !update.transactions.some((tr) => tr.effects.length > 0)
    ) {
      return;
    }
    syncMinimap(update.view, getSnapshot(), { force: highlightChanged });
  });
}
