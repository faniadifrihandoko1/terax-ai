import {
  forEachDiagnostic,
  setDiagnostics,
  setDiagnosticsEffect,
  type Diagnostic,
} from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { diskTextMatchesBuffer } from "@/modules/editor/lib/eol";
import type { DocumentState } from "@/modules/editor/lib/useDocument";
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
import { dirnameOf, eslintPathKey, isLintablePath } from "./eslintPaths";
import {
  onEslintRunRequested,
  setEslintEditorPresence,
} from "./eslintRequests";
import {
  readDiskText,
  resolveEslintBinary,
  runEslintFile,
} from "./eslintRunner";
import { describeEslintRunStatus } from "./eslintStatusText";
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
    useEslintStore.getState().clearRunStatus(this.path);
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
    store.setRunStatus(this.path, { kind: "running" });
    const aborted = (): boolean => {
      if (
        this.destroyed ||
        generation !== this.generation ||
        view.state.doc !== docAtStart
      ) {
        // Status only, never a toast: a doc change mid-run is normal
        // (save/format round-trip) and the next trigger retries.
        store.setRunStatus(this.path, { kind: "aborted-doc-changed" });
        return true;
      }
      return false;
    };
    const disk = await readDiskText(this.path);
    if (aborted()) return;
    if (disk === null) {
      const root = dirnameOf(this.path);
      store.setRunStatus(this.path, { kind: "disk-read-failed" });
      notifyEslintDiskReadFailed(root, this.path);
      return;
    }
    if (!diskTextMatchesBuffer(disk, docAtStart.toString())) {
      // Status only, never a toast: a dirty buffer is the normal
      // state while typing, and a run is retried after every save.
      store.setRunStatus(this.path, { kind: "skipped-dirty" });
      return;
    }
    const resolution = await resolveEslintBinary(this.path);
    if (aborted()) return;
    const binary = resolution.binary;
    if (!binary) {
      const root = dirnameOf(this.path);
      const detection = resolution.detection;
      store.setRootStatus(root, { kind: "missing-binary", root });
      // A null binary always comes with a "missing" detection; the
      // fallbacks only satisfy the type checker.
      store.setRunStatus(this.path, {
        kind: "missing-binary",
        root,
        searchedLevels:
          detection.status === "missing" ? detection.searchedLevels : 0,
        truncatedByCap:
          detection.status === "missing" ? detection.truncatedByCap : false,
        controlStatFailed:
          detection.status === "missing"
            ? detection.controlStatFailed
            : false,
      });
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
    if (aborted()) return;
    if (result.kind === "timeout" || result.kind === "failed") {
      const message =
        result.kind === "timeout" ? "ESLint timed out" : result.message;
      store.setRootStatus(binary.root, {
        kind: "error",
        root: binary.root,
        message,
      });
      store.setRunStatus(
        this.path,
        result.kind === "timeout"
          ? { kind: "timeout", root: binary.root }
          : { kind: "failed", root: binary.root, message },
      );
      notifyEslintRunFailed(binary.root, message);
      return;
    }
    if (result.kind === "missing-config") {
      store.setRootStatus(binary.root, {
        kind: "missing-config",
        root: binary.root,
      });
      store.setRunStatus(this.path, {
        kind: "missing-config",
        root: binary.root,
      });
      this.notifyMissing(binary.root, "missing-config");
      store.clearPath(this.path);
      this.applyStored();
      return;
    }
    const fileResult = findResultForFile(result.results, this.path);
    if (!fileResult) {
      const returnedPaths = result.results.map((r) => r.filePath);
      const status = {
        kind: "no-result-match" as const,
        filePath: this.path,
        returnedPaths,
      };
      store.setRunStatus(this.path, status);
      notifyEslintNoResultMatch(binary.root, status);
      store.clearPath(this.path);
      this.applyStored();
      return;
    }
    const diags = eslintMessagesToDiagnostics(docAtStart, fileResult.messages);
    const errors = diags.filter((d) => d.severity === "error").length;
    const warnings = diags.filter((d) => d.severity === "warning").length;
    store.setPathDiagnostics(this.path, diags);
    store.setRunStatus(this.path, { kind: "ok", errors, warnings });
    this.applyStored();
  }
}

