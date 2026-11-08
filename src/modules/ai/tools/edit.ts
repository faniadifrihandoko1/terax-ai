import { tool } from "ai";
import { z } from "zod";
import { djb2Hash } from "../lib/hash";
import { native } from "../lib/native";
import {
  composePendingProposal,
  getPendingProposal,
} from "../lib/pendingProposals";
import {
  buildEditCheckpoint,
  recordToolWriteCheckpoint,
} from "../lib/reviewCheckpoint";
import { checkWritableCanonical } from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

type EditResult =
  | {
      ok: true;
      /** The change was written to disk immediately (Fase 8). */
      written: true;
      replacements: number;
      bytesWritten: number;
      path: string;
      note: string;
    }
  | {
      ok: true;
      /** Plan mode: the change went to the plan queue, not to disk. */
      proposed: true;
      queued_for_plan_review: true;
      replacements: number;
      bytesProposed: number;
      path: string;
      note: string;
    }
  | { error: string; path: string };

/**
 * What the model is told after a successful write. The file is already
 * changed on disk; the user reviews it afterwards in the AI diff tab,
 * where Accept keeps it and Reject reverts it from the checkpoint.
 */
const WRITTEN_NOTE =
  "Written to disk; review it in the AI diff tab — Accept keeps it, Reject reverts it from the checkpoint. Further edits to this file build on the written content.";

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
 * anything. The base is always the on-disk content: since Fase 8 the
 * previous write is already on disk, so several tool calls to one file
 * in a run compose naturally. Plan mode always uses the on-disk content
 * too: queued plan edits keep their own per-item proposed content and
 * never touch the pending-proposal registry.
 */
async function computeEdits(
  abs: string,
  edits: { old_string: string; new_string: string; replace_all?: boolean }[],
): Promise<ComputedEdits> {
  const r = await native.readFile(abs);
  if (r.kind === "binary")
    return { ok: false, error: "binary file refused", path: abs };
  if (r.kind === "toolarge")
    return { ok: false, error: `file too large (${r.size} bytes)`, path: abs };

  const original = r.content;
  let content = original;
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
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}`,
          path: abs,
        };
      }
      totalReplacements += n;
    } else {
      const first = content.indexOf(e.old_string);
      if (first === -1) {
        return {
          ok: false,
          error: `old_string not found: ${JSON.stringify(e.old_string.slice(0, 80))}`,
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
  toolCallId: string,
): Promise<EditResult> {
  if (!ctx.readCache.has(abs)) {
    return {
      error:
        "must call read_file on this path first (read-before-edit invariant).",
      path: abs,
    };
  }
  const planActive = usePlanStore.getState().active;
  const computed = await computeEdits(abs, edits);
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
  // Fase 8 (write-first): the edit goes to disk immediately, like
  // Antigravity's write-first model — git shows the change at once and
  // later terminal commands run against the new code. A failed write
  // records nothing, so the run can retry the edit.
  const prior = getPendingProposal(abs);
  try {
    await native.writeFile(abs, computed.content);
  } catch (error) {
    return {
      error: `failed to write ${abs}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      path: abs,
    };
  }
  composePendingProposal(
    abs,
    computed.original,
    computed.content,
    false,
    "edit",
    undefined,
    toolCallId,
  );
  // Fase 9 (slice 2): the checkpoint is taken here, at write time —
  // the registry holds the written baseline from this moment on, so
  // Restore works even if the run is interrupted before the bridge
  // opens the review tab. A second write to the same file only
  // advances the written state of the first write's checkpoint; the
  // baseline never moves. The tool call id is the checkpoint id, and
  // also the review tab's proposal id, so the bridge's later
  // ensureWriteCheckpoint for the same id just advances it.
  recordToolWriteCheckpoint(
    prior?.approvalId,
    buildEditCheckpoint({
      approvalId: toolCallId,
      sessionId: ctx.getSessionId() ?? undefined,
      path: abs,
      originalContent: computed.original,
      reconstructedContent: computed.content,
      appliedHunks: [],
    }),
  );
  // The read cache must track the new content: the delete guard compares
  // the file against the last read, and the agent's own write is not a
  // foreign change.
  ctx.readCache.set(abs, {
    size: computed.content.length,
    hash: djb2Hash(computed.content),
  });
  return {
    ok: true,
    written: true,
    replacements: computed.replacements,
    bytesWritten: computed.content.length,
    path: abs,
    note: WRITTEN_NOTE,
  };
}

export function buildEditTools(ctx: ToolContext) {
  return {
    edit: tool({
      description:
        "Replace an exact string in a file. Requires read_file on this path first in the current session — this prevents blind edits. `old_string` must be unique in the file unless `replace_all: true`. The change is written to disk immediately and reviewed afterwards in the AI diff tab — Accept keeps it, Reject reverts it from the checkpoint.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z
          .string()
          .describe("Exact substring to replace. Must be unique unless replace_all."),
        new_string: z.string().describe("Replacement substring."),
        replace_all: z.boolean().optional(),
      }),
      execute: async (
        { path, old_string, new_string, replace_all },
        { toolCallId },
      ) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        return proposeEdits(
          safety.canonical,
          [{ old_string, new_string, replace_all }],
          "edit",
          ctx,
          toolCallId,
        );
      },
    }),

    multi_edit: tool({
      description:
        "Apply several exact-string replacements to a single file atomically. Each edit is applied in order to the running buffer; if any edit's old_string is missing or non-unique, the whole batch aborts before writing anything. Requires prior read_file on the path. The batch is written to disk immediately and reviewed afterwards in the AI diff tab — Accept keeps it, Reject reverts it from the checkpoint.",
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
      execute: async ({ path, edits }, { toolCallId }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        return proposeEdits(safety.canonical, edits, "multi_edit", ctx, toolCallId);
      },
    }),
  } as const;
}
