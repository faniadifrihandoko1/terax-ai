/**
 * VS Code-style content search view helpers (Fase 31, DEL-131).
 *
 * Pure functions under the command palette's content search (`#` mode):
 * grouping hits per file, the "N results in M files" summary, and the
 * match ranges used to highlight the query inside each result line.
 * Rendering lives in CommandPalette.tsx; the search itself lives in
 * useContentSearch.ts (Tauri `fs_grep_interactive`).
 */

export type ContentHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

/** The three toggles next to the search input, VS Code style. */
export type ContentSearchOptions = {
  /** Aa — match case. Off = smart-case (see findMatchRanges). */
  matchCase: boolean;
  /** ab — match whole word only. */
  wholeWord: boolean;
  /** * — treat the query as a regular expression. */
  useRegex: boolean;
};

export const DEFAULT_CONTENT_SEARCH_OPTIONS: ContentSearchOptions = {
  matchCase: false,
  wholeWord: false,
  useRegex: false,
};

export type ContentFileGroup = {
  path: string;
  rel: string;
  name: string;
  hits: ContentHit[];
};

export function contentFileBasename(rel: string): string {
  const parts = rel.split(/[\\/]/);
  return parts[parts.length - 1] || rel;
}

/**
 * Group flat hits per file, in first-appearance order, hits in result
 * order. The Rust walk is parallel, so hits for one file are not
 * guaranteed adjacent — grouping must not assume that.
 */
export function groupContentHits(hits: ContentHit[]): ContentFileGroup[] {
  const groups: ContentFileGroup[] = [];
  const byPath = new Map<string, ContentFileGroup>();
  for (const hit of hits) {
    let group = byPath.get(hit.path);
    if (!group) {
      group = {
        path: hit.path,
        rel: hit.rel,
        name: contentFileBasename(hit.rel),
        hits: [],
      };
      byPath.set(hit.path, group);
      groups.push(group);
    }
    group.hits.push(hit);
  }
  return groups;
}

/** "1 result in 1 file" / "5 results in 2 files" (+ partial note). */
export function summarizeContentSearch(
  totalHits: number,
  fileCount: number,
  truncated: boolean,
): string {
  const resultWord = totalHits === 1 ? "result" : "results";
  const fileWord = fileCount === 1 ? "file" : "files";
  const base = `${totalHits} ${resultWord} in ${fileCount} ${fileWord}`;
  return truncated ? `${base} (partial results)` : base;
}

export type MatchRange = {
  start: number;
  end: number;
};

/** Cap so a pathological regex cannot produce unbounded spans per line. */
const MAX_RANGES_PER_LINE = 100;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ranges of the query inside one result line, in UTF-16 code units
 * (JS string indices — ready for substring rendering).
 *
 * Mirrors the Rust matcher in `fs_grep_interactive` closely enough for
 * highlighting:
 * - Literal mode escapes the query; regex mode uses it as-is.
 * - Case: matchCase on is always sensitive; off is smart-case — an
 *   uppercase letter anywhere in the query makes it sensitive,
 *   otherwise insensitive (same rule as grep-regex `case_smart` for
 *   ordinary word queries; literal-less patterns such as `\w+` differ
 *   — Rust stays sensitive there, this stays insensitive).
 * - Whole word wraps the pattern in `\b...\b` (VS Code parity). The
 *   Rust side uses grep-regex `.word()`, which only requires a
 *   non-word character on each side — for patterns starting/ending in
 *   punctuation (e.g. `-2`) Rust matches but this may not highlight.
 * - Invalid regex returns no ranges (the search itself then fails in
 *   Rust and the palette shows "Search failed" + Retry).
 * - Zero-length matches are skipped; `RegExp.exec` advances past them
 *   on its own with the `g` flag, and the iteration guard below stops
 *   any pathological loop regardless.
 */
export function findMatchRanges(
  text: string,
  query: string,
  options: ContentSearchOptions,
): MatchRange[] {
  if (!query) return [];
  const sensitive = options.matchCase || /[A-Z]/.test(query);
  const flags = sensitive ? "g" : "gi";
  const source = options.useRegex ? query : escapeRegExp(query);
  const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source;
  let re: RegExp;
  try {
    re = new RegExp(wrapped, flags);
  } catch {
    return [];
  }
  const ranges: MatchRange[] = [];
  let guard = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[0].length > 0) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
      if (ranges.length >= MAX_RANGES_PER_LINE) break;
    }
    guard += 1;
    if (guard > text.length + 2) break;
  }
  return ranges;
}
