import type { ChangeSpec, Text } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { toast } from "sonner";
import type { TeraxLspClient } from "@/modules/lsp/lib/client";
import {
  registerApplyEditHandler,
  type ApplyEditOutcome,
  type LspRange,
  type LspWorkspaceEdit,
} from "@/modules/lsp/lib/applyEdit";
import { offsetToLspPosition } from "@/modules/lsp/lib/lspDocumentSync";
import { eslintPathKey } from "./eslintPaths";
import { useEslintStore, type EslintRawDiagnostic } from "./eslintStore";

/** Same budget as the other LSP requests in the client. */
const CODE_ACTION_TIMEOUT_MS = 10_000;

export type LspCodeAction = {
  title: string;
  kind?: string;
  diagnostics?: unknown[];
  edit?: LspWorkspaceEdit;
  command?: {
    title: string;
    command: string;
    arguments?: unknown[];
  };
  isPreferred?: boolean;
};

export type FixOutcome =
  | { kind: "applied"; title: string; edits?: number }
  | { kind: "no-diagnostic" }
  | { kind: "no-action" }
  | { kind: "no-plugin" }
  | { kind: "stale" }
  | { kind: "failed"; message: string };

// ──────────────────────────────────────────────────────────────────────────
// Pure: LSP range ↔ CodeMirror offsets, WorkspaceEdit → ChangeSpec
// ──────────────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * LSP range (0-based line, UTF-16 character) → CodeMirror offsets.
 * Characters are UTF-16 units in both systems, so `line.from +
 * character` is exact, including astral characters (one surrogate
 * pair = 2 units on both sides). Out-of-range lines/characters clamp
 * to the document instead of throwing - a server must never crash
 * the editor with a bad range.
 */
export function lspRangeToOffsets(
  doc: Text,
  range: LspRange,
): { from: number; to: number } {
  const startLineNo = clamp(Math.trunc(range.start.line) + 1, 1, doc.lines);
  const startLine = doc.line(startLineNo);
  const startCol = clamp(
    Math.trunc(range.start.character),
    0,
    startLine.length,
  );
  const endLineNo = clamp(Math.trunc(range.end.line) + 1, 1, doc.lines);
  const endLine = doc.line(endLineNo);
  const endCol = clamp(Math.trunc(range.end.character), 0, endLine.length);
  const from = startLine.from + startCol;
  const to = endLine.from + endCol;
  return { from: Math.min(from, to), to: Math.max(from, to) };
}

export type WorkspaceEditMapping =
  | { ok: true; changes: ChangeSpec[] }
  | { ok: false; reason: string };

function isTextDocumentEdit(
  entry: unknown,
): entry is {
  textDocument: { uri: string; version?: number | null };
  edits: Array<{ range: LspRange; newText: string }>;
} {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "textDocument" in entry &&
    typeof (entry as { textDocument?: unknown }).textDocument === "object" &&
    (entry as { textDocument?: { uri?: unknown } }).textDocument !== null &&
    typeof (entry as { textDocument: { uri?: unknown } }).textDocument
      .uri === "string" &&
    "edits" in entry &&
    Array.isArray(
      (entry as { edits?: unknown }).edits,
    )
  );
}

/**
 * Translates a server `WorkspaceEdit` into CodeMirror changes for
 * one document (`uri`). Only edits for that document apply - an edit
 * for another file, or a non-TextDocumentEdit entry (create/rename/
 * delete), rejects the whole edit instead of applying it partially.
 * Edits are sorted by position and must not overlap (the server
 * computes non-overlapping edits; an overlap means the edit is stale
 * or corrupt). A version carried by a TextDocumentEdit is NOT
 * checked here: staleness is guarded by document identity in the
 * plugin (see below), which subsumes the version - server versions
 * advance only on didOpen/didChange.
 */
export function workspaceEditToChanges(
  doc: Text,
  edit: LspWorkspaceEdit,
  uri: string,
): WorkspaceEditMapping {
  const raw: Array<{ from: number; to: number; insert: string }> = [];
  for (const entry of edit.documentChanges ?? []) {
    if (!isTextDocumentEdit(entry)) {
      return {
        ok: false,
        reason: "unsupported document change (not a text edit)",
      };
    }
    if (entry.textDocument.uri !== uri) {
      return { ok: false, reason: "edit targets another file" };
    }
    for (const e of entry.edits) {
      const { from, to } = lspRangeToOffsets(doc, e.range);
      raw.push({ from, to, insert: e.newText });
    }
  }
  for (const [key, edits] of Object.entries(edit.changes ?? {})) {
    if (key !== uri) {
      return { ok: false, reason: "edit targets another file" };
    }
    for (const e of edits) {
      const { from, to } = lspRangeToOffsets(doc, e.range);
      raw.push({ from, to, insert: e.newText });
    }
  }
  raw.sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < raw.length; i++) {
    if (raw[i]!.from < raw[i - 1]!.to) {
      return { ok: false, reason: "overlapping edits" };
    }
  }
  return { ok: true, changes: raw };
}

