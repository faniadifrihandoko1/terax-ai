import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import {
  type ContentHit,
  type ContentSearchOptions,
} from "../lib/contentSearchView";
import { type AsyncQueryState, useAsyncQuery } from "./useAsyncQuery";

export type { ContentHit };

export const CONTENT_SEARCH_MIN_QUERY = 2;
const LIMIT = 80;
const DEBOUNCE_MS = 140;

type GrepResponse = {
  hits: ContentHit[];
  truncated: boolean;
  files_scanned: number;
};

export type ContentSearchState = AsyncQueryState<ContentHit> & {
  /** The backend stopped at LIMIT hits — the summary says so. */
  truncated: boolean;
};

export function useContentSearch(
  root: string | null,
  term: string,
  enabled: boolean,
  options: ContentSearchOptions,
): ContentSearchState {
  // Keyed by the term that produced it: a superseded run resolving late
  // must not stamp its truncated flag onto newer results.
  const [truncatedFor, setTruncatedFor] = useState<{
    term: string;
    truncated: boolean;
  }>({ term: "", truncated: false });
  const run = useCallback(
    async (q: string): Promise<ContentHit[]> => {
      if (!root) return [];
      const res = await invoke<GrepResponse>("fs_grep_interactive", {
        pattern: q,
        root,
        maxResults: LIMIT,
        workspace: currentWorkspaceEnv(),
        caseSensitive: options.matchCase,
        wholeWord: options.wholeWord,
        regex: options.useRegex,
      });
      setTruncatedFor({ term: q, truncated: res.truncated });
      return res.hits;
    },
    [root, options],
  );

  const query = useAsyncQuery({
    enabled: enabled && !!root,
    term,
    minLength: CONTENT_SEARCH_MIN_QUERY,
    debounceMs: DEBOUNCE_MS,
    run,
    // Toggling Aa/ab/* must re-run the search without editing the term.
    refreshKey: JSON.stringify(options),
  });

  return {
    ...query,
    truncated: truncatedFor.term === term ? truncatedFor.truncated : false,
  };
}
