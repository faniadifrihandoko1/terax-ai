import {
  canonicalPath,
  dirnameOf,
} from "@/modules/eslint/lib/eslintPaths";
import {
  resolveEslintBinary,
  runEslintFile,
  runEslintProjectChunked,
  readDiskText,
  statExists,
  tauriRunCommand,
  type CommandOutput,
  type EslintBinary,
  type EslintProjectRunResult,
  type EslintRunResult,
  type RunCommand,
} from "@/modules/eslint/lib/eslintRunner";

/**
 * Auto-verifikasi setelah Confirm (Fase 37): begitu sebuah review
 * dikonfirmasi, Terax menjalankan check proyek (typecheck / lint /
 * test) dan melaporkan hasilnya sebagai pesan di chat — user tidak
 * perlu pindah ke terminal untuk tahu perubahannya aman.
 *
 * Dua lapisan, seperti runner ESLint Fase 10/15: bagian murni
 * (deteksi proyek + rencana check + format laporan) yang bisa
 * diuji tanpa shell, dan runner yang mengeksekusi rencananya lewat
 * `shell_run_command` yang sudah ada. Tidak ada auto-fix dan tidak
 * ada auto-revert — hasil yang gagal hanya dilaporkan.
 */

/** Total budget satu verifikasi, semua check digabung. */
export const VERIFY_TOTAL_TIMEOUT_SECS = 300;
/** Batas file untuk lint per file; di atasnya lint seluruh project. */
export const MAX_ESLINT_FILES = 20;
/** Ringkasan error: baris pertama saja, dipotong di sini. */
export const ERROR_SUMMARY_MAX_LINES = 8;
export const ERROR_SUMMARY_MAX_CHARS = 1000;
const TSC_PROBE_TIMEOUT_SECS = 10;
const WALK_MAX_DEPTH = 12;

export type VerifyCheckKind = "typecheck" | "lint" | "test";

export type VerifyCheck =
  | {
      kind: VerifyCheckKind;
      mode: "shell";
      label: string;
      command: string;
    }
  | { kind: "lint"; mode: "eslint-files"; label: string; targets: string[] }
  | { kind: "lint"; mode: "eslint-project"; label: string };

export type VerifyProjectInfo = {
  /** Direktori kerja perintah: dir package.json, lalu dir tsconfig. */
  root: string;
  hasPackageJson: boolean;
  scripts: Record<string, string>;
  packageManager: "npm" | "pnpm" | "yarn";
  hasTsconfig: boolean;
  /** `tsc` bisa dipanggil lewat npx tanpa install (bila ada tsconfig). */
  tscAvailable: boolean;
};

export type VerifyDeps = {
  stat: (path: string) => Promise<boolean>;
  readFile: (path: string) => Promise<string | null>;
  runCommand: RunCommand;
  resolveEslintBinary: (filePath: string) => Promise<EslintBinary | null>;
  runEslintFile: (args: {
    binary: EslintBinary;
    file: string;
    timeoutSecs?: number;
  }) => Promise<EslintRunResult>;
  runEslintProjectChunked: (args: {
    binary: EslintBinary;
    timeoutSecs?: number;
  }) => Promise<EslintProjectRunResult>;
};

export function defaultVerifyDeps(): VerifyDeps {
  return {
    stat: statExists,
    readFile: readDiskText,
    runCommand: tauriRunCommand,
    resolveEslintBinary: async (filePath) =>
      (await resolveEslintBinary(filePath)).binary,
    runEslintFile: (args) => runEslintFile(args),
    runEslintProjectChunked: (args) => runEslintProjectChunked(args),
  };
}

