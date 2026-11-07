import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import {
  composePendingProposal,
  getPendingProposal,
} from "../lib/pendingProposals";
import { checkWritableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

type EditResult =
  | {
      ok: true;
      /** True when the change is a review proposal, not a disk write. */
      proposed: true;
      /** True when the proposal went to the plan queue instead. */
      queued_for_plan_review?: boolean;
      replacements: number;
      bytesProposed: number;
      path: string;
      note: string;
    }
  | { error: string; path: string };

/**
 * What the model is told after a successful proposal. The on-disk file
 * is untouched until the user applies the review, and further edits to
 * the same file build on the pending proposal, not on the disk content.
 */
const PROPOSAL_NOTE =
  "Proposal recorded for review; the file on disk is unchanged until the user applies it in the review tab. Further edits to this file build on this pending proposal.";

type ComputedEdits =
  | {
      ok: true;
      original: string;
      content: string;
      replacements: number;
    }
  | { ok: false; error: string; path: string };

/**
 * Applies the edits to a buffer and returns the result — without writing
 * anything. The base is the pending proposal for the path when one
 * exists (so several tool calls to one file in a run compose), otherwise
 * the on-disk content. Plan mode always uses the on-disk content: queued
 * plan edits keep their own per-item proposed content and never touch
 * the pending-proposal registry.
 */
async function computeEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
  planMode: boolean,
): Promise<ComputedEdits> {
  const r = await native.readFile(abs);
  if (r.kind === "binary")
    return { ok: false, error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { ok: false, error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;
  const pending = planMode ? undefined : getPendingProposal(abs);
  let content = pending?.proposedContent ?? original;
  let totalReplacements = 0;

  for (const e of edits) {
    if (e.old_string === e.new_string) {
      return {
        ok: false,
        error: "old_string and new_string are identical",
        path: abs,
      };
    }
    if (e.old_string.length === 0) {
      return { ok: false, error: "old_string cannot be empty", path: abs };
    }
    if (e.replace_all) {
      const before = content;
      content = content.split(e.old_string).join(e.new_string);
      // Recover count via direct search to avoid divide-by-zero edge cases.
      let n = 0;
      let i = 0;
      while ((i = before.indexOf(e.old_string, i)) !== -1) {
        n++;
        i += e.old_string.length;
      }
      if (n === 0) {
        return {
          ok: false,
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}${pending ? " (it may have been changed by your earlier proposal in this run; base the edit on your proposed content, not the on-disk content)" : ""}`,
          path: abs,
        };
      }
      totalReplacements += n;
    } else {
      const first = content.indexOf(e.old_string);
      if (first === -1) {
        return {
          ok: false,
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}${pending ? " (it may have been changed by your earlier proposal in this run; base the edit on your proposed content, not the on-disk content)" : ""}`,
          path: abs,
        };
      }
      const second = content.indexOf(e.old_string, first + 1);
      if (second !== -1) {
        return {
          ok: false,
          error:
            "old_string is not unique. Provide more surrounding context, or set replace_all=true.",
          path: abs,
        };
      }
      content =
        content.slice(0, first) +
        e.new_string +
        content.slice(first + e.old_string.length);
      totalReplacements += 1;
    }
  }

  return { ok: true, original, content, replacements: totalReplacements };
}

async function proposeEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
  kind: "edit" | "multi_edit",
  ctx: ToolContext,
): Promise<EditResult> {
  if (!ctx.readCache.has(abs)) {
    return {
      error:
        "must call read_file on this path first (read-before-edit invariant).",
      path: abs,
    };
  }
  const planActive = usePlanStore.getState().active;
  const computed = await computeEdits(abs, edits, planActive);
  if (!computed.ok) return { error: computed.error, path: computed.path };
  if (planActive) {
    usePlanStore.getState().enqueue({
      id: newQueuedEditId(),
      kind,
      path: abs,
      originalContent: computed.original,
      proposedContent: computed.content,
      isNewFile: false,
    });
    return {
      ok: true,
      proposed: true,
      queued_for_plan_review: true,
      replacements: computed.replacements,
      bytesProposed: computed.content.length,
      path: abs,
      note: "Queued for plan review; the file on disk is unchanged.",
    };
  }
  composePendingProposal(
    abs,
    computed.original,
    computed.content,
    false,
  );
  return {
    ok: true,
    proposed: true,
    replacements: computed.replacements,
    bytesProposed: computed.content.length,
    path: abs,
    note: PROPOSAL_NOTE,
  };
}

export function buildEditTools(ctx: ToolContext) {
  return {
    edit: tool({
      description:
        "Replace an exact string in a file. Requires read_file on this path first in the current session — this prevents blind edits. `old_string` must be unique in the file unless `replace_all: true`. Proposes the change for user review; nothing is written to disk until the user applies it in the review tab.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z
          .string()
          .describe("Exact substring to replace. Must be unique unless replace_all."),
        new_string: z.string().describe("Replacement substring."),
        replace_all: z.boolean().optional(),
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        return proposeEdits(
          safety.canonical,
          [{ old_string, new_string, replace_all }],
          "edit",
          ctx,
        );
      },
    }),

    multi_edit: tool({
      description:
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before proposing anything. Requires prior read_file on the path. Proposes the batch for user review; nothing is written until the user applies it.",
      inputSchema: z.object({
        path: z.string(),
        edits: z
          .array(
            z.object({
              old_string: z.string(),
              new_string: z.string(),
              replace_all: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
      execute: async ({ path, edits }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        return proposeEdits(safety.canonical, edits, "multi_edit", ctx);
      },
    }),
  } as const;
}
