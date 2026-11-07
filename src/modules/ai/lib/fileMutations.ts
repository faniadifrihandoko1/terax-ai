import { checkReadable } from "./security";
import { native } from "./native";
import { resolvePath } from "../tools/tools";

/**
 * Shared derivation of AI-proposed file content from chat tool parts.
 *
 * AgentRunBridge and ChangedFilesCard both need the same answer ("what
 * would this tool call write?"), so the logic lives here once instead of
 * being duplicated in a headless bridge and a chat component. Everything
 * in this module is pure except readOriginal, which reads one file.
 */

export type EditOp = {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
};

export type FileMutation =
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "literal"; content: string };
    }
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "edits"; edits: EditOp[] };
    }
  | {
      state: string;
      approvalId: string | null;
      path: string;
      /** The file is gone after the apply; proposed content is "". */
      derive: { kind: "delete" };
    }
  | {
      state: string;
      approvalId: string | null;
      path: string;
      /** Content unchanged; the file moves to `to`. */
      derive: { kind: "rename"; to: string };
    };

export type ToolPartLike = {
  type?: string;
  state?: string;
  approval?: { id: string };
  input?: unknown;
  /** Tool result, present once the call finished (Fase 6). */
  output?: unknown;
  toolCallId?: string;
};

/** True for the tool parts that mutate a file and can appear in a diff. */
export function isFileMutationPart(type: string): boolean {
  return (
    type === "tool-write_file" ||
    type === "tool-edit" ||
    type === "tool-multi_edit" ||
    type === "tool-delete_file" ||
    type === "tool-rename_file"
  );
}

export function extractFileMutation(
  part: ToolPartLike,
): FileMutation | null {
  const type = part.type ?? "";
  const state = part.state ?? "";
  // Fase 6: the id that keys a proposal. Before Fase 6 this was the AI SDK
  // approval id; file proposals no longer go through an approval
  // round-trip, so the id is now the tool call's own id. An approval id
  // still wins when one exists (legacy parts from sessions recorded
  // before Fase 6, whose tool call was approval-gated). The field keeps
  // its old name so tabs, persistence, checkpoints and the card keep
  // working unchanged — it identifies the proposing tool call.
  const approvalId = part.approval?.id ?? part.toolCallId ?? null;
  const input = (part.input ?? {}) as Record<string, unknown>;

  if (type === "tool-write_file") {
    const path = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (!path) return null;
    return { state, approvalId, path, derive: { kind: "literal", content } };
  }
  if (type === "tool-edit") {
    const path = typeof input.path === "string" ? input.path : "";
    const oldStr =
      typeof input.old_string === "string" ? input.old_string : "";
    const newStr =
      typeof input.new_string === "string" ? input.new_string : "";
    if (!path) return null;
    return {
      state,
      approvalId,
      path,
      derive: {
        kind: "edits",
        edits: [
          {
            old_string: oldStr,
            new_string: newStr,
            replace_all: Boolean(input.replace_all),
          },
        ],
      },
    };
  }
  if (type === "tool-multi_edit") {
    const path = typeof input.path === "string" ? input.path : "";
    if (!path || !Array.isArray(input.edits)) return null;
    const edits: EditOp[] = (input.edits as Record<string, unknown>[])
      .map((e) => ({
        old_string: typeof e.old_string === "string" ? e.old_string : "",
        new_string: typeof e.new_string === "string" ? e.new_string : "",
        replace_all: Boolean(e.replace_all),
      }))
      .filter((e) => e.old_string.length > 0);
    if (edits.length === 0) return null;
    return { state, approvalId, path, derive: { kind: "edits", edits } };
  }
  if (type === "tool-delete_file") {
    const path = typeof input.path === "string" ? input.path : "";
    if (!path) return null;
    return { state, approvalId, path, derive: { kind: "delete" } };
  }
  if (type === "tool-rename_file") {
    const path = typeof input.path === "string" ? input.path : "";
    const to = typeof input.to === "string" ? input.to : "";
    if (!path || !to) return null;
    return { state, approvalId, path, derive: { kind: "rename", to } };
  }
  return null;
}

export function applyEditsLocally(
  original: string,
  edits: EditOp[],
): { ok: true; content: string } | { ok: false } {
  let content = original;
  for (const e of edits) {
    if (e.old_string === e.new_string || e.old_string.length === 0)
      return { ok: false };
    if (e.replace_all) {
      if (!content.includes(e.old_string)) return { ok: false };
      content = content.split(e.old_string).join(e.new_string);
    } else {
      const first = content.indexOf(e.old_string);
      if (first === -1) return { ok: false };
      const second = content.indexOf(e.old_string, first + 1);
      if (second !== -1) return { ok: false };
      content =
        content.slice(0, first) +
        e.new_string +
        content.slice(first + e.old_string.length);
    }
  }
  return { ok: true, content };
}

/** Turns a mutation's derive step into proposed content, if it applies. */
export function deriveProposed(
  original: string,
  derive: FileMutation["derive"],
): { ok: true; content: string } | { ok: false } {
  if (derive.kind === "literal") {
    return { ok: true, content: derive.content };
  }
  if (derive.kind === "delete") {
    return { ok: true, content: "" };
  }
  if (derive.kind === "rename") {
    return { ok: true, content: original };
  }
  return applyEditsLocally(original, derive.edits);
}

export async function readOriginal(
  abs: string,
): Promise<{ content: string; isNewFile: boolean }> {
  // The fs guard rejects sensitive paths even on read; mirror that here so
  // the caller sees an empty "before" rather than an error.
  const safety = checkReadable(abs);
  if (!safety.ok) return { content: "", isNewFile: false };
  try {
    const r = await native.readFile(abs);
    if (r.kind === "text") return { content: r.content, isNewFile: false };
    // Binary or oversized: no sensible original to render.
    return { content: "", isNewFile: false };
  } catch (e) {
    const msg = String(e).toLowerCase();
    const notFound =
      msg.includes("no such file") ||
      msg.includes("not found") ||
      msg.includes("os error 2");
    return { content: "", isNewFile: notFound };
  }
}

/** Resolves a mutation's relative path against the agent cwd. */
export function resolveMutationPath(
  path: string,
  cwd: string | null,
): string {
  if (!cwd) return path;
  try {
    return resolvePath(path, cwd);
  } catch {
    return path;
  }
}
