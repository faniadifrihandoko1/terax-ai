import type { AiDiffStatus } from "@/modules/tabs";
import { IS_WINDOWS } from "@/lib/platform";
import type { PendingProposal } from "@/modules/ai/lib/pendingProposals";
import { normalizePath } from "./gitStatusUtils";

/**
 * Pending-review map for the sidebar (Fase 34): which tree files have
 * an AI change waiting for review, and under which proposal id(s) the
 * review tab opens.
 *
 * One source of truth with the Changed Files card, but built from
 * sources that survive a closed tab — the card's rows come from the
 * chat message parts, while this map comes from the live
 * pending-proposal registry (cleared only by Confirm/Revert, never by
 * closing a tab) plus the open ai-diff tabs. A file whose tab was
 * closed keeps its badge because the registry entry is still there;
 * a file whose proposal was confirmed loses it because Confirm
 * clears the registry and the tab turns "applied". The map is keyed
 * by canonical path so a registry path spelled with backslashes
 * matches the tree row spelled with slashes (and, on Windows, case
 * does not matter — same rule as `eslintPathKey`).
 */

/** What a sidebar click needs to open the review for one file. */
export type PendingReviewRef = {
  /**
   * Id the click activates or rebuilds under: the open tab's id when
   * one exists (the tab is found by this id), else the registry's
   * first-write id.
   */
  approvalId: string;
  /** Every mutation id known for this path, primary first. */
  approvalIds: string[];
};

/** One open ai-diff tab, in the shape App already has. */
export type PendingReviewTab = {
  approvalId: string;
  path: string;
  status: AiDiffStatus;
  mutationKind?: "edit" | "delete" | "rename";
};

/** One live registry entry (see `listPendingProposals`). */
export type PendingReviewRegistryEntry = {
  path: string;
  proposal: PendingProposal;
};

/** Canonical key for matching a tree row path against a review path. */
export function pendingReviewPathKey(
  path: string,
  windows: boolean = IS_WINDOWS,
): string {
  const slash = normalizePath(path);
  return windows ? slash.toLowerCase() : slash;
}

/**
 * Statuses in which a review still needs the user: "done" means every
 * hunk is decided but the review is not confirmed yet. Applied,
 * rejected and restored are terminal — the change is settled.
 */
const REVIEWABLE_STATUSES: ReadonlySet<AiDiffStatus> = new Set([
  "pending",
  "reviewing",
  "done",
  "conflict",
]);

/**
 * Builds path → review for every file with a pending AI change.
 *
 * - Registry entries: only edits with an approval id. A delete or
 *   rename has no live tree file at its path, and an entry without an
 *   id (pre-Fase-9) cannot open a tab under any id.
 * - Open tabs: only edits with a reviewable status. A tab's id
 *   becomes the primary id (the click can activate it directly);
 *   when the registry also knows the path, both ids are kept so the
 *   Fase 33 rebuild can try them all.
 * - A terminal tab never creates an entry and never resurrects one:
 *   the registry is already gone by then (Confirm clears it), so a
 *   second, still-pending tab for the same path is the only way the
 *   file stays badged.
 */
export function buildPendingReviewByPath(input: {
  tabs: readonly PendingReviewTab[];
  registry: readonly PendingReviewRegistryEntry[];
  /** Override the platform for the path keys (tests use this). */
  windows?: boolean;
}): Map<string, PendingReviewRef> {
  const windows = input.windows ?? IS_WINDOWS;
  const out = new Map<string, PendingReviewRef>();
  for (const { path, proposal } of input.registry) {
    if (proposal.kind !== "edit") continue;
    if (proposal.approvalId === undefined) continue;
    out.set(pendingReviewPathKey(path, windows), {
      approvalId: proposal.approvalId,
      approvalIds: [proposal.approvalId],
    });
  }
  for (const tab of input.tabs) {
    if ((tab.mutationKind ?? "edit") !== "edit") continue;
    if (!REVIEWABLE_STATUSES.has(tab.status)) continue;
    const key = pendingReviewPathKey(tab.path, windows);
    const existing = out.get(key);
    out.set(key, {
      approvalId: tab.approvalId,
      approvalIds: [
        tab.approvalId,
        ...(existing?.approvalIds ?? []).filter(
          (id) => id !== tab.approvalId,
        ),
      ],
    });
  }
  return out;
}

/** Exact pending-review entry for a tree path, if any. */
export function pendingReviewForPath(
  byPath: ReadonlyMap<string, PendingReviewRef>,
  path: string,
  windows: boolean = IS_WINDOWS,
): PendingReviewRef | undefined {
  return byPath.get(pendingReviewPathKey(path, windows));
}

/**
 * True when a folder contains a pending-review file below it (same
 * prefix rule as the diagnostics aggregate): a collapsed folder still
 * shows the dot, so the pending file can be found.
 */
export function hasPendingReviewDescendant(
  byPath: ReadonlyMap<string, PendingReviewRef>,
  dirPath: string,
  windows: boolean = IS_WINDOWS,
): boolean {
  const prefix = `${pendingReviewPathKey(dirPath, windows)}/`;
  for (const key of byPath.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Whether a plain click on a tree row should open the review instead
 * of the file. Shift/mod clicks keep selecting, and folders keep
 * toggling — only a plain click on a pending file is rerouted.
 */
export function shouldOpenReview(input: {
  isDir: boolean;
  shift: boolean;
  mod: boolean;
  pendingReview?: PendingReviewRef | null;
}): boolean {
  if (input.isDir || input.shift || input.mod) return false;
  return input.pendingReview !== undefined && input.pendingReview !== null;
}
