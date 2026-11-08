import { useDiagnosticsStore } from "@/modules/editor/lib/diagnosticsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { toast } from "sonner";
import { canonicalPath, eslintPathKey, joinPosix } from "./eslintPaths";
import {
  groupProjectLintResults,
  summarizeProjectLintFiles,
  type EslintProjectLintFile,
} from "./eslintProjectLint";
import { getEslintEditorPresence } from "./eslintRequests";
import {
  PROJECT_LINT_TIMEOUT_SECS,
  resolveEslintBinary,
  runEslintProject,
  type RunCommand,
} from "./eslintRunner";
import type { StatFn } from "./eslintDetect";
import { useEslintStore } from "./eslintStore";
import { describeEslintRunStatus } from "./eslintStatusText";

/**
 * Runs ESLint over the whole project from its root and records the
 * snapshot in the store for the Problems panel. One run at a time:
 * a second invocation while a run is active toasts instead of
 * starting a parallel lint. The run itself is async and never
 * blocks the editor; the panel shows the "running" state meanwhile.
 * A stale completion (a newer run started since) is dropped.
 */
export async function requestEslintProjectLint(
  root: string | null,
  deps: { stat?: StatFn; runCommand?: RunCommand; windows?: boolean } = {},
): Promise<void> {
  const store = useEslintStore.getState();
  if (!usePreferencesStore.getState().eslintEnabled) {
    toast.warning("ESLint diagnostics mati", {
      description:
        'Nyalakan di Settings → General → "ESLint diagnostics" untuk menjalankan ESLint.',
    });
    return;
  }
  if (!root) {
    toast.warning("Tidak ada project terbuka", {
      description:
        "Buka sebuah project dulu, lalu jalankan lint seluruh project.",
    });
    return;
  }
  const current = store.projectLint.status;
  if (current.kind === "running") {
    toast.warning("Lint project masih berjalan", {
      description: "Tunggu run yang sedang berjalan selesai dulu.",
    });
    return;
  }
  const startedAt = Date.now();
  store.setProjectLintStatus({ kind: "running", root, startedAt });
  const isCurrentRun = (): boolean => {
    const status = useEslintStore.getState().projectLint.status;
    return (
      status.kind === "running" &&
      status.root === root &&
      status.startedAt === startedAt
    );
  };

  // Resolve from a path inside the root so the walk starts at the
  // root itself, exactly like the per-file runs that walk up from
  // the file. A binary found in an ancestor lints that ancestor.
  const resolution = await resolveEslintBinary(
    joinPosix(root, "package.json"),
    deps,
  );
  if (!isCurrentRun()) return;
  if (!resolution.binary) {
    const detection = resolution.detection;
    const diagnosis =
      detection.status === "missing"
        ? {
            searchedLevels: detection.searchedLevels,
            truncatedByCap: detection.truncatedByCap,
            controlStatFailed: detection.controlStatFailed,
          }
        : { searchedLevels: 0, truncatedByCap: false, controlStatFailed: false };
    store.setProjectLintStatus({
      kind: "missing-binary",
      root,
      ...diagnosis,
      at: Date.now(),
    });
    const { label, detail } = describeEslintRunStatus({
      kind: "missing-binary",
      root,
      ...diagnosis,
    });
    toast.warning(label, { description: detail });
    return;
  }

  const result = await runEslintProject({
    binary: resolution.binary,
    runCommand: deps.runCommand,
  });
  if (!isCurrentRun()) return;
  const at = Date.now();
  switch (result.kind) {
    case "ok": {
      const prevFiles = useEslintStore.getState().projectLint.files;
      const files = groupProjectLintResults(result.results);
      const totals = summarizeProjectLintFiles(files);
      store.setProjectLintResults(
        { kind: "ok", root, ...totals, at },
        files,
      );
      applyProjectLintCounts(prevFiles, files);
      if (totals.errors === 0 && totals.warnings === 0) {
        toast.success("ESLint project bersih", {
          description: "Tidak ada masalah ESLint di project ini.",
        });
      } else {
        toast.success("Lint project selesai", {
          description: `${totals.errors} error · ${totals.warnings} warning di ${totals.files} file`,
        });
      }
      return;
    }
    case "missing-config": {
      store.setProjectLintStatus({ kind: "missing-config", root, at });
      toast.warning("ESLint tidak punya config di project ini", {
        description:
          "Tambahkan eslint.config.js (atau .eslintrc) di project, atau matikan diagnostik ESLint di Settings → General.",
      });
      return;
    }
    case "timeout": {
      store.setProjectLintStatus({ kind: "timeout", root, at });
      toast.warning("Lint project kehabisan waktu", {
        description: `ESLint tidak selesai dalam ${PROJECT_LINT_TIMEOUT_SECS} detik. Coba lint per folder atau per file.`,
      });
      return;
    }
    case "truncated": {
      store.setProjectLintStatus({ kind: "truncated", root, at });
      toast.warning("Hasil lint project tidak lengkap", {
        description:
          "Output ESLint melebihi batas 256 KiB sehingga laporannya terpotong dan tidak bisa dibaca. Lint per folder atau per file untuk hasil lengkap.",
      });
      return;
    }
    case "failed": {
      store.setProjectLintStatus({
        kind: "failed",
        root,
        message: result.message,
        at,
      });
      toast.warning("Lint project gagal", { description: result.message });
      return;
    }
  }
}

/**
 * Fills the explorer counts from a project-wide run. Files open in
 * an editor keep their per-file counts: the per-file lint owns them
 * and reports fresher numbers. Files that were in the previous run
 * but are clean now lose their counts the same way, so a fixed file
 * stops showing a badge.
 */
function applyProjectLintCounts(
  prevFiles: readonly EslintProjectLintFile[],
  nextFiles: readonly EslintProjectLintFile[],
): void {
  const diag = useDiagnosticsStore.getState();
  const nextKeys = new Set(nextFiles.map((f) => eslintPathKey(f.path)));
  for (const prev of prevFiles) {
    if (nextKeys.has(eslintPathKey(prev.path))) continue;
    if (editorOwnsCounts(prev.path)) continue;
    diag.report(canonicalPath(prev.path), null);
  }
  for (const file of nextFiles) {
    if (editorOwnsCounts(file.path)) continue;
    diag.report(canonicalPath(file.path), {
      errors: file.errors,
      warnings: file.warnings,
    });
  }
}

/** True when an editor pane is open (or opening) for the path. */
function editorOwnsCounts(path: string): boolean {
  const presence = getEslintEditorPresence(path);
  return presence === "loading" || presence === "ready";
}
