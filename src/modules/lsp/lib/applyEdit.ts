/**
 * Server-initiated `workspace/applyEdit` handling (Fase 18).
 *
 * The ESLint server applies quick fixes by sending `workspace/applyEdit`
 * back to the client (verified from vscode-eslint-language-server
 * 4.10.0: `onExecuteCommand` looks the precomputed edit up in its
 * `changes` map and calls `connection.workspace.applyEdit`). The
 * client library (`codemirror-languageserver` 1.22.1) auto-replies
 * `null` to every server-to-client request, so without Terax routing
 * the edit here it would never apply. The transport (`transport.ts`)
 * intercepts the request before the library sees it and hands it to
 * the handler registered for the edit's document uri.
 */

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspTextEdit = { range: LspRange; newText: string };

export type LspTextDocumentEdit = {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
};

export type LspWorkspaceEdit = {
  documentChanges?: Array<LspTextDocumentEdit | Record<string, unknown>>;
  changes?: Record<string, LspTextEdit[]>;
};

export type ApplyEditOutcome = { applied: boolean; reason?: string };
export type ApplyEditHandler = (
  edit: LspWorkspaceEdit,
) => Promise<ApplyEditOutcome>;

const handlers = new Map<string, Set<ApplyEditHandler>>();

/**
 * Registers a handler for `workspace/applyEdit` requests targeting
 * `uri`. Returns an unsubscribe function; handlers are tried in
 * registration order until one applies the edit.
 */
export function registerApplyEditHandler(
  uri: string,
  handler: ApplyEditHandler,
): () => void {
  let set = handlers.get(uri);
  if (!set) {
    set = new Set();
    handlers.set(uri, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) handlers.delete(uri);
  };
}

function editTargetUri(edit: LspWorkspaceEdit): string | null {
  for (const entry of edit.documentChanges ?? []) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "textDocument" in entry &&
      typeof (entry as LspTextDocumentEdit).textDocument?.uri === "string"
    ) {
      return (entry as LspTextDocumentEdit).textDocument.uri;
    }
  }
  const keys = Object.keys(edit.changes ?? {});
  return keys[0] ?? null;
}

/**
 * Routes one `workspace/applyEdit` request (params as received over
 * the wire) to the handlers registered for its document uri. Never
 * throws: a malformed request or a handler that throws is
 * `{applied: false}`, so the server can report the failure instead
 * of hanging on an unanswered request.
 */
export async function handleApplyEditRequest(
  params: unknown,
): Promise<ApplyEditOutcome> {
  try {
    if (typeof params !== "object" || params === null) {
      return { applied: false, reason: "malformed applyEdit params" };
    }
    const edit = (params as { edit?: unknown }).edit;
    if (typeof edit !== "object" || edit === null) {
      return { applied: false, reason: "missing edit" };
    }
    const uri = editTargetUri(edit as LspWorkspaceEdit);
    if (!uri) return { applied: false, reason: "no target document" };
    const set = handlers.get(uri);
    if (!set || set.size === 0) {
      return { applied: false, reason: "no open editor for this file" };
    }
    for (const handler of [...set]) {
      try {
        const outcome = await handler(edit as LspWorkspaceEdit);
        if (outcome.applied) return outcome;
      } catch (e) {
        console.error("[lsp] applyEdit handler failed", e);
      }
    }
    return { applied: false, reason: "no handler applied the edit" };
  } catch (e) {
    console.error("[lsp] applyEdit routing failed", e);
    return { applied: false, reason: String(e) };
  }
}