// ──────────────────────────────────────────────────────────────────────────
// Pure: diagnostics at a position, action picking
// ──────────────────────────────────────────────────────────────────────────

/**
 * Raw server diagnostics whose range contains the [from, to] span
 * (boundaries inclusive - a cursor sitting exactly on an edge still
 * counts, like VS Code). Ranges are compared in CodeMirror offsets
 * after the same clamped conversion the mapper uses.
 */
export function findRawDiagnosticsInRange(
  items: readonly EslintRawDiagnostic[],
  doc: Text,
  from: number,
  to: number,
): EslintRawDiagnostic[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return items.filter((item) => {
    const r = lspRangeToOffsets(doc, item.range);
    return r.from <= hi && lo <= r.to;
  });
}

export function findRawDiagnosticsAt(
  items: readonly EslintRawDiagnostic[],
  doc: Text,
  pos: number,
): EslintRawDiagnostic[] {
  return findRawDiagnosticsInRange(items, doc, pos, pos);
}

/**
 * The single-fix action to run: a fix is an action whose command is
 * `eslint.applySingleFix` or that carries an inline edit (suggestion
 * and disable-rule actions have other commands and are not fixes).
 * The server marks its fix `isPreferred`; that one wins, otherwise
 * the first fix in server order.
 */
export function pickQuickFixAction(
  actions: readonly LspCodeAction[],
): LspCodeAction | null {
  const fixes = actions.filter(
    (a) => a.command?.command === "eslint.applySingleFix" || a.edit !== undefined,
  );
  if (fixes.length === 0) return null;
  return fixes.find((a) => a.isPreferred) ?? fixes[0]!;
}

/**
 * The fix-all action: kind `source.fixAll.eslint` (the server's
 * inline-edit form). A plain `source` action that only carries the
 * `eslint.applyAllFixes` command is the fallback and is accepted
 * too; anything else is not a fix-all.
 */
export function pickFixAllAction(
  actions: readonly LspCodeAction[],
): LspCodeAction | null {
  return (
    actions.find((a) => a.kind === "source.fixAll.eslint") ??
    actions.find((a) => a.command?.command === "eslint.applyAllFixes") ??
    null
  );
}

