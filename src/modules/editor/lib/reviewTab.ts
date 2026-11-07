import type { AiDiffTab, Tab } from "@/modules/tabs";

/** Canonical path form for matching editor tabs to ai-diff proposals. */
export function normalizeReviewPath(p: string): string {
  return p.split("\\").join("/");
}

/**
 * The AI proposal for a file, if any (first one wins when a file has
 * several). Any status matches: the caller decides which statuses show
 * an inline overlay, so an applied or rejected proposal clears it.
 */
export function reviewTabFor(
  tabs: readonly Tab[],
  path: string,
): AiDiffTab | null {
  const wanted = normalizeReviewPath(path);
  return (
    tabs.find(
      (t): t is AiDiffTab =>
        t.kind === "ai-diff" && normalizeReviewPath(t.path) === wanted,
    ) ?? null
  );
}
