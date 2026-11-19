/**
 * Sidebar content search (Fase 32, DEL-132).
 *
 * Antigravity-style search panel in the sidebar: content search over
 * the workspace (Fase 31 engine — `fs_grep_interactive` +
 * `contentSearchView.ts`), with Aa/ab/* toggles, an "N results in M
 * files - Open in editor" summary, results grouped per file
 * (collapsible, count badge), and the match highlighted orange in
 * each preview line.
 *
 * This REPLACES the old file-name search (`fs_search`, fuzzy over the
 * file index). Name search is not lost: it lives in the command
 * palette's file mode. The sidebar panel is content search only,
 * like Antigravity's panel.
 *
 * Responsive cards: every row is a flex row with `min-w-0` on the
 * truncating spans, so in the narrow sidebar the file name truncates
 * with an ellipsis, the parent dir truncates muted, and the count
 * badge stays pinned at the right — no text is clipped mid-glyph at
 * the panel edge (the old rows had two `truncate` spans without
 * `min-w-0`, so the path ran off the edge).
 */

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Cancel01Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  HighlightedLine,
  parentDir,
  SearchToggle,
} from "@/modules/command-palette/components/contentSearchBits";
import { useContentSearch } from "@/modules/command-palette/hooks/useContentSearch";
import {
  DEFAULT_CONTENT_SEARCH_OPTIONS,
  groupContentHits,
  summarizeContentSearch,
  type ContentSearchOptions,
} from "@/modules/command-palette/lib/contentSearchView";
import { useEffect, useMemo, useState } from "react";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
} from "react";
import { FileIcon } from "./FileIcon";
import { copyToClipboard, revealInFinder } from "./lib/contextActions";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import {
  buildSidebarSearchRows,
  toggleCollapsed,
} from "./lib/sidebarSearchRows";
import { cn } from "@/lib/utils";

type Props = {
  rootPath: string;
  onOpenFile: (path: string) => void;
  /** Open a hit at its line (App's openContentHit). Falls back to onOpenFile. */
  onOpenContentHit?: (path: string, line: number) => void;
  open: boolean;
  onRequestClose: () => void;
  onActiveChange?: (active: boolean) => void;
  onAttachToAgent?: (path: string) => void;
};

export type ExplorerSearchHandle = {
  focus: () => void;
  isFocused: () => boolean;
};

const ROW_CLASS =
  "flex w-full min-w-0 items-center gap-1 px-2 py-1 text-left text-xs transition-colors";