function asCodeActionArray(result: unknown): LspCodeAction[] {
  if (!Array.isArray(result)) return [];
  return result.filter(
    (a): a is LspCodeAction =>
      typeof a === "object" && a !== null && typeof a.title === "string",
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Bus: palette commands and fix-on-save reach the mounted plugin
// ──────────────────────────────────────────────────────────────────────────

export type EslintCodeActionHandler = {
  fixAtCursor(): Promise<FixOutcome>;
  fixAll(): Promise<FixOutcome>;
};

const codeActionHandlers = new Map<
  string,
  Set<EslintCodeActionHandler>
>();

export function registerEslintCodeActionHandler(
  path: string,
  handler: EslintCodeActionHandler,
): () => void {
  const key = eslintPathKey(path);
  let set = codeActionHandlers.get(key);
  if (!set) {
    set = new Set();
    codeActionHandlers.set(key, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) codeActionHandlers.delete(key);
  };
}

function firstHandler(path: string): EslintCodeActionHandler | null {
  const set = codeActionHandlers.get(eslintPathKey(path));
  if (!set || set.size === 0) return null;
  return [...set][0]!;
}

export function toastFixOutcome(
  outcome: FixOutcome,
  opts?: { quiet?: boolean },
): void {
  const quiet = opts?.quiet ?? false;
  switch (outcome.kind) {
    case "applied":
      if (!quiet) {
        toast.success("Perbaikan diterapkan", {
          description:
            outcome.edits !== undefined
              ? `${outcome.title} (${outcome.edits} edit)`
              : outcome.title,
        });
      }
      break;
    case "no-diagnostic":
      if (!quiet) {
        toast.warning("Tidak ada pelanggaran ESLint di kursor", {
          description:
            "Pindahkan kursor ke garis merah/kuning, atau pakai fix-all untuk seluruh file.",
        });
      }
      break;
    case "no-action":
      if (!quiet) {
        toast.warning("Tidak ada perbaikan otomatis", {
          description:
            "Pelanggaran ini tidak punya quick fix (atau diagnostik sudah berubah). Perbaiki manual.",
        });
      }
      break;
    case "no-plugin":
      if (!quiet) {
        toast.warning("ESLint server belum aktif untuk file ini", {
          description:
            "Nyalakan language server ESLint, lalu coba lagi setelah diagnostik muncul.",
        });
      }
      break;
    case "stale":
      toast.warning("Dokumen berubah", {
        description:
          "Perbaikan dibatalkan karena file berubah sejak diminta. Coba lagi.",
      });
      break;
    case "failed":
      toast.error("Gagal meminta perbaikan", {
        description: outcome.message,
      });
      break;
  }
}

export async function requestEslintFixAtCursor(
  path: string,
  opts?: { quiet?: boolean },
): Promise<FixOutcome> {
  const handler = firstHandler(path);
  const outcome: FixOutcome = handler
    ? await handler.fixAtCursor().catch((e) => ({
        kind: "failed",
        message: String(e),
      }) as FixOutcome)
    : { kind: "no-plugin" };
  toastFixOutcome(outcome, opts);
  return outcome;
}

export async function requestEslintFixAll(
  path: string,
  opts?: { quiet?: boolean },
): Promise<FixOutcome> {
  const handler = firstHandler(path);
  const outcome: FixOutcome = handler
    ? await handler.fixAll().catch((e) => ({
        kind: "failed",
        message: String(e),
      }) as FixOutcome)
    : { kind: "no-plugin" };
  toastFixOutcome(outcome, opts);
  return outcome;
}

// ──────────────────────────────────────────────────────────────────────────
// Plugin: mounts in the editor, owns the client + the staleness guard
// ──────────────────────────────────────────────────────────────────────────

class EslintCodeActionPlugin {
  private view: EditorView;
  private client: TeraxLspClient;
  private documentUri: string;
  private path: string;
  private destroyed = false;
  /**
   * Staleness guard: the document snapshot the current fix was
   * computed against. The server versions a document only on
   * didOpen/didChange, so "same document object" is exactly "same
   * server version" - an edit made after the request makes the
   * guard mismatch and the fix is refused instead of applied to
   * shifted ranges. Armed before each request, consumed by the
   * applyEdit handler, cleared when the flow settles.
   */
  private guardDoc: Text | null = null;
  /** Outcome of the last server-initiated applyEdit for this flow. */
  private lastApply: ApplyEditOutcome | null = null;
  private unregisterApply: (() => void) | null = null;
  private unregisterBus: (() => void) | null = null;

  constructor(
    view: EditorView,
    opts: {
      client: TeraxLspClient;
      documentUri: string;
      path: string;
    },
  ) {
    this.view = view;
    this.client = opts.client;
    this.documentUri = opts.documentUri;
    this.path = opts.path;
    this.unregisterApply = registerApplyEditHandler(
      opts.documentUri,
      (edit) => this.handleApplyEdit(edit),
    );
    this.unregisterBus = registerEslintCodeActionHandler(opts.path, {
      fixAtCursor: () => this.fixAtCursor(),
      fixAll: () => this.fixAll(),
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.unregisterApply?.();
    this.unregisterBus?.();
    this.guardDoc = null;
  }

  async fixAtCursor(): Promise<FixOutcome> {
    if (this.destroyed) return { kind: "no-plugin" };
    const doc = this.view.state.doc;
    const sel = this.view.state.selection.main;
    const from = Math.min(sel.anchor, sel.head);
    const to = Math.max(sel.anchor, sel.head);
    const rawItems =
      useEslintStore.getState().rawByPath[eslintPathKey(this.path)] ?? [];
    const atCursor = findRawDiagnosticsInRange(rawItems, doc, from, to);
    if (atCursor.length === 0) return { kind: "no-diagnostic" };
    const start = offsetToLspPosition(doc, from);
    const end = offsetToLspPosition(doc, to);
    this.guardDoc = doc;
    try {
      await this.ensureReady();
      const result = await this.client.textDocumentCodeAction(
        {
          textDocument: { uri: this.documentUri },
          range: { start, end },
          context: {
            diagnostics: atCursor,
            only: ["quickfix"],
            triggerKind: 1,
          },
        },
        CODE_ACTION_TIMEOUT_MS,
      );
      const picked = pickQuickFixAction(asCodeActionArray(result));
      if (!picked) return { kind: "no-action" };
      return await this.executeAction(picked, doc);
    } catch (e) {
      return { kind: "failed", message: String(e) };
    } finally {
      this.guardDoc = null;
    }
  }

  async fixAll(): Promise<FixOutcome> {
    if (this.destroyed) return { kind: "no-plugin" };
    const doc = this.view.state.doc;
    const endLine = doc.line(doc.lines);
    this.guardDoc = doc;
    try {
      await this.ensureReady();
      const result = await this.client.textDocumentCodeAction(
        {
          textDocument: { uri: this.documentUri },
          range: {
            start: { line: 0, character: 0 },
            end: { line: doc.lines - 1, character: endLine.length },
          },
          context: {
            diagnostics: [],
            only: ["source.fixAll.eslint"],
            triggerKind: 1,
          },
        },
        CODE_ACTION_TIMEOUT_MS,
      );
      const picked = pickFixAllAction(asCodeActionArray(result));
      if (!picked) return { kind: "no-action" };
      return await this.executeAction(picked, doc);
    } catch (e) {
      return { kind: "failed", message: String(e) };
    } finally {
      this.guardDoc = null;
    }
  }

  /**
   * Runs one picked action. An inline edit applies directly; a
   * command goes through `workspace/executeCommand` and the server
   * answers with `workspace/applyEdit`, which the transport routes
   * back to `handleApplyEdit` below. The server awaits the applyEdit
   * response before answering executeCommand, so by the time the
   * await below resolves, `lastApply` already records the outcome,
   * no extra waiter is needed.
   */
  private async executeAction(
    action: LspCodeAction,
    doc: Text,
  ): Promise<FixOutcome> {
    if (action.edit) {
      const mapped = workspaceEditToChanges(
        this.view.state.doc,
        action.edit,
        this.documentUri,
      );
      if (!mapped.ok) return { kind: "failed", message: mapped.reason };
      if (this.view.state.doc !== doc) return { kind: "stale" };
      this.view.dispatch({ changes: mapped.changes });
      return {
        kind: "applied",
        title: action.title,
        edits: mapped.changes.length,
      };
    }
    if (action.command) {
      this.lastApply = null;
      try {
        await this.client.workspaceExecuteCommand(
          {
            command: action.command.command,
            arguments: action.command.arguments ?? [],
          },
          CODE_ACTION_TIMEOUT_MS,
        );
      } catch (e) {
        return { kind: "failed", message: String(e) };
      }
      if (this.lastApply?.applied) {
        return { kind: "applied", title: action.title };
      }
      return { kind: "no-action" };
    }
    return { kind: "no-action" };
  }

  private async handleApplyEdit(
    edit: LspWorkspaceEdit,
  ): Promise<ApplyEditOutcome> {
    if (this.destroyed) {
      return { applied: false, reason: "plugin destroyed" };
    }
    if (!this.guardDoc) {
      return { applied: false, reason: "no fix in progress" };
    }
    if (this.view.state.doc !== this.guardDoc) {
      return {
        applied: false,
        reason: "document changed since the fix was requested",
      };
    }
    const mapped = workspaceEditToChanges(
      this.view.state.doc,
      edit,
      this.documentUri,
    );
    if (!mapped.ok) return { applied: false, reason: mapped.reason };
    this.view.dispatch({ changes: mapped.changes });
    this.lastApply = { applied: true };
    this.guardDoc = null;
    return { applied: true };
  }

  private async ensureReady(): Promise<void> {
    if (this.client.initializePromise) {
      await this.client.initializePromise;
    }
    if (!this.client.ready) {
      throw new Error("ESLint language server is not ready");
    }
  }
}

export function eslintCodeActionExtension(opts: {
  client: TeraxLspClient;
  documentUri: string;
  path: string;
}): import("@codemirror/state").Extension {
  const plugin = ViewPlugin.define(
    (view) => new EslintCodeActionPlugin(view, opts),
  );
  return [
    plugin,
    keymap.of([
      {
        key: "Mod-.",
        preventDefault: true,
        run: (view) => {
          const inst = view.plugin(plugin);
          if (!inst) return false;
          void inst
            .fixAtCursor()
            .then((outcome) => toastFixOutcome(outcome));
          return true;
        },
      },
    ]),
  ];
}