/** Direktori dari probe path ke atas, probe path sendiri dihitung dulu. */
function walkDirs(probePath: string): string[] {
  const out: string[] = [];
  let dir = canonicalPath(probePath);
  while (dir && out.length <= WALK_MAX_DEPTH) {
    out.push(dir);
    const parent = dirnameOf(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function parseScripts(text: string | null): Record<string, string> {
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return {};
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (typeof scripts !== "object" || scripts === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(scripts)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    // package.json rusak: bukan alasan untuk throw — script dianggap kosong.
    return {};
  }
}

/**
 * Mendeteksi proyek untuk satu file (atau direktori): walk-up mencari
 * package.json lalu tsconfig, mengikuti pola `detectEslint` (cap 12
 * level). Package manager dari lockfile di root; `tsc` di-probe bila
 * ada tsconfig — probe-nya murah dan hasilnya dipakai rencana check.
 */
export async function detectVerifyProject(
  probePath: string,
  deps: VerifyDeps = defaultVerifyDeps(),
): Promise<VerifyProjectInfo> {
  const dirs = walkDirs(probePath);
  let packageDir: string | null = null;
  let scripts: Record<string, string> = {};
  let tsconfigDir: string | null = null;
  for (const dir of dirs) {
    if (packageDir === null) {
      const pkgPath = `${dir}/package.json`;
      if (await deps.stat(pkgPath)) {
        packageDir = dir;
        scripts = parseScripts(await deps.readFile(pkgPath));
      }
    }
    if (tsconfigDir === null && (await deps.stat(`${dir}/tsconfig.json`))) {
      tsconfigDir = dir;
    }
    if (packageDir !== null && tsconfigDir !== null) break;
  }
  const root = packageDir ?? tsconfigDir ?? dirnameOf(probePath);
  let packageManager: VerifyProjectInfo["packageManager"] = "npm";
  if (packageDir !== null) {
    if (await deps.stat(`${packageDir}/pnpm-lock.yaml`)) {
      packageManager = "pnpm";
    } else if (await deps.stat(`${packageDir}/yarn.lock`)) {
      packageManager = "yarn";
    }
  }
  const hasTsconfig = tsconfigDir !== null;
  let tscAvailable = false;
  if (hasTsconfig) {
    try {
      const probe = await deps.runCommand("npx --no-install tsc --version", {
        cwd: root,
        timeoutSecs: TSC_PROBE_TIMEOUT_SECS,
      });
      tscAvailable = !probe.timed_out && probe.exit_code === 0;
    } catch {
      tscAvailable = false;
    }
  }
  return {
    root,
    hasPackageJson: packageDir !== null,
    scripts,
    packageManager,
    hasTsconfig,
    tscAvailable,
  };
}

/**
 * Rencana check untuk satu proyek, murni: script package.json dulu
 * (urutan typecheck → lint → test), lalu fallback — `tsc --noEmit`
 * bila ada tsconfig dan tsc tersedia, ESLint pada file yang berubah
 * (atau seluruh project bila tidak ada file / terlalu banyak).
 */
export function buildVerifyPlan(
  info: VerifyProjectInfo,
  changedFiles: readonly string[],
  opts: { manual?: boolean } = {},
): { checks: VerifyCheck[] } | { nothing: string } {
  const checks: VerifyCheck[] = [];
  const run = (name: string) => `${info.packageManager} run ${name}`;
  if (info.scripts.typecheck) {
    checks.push({
      kind: "typecheck",
      mode: "shell",
      label: "typecheck",
      command: run("typecheck"),
    });
  } else if (info.hasTsconfig && info.tscAvailable) {
    checks.push({
      kind: "typecheck",
      mode: "shell",
      label: "typecheck",
      command: "npx --no-install tsc --noEmit",
    });
  }
  if (info.scripts.lint) {
    checks.push({
      kind: "lint",
      mode: "shell",
      label: "lint",
      command: run("lint"),
    });
  } else if (changedFiles.length > 0 && changedFiles.length <= MAX_ESLINT_FILES) {
    checks.push({
      kind: "lint",
      mode: "eslint-files",
      label: "lint",
      targets: [...changedFiles],
    });
  } else if (
    changedFiles.length > MAX_ESLINT_FILES ||
    (changedFiles.length === 0 && opts.manual === true)
  ) {
    // Terlalu banyak file, atau verifikasi manual tanpa file tertentu:
    // lint seluruh project (chunked, Fase 15) daripada per file.
    checks.push({ kind: "lint", mode: "eslint-project", label: "lint" });
  }
  if (info.scripts.test) {
    checks.push({
      kind: "test",
      mode: "shell",
      label: "test",
      command: run("test"),
    });
  }
  if (checks.length > 0) return { checks };
  const missing: string[] = [];
  if (Object.keys(info.scripts).length === 0) {
    missing.push("tidak ada script typecheck/lint/test di package.json");
  }
  if (!info.hasTsconfig) missing.push("tidak ada tsconfig");
  if (info.hasTsconfig && !info.tscAvailable) missing.push("tsc tidak terpasang");
  if (changedFiles.length === 0) missing.push("tidak ada file untuk di-lint");
  const joined =
    missing.length > 1
      ? `${missing.slice(0, -1).join(", ")}, dan ${missing[missing.length - 1]}`
      : (missing[0] ?? "tidak ada check yang bisa dijalankan");
  return { nothing: joined };
}

export type VerifyCheckResult = {
  kind: VerifyCheckKind;
  label: string;
  status: "passed" | "failed" | "timeout" | "skipped";
  durationMs: number;
  summary?: string;
};

export type VerifyOutcome =
  | {
      status: "passed" | "failed" | "timeout";
      checks: VerifyCheckResult[];
      durationMs: number;
      files: string[];
    }
  | { status: "nothing-to-verify"; reason: string; files: string[] }
  | {
      status: "failed";
      checks: VerifyCheckResult[];
      durationMs: number;
      files: string[];
      error: string;
    };

/** Baris pertama output yang gagal, dipotong supaya laporan tetap dibaca. */
export function summarizeCommandOutput(out: CommandOutput): string {
  const text =
    [out.stderr, out.stdout]
      .map((s) => s.trim())
      .find((s) => s !== "") ?? "";
  if (!text) {
    return out.exit_code === null
      ? "tidak ada output"
      : `berakhir dengan kode ${out.exit_code} tanpa output`;
  }
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, ERROR_SUMMARY_MAX_LINES);
  const summary = lines.join("\n");
  return summary.length > ERROR_SUMMARY_MAX_CHARS
    ? summary.slice(0, ERROR_SUMMARY_MAX_CHARS)
    : summary;
}

function formatDuration(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} dtk`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function filesLine(files: readonly string[]): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, 3).map(basename);
  const rest = files.length - shown.length;
  const noun = files.length === 1 ? "file dikonfirmasi" : "file dikonfirmasi";
  return `\n\n${files.length} ${noun}: ${shown.join(", ")}${rest > 0 ? `, dan ${rest} lainnya` : ""}.`;
}

/**
 * Laporan sebagai teks Markdown untuk pesan chat: lolos / gagal
 * (check mana + ringkasan error) / waktu habis / tidak ada yang
 * bisa diverifikasi. Sengaja tanpa ajakan auto-fix — hasil yang
 * gagal hanya dilaporkan.
 */
export function formatVerifyReport(
  outcome: VerifyOutcome,
  files: readonly string[],
): string {
  if (outcome.status === "nothing-to-verify") {
    return (
      "**Verifikasi setelah Confirm — tidak ada yang bisa diverifikasi**\n\n" +
      `${outcome.reason}.\n\nTambahkan script typecheck/lint/test di package.json supaya Terax bisa memverifikasi perubahan.`
    );
  }
  const checkLines = outcome.checks
    .map((c) => {
      const word =
        c.status === "passed"
          ? "lolos"
          : c.status === "failed"
            ? "gagal"
            : c.status === "timeout"
              ? "waktu habis"
              : "dilewati";
      const note = c.summary ? ` — ${c.summary.split("\n")[0]}` : "";
      return `- ${c.label}: ${word} (${formatDuration(c.durationMs)})${note}`;
    })
    .join("\n");
  if (outcome.status === "passed") {
    return (
      "**Verifikasi setelah Confirm — lolos**\n\n" +
      `${checkLines}${filesLine(files)}`
    );
  }
  if (outcome.status === "timeout") {
    const failed = outcome.checks.find((c) => c.status === "timeout");
    return (
      "**Verifikasi setelah Confirm — waktu habis**\n\n" +
      `${checkLines}\n\nCheck ${failed?.label ?? "verifikasi"} tidak selesai dalam ${VERIFY_TOTAL_TIMEOUT_SECS} dtk — batas total satu verifikasi. Jalankan check itu manual di terminal untuk melihat hasilnya.${filesLine(files)}`
    );
  }
  // failed
  const failed = outcome.checks.find((c) => c.status === "failed");
  const detail =
    outcome.checks.length === 0 && "error" in outcome && outcome.error
      ? `\n\nVerifikasi tidak bisa dijalankan: ${outcome.error}`
      : failed?.summary
        ? `\n\n\`\`\`\n${failed.summary}\n\`\`\``
        : "";
  return (
    `**Verifikasi setelah Confirm — gagal di ${failed?.label ?? "verifikasi"}**\n\n` +
    `${checkLines}${detail}\n\nPerbaiki lalu Confirm ulang, atau jalankan "Verifikasi perubahan" dari Command Palette.${filesLine(files)}`
  );
}

type EslintViolation = {
  filePath: string;
  line: number;
  message: string;
};

function summarizeEslintResults(
  results: { filePath: string; messages: { line: number; message: string }[] }[],
): { total: number; files: number; example?: EslintViolation } {
  let total = 0;
  let example: EslintViolation | undefined;
  const withMessages = results.filter((r) => r.messages.length > 0);
  for (const r of results) {
    total += r.messages.length;
    if (!example && r.messages.length > 0) {
      example = {
        filePath: r.filePath,
        line: r.messages[0]?.line ?? 1,
        message: r.messages[0]?.message ?? "",
      };
    }
  }
  return { total, files: withMessages.length, example };
}

async function runEslintFilesCheck(
  check: Extract<VerifyCheck, { mode: "eslint-files" }>,
  deps: VerifyDeps,
  timeoutSecs: number,
  startedAt: number,
): Promise<VerifyCheckResult> {
  const done = (status: VerifyCheckResult["status"], summary?: string): VerifyCheckResult => ({
    kind: "lint",
    label: "lint",
    status,
    durationMs: Date.now() - startedAt,
    summary,
  });
  const existing: string[] = [];
  for (const target of check.targets) {
    if (await deps.stat(target)) existing.push(target);
  }
  if (existing.length === 0) {
    return done("skipped", "file sudah tidak ada di disk");
  }
  const binary = await deps.resolveEslintBinary(existing[0] ?? "");
  if (!binary) {
    return done("skipped", "ESLint tidak terpasang di proyek ini");
  }
  const all: EslintViolation[] = [];
  let fileCount = 0;
  for (const file of existing) {
    const result = await deps.runEslintFile({
      binary,
      file,
      timeoutSecs: Math.max(1, timeoutSecs),
    });
    if (result.kind === "timeout") return done("timeout");
    if (result.kind === "missing-config") {
      return done("skipped", "tidak ada konfigurasi ESLint");
    }
    if (result.kind === "failed") return done("failed", result.message);
    const summary = summarizeEslintResults(result.results);
    fileCount += summary.files;
    for (const r of result.results) {
      for (const m of r.messages) {
        all.push({ filePath: r.filePath, line: m.line, message: m.message });
      }
    }
  }
  if (all.length === 0) return done("passed");
  const first = all[0];
  return done(
    "failed",
    `${all.length} pelanggaran di ${fileCount} file` +
      (first
        ? ` — ${basename(first.filePath)}:${first.line} ${first.message}`
        : ""),
  );
}

async function runEslintProjectCheck(
  root: string,
  deps: VerifyDeps,
  timeoutSecs: number,
  startedAt: number,
): Promise<VerifyCheckResult> {
  const done = (status: VerifyCheckResult["status"], summary?: string): VerifyCheckResult => ({
    kind: "lint",
    label: "lint",
    status,
    durationMs: Date.now() - startedAt,
    summary,
  });
  const binary = await deps.resolveEslintBinary(`${root}/package.json`);
  if (!binary) {
    return done("skipped", "ESLint tidak terpasang di proyek ini");
  }
  const result = await deps.runEslintProjectChunked({
    binary,
    timeoutSecs: Math.max(1, timeoutSecs),
  });
  if (result.kind === "timeout") return done("timeout");
  if (result.kind === "missing-config") {
    return done("skipped", "tidak ada konfigurasi ESLint");
  }
  if (result.kind === "truncated") {
    return done("failed", "hasil lint tidak lengkap (output terpotong)");
  }
  if (result.kind === "failed") return done("failed", result.message);
  const summary = summarizeEslintResults(result.results);
  if (summary.total === 0) return done("passed");
  const first = summary.example;
  return done(
    "failed",
    `${summary.total} pelanggaran di ${summary.files} file` +
      (first
        ? ` — ${basename(first.filePath)}:${first.line} ${first.message}`
        : ""),
  );
}

/**
 * Menjalankan satu verifikasi penuh: deteksi proyek → rencana →
 * check berurutan dengan fail-fast dalam satu budget total. Satu
 * check yang timeout menghentikan semuanya sebagai timeout; semua
 * check ter-skip menjadi nothing-to-verify, bukan lolos palsu.
 */
export async function runPostConfirmVerification(args: {
  sessionId: string;
  files: readonly string[];
  rootHint?: string;
  manual?: boolean;
  deps?: VerifyDeps;
}): Promise<VerifyOutcome> {
  const deps = args.deps ?? defaultVerifyDeps();
  const files = [...args.files];
  const probePath = files[0] ?? args.rootHint;
  if (!probePath) {
    return {
      status: "nothing-to-verify",
      reason: "tidak ada file atau proyek untuk diverifikasi",
      files,
    };
  }
  const startedAt = Date.now();
  const deadline = startedAt + VERIFY_TOTAL_TIMEOUT_SECS * 1000;
  const remainingSecs = () =>
    Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
  const info = await detectVerifyProject(probePath, deps);
  const plan = buildVerifyPlan(info, files, { manual: args.manual === true });
  if ("nothing" in plan) {
    return { status: "nothing-to-verify", reason: plan.nothing, files };
  }
  const results: VerifyCheckResult[] = [];
  for (const check of plan.checks) {
    const checkStarted = Date.now();
    if (check.mode === "shell") {
      let out: CommandOutput;
      try {
        out = await deps.runCommand(check.command, {
          cwd: info.root,
          timeoutSecs: remainingSecs(),
        });
      } catch (e) {
        results.push({
          kind: check.kind,
          label: check.label,
          status: "failed",
          durationMs: Date.now() - checkStarted,
          summary: String(e),
        });
        break;
      }
      if (out.timed_out) {
        results.push({
          kind: check.kind,
          label: check.label,
          status: "timeout",
          durationMs: Date.now() - checkStarted,
        });
        return {
          status: "timeout",
          checks: results,
          durationMs: Date.now() - startedAt,
          files,
        };
      }
      if (out.truncated) {
        results.push({
          kind: check.kind,
          label: check.label,
          status: "failed",
          durationMs: Date.now() - checkStarted,
          summary: "output terpotong (melebihi batas)",
        });
        break;
      }
      if (out.exit_code === 0) {
        results.push({
          kind: check.kind,
          label: check.label,
          status: "passed",
          durationMs: Date.now() - checkStarted,
        });
        continue;
      }
      results.push({
        kind: check.kind,
        label: check.label,
        status: "failed",
        durationMs: Date.now() - checkStarted,
        summary: summarizeCommandOutput(out),
      });
      break;
    }
    if (check.mode === "eslint-files") {
      const result = await runEslintFilesCheck(
        check,
        deps,
        remainingSecs(),
        checkStarted,
      );
      results.push(result);
      if (result.status === "timeout") {
        return {
          status: "timeout",
          checks: results,
          durationMs: Date.now() - startedAt,
          files,
        };
      }
      if (result.status === "failed") break;
      continue;
    }
    const result = await runEslintProjectCheck(
      info.root,
      deps,
      remainingSecs(),
      checkStarted,
    );
    results.push(result);
    if (result.status === "timeout") {
      return {
        status: "timeout",
        checks: results,
        durationMs: Date.now() - startedAt,
        files,
      };
    }
    if (result.status === "failed") break;
  }
  const ran = results.some((r) => r.status !== "skipped");
  if (!ran) {
    const reason = results
      .map((r) => r.summary)
      .filter((s): s is string => Boolean(s))
      .join("; ");
    return {
      status: "nothing-to-verify",
      reason: reason || "tidak ada check yang bisa dijalankan",
      files,
    };
  }
  const failed = results.some((r) => r.status === "failed");
  return {
    status: failed ? "failed" : "passed",
    checks: results,
    durationMs: Date.now() - startedAt,
    files,
  };
}
