/**
 * Sidebar content search row model (Fase 32, DEL-132).
 *
 * The sidebar search renders grouped content hits (see Fase 31's
 * `contentSearchView.ts` for grouping/summary/highlight). Keyboard
 * navigation (ArrowUp/ArrowDown/Enter) walks a FLAT list of rows:
 * one header row per file group plus one row per visible hit.
 * Collapsed groups contribute only their header row; Enter on a
 * header toggles the collapse, Enter on a hit opens the file at
 * that line. This module is the pure, testable core of that model —
 * rendering lives in ExplorerSearch.tsx.
 */

import type {
  ContentFileGroup,
  ContentHit,
} from "@/modules/command-palette/lib/contentSearchView";

export type SidebarSearchRow =
  | { kind: "group"; path: string; group: ContentFileGroup }
  | { kind: "hit"; path: string; line: number; hit: ContentHit };

export function buildSidebarSearchRows(
  groups: ContentFileGroup[],
  collapsed: ReadonlySet<string>,
): SidebarSearchRow[] {
  const rows: SidebarSearchRow[] = [];
  for (const group of groups) {
    rows.push({ kind: "group", path: group.path, group });
    if (collapsed.has(group.path)) continue;
    for (const hit of group.hits) {
      rows.push({ kind: "hit", path: hit.path, line: hit.line, hit });
    }
  }
  return rows;
}

/** Toggle one group in the collapsed set; returns a new set. */
export function toggleCollapsed(
  collapsed: ReadonlySet<string>,
  path: string,
): ReadonlySet<string> {
  const next = new Set(collapsed);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
