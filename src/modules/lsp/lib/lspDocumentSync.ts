import type { ChangeSet, Extension, Text } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { TeraxLspClient } from "./client";

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspTextChange =
  | { range: LspRange; text: string }
  | { text: string };
export type LspSyncKind = "incremental" | "full";

export type LspDidOpenParams = {
  textDocument: {
    uri: string;
    languageId: string;
    version: number;
    text: string;
  };
};

export type LspDidChangeParams = {
  textDocument: { uri: string; version: number };
  contentChanges: LspTextChange[];
};

/**
 * CodeMirror offset → LSP position (0-based line/character).
 * Characters are UTF-16 units, matching LSP's default position
 * encoding and CodeMirror's string offsets.
 */
export function offsetToLspPosition(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

/** Inverse of `offsetToLspPosition`; undefined for out-of-range input. */
export function lspPositionToOffset(
  doc: Text,
  pos: LspPosition,
): number | undefined {
  if (pos.line >= doc.lines) return undefined;
  const offset = doc.line(pos.line + 1).from + pos.character;
  if (offset > doc.length) return undefined;
  return offset;
}

/**
 * Maps a CodeMirror ChangeSet to LSP `DidChangeTextDocument` content
 * changes. An exact mirror of `changeSetToEvents` in
 * codemirror-languageserver 1.22.1 (which does not export it),
 * including the descending sort: the server applies the events in
 * array order, and later offsets first means earlier offsets never
 * shift under it.
 */
export function changeSetToLspEvents(
  doc: Text,
  changes: ChangeSet,
): { range: LspRange; text: string }[] {
  const events: { range: LspRange; text: string }[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    events.push({
      range: {
        start: offsetToLspPosition(doc, fromA),
        end: offsetToLspPosition(doc, toA),
      },
      text: inserted.toString(),
    });
  });
  events.sort((a, b) => {
    const aOff = lspPositionToOffset(doc, a.range.start);
    const bOff = lspPositionToOffset(doc, b.range.start);
    if (aOff === undefined || bOff === undefined) return 0;
    return bOff - aOff;
  });
  return events;
}

/**
 * Reads the sync kind a server declared in its initialize result.
 * `textDocumentSync` is a TextDocumentSyncKind number (0 None, 1 Full,
 * 2 Incremental) or an options object with a `change` field. Anything
 * other than an explicit Full is Incremental: that is what Terax
 * already sends (the library plugin is always Incremental here) and
 * what the ESLint server declares — verified from the server source
 * (microsoft/vscode-eslint, server/src/eslintServer.ts:
 * `textDocumentSync: { openClose: true, change:
 * TextDocumentSyncKind.Incremental, ... }`).
 */
export function resolveLspSyncKind(capabilities: unknown): LspSyncKind {
  const sync = (
    capabilities as { textDocumentSync?: unknown } | null | undefined
  )?.textDocumentSync;
  const change =
    typeof sync === "number"
      ? sync
      : (sync as { change?: unknown } | null | undefined)?.change;
  return change === 1 ? "full" : "incremental";
}

/**
 * Pure version/state machine for one (client, document) sync: the
 * ViewPlugin adapter owns the transport calls, this owns the numbers.
 * Versions mirror the library plugin exactly: didOpen is version 0,
 * and didChange reuses version 0 first (`version++` post-increment),
 * then 1, 2, … — the same values the servers already tolerate from
 * the first preset's library plugin.
 */
export class DocumentSyncTracker {
  private version = 0;
  private opened = false;

  get isOpen(): boolean {
    return this.opened;
  }

  openParams(
    uri: string,
    languageId: string,
    text: string,
  ): LspDidOpenParams {
    this.opened = true;
    return { textDocument: { uri, languageId, version: 0, text } };
  }

  changeParams(
    uri: string,
    events: { range: LspRange; text: string }[],
    fullText: string,
    kind: LspSyncKind,
  ): LspDidChangeParams | null {
    if (!this.opened) return null;
    const version = this.version++;
    return {
      textDocument: { uri, version },
      contentChanges:
        kind === "full" ? [{ text: fullText }] : events,
    };
  }
}

/**
 * Terax's own document-sync plugin, for presets whose library plugin
 * never gets created. The library's `languageServerPlugin` is deduped
 * by the `viewPlugin` facet to its first provision (Fase 16), so with
 * two presets for one language (TypeScript + ESLint for ts/tsx) only
 * the first preset's server ever receives didOpen/didChange. This
 * plugin sends the same notifications for the later presets, with
 * the same shapes and version numbering as the library plugin.
 *
 * Two deliberate differences from the library plugin:
 * - didOpen reads the document text when initialize completes, not
 *   at construction, so edits typed while the server starts are
 *   already in the opened snapshot (the library captures stale text
 *   and drops pre-init changes).
 * - destroy() sends no didClose: `releaseRef` in sessionManager
 *   already sends `textDocument/didClose` when the last handle for
 *   (session, uri) is released, which covers this plugin's documents
 *   too — sending it here as well would double-close.
 */
class LspDocumentSyncPlugin {
  private view: EditorView;
  private client: TeraxLspClient;
  private documentUri: string;
  private languageId: string;
  private tracker = new DocumentSyncTracker();
  private syncKind: LspSyncKind = "incremental";
  private destroyed = false;

  constructor(
    view: EditorView,
    opts: {
      client: TeraxLspClient;
      documentUri: string;
      languageId: string;
    },
  ) {
    this.view = view;
    this.client = opts.client;
    this.documentUri = opts.documentUri;
    this.languageId = opts.languageId;
    void this.open();
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged || !this.tracker.isOpen) return;
    if (!this.client.ready) return;
    const params = this.tracker.changeParams(
      this.documentUri,
      changeSetToLspEvents(update.startState.doc, update.changes),
      this.view.state.doc.toString(),
      this.syncKind,
    );
    if (!params) return;
    void this.client.textDocumentDidChange(params).catch((e) => {
      console.error("[lsp] didChange failed", e);
    });
  }

  destroy(): void {
    this.destroyed = true;
  }

  private async open(): Promise<void> {
    if (this.client.initializePromise) {
      await this.client.initializePromise;
    }
    if (this.destroyed || !this.client.ready) return;
    this.syncKind = resolveLspSyncKind(this.client.capabilities);
    const params = this.tracker.openParams(
      this.documentUri,
      this.languageId,
      this.view.state.doc.toString(),
    );
    try {
      await this.client.textDocumentDidOpen(params);
    } catch (e) {
      console.error("[lsp] didOpen failed", e);
    }
  }
}

/**
 * Document sync for one preset's document. Mount only for presets
 * whose library plugin was deduped away (see sessionManager's
 * `manualDocumentSync`); mounting it for the first preset would
 * double-sync the same document to the same server.
 */
export function lspDocumentSyncExtension(opts: {
  client: TeraxLspClient;
  documentUri: string;
  languageId: string;
}): Extension {
  return ViewPlugin.define(
    (view) => new LspDocumentSyncPlugin(view, opts),
  );
}
