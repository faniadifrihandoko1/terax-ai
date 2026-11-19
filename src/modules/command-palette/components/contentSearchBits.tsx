/**
 * Shared VS Code-style content search bits (Fase 31 palette, Fase 32
 * sidebar). One source of truth for the Aa/ab/* toggles, the orange
 * match highlight inside a result line, and the parent-dir display —
 * the command palette and the sidebar search must look identical.
 */

import {
  findMatchRanges,
  type ContentSearchOptions,
} from "../lib/contentSearchView";
import { useMemo } from "react";

/** One VS Code-style search toggle (Aa / ab / *). */
export function SearchToggle({
  label,
  title,
  pressed,
  onToggle,
}: {
  label: string;
  title: string;
  pressed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      onClick={onToggle}
      className={
        pressed
          ? "rounded px-1.5 py-0.5 font-mono text-[11px] font-medium bg-accent text-foreground"
          : "rounded px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      }
    >
      {label}
    </button>
  );
}

/** A result line with the query matches highlighted orange, VS Code style. */
export function HighlightedLine({
  text,
  query,
  options,
}: {
  text: string;
  query: string;
  options: ContentSearchOptions;
}) {
  const ranges = useMemo(
    () => findMatchRanges(text, query, options),
    [text, query, options],
  );
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let pos = 0;
  ranges.forEach((range) => {
    if (range.start > pos) {
      parts.push(
        <span key={`plain-${range.start}`}>
          {text.slice(pos, range.start)}
        </span>,
      );
    }
    parts.push(
      <span
        key={`match-${range.start}-${range.end}`}
        className="rounded-[1px] bg-amber-500/45"
      >
        {text.slice(range.start, range.end)}
      </span>,
    );
    pos = range.end;
  });
  if (pos < text.length) {
    parts.push(<span key="plain-tail">{text.slice(pos)}</span>);
  }
  return <>{parts}</>;
}

/** Parent directory of a workspace-relative path ("" at the root). */
export function parentDir(rel: string): string {
  const idx = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
  return idx === -1 ? "" : rel.slice(0, idx);
}
