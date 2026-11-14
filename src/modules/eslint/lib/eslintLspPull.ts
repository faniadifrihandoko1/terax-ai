import {
  forEachDiagnostic,
  setDiagnostics,
  setDiagnosticsEffect,
  type Diagnostic,
} from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { TeraxLspClient } from "@/modules/lsp/lib/client";
import { ESLINT_SOURCE, type DocLike } from "./eslintJson";
import {
  countDiagnostics,
  diagnosticsEqual,
  mergeDiagnostics,
  needsEslintReapply,
} from "./eslintMerge";
import { eslintPathKey } from "./eslintPaths";
import { onEslintRunRequested } from "./eslintRequests";
import { useEslintStore, type EslintRawDiagnostic } from "./eslintStore";

/** Delay before the first pull, so the document-sync plugin's
 * `didOpen` for the document has reached the server first. */
const INITIAL_DELAY_MS = 100;
/** Debounce between a buffer edit and the next pull. */
const CHANGE_DELAY_MS = 400;
/** One retry when the first pull fails (usually the pull racing the
 * server's `didOpen` handling); later failures only warn. */
const FIRST_PULL_RETRY_MS = 250;
/** Same budget as the other LSP requests in the client. */
const PULL_TIMEOUT_MS = 10_000;

/** Raw pull items are the store's exact server diagnostics. */
type LspDiagnosticItem = EslintRawDiagnostic;

type DiagnosticPullResult =
  | { kind: "full"; items: LspDiagnosticItem[]; resultId?: string }
  | { kind: "unchanged"; resultId: string };

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function codeToString(code: LspDiagnosticItem["code"]): string | null {
  if (typeof code === "string") return code;
  if (typeof code === "number") return String(code);
  if (code && typeof code.value === "string") return code.value;
  if (code && typeof code.value === "number") return String(code.value);
  return null;
}

/**
 * Maps the server's pull diagnostics to CodeMirror diagnostics, with
 * the same range clamping and message shape as the CLI mapper
 * (`eslintMessagesToDiagnostics`): `message (ruleId)`, source
 * `"eslint"`, severity 1 error / 2 warning / anything else info.
 */