export function eslintPluginExtension(path: string): Extension {
  return ViewPlugin.define((view) => new EslintPlugin(view, path));
}

/**
 * Shared once-per-root guard for the ESLint-problem toasts below, so a
 * broken project does not spam a toast on every debounced trigger.
 * Returns false when this root was already notified this session.
 */
function notifyOnce(root: string): boolean {
  const store = useEslintStore.getState();
  if (store.notifiedRoots[root]) return false;
  store.markRootNotified(root);
  return true;
}

/**
 * Warns once per root per session that ESLint runs are failing for
 * that project (timeout, spawn failure, bad output).
 * Previously a failed run only set rootStatus to "error" and the user
 * saw nothing at all.
 */
export function notifyEslintRunFailed(root: string, message: string): void {
  if (!notifyOnce(root)) return;
  toast.warning("ESLint gagal dijalankan", {
    description:
      message ||
      "Periksa instalasi ESLint di project ini, atau matikan diagnostik ESLint di Settings → General.",
  });
}

/**
 * Warns once per root per session that the file could not be read from
 * disk. Previously the run returned silently and no diagnostic ever
 * appeared, with no clue why.
 */
export function notifyEslintDiskReadFailed(
  root: string,
  path: string,
): void {
  if (!notifyOnce(root)) return;
  toast.warning("ESLint gagal membaca file", {
    description: `Terax tidak bisa membaca ${path} dari disk. Periksa path project dan izin akses file.`,
  });
}

/**
 * Warns once per root per session that ESLint ran but returned results
 * for a different path than the open file. Previously the run stored
 * zero diagnostics and the user saw nothing.
 */
export function notifyEslintNoResultMatch(
  root: string,
  status: { filePath: string; returnedPaths: string[] },
): void {
  if (!notifyOnce(root)) return;
  const { label, detail } = describeEslintRunStatus({
    kind: "no-result-match",
    filePath: status.filePath,
    returnedPaths: status.returnedPaths,
  });
  toast.warning(label, { description: detail });
}

/**
 * Mirrors useLspExtension: returns the ESLint diagnostics extension for
 * an open editor, or null when ESLint is off, the file is not lintable,
 * or the document is not ready yet. The document status (not just a
 * boolean) is needed so the hook can record the editor's presence:
 * the plugin — and therefore the run listener — only exists once the
 * document is ready, and the manual-run command must be able to tell
 * "editor open but still loading" apart from "no editor at all".
 */
export function useEslintExtension(
  path: string,
  docStatus: DocumentState["status"],
): Extension | null {
  const enabled = usePreferencesStore((s) => s.eslintEnabled);
  const [ext, setExt] = useState<Extension | null>(null);

  // Fase 10.2: record that an editor pane is open for this path and
  // whether its document has loaded, so a manual run that finds no
  // listener can report the real cause. Registered only for lintable
  // paths — the command is disabled for anything else anyway.
  // Cleanup on unmount or path change removes the marker.
  useEffect(() => {
    if (!isLintablePath(path)) return;
    setEslintEditorPresence(
      path,
      docStatus === "ready"
        ? "ready"
        : docStatus === "loading"
          ? "loading"
          : "unavailable",
    );
    return () => setEslintEditorPresence(path, null);
  }, [path, docStatus]);

  useEffect(() => {
    const ready = docStatus === "ready";
    if (!ready || !enabled || !isLintablePath(path)) {
      setExt(null);
      return;
    }
    setExt(eslintPluginExtension(path));
    return () => setExt(null);
  }, [path, docStatus, enabled]);

  return ext;
}
