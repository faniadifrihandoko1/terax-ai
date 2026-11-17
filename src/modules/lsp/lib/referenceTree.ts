import { fileUriToPath } from "./uri";

// Fase 24 — pure model for the references tree panel (VS Code style).
// All grouping, sorting, dedup and toggle logic lives here so it can be
// unit-tested without a DOM; the DOM panel in locationsPanel.ts only
// renders this model. The old flat panel deduped locations by their
// `file:line` label, silently dropping a second reference on the same
// line of the same file — grouping dedups by full position instead.

export type ReferenceLocationInput = {
  uri: string;
  /** 0-based */
  line: number;
  /** 0-based UTF-16 offset, as returned by the language server. */
  character: number;
  /** Trimmed source-line text, when known; null/undefined falls back. */
  preview?: string | null;
};

export type ReferenceFileGroup = {
  uri: string;
  /** Path relative to the project root, or the full path when outside it. */
  relPath: string;
  fileName: string;
  items: ReferenceLocationInput[];
  /** VS Code's references view starts with every group expanded. */
  collapsed: boolean;
};

export type ReferenceTree = {
  title: string;
  /** Total reference count across all groups. */
  total: number;
  groups: ReferenceFileGroup[];
};

/** Relative path for display; falls back to the full path (or the raw
 * URI when it is not a file URI) when the location is outside the root. */
export function relativeLspPath(uri: string, rootPath: string): string {
  const path = fileUriToPath(uri);
  if (!path) return uri;
  const root = rootPath.replace(/\\/g, "/");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function fileNameOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

function positionKey(loc: ReferenceLocationInput): string {
  return `${loc.uri}\n${loc.line}:${loc.character}`;
}

/**
 * Group locations by file. Groups are sorted by relative path, items
 * inside a group by line then character. Locations sharing a full
 * position are merged into one item.
 */
export function groupReferenceLocations(
  locs: readonly ReferenceLocationInput[],
  rootPath: string,
): ReferenceFileGroup[] {
  const byUri = new Map<string, Map<string, ReferenceLocationInput>>();
  for (const loc of locs) {
    let items = byUri.get(loc.uri);
    if (!items) {
      items = new Map();
      byUri.set(loc.uri, items);
    }
    const key = positionKey(loc);
    if (!items.has(key)) items.set(key, loc);
  }
  const groups: ReferenceFileGroup[] = [...byUri.entries()].map(
    ([uri, items]) => {
      const relPath = relativeLspPath(uri, rootPath);
      const sorted = [...items.values()].sort(
        (a, b) => a.line - b.line || a.character - b.character,
      );
      return {
        uri,
        relPath,
        fileName: fileNameOf(relPath),
        items: sorted,
        collapsed: false,
      };
    },
  );
  groups.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return groups;
}

export function buildReferenceTree(
  title: string,
  locs: readonly ReferenceLocationInput[],
  rootPath: string,
): ReferenceTree {
  const groups = groupReferenceLocations(locs, rootPath);
  return {
    title,
    total: groups.reduce((n, g) => n + g.items.length, 0),
    groups,
  };
}

/** Immutable toggle: flips one group's collapsed flag, returns the same
 * tree object when the URI is not in it. */
export function toggleReferenceGroup(
  tree: ReferenceTree,
  uri: string,
): ReferenceTree {
  if (!tree.groups.some((g) => g.uri === uri)) return tree;
  return {
    ...tree,
    groups: tree.groups.map((g) =>
      g.uri === uri ? { ...g, collapsed: !g.collapsed } : g,
    ),
  };
}

export type ReferenceTreeRow =
  | {
      kind: "group";
      groupUri: string;
      label: string;
      count: number;
      collapsed: boolean;
    }
  | { kind: "item"; groupUri: string; loc: ReferenceLocationInput };

/** Flat row list the panel renders and navigates: group headers first,
 * then the items of expanded groups only, in group order. */
export function visibleReferenceRows(tree: ReferenceTree): ReferenceTreeRow[] {
  const rows: ReferenceTreeRow[] = [];
  for (const group of tree.groups) {
    rows.push({
      kind: "group",
      groupUri: group.uri,
      label: group.relPath,
      count: group.items.length,
      collapsed: group.collapsed,
    });
    if (!group.collapsed) {
      for (const loc of group.items) {
        rows.push({ kind: "item", groupUri: group.uri, loc });
      }
    }
  }
  return rows;
}

const MAX_PREVIEW_LENGTH = 160;

/**
 * Extract one source line as a row preview: trimmed, and truncated with
 * an ellipsis when very long. Returns null for missing/blank lines so
 * callers can fall back to `file:line`.
 */
export function extractLinePreview(
  text: string | null | undefined,
  line: number,
): string | null {
  if (text == null) return null;
  const lines = text.split("\n");
  if (line < 0 || line >= lines.length) return null;
  const trimmed = lines[line].trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_PREVIEW_LENGTH) {
    return `${trimmed.slice(0, MAX_PREVIEW_LENGTH)}…`;
  }
  return trimmed;
}

/** Row text: the line preview when known, otherwise `file:line`
 * (1-based line), like the old flat panel. */
export function formatReferenceItemLabel(
  loc: ReferenceLocationInput,
  rootPath: string,
): string {
  if (loc.preview) return loc.preview;
  return `${relativeLspPath(loc.uri, rootPath)}:${loc.line + 1}`;
}
