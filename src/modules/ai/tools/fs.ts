import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import {
  composePendingProposal,
} from "../lib/pendingProposals";
import {
  checkDeleteGuard,
  checkRenameGuard,
  isPathInside,
} from "../lib/fileOpGuards";
import {
  checkReadableCanonical,
  checkWritableCanonical,
} from "../lib/security";
import { newQueuedEditId, usePlanStore } from "../store/planStore";
import { resolvePath, type ToolContext } from "./context";

/**
 * What the model is told after a successful file proposal. The on-disk
 * file is untouched until the user applies the review.
 */
const PROPOSAL_NOTE =
  "Proposal recorded for review; the file on disk is unchanged until the user applies it in the review tab.";

const READ_BYTE_CAP = 25 * 1024;
const READ_LINE_CAP = 2000;

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

export function buildFsTools(ctx: ToolContext) {
  return {
    read_file: tool({
      description:
        "Read a UTF-8 text file. Defaults to the first 2000 lines (capped at 25KB). Pass `offset`/`limit` for line-based windowing of large files. Refuses binary, oversized, or sensitive files (.env, keys, credentials). If you call this on the same path twice in a session without edits in between, the second call returns `unchanged: true` instead of re-emitting the content — re-read the prior tool result.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("0-based start line. Default 0."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe("Max lines to return. Default 2000."),
      }),
      execute: async ({ path, offset, limit }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const r = await native.readFile(abs);
          if (r.kind === "binary")
            return { error: "binary file refused", path: abs, size: r.size };
          if (r.kind === "toolarge")
            return {
              error: `file too large (${r.size} bytes, limit ${r.limit})`,
              path: abs,
            };

          const hash = djb2(r.content);
          const isFullRead = offset === undefined && limit === undefined;
          const prior = ctx.readCache.get(abs);
          if (isFullRead && prior && prior.size === r.size && prior.hash === hash) {
            return { path: abs, unchanged: true, size: r.size };
          }
          ctx.readCache.set(abs, { size: r.size, hash });

          if (isFullRead) {
            const lines = r.content.split("\n");
            const sliceEnd = Math.min(lines.length, READ_LINE_CAP);
            let content = lines.slice(0, sliceEnd).join("\n");
            let truncated = sliceEnd < lines.length;
            if (content.length > READ_BYTE_CAP) {
              content = content.slice(0, READ_BYTE_CAP);
              truncated = true;
            }
            return {
              path: abs,
              content,
              size: r.size,
              total_lines: lines.length,
              ...(truncated
                ? { truncated: true, hint: "call read_file with offset to continue" }
                : {}),
            };
          }

          const lines = r.content.split("\n");
          const start = offset ?? 0;
          const requested = limit ?? READ_LINE_CAP;
          const end = Math.min(lines.length, start + requested);
          let content = lines.slice(start, end).join("\n");
          let truncated = end < lines.length;
          if (content.length > READ_BYTE_CAP) {
            content = content.slice(0, READ_BYTE_CAP);
            truncated = true;
          }
          return {
            path: abs,
            content,
            size: r.size,
            total_lines: lines.length,
            start_line: start,
            end_line: end,
            ...(truncated ? { truncated: true } : {}),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    list_directory: tool({
      description:
        "List immediate entries (files + directories) in a directory. Hidden entries are omitted.",
      inputSchema: z.object({
        path: z
          .string()
          .describe("Absolute path, or relative to the active terminal cwd."),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkReadableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        try {
          const entries = await native.readDir(abs);
          return {
            path: abs,
            entries: entries.map((e) => ({ name: e.name, kind: e.kind })),
          };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    write_file: tool({
      description:
        "Create or overwrite a file with the given content. Proposes the new content for user review; nothing is written to disk until the user applies it in the review tab. Prefer `edit` / `multi_edit` for in-place changes — only use `write_file` for creating a brand-new file or fully replacing a tiny one.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      execute: async ({ path, content }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        // On-disk baseline for the proposal (and for the plan queue).
        let original = "";
        let isNewFile = false;
        try {
          const r = await native.readFile(abs);
          if (r.kind === "text") original = r.content;
        } catch {
          isNewFile = true;
        }

        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "write_file",
            path: abs,
            originalContent: original,
            proposedContent: content,
            isNewFile,
          });
          return {
            path: abs,
            queued_for_plan_review: true,
            ok: true,
          };
        }

        composePendingProposal(abs, original, content, isNewFile);
        return {
          path: abs,
          bytesProposed: content.length,
          proposed: true,
          ok: true,
          note: PROPOSAL_NOTE,
        };
      },
    }),

    create_directory: tool({
      description:
        "Create a directory (and any missing parents). Runs immediately — there is no review step for directories.",
      inputSchema: z.object({
        path: z.string(),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;
        if (usePlanStore.getState().active) {
          usePlanStore.getState().enqueue({
            id: newQueuedEditId(),
            kind: "create_directory",
            path: abs,
            originalContent: "",
            proposedContent: "",
            isNewFile: true,
            description: "Create directory",
          });
          return { path: abs, queued_for_plan_review: true, ok: true };
        }
        try {
          await native.createDir(abs);
          return { path: abs, ok: true };
        } catch (e) {
          return { error: String(e), path: abs };
        }
      },
    }),

    delete_file: tool({
      description:
        "Delete a file. Proposes the deletion for user review in the AI diff tab — the file is unchanged on disk until the user accepts it there. Requires a prior read_file on the path in this session, and refuses when the file changed since that read. Never use for directories.",
      inputSchema: z.object({
        path: z.string(),
        reason: z
          .string()
          .optional()
          .describe("Why the file should be deleted."),
      }),
      execute: async ({ path }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const safety = await checkWritableCanonical(reqPath, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, path: reqPath };
        const abs = safety.canonical;

        if (usePlanStore.getState().active) {
          return {
            error:
              "delete_file is not supported in plan mode: deletes are reviewed per file, not queued.",
            path: abs,
          };
        }

        const seen = ctx.readCache.get(abs) ?? null;
        let exists = false;
        let currentHash: number | null = null;
        try {
          const r = await native.readFile(abs);
          if (r.kind === "text") {
            exists = true;
            currentHash = djb2(r.content);
          } else {
            return { error: "file is not readable as text", path: abs };
          }
        } catch {
          exists = false;
        }
        const guard = checkDeleteGuard({
          exists,
          currentHash,
          seenHash: seen?.hash ?? null,
        });
        if (!guard.ok) return { error: guard.reason, path: abs };

        // Proposal only: the file is deleted by the review UI, after the
        // user accepts it — never here.
        return {
          path: abs,
          proposed: true,
          ok: true,
          note: "Deletion proposed for review; the file is unchanged on disk until the user accepts it in the review tab.",
        };
      },
    }),

    rename_file: tool({
      description:
        "Rename or move a file. Proposes the rename for user review in the AI diff tab — nothing moves on disk until the user accepts it there. Refuses when the target already exists or the target is outside the workspace. Never use for directories.",
      inputSchema: z.object({
        path: z.string(),
        to: z
          .string()
          .describe(
            "New path, absolute or relative to the active terminal cwd.",
          ),
        reason: z
          .string()
          .optional()
          .describe("Why the file should be renamed."),
      }),
      execute: async ({ path, to }) => {
        const reqPath = resolvePath(path, ctx.getCwd());
        const reqTo = resolvePath(to, ctx.getCwd());
        const sourceSafety = await checkWritableCanonical(
          reqPath,
          native.canonicalize,
        );
        if (!sourceSafety.ok)
          return { error: sourceSafety.reason, path: reqPath };
        const abs = sourceSafety.canonical;
        const targetSafety = await checkWritableCanonical(
          reqTo,
          native.canonicalize,
        );
        if (!targetSafety.ok)
          return { error: targetSafety.reason, path: reqTo };
        const absTo = targetSafety.canonical;

        if (usePlanStore.getState().active) {
          return {
            error:
              "rename_file is not supported in plan mode: renames are reviewed per file, not queued.",
            path: abs,
          };
        }

        let sourceExists = false;
        try {
          const r = await native.readFile(abs);
          sourceExists = r.kind === "text";
        } catch {
          sourceExists = false;
        }
        let targetExists = false;
        try {
          await native.readFile(absTo);
          targetExists = true;
        } catch {
          targetExists = false;
        }

        const root = ctx.getWorkspaceRoot();
        if (!root) {
          return {
            error:
              "cannot rename: no workspace root to verify the target against",
            path: abs,
          };
        }
        let targetInside = false;
        try {
          const canonRoot = await native.canonicalize(root);
          // absTo already carries a canonical parent (checkWritableCanonical
          // resolved it for a not-yet-existing target), so its parent dir
          // is the canonical form to compare against the root.
          const lastSep = Math.max(
            absTo.lastIndexOf("/"),
            absTo.lastIndexOf("\\"),
          );
          const canonParent =
            lastSep > 0 ? absTo.slice(0, lastSep) : absTo;
          targetInside = isPathInside(canonRoot, canonParent);
        } catch {
          targetInside = false;
        }

        const guard = checkRenameGuard({
          sourceExists,
          targetExists,
          targetInsideWorkspace: targetInside,
        });
        if (!guard.ok) return { error: guard.reason, path: abs };

        // Proposal only: the rename is executed by the review UI, after
        // the user accepts it — never here.
        return {
          path: abs,
          to: absTo,
          proposed: true,
          ok: true,
          note: "Rename proposed for review; nothing moves on disk until the user accepts it in the review tab.",
        };
      },
    }),
  } as const;
}