export function mapLspDiagnosticsToCodeMirror(
  doc: DocLike,
  items: readonly LspDiagnosticItem[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const item of items) {
    const startLineNo = clamp(Math.trunc(item.range.start.line) + 1, 1, doc.lines);
    const startLine = doc.line(startLineNo);
    const startLen = startLine.to - startLine.from;
    const startCol = clamp(Math.trunc(item.range.start.character), 0, startLen);
    let from = startLine.from + startCol;
    let to = from;
    const endLineNo = clamp(Math.trunc(item.range.end.line) + 1, 1, doc.lines);
    const endLine = doc.line(endLineNo);
    const endLen = endLine.to - endLine.from;
    const endCol = clamp(Math.trunc(item.range.end.character), 0, endLen);
    to = Math.max(from, endLine.from + endCol);
    if (to === from) to = Math.min(from + 1, startLine.to);
    if (to === from && startLen > 0) {
      // Pointing at end of line: underline the last character instead.
      from = Math.max(startLine.from, from - 1);
    }
    if (to === from) continue;
    const ruleId = codeToString(item.code);
    out.push({
      from,
      to,
      severity:
        item.severity === 1
          ? "error"
          : item.severity === 2
            ? "warning"
            : "info",
      message: ruleId ? `${item.message} (${ruleId})` : item.message,
      source: ESLINT_SOURCE,
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * Pulls diagnostics from the ESLint language server for an open
 * document and publishes them merged with the other LSP server's
 * diagnostics (TypeScript), using the same merge layer as the CLI
 * plugin.
 *
 * Why a pull plugin at all: the ESLint server never pushes
 * `publishDiagnostics`; diagnostics only arrive on a
 * `textDocument/diagnostic` request, which the generic LSP plugin
 * never sends. The server lints the buffer the editor sent it via
 * `didOpen`/`didChange` — from the library plugin for the first
 * preset, from Terax's manual sync plugin (`lspDocumentSync`) for
 * later presets (Fase 17) — so unlike the CLI plugin this works on
 * dirty buffers and never depends on the file being saved. Before
 * Fase 17, in multi-preset mode the server never received `didOpen`
 * at all, so the pull returned empty: the server's pull handler
 * returns an empty report for unknown documents (verified from
 * microsoft/vscode-eslint source), it does NOT read the file from
 * disk — the earlier "reads from disk" theory was wrong.
 *
 * Merge rule (same as the CLI-vs-LSP case, `eslintMerge.ts`): the
 * store's `byPath` is the single source of truth for ESLint
 * diagnostics. A publish replaces the whole lint set, so every
 * publisher must publish the union: current non-ESLint diagnostics
 * plus the stored ESLint ones. A foreign publish (the TypeScript
 * plugin wiping the ESLint entries) is detected by watching
 * `setDiagnosticsEffect` and repaired in a microtask; `diagnosticsEqual`
 * stops the reapply from ping-ponging. Diagnostics from both sources
 * at the same range are both kept: different messages, different
 * sources; CodeMirror shows the most severe in the gutter and all of
 * them in the tooltip.
 */
class EslintLspPullPlugin {
  private view: EditorView;
  private path: string;
  private documentUri: string;
  private client: TeraxLspClient;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reapplyScheduled = false;
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;
  private lastResultId: string | undefined;
  private retriedFirstPull = false;

  constructor(
    view: EditorView,
    path: string,
    documentUri: string,
    client: TeraxLspClient,
  ) {
    this.view = view;
    this.path = path;
    this.documentUri = documentUri;
    this.client = client;
    // This plugin is the CLI plugin's off switch for the file, and
    // the manual-run command's trigger: a manual run reaches this
    // plugin through the same request bus, so it pulls instead of
    // running the CLI while the server is live.
    useEslintStore.getState().setLspActive(path, true);
    this.unsubscribe = onEslintRunRequested(path, () => this.schedule(0));
    this.schedule(INITIAL_DELAY_MS);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.schedule(CHANGE_DELAY_MS);
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (!effect.is(setDiagnosticsEffect)) continue;
        if (this.checkReapplyNeeded(effect.value)) this.scheduleReapply();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.unsubscribe?.();
    useEslintStore.getState().setLspActive(this.path, false);
    useEslintStore.getState().clearPath(this.path);
    useEslintStore.getState().clearRunStatus(this.path);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pull();
    }, delayMs);
  }

  private checkReapplyNeeded(
    effectDiagnostics: readonly Diagnostic[],
  ): boolean {
    const stored =
      useEslintStore.getState().byPath[eslintPathKey(this.path)] ?? [];
    if (stored.length === 0) return false;
    return needsEslintReapply(effectDiagnostics, stored);
  }

  private scheduleReapply(): void {
    if (this.reapplyScheduled) return;
    this.reapplyScheduled = true;
    queueMicrotask(() => {
      this.reapplyScheduled = false;
      if (this.destroyed) return;
      this.applyStored();
    });
  }

  /** Publishes the stored ESLint diagnostics merged with the rest. */
  private applyStored(): void {
    const stored =
      useEslintStore.getState().byPath[eslintPathKey(this.path)] ?? [];
    const current: Diagnostic[] = [];
    forEachDiagnostic(this.view.state, (d) => {
      current.push(d);
    });
    const merged = mergeDiagnostics(current, stored);
    if (!diagnosticsEqual(current, merged)) {
      this.view.dispatch(setDiagnostics(this.view.state, merged));
    }
  }

  private async pull(): Promise<void> {
    const generation = ++this.generation;
    const docAtStart = this.view.state.doc;
    let result: unknown;
    try {
      result = await this.client.textDocumentDiagnostic(
        {
          textDocument: { uri: this.documentUri },
          ...(this.lastResultId
            ? { previousResultId: this.lastResultId }
            : {}),
        },
        PULL_TIMEOUT_MS,
      );
    } catch (e) {
      if (this.destroyed || generation !== this.generation) return;
      // The first pull can race the server's didOpen handling; one
      // retry a moment later is cheaper than leaving the file
      // unlinted until the next edit.
      if (!this.retriedFirstPull) {
        this.retriedFirstPull = true;
        this.schedule(FIRST_PULL_RETRY_MS);
        return;
      }
      console.warn("[eslint-lsp] diagnostic pull failed", e);
      return;
    }
    if (
      this.destroyed ||
      generation !== this.generation ||
      this.view.state.doc !== docAtStart
    ) {
      return;
    }
    const parsed = result as DiagnosticPullResult | null;
    if (!parsed || typeof parsed !== "object") return;
    if (parsed.kind === "unchanged") {
      this.lastResultId = parsed.resultId;
      return;
    }
    if (parsed.kind !== "full" || !Array.isArray(parsed.items)) return;
    this.lastResultId = parsed.resultId;
    const diags = mapLspDiagnosticsToCodeMirror(docAtStart, parsed.items);
    const { errors, warnings } = countDiagnostics(diags);
    const store = useEslintStore.getState();
    store.setPathDiagnostics(this.path, diags);
    // Fase 18: keep the exact server items too - code actions match
    // context diagnostics by range + code + message hash, which the
    // combined `message (ruleId)` CodeMirror text would not match.
    store.setPathRawDiagnostics(this.path, parsed.items);
    store.setRunStatus(this.path, { kind: "ok", errors, warnings });
    this.applyStored();
  }
}

export function eslintLspPullExtension(opts: {
  client: TeraxLspClient;
  documentUri: string;
  path: string;
}): Extension {
  return ViewPlugin.define(
    (view) =>
      new EslintLspPullPlugin(view, opts.path, opts.documentUri, opts.client),
  );
}
