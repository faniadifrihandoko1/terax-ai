import type { EslintRunStatus } from "./eslintStore";
import type { EslintProjectLintStatus } from "./eslintProjectLint";

export type EslintStatusTone = "ok" | "warn" | "error" | "muted";

export type EslintStatusText = {
  /** Short label for the status bar pill. */
  label: string;
  /** Longer explanation for the tooltip / toast. */
  detail: string;
  tone: EslintStatusTone;
};

const MAX_PATH_CHARS = 100;

function shortPath(path: string): string {
  if (path.length <= MAX_PATH_CHARS) return path;
  return `…${path.slice(path.length - MAX_PATH_CHARS + 1)}`;
}

/**
 * Human-readable rendering of a run status, shared by the status bar
 * pill and the manual-run toast so both describe an outcome the same
 * way. Labels stay short; the detail names the cause and the next
 * step when one exists.
 */
export function describeEslintRunStatus(
  status: EslintRunStatus,
): EslintStatusText {
  switch (status.kind) {
    case "running":
      return {
        label: "ESLint: berjalan…",
        detail: "ESLint sedang memeriksa file ini.",
        tone: "muted",
      };
    case "ok": {
      if (status.errors === 0 && status.warnings === 0) {
        return {
          label: "ESLint: bersih",
          detail: "ESLint tidak menemukan error atau warning di file ini.",
          tone: "ok",
        };
      }
      const parts: string[] = [];
      if (status.errors > 0) parts.push(`${status.errors} error`);
      if (status.warnings > 0) parts.push(`${status.warnings} warning`);
      return {
        label: `ESLint: ${parts.join(" · ")}`,
        detail: `ESLint menemukan ${parts.join(" dan ")} di file ini.`,
        tone: status.errors > 0 ? "error" : "warn",
      };
    }
    case "missing-binary": {
      const base =
        status.controlStatFailed
          ? `Terax bahkan tidak bisa membaca folder file itu sendiri (fs_stat gagal) — periksa path project, terutama karakter non-ASCII atau folder yang disinkronkan seperti OneDrive.`
          : status.truncatedByCap
            ? `Pencarian naik ${status.searchedLevels} level ancestor dan mencapai batas — file ini mungkin terlalu dalam dari project root untuk ditemukan binary-nya.`
            : `Tidak ada node_modules/.bin/eslint di ${status.searchedLevels} level ancestor yang diperiksa dari ${shortPath(status.root)}.`;
      return {
        label: "ESLint: binary tidak ditemukan",
        detail: `${base} Install eslint di project ini, atau matikan diagnostik ESLint di Settings → General.`,
        tone: "warn",
      };
    }
    case "missing-config":
      return {
        label: "ESLint: tidak ada config",
        detail:
          "ESLint ditemukan, tapi project ini tidak punya config yang bisa dipakai. Tambahkan eslint.config.js (atau .eslintrc), atau matikan diagnostik ESLint di Settings → General.",
        tone: "warn",
      };
    case "failed":
      return {
        label: "ESLint: gagal dijalankan",
        detail: status.message || "ESLint gagal dijalankan.",
        tone: "error",
      };
    case "timeout":
      return {
        label: "ESLint: timeout",
        detail: "Run ESLint melebihi batas 30 detik.",
        tone: "error",
      };
    case "skipped-dirty":
      return {
        label: "ESLint: menunggu save",
        detail:
          "File belum disimpan — ESLint hanya memeriksa file yang tersimpan di disk. Tekan Ctrl+S untuk memeriksa.",
        tone: "muted",
      };
    case "disk-read-failed":
      return {
        label: "ESLint: gagal baca file",
        detail:
          "Terax tidak bisa membaca file ini dari disk. Periksa path project dan izin akses file.",
        tone: "error",
      };
    case "aborted-doc-changed":
      return {
        label: "ESLint: dibatalkan",
        detail:
          "Dokumen berubah saat run berlangsung (mis. save atau format) — run dibatalkan dan pemicu berikutnya akan mencoba lagi.",
        tone: "muted",
      };
    case "no-result-match": {
      const returned =
        status.returnedPaths.length > 0
          ? status.returnedPaths.map(shortPath).join(", ")
          : "(tidak ada hasil)";
      return {
        label: "ESLint: hasil tidak cocok",
        detail: `ESLint berjalan tapi mengembalikan hasil untuk path lain (${returned}), bukan ${shortPath(status.filePath)}. Kemungkinan perbedaan normalisasi path (mis. symlink atau nama pendek 8.3).`,
        tone: "error",
      };
    }
  }
}

/** "running" is the only non-terminal outcome; everything else ends a run. */
export function isTerminalEslintRunStatus(status: EslintRunStatus): boolean {
  return status.kind !== "running";
}

/**
 * Human-readable rendering of a project-wide lint outcome, shared by
 * the Problems panel header and the run toasts. The missing-binary
 * and missing-config texts reuse the per-file wording: the cause and
 * the next step are the same, only the scope differs.
 */
export function describeEslintProjectLintStatus(
  status: EslintProjectLintStatus,
): EslintStatusText {
  switch (status.kind) {
    case "idle":
      return {
        label: "Belum ada hasil lint project",
        detail:
          "Jalankan lint seluruh project untuk melihat semua masalah ESLint di project ini.",
        tone: "muted",
      };
    case "running":
      return {
        label: "ESLint: memeriksa project…",
        detail: "ESLint sedang memeriksa seluruh project.",
        tone: "muted",
      };
    case "ok": {
      if (status.errors === 0 && status.warnings === 0) {
        return {
          label: "ESLint project bersih",
          detail: "ESLint tidak menemukan error atau warning di project ini.",
          tone: "ok",
        };
      }
      const parts: string[] = [];
      if (status.errors > 0) parts.push(`${status.errors} error`);
      if (status.warnings > 0) parts.push(`${status.warnings} warning`);
      return {
        label: `${parts.join(" · ")} di ${status.files} file`,
        detail: `ESLint menemukan ${parts.join(" dan ")} di ${status.files} file.`,
        tone: status.errors > 0 ? "error" : "warn",
      };
    }
    case "missing-binary":
      return describeEslintRunStatus({
        kind: "missing-binary",
        root: status.root,
        searchedLevels: status.searchedLevels,
        truncatedByCap: status.truncatedByCap,
        controlStatFailed: status.controlStatFailed,
      });
    case "missing-config":
      return describeEslintRunStatus({
        kind: "missing-config",
        root: status.root,
      });
    case "failed":
      return {
        label: "ESLint: lint project gagal",
        detail: status.message || "Lint project gagal dijalankan.",
        tone: "error",
      };
    case "timeout":
      return {
        label: "ESLint: lint project timeout",
        // Keep the seconds in sync with PROJECT_LINT_TIMEOUT_SECS in
        // lib/eslintRunner.ts.
        detail:
          "ESLint tidak selesai dalam 120 detik. Coba lint per folder atau per file.",
        tone: "error",
      };
    case "truncated":
      return {
        label: "ESLint: hasil tidak lengkap",
        detail:
          "Output ESLint melebihi batas 256 KiB sehingga laporannya terpotong dan tidak bisa dibaca. Lint per folder atau per file untuk hasil lengkap.",
        tone: "warn",
      };
  }
}
