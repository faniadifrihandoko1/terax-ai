import { usePreferencesStore } from "@/modules/settings/preferences";
import { toast } from "sonner";
import { eslintPathKey } from "./eslintPaths";
import { hasEslintRunListener, requestEslintRun } from "./eslintRequests";
import { useEslintStore, type EslintRunStatus } from "./eslintStore";
import {
  describeEslintRunStatus,
  isTerminalEslintRunStatus,
} from "./eslintStatusText";

/** Time a manual run may take before the waiter gives up (a run times out at 30 s). */
export const MANUAL_RUN_TIMEOUT_MS = 35_000;

/**
 * Asks the open editor for `path` to run ESLint now (bypassing the
 * debounce) and reports the outcome with a toast: the error/warning
 * counts on success, the exact reason on failure. The run itself
 * still goes through `EslintPlugin.run()`, so the dirty-check, the
 * LSP merge and the status recording all apply unchanged.
 */
export function requestEslintRunWithReport(path: string): void {
  if (!usePreferencesStore.getState().eslintEnabled) {
    toast.warning("ESLint diagnostics mati", {
      description:
        'Nyalakan di Settings → General → "ESLint diagnostics" untuk menjalankan ESLint.',
    });
    return;
  }
  if (!hasEslintRunListener(path)) {
    toast.warning("Tidak ada editor ESLint untuk file ini", {
      description:
        "Buka file JavaScript/TypeScript di editor, lalu coba lagi.",
    });
    return;
  }
  // Store keys are normalized (forward slashes, lowercased on
  // Windows); look the run status up by the same key the plugin
  // writes, or the waiter never sees the terminal status.
  const key = eslintPathKey(path);
  const before = useEslintStore.getState().runStatus[key];
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = (status: EslintRunStatus | null) => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
    if (status === null) {
      toast.warning("ESLint belum selesai", {
        description:
          "Run ESLint melebihi 35 detik tanpa hasil. Coba lagi, atau periksa status ESLint di status bar.",
      });
      return;
    }
    const { label, detail } = describeEslintRunStatus(status);
    // The toast kind reflects the run, not the diagnostics: a run
    // that found errors still succeeded, so it reports as success.
    if (status.kind === "ok") {
      toast.success(label, { description: detail });
    } else {
      toast.warning(label, { description: detail });
    }
  };
  const unsubscribe = useEslintStore.subscribe((state) => {
    const next = state.runStatus[key];
    if (next && next !== before && isTerminalEslintRunStatus(next)) {
      finish(next);
    }
  });
  timer = setTimeout(() => finish(null), MANUAL_RUN_TIMEOUT_MS);
  requestEslintRun(path);
}