export const ExplorerSearch = forwardRef<ExplorerSearchHandle, Props>(function ExplorerSearch({
  rootPath,
  onOpenFile,
  onOpenContentHit,
  open,
  onRequestClose,
  onActiveChange,
  onAttachToAgent,
}: Props,
  ref,
) {
  const [query, setQuery] = useState("");
  // Fase 31 parity: options persist across open/close; only the
  // collapsed groups reset when the panel closes.
  const [options, setOptions] = useState<ContentSearchOptions>(
    DEFAULT_CONTENT_SEARCH_OPTIONS,
  );
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKeyboardNavAt = useRef(0);

  const active = query.trim().length > 0;
  const term = query.trim();

  const search = useContentSearch(rootPath, term, open, options);
  const groups = useMemo(
    () => groupContentHits(search.results),
    [search.results],
  );
  const rows = useMemo(
    () => buildSidebarSearchRows(groups, collapsedGroups),
    [groups, collapsedGroups],
  );
  const summary = useMemo(
    () =>
      summarizeContentSearch(
        search.results.length,
        groups.length,
        search.truncated,
      ),
    [search.results.length, groups.length, search.truncated],
  );

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setCollapsedGroups(new Set());
      setSelectedIndex(0);
    }
  }, [open ]);

  // Keep the selection inside the visible rows as groups collapse or
  // new results arrive.
  useEffect(() => {
    setSelectedIndex((prev) =>
      rows.length === 0 ? 0 : Math.min(prev, rows.length - 1),
    );
  }, [rows.length]);

  useEffect(() => {
    if (active && rows.length > 0) {
      const el = scrollRef.current?.querySelector(
        `[data-index="${selectedIndex}"]`,
      );
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, rows, active]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        requestAnimationFrame(() => {
          inputRef.current?.focus();
        });
      },
      isFocused: () => document.activeElement === inputRef.current,
    }),
    [],
  );

  const toggleOption = useCallback((key: keyof ContentSearchOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
    inputRef.current?.focus();
  }, []);

  const toggleGroup = useCallback((path: string) => {
    setCollapsedGroups((prev) => toggleCollapsed(prev, path));
  }, []);

  const openHit = useCallback(
    (path: string, line: number) => {
      if (onOpenContentHit) onOpenContentHit(path, line);
      else onOpenFile(path);
    },
    [onOpenContentHit, onOpenFile],
  );

  const openFirstHit = useCallback(() => {
    const first = groups[0]?.hits[0];
    if (first) openHit(first.path, first.line);
  }, [groups, openHit]);

  const activateRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      if (row.kind === "group") toggleGroup(row.path);
      else openHit(row.hit.path, row.hit.line);
    },
    [rows, toggleGroup, openHit],
  );

  const noteMouseEnter = useCallback((index: number) => {
    if (Date.now() - lastKeyboardNavAt.current > 250) {
      setSelectedIndex(index);
    }
  }, []);

  const tooShort = term.length > 0 && term.length < 2;

  return (
    <div className={cn("flex flex-col", active && "min-h-0 flex-1")}>
      {open ? (
        <div className="shrink-0 px-2 pt-1.5 animate-in fade-in-0 slide-in-from-top-3 duration-200 ease-out">
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={2}
              className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestClose();
                  return;
                }
                if (rows.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    lastKeyboardNavAt.current = Date.now();
                    setSelectedIndex((prev) => (prev + 1) % rows.length);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    lastKeyboardNavAt.current = Date.now();
                    setSelectedIndex(
                      (prev) => (prev - 1 + rows.length) % rows.length,
                    );
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    activateRow(selectedIndex);
                  }
                }
              }}
              placeholder="Search"
              className="h-7 pr-7 pl-6.5 text-xs"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-0.5 pt-1">
            <SearchToggle
              label="Aa"
              title="Match Case"
              pressed={options.matchCase}
              onToggle={() => toggleOption("matchCase")}
            />
            <SearchToggle
              label="ab"
              title="Match Whole Word"
              pressed={options.wholeWord}
              onToggle={() => toggleOption("wholeWord")}
            />
            <SearchToggle
              label="*"
              title="Use Regular Expression"
              pressed={options.useRegex}
              onToggle={() => toggleOption("useRegex")}
            />
          </div>
        </div>
      ) : null}

      {active ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="py-1" ref={scrollRef}>
            {tooShort ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                Type at least 2 characters
              </div>
            ) : search.error ? (
              <>
                <div className="px-3 py-2 text-[11px] text-destructive">
                  Search failed
                </div>
                <button
                  type="button"
                  onClick={search.retry}
                  className="mx-2 rounded px-2 py-1 text-left text-xs text-foreground/80 hover:bg-accent/50"
                >
                  Retry
                </button>
              </>
            ) : search.loading && rows.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                Searching…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                No matches
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1 px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate">{summary}</span>
                  <span>-</span>
                  <button
                    type="button"
                    onClick={openFirstHit}
                    className="shrink-0 text-blue-500 hover:underline dark:text-blue-400"
                  >
                    Open in editor
                  </button>
                </div>
                {rows.map((row, index) => {
                  const isSelected = index === selectedIndex;
                  const rowClass = cn(
                    ROW_CLASS,
                    isSelected
                      ? "bg-accent text-foreground"
                      : "hover:bg-accent/50 text-foreground/80",
                  );
                  if (row.kind === "group") {
                    const group = row.group;
                    const collapsed = collapsedGroups.has(group.path);
                    return (
                      <ContextMenu key={group.path}>
                        <ContextMenuTrigger asChild>
                          <button
                            type="button"
                            data-index={index}
                            onClick={() => toggleGroup(group.path)}
                            onMouseEnter={() => noteMouseEnter(index)}
                            className={rowClass}
                            title={group.path}
                            aria-expanded={!collapsed}
                          >
                            <HugeiconsIcon
                              icon={
                                collapsed ? ChevronRightIcon : ChevronDownIcon
                              }
                              size={13}
                              strokeWidth={2}
                              className="shrink-0 text-muted-foreground"
                            />
                            <FileIcon
                              name={group.name}
                              className="size-3.5 shrink-0"
                            />
                            <span className="min-w-0 shrink truncate font-medium">
                              {group.name}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                              {parentDir(group.rel)}
                            </span>
                            <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {group.hits.length}
                            </span>
                          </button>
                        </ContextMenuTrigger>
                        <ContextMenuContent className={COMPACT_CONTENT}>
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onOpenFile(group.path)}
                          >
                            Open
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => void revealInFinder(group.path)}
                          >
                            Reveal in Finder
                          </ContextMenuItem>
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => void copyToClipboard(group.path)}
                          >
                            Copy Path
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            className={COMPACT_ITEM}
                            onSelect={() => onAttachToAgent?.(group.path)}
                          >
                            Attach to Agent
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  }
                  const hit = row.hit;
                  const display = hit.text.trim();
                  return (
                    <button
                      key={`${hit.path}:${hit.line}`}
                      type="button"
                      data-index={index}
                      onClick={() => openHit(hit.path, hit.line)}
                      onMouseEnter={() => noteMouseEnter(index)}
                      className={rowClass}
                      title={`${hit.rel}:${hit.line}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                        <HighlightedLine
                          text={display}
                          query={term}
                          options={options}
                        />
                      </span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        :{hit.line}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
});
