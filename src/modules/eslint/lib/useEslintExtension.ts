import {
  forEachDiagnostic,
  setDiagnostics,
  setDiagnosticsEffect,
  type Diagnostic,
} from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { diskTextMatchesBuffer } from "@/modules/editor/lib/eol";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  eslintMessagesToDiagnostics,
  findResultForFile,
} from "./eslintJson";
import {
  diagnosticsEqual,
  mergeDiagnostics,
  needsEslintReapply,
} from "./eslintMerge";
import { dirnameOf, isLintablePath } from "./eslintPaths";
import { onEslintRunRequested } from "./eslintRequests";
import {
  readDiskText,
  resolveEslintBinary,
  runEslintFile,
} from "./eslintRunner";
import { useEslintStore } from "./eslintStore";

const INITIAL_DELAY_MS = 350;
const CHANGE_DELAY_MS = 600;

/**
 * Runs the project's ESLint on the file and publishes its diagnostics
 * into the shared CodeMirror lint state, merged with whatever else is
 * already there (LSP diagnostics). The LSP plugin publishes with
 * setDiagnostics, which replaces the whole set, so a merge guard
 * re-applies the stored ESLint diagnostics whenever another publisher
 * wipes them. ESLint lints the file on disk, never the buffer: a run
 * is skipped while the buffer is dirty, so the diagnostics shown
 * always match the saved file. "Dirty" is judged after LF
 * normalization (diskTextMatchesBuffer): buffers live in LF space,
 * so a saved CRLF file matches its buffer — comparing raw bytes
 * would skip every CRLF file forever. Diagnostics refresh on open,
 * on save, and when an external write reloads the buffer.
 */
class EslintPlugin {
  private view: EditorView;
  private path: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reapplyScheduled = false;
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;

  constructor(view: EditorView, path: string) {
    this.view = view;
    this.path = path;
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
    useEslintStore.getState().clearPath(this.path);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private checkReapplyNeeded(
    effectDiagnostics: readonly Diagnostic[],
  ): boolean {
    const stored = useEslintStore.getState().byPath[this.path] ?? [];
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
    const stored = useEslintStore.getState().byPath[this.path] ?? [];
    const current: Diagnostic[] = [];
    forEachDiagnostic(this.view.state, (d) => {
      current.push(d);
    });
    const merged = mergeDiagnostics(current, stored);
    if (!diagnosticsEqual(current, merged)) {
      this.view.dispatch(setDiagnostics(this.view.state, merged));
    }
  }

  private notifyMissing(
    root: string,
    kind: "missing-binary" | "missing-config",
  ): void {
    const store = useEslintStore.getState();
    if (store.notifiedRoots[root]) return;
    store.markRootNotified(root);
    if (kind === "missing-binary") {
      toast.warning("ESLint tidak ditemukan di project ini", {
        description:
          "Install eslint di project ini, atau matikan diagnostik ESLint di Settings → General.",
      });
    } else {
      toast.warning("ESLint tidak punya config di project ini", {
        description:
          "Tambahkan eslint.config.js (atau .eslintrc) di project, atau matikan diagnostik ESLint di Settings → General.",
      });
    }
  }

  private async run(): Promise<void> {
    const generation = ++this.generation;
    const store = useEslintStore.getState();
    if (!usePreferencesStore.getState().eslintEnabled) return;
    if (!isLintablePath(this.path)) return;
    const view = this.view;
    const docAtStart = view.state.doc;
    const disk = await readDiskText(this.path);
    if (
      this.destroyed ||
      generation !== this.generation ||
      view.state.doc !== docAtStart
    ) {
      return;
    }
    if (disk === null) return;
    if (!diskTextMatchesBuffer(disk, docAtStart.toString())) return;
    const binary = await resolveEslintBinary(this.path);
    if (
      this.destroyed ||
      generation !== this.generation ||
      view.state.doc !== docAtStart
    ) {
      return;
    }
    if (!binary) {
      const root = dirnameOf(this.path);
      store.setRootStatus(root, { kind: "missing-binary", root });
      this.notifyMissing(root, "missing-binary");
      store.clearPath(this.path);
      this.applyStored();
      return;
    }
    store.setRootStatus(binary.root, {
      kind: "found",
      root: binary.root,
      binary: binary.kind === "path" ? binary.binary : "npx",
    });
    const result = await runEslintFile({ binary, file: this.path });
    if (
      this.destroyed ||
      generation !== this.generation ||
      view.state.doc !== docAtStart
    ) {
      return;
    }
    if (result.kind === "timeout" || result.kind === "failed") {
      store.setRootStatus(binary.root, {
        kind: "error",
        root: binary.root,
        message:
          result.kind === "timeout" ? "ESLint timed out" : result.message,
      });
      return;
    }
    if (result.kind === "missing-config") {
      store.setRootStatus(binary.root, {
        kind: "missing-config",
        root: binary.root,
      });
      this.notifyMissing(binary.root, "missing-config");
      store.clearPath(this.path);
      this.applyStored();
      return;
    }
    const fileResult = findResultForFile(result.results, this.path);
    const diags = eslintMessagesToDiagnostics(
      docAtStart,
      fileResult?.messages ?? [],
    );
    store.setPathDiagnostics(this.path, diags);
    this.applyStored();
  }
}

export function eslintPluginExtension(path: string): Extension {
  return ViewPlugin.define((view) => new EslintPlugin(view, path));
}

/**
 * Mirrors useLspExtension: returns the ESLint diagnostics extension for
 * an open editor, or null when ESLint is off, the file is not lintable,
 * or the document is not ready yet.
 */
export function useEslintExtension(
  path: string,
  ready: boolean,
): Extension | null {
  const enabled = usePreferencesStore((s) => s.eslintEnabled);
  const [ext, setExt] = useState<Extension | null>(null);

  useEffect(() => {
    if (!ready || !enabled || !isLintablePath(path)) {
      setExt(null);
      return;
    }
    setExt(eslintPluginExtension(path));
    return () => setExt(null);
  }, [path, ready, enabled]);

  return ext;
}
