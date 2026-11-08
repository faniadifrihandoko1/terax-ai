import { usePreferencesStore } from "@/modules/settings/preferences";
import { toast } from "sonner";
import { eslintPathKey } from "./eslintPaths";
import {
  getEslintEditorPresence,
  hasEslintRunListener,
  requestEslintRun,
} from "./eslintRequests";
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
    // No listener means no plugin is attached for this path yet.
    // The old message blamed the user for not opening the file, but
    // the file can be open while the plugin is still missing: the
    // document may still be loading, the plugin may still be
    // attaching, the file may be unreadable, or the active tab may
    // be a review/diff tab that never mounts an editor. Name the
    // real cause instead of guessing.
    const presence = getEslintEditorPresence(path);
    if (presence === "loading") {
      toast.warning("Editor masih memuat file", {
        description:
          "File masih dibaca dari disk, jadi plugin ESLint belum terpasang. Tunggu sebentar lalu coba lagi.",
      });
      return;
    }
    if (presence === "ready") {
      toast.warning("Editor ESLint belum siap", {
        description:
          "Plugin ESLint untuk file ini masih dipasang. Tunggu sebentar lalu coba lagi.",
      });
      return;
    }
    if (presence === "unavailable") {
      toast.warning("File tidak bisa dibuka di editor", {
        description:
          "File ini tidak bisa dibaca sebagai teks (gagal dibaca, biner, atau terlalu besar), jadi ESLint tidak bisa dijalankan. Tutup dan buka lagi tabnya.",
      });
      return;
    }
    toast.warning("Tidak ada editor ESLint untuk file ini", {
      description:
        "Buka file di tab editor — tab review (ai-diff) dan tab diff tidak menjalankan ESLint — lalu coba lagi.",
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
