import { IS_WINDOWS } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { detectEslint, type EslintDetection, type StatFn } from "./eslintDetect";
import {
  parseEslintJsonOutput,
  type EslintFileResult,
} from "./eslintJson";
import { dirnameOf, canonicalPath, isLintablePath, joinPosix } from "./eslintPaths";

export type CommandOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated?: boolean;
};

export type RunCommand = (
  command: string,
  opts: { cwd: string; timeoutSecs: number },
) => Promise<CommandOutput>;

/** Production command runner: the existing one-shot shell exec. */
export async function tauriRunCommand(
  command: string,
  opts: { cwd: string; timeoutSecs: number },
): Promise<CommandOutput> {
  return invoke<CommandOutput>("shell_run_command", {
    command,
    cwd: opts.cwd,
    timeoutSecs: opts.timeoutSecs,
    workspace: currentWorkspaceEnv(),
  });
}

export async function statExists(path: string): Promise<boolean> {
  try {
    await invoke("fs_stat", { path, workspace: currentWorkspaceEnv() });
    return true;
  } catch {
    return false;
  }
}

export async function readDiskText(path: string): Promise<string | null> {
  const res = await invoke<{ kind: string; content?: string }>("fs_read_file", {
    path,
    workspace: currentWorkspaceEnv(),
  }).catch(() => null);
  if (res?.kind !== "text" || res.content == null) return null;
  return res.content;
}

export type EslintBinary =
  | { kind: "path"; root: string; binary: string }
  | { kind: "npx"; root: string };

export function buildEslintCommand(binary: EslintBinary, file: string): string {
  return buildEslintCommandForTargets(binary, [file]);
}

/** Same command, for several targets at once (one chunk of a project run). */
export function buildEslintCommandForTargets(
  binary: EslintBinary,
  targets: readonly string[],
): string {
  const bin =
    binary.kind === "path"
      ? quoteShellArg(binary.binary)
      : "npx --no-install eslint";
  return `${bin} --format json -- ${targets.map((t) => quoteShellArg(t)).join(" ")}`;
}

export type EslintRunResult =
  | { kind: "ok"; results: EslintFileResult[] }
  | { kind: "missing-config" }
  | { kind: "timeout" }
  | { kind: "failed"; message: string };

/**
 * Project-wide run outcome. Like `EslintRunResult`, plus `truncated`:
 * the 256 KiB one-shot output cap cut the JSON report short, so the
 * results are unusable and must not be shown as a complete lint.
 */
export type EslintProjectRunResult =
  | { kind: "ok"; results: EslintFileResult[] }
  | { kind: "missing-config" }
  | { kind: "timeout" }
  | { kind: "truncated" }
  | { kind: "failed"; message: string };

/**
 * Project-wide runs lint a whole directory tree, so they get a longer
 * budget than the 30 s single-file run. Still bounded: a runaway lint
 * must end in a timeout, never hang the UI.
 */
export const PROJECT_LINT_TIMEOUT_SECS = 120;

const CONFIG_MISSING =
  /couldn'?t find (a )?configuration file|no eslint configuration|Could not find config file/i;

/**
 * Exit-2 text for a target with nothing lintable: an empty folder
 * ("No files matching the pattern") or a fully ignored one ("all of
 * the files matching the glob pattern … are ignored" / "File ignored
 * because of a matching ignore pattern"). Verified live on ESLint
 * 8.57.0 and 9.39.5, legacy and flat — both exit 2 with this text
 * and no JSON. A chunk that hits it simply contributes nothing.
 */
const NO_FILES_MATCHING =
  /no files matching the pattern|all of the files matching the glob pattern .* are ignored|file ignored because of a matching ignore pattern/i;

/**
 * Shared reading of one `shell_run_command` result: exit 1 means
 * "violations found", not failure; exit 2 with a config error means
 * the project has no usable ESLint config. Callers check
 * `out.truncated` and `out.timed_out` first and map those themselves,
 * because a truncated single-file run is a failure while a truncated
 * project-wide run is its own outcome (partial JSON cannot be parsed).
 * With `tolerateNoMatch`, an exit-2 "nothing lintable here" is an
 * empty ok instead of a failure — only the chunked project runner
 * uses that, where an empty or fully ignored folder is normal.
 */
function interpretEslintOutput(
  out: CommandOutput,
  opts: { tolerateNoMatch?: boolean } = {},
): EslintRunResult {
  if (out.timed_out) return { kind: "timeout" };
  const combined = `${out.stdout}\n${out.stderr}`;
  if (out.exit_code === 2 && CONFIG_MISSING.test(combined)) {
    return { kind: "missing-config" };
  }
  if (
    opts.tolerateNoMatch &&
    out.exit_code === 2 &&
    NO_FILES_MATCHING.test(combined)
  ) {
    return { kind: "ok", results: [] };
  }
  if (out.exit_code !== 0 && out.exit_code !== 1) {
    return {
      kind: "failed",
      message:
        out.stderr.trim().slice(-300) ||
        `ESLint exited with code ${out.exit_code}`,
    };
  }
  if (!out.stdout.trim()) {
    return {
      kind: "failed",
      message:
        out.stderr.trim().slice(-300) || "ESLint produced no output",
    };
  }
  try {
    return { kind: "ok", results: parseEslintJsonOutput(out.stdout) };
  } catch (e) {
    return { kind: "failed", message: String(e) };
  }
}

/**
 * Runs the project's ESLint on one file and parses the JSON report.
 * Exit code 1 means "violations found", not failure. Exit code 2 with a
 * config error means the project has no usable ESLint config.
 */
export async function runEslintFile(args: {
  binary: EslintBinary;
  file: string;
  timeoutSecs?: number;
  runCommand?: RunCommand;
}): Promise<EslintRunResult> {
  const runCommand = args.runCommand ?? tauriRunCommand;
  let out: CommandOutput;
  try {
    out = await runCommand(buildEslintCommand(args.binary, args.file), {
      cwd: args.binary.root,
      timeoutSecs: args.timeoutSecs ?? 30,
    });
  } catch (e) {
    return { kind: "failed", message: String(e) };
  }
  if (out.truncated) {
    return {
      kind: "failed",
      message: "ESLint output was truncated; too many violations to display",
    };
  }
  return interpretEslintOutput(out);
}

/**
 * Lints the whole directory the binary belongs to (`eslint .` from the
 * binary root, so `.eslintignore` and the project config apply exactly
 * as they do for a manual run). The caller owns the binary resolution:
 * pass the binary `resolveEslintBinary` found for this project.
 */
export function buildEslintProjectCommand(binary: EslintBinary): string {
  return buildEslintCommand(binary, ".");
}

export async function runEslintProject(args: {
  binary: EslintBinary;
  timeoutSecs?: number;
  runCommand?: RunCommand;
}): Promise<EslintProjectRunResult> {
  const runCommand = args.runCommand ?? tauriRunCommand;
  let out: CommandOutput;
  try {
    out = await runCommand(buildEslintProjectCommand(args.binary), {
      cwd: args.binary.root,
      timeoutSecs: args.timeoutSecs ?? PROJECT_LINT_TIMEOUT_SECS,
    });
  } catch (e) {
    return { kind: "failed", message: String(e) };
  }
  if (out.timed_out) return { kind: "timeout" };
  if (out.truncated) return { kind: "truncated" };
  const result = interpretEslintOutput(out);
  if (result.kind === "timeout") return { kind: "timeout" };
  return result;
}

/** True when an eslint is reachable through npx without installing. */
export async function probeNpxEslint(
  runCommand: RunCommand,
  cwd: string,
): Promise<boolean> {
  try {
    const out = await runCommand("npx --no-install eslint --version", {
      cwd,
      timeoutSecs: 10,
    });
    return !out.timed_out && out.exit_code === 0;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Chunked project-wide runs (Fase 15)
// ──────────────────────────────────────────────────────────────────────────

/** One top-level child of a project root, from `fs_read_dir`. */
export type TopLevelEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
};

export type ListDirFn = (path: string) => Promise<TopLevelEntry[]>;

/**
 * Folders ESLint never lints for `eslint .`, skipped as chunks too
 * (passing them explicitly would only produce an "ignored" failure).
 */
export const ESLINT_SKIPPED_TOP_LEVEL_DIRS: readonly string[] = [
  "node_modules",
];

/**
 * Production listing: the same `fs_read_dir` the explorer uses,
 * without hidden entries (dot-directories like `.git` never take
 * part in a project lint). Throws when the directory cannot be read;
 * the chunked runner falls back to a single `eslint .` run.
 */
export async function listTopLevelEntries(
  path: string,
): Promise<TopLevelEntry[]> {
  const entries = await invoke<TopLevelEntry[]>("fs_read_dir", {
    path,
    showHidden: false,
    workspace: currentWorkspaceEnv(),
  });
  return entries.map((e) => ({ name: e.name, kind: e.kind }));
}

/** One piece of a project run: CLI targets plus the directory they lint. */
export type ProjectLintChunk = {
  /** CLI targets, relative to the binary root. */
  targets: string[];
  /**
   * The single directory these targets lint, relative to the root —
   * null for a list of files. A directory chunk only ever reports
   * files under itself, so results outside it are dropped.
   */
  dir: string | null;
};

/**
 * Turns a top-level listing into the chunks one project run is split
 * into: one chunk per directory (skipping node_modules and symlinks),
 * plus a single chunk with every lintable file that sits directly
 * under the root. Chunks are sorted by name so runs are reproducible
 * and tests can assert the exact commands.
 */
export function buildProjectLintChunks(
  entries: readonly TopLevelEntry[],
): ProjectLintChunk[] {
  const dirs = entries
    .filter(
      (e) =>
        e.kind === "dir" && !ESLINT_SKIPPED_TOP_LEVEL_DIRS.includes(e.name),
    )
    .map((e) => e.name)
    .sort();
  const rootFiles = entries
    .filter((e) => e.kind === "file" && isLintablePath(e.name))
    .map((e) => e.name)
    .sort();
  const chunks: ProjectLintChunk[] = dirs.map((d) => ({
    targets: [d],
    dir: d,
  }));
  if (rootFiles.length > 0) chunks.push({ targets: rootFiles, dir: null });
  return chunks;
}

/**
 * Maximum times one chunk may be split deeper before the run reports
 * `truncated`. Two levels is enough for any real project — a single
 * folder would need 50+ violating files to exceed the 256 KiB cap
 * on its own — and the bound keeps the run finite.
 */
export const MAX_CHUNK_DEPTH = 2;

/**
 * Lints the whole project as a sequence of per-folder chunks with
 * the results merged into one report, instead of one `eslint .`
 * whose JSON can exceed the 256 KiB one-shot output cap and become
 * unreadable (the Fase 11 "hasil tidak lengkap" failure). The cwd
 * stays the binary root, so config resolution and `.eslintignore`
 * apply exactly as they do for a manual run, and the merged file
 * set is the same as `eslint .` (verified live on a probe project:
 * chunks `src` + `root.js` returned exactly the files `eslint .`
 * did). A chunk whose target has nothing lintable (empty folder, or
 * fully ignored) is an empty ok, not a failure. When one chunk's
 * JSON still exceeds the cap it is split one level deeper (its
 * subdirectories, then its file list halved) up to MAX_CHUNK_DEPTH;
 * beyond that the run reports `truncated`. The whole run shares one
 * budget (PROJECT_LINT_TIMEOUT_SECS); each chunk gets what is left
 * of it. When the directory listing itself fails, or there is
 * nothing to chunk, the run falls back to the single `eslint .`
 * run, exactly like Fase 11.
 */
export async function runEslintProjectChunked(args: {
  binary: EslintBinary;
  timeoutSecs?: number;
  runCommand?: RunCommand;
  listDir?: ListDirFn;
}): Promise<EslintProjectRunResult> {
  const runCommand = args.runCommand ?? tauriRunCommand;
  const listDir = args.listDir ?? listTopLevelEntries;
  const totalBudgetSecs = args.timeoutSecs ?? PROJECT_LINT_TIMEOUT_SECS;
  const deadline = Date.now() + totalBudgetSecs * 1000;
  const remainingSecs = () =>
    Math.max(1, Math.ceil((deadline - Date.now()) / 1000));

  let entries: TopLevelEntry[];
  try {
    entries = await listDir(args.binary.root);
  } catch {
    return runEslintProject(args);
  }
  const chunks = buildProjectLintChunks(entries);
  if (chunks.length === 0) return runEslintProject(args);

  const allResults: EslintFileResult[] = [];

  const runChunk = async (
    chunk: ProjectLintChunk,
    depth: number,
  ): Promise<EslintProjectRunResult | { kind: "ok" }> => {
    if (Date.now() >= deadline) return { kind: "timeout" };
    let out: CommandOutput;
    try {
      out = await runCommand(
        buildEslintCommandForTargets(args.binary, chunk.targets),
        { cwd: args.binary.root, timeoutSecs: remainingSecs() },
      );
    } catch (e) {
      return { kind: "failed", message: String(e) };
    }
    if (out.timed_out) return { kind: "timeout" };
    if (out.truncated) {
      if (depth >= MAX_CHUNK_DEPTH) return { kind: "truncated" };
      if (chunk.targets.length > 1) {
        // A file list: halve it and lint each half.
        const mid = Math.ceil(chunk.targets.length / 2);
        const first = await runChunk(
          { targets: chunk.targets.slice(0, mid), dir: null },
          depth + 1,
        );
        if (first.kind !== "ok") return first;
        return runChunk(
          { targets: chunk.targets.slice(mid), dir: null },
          depth + 1,
        );
      }
      if (chunk.dir === null) return { kind: "truncated" };
      // A single directory: split into its children.
      const dir = chunk.dir;
      let children: TopLevelEntry[];
      try {
        children = await listDir(joinPosix(args.binary.root, dir));
      } catch {
        return { kind: "truncated" };
      }
      const subChunks = buildProjectLintChunks(children);
      if (subChunks.length === 0) return { kind: "truncated" };
      for (const sub of subChunks) {
        const outcome = await runChunk(
          {
            targets: sub.targets.map((t) => joinPosix(dir, t)),
            dir: sub.dir === null ? null : joinPosix(dir, sub.dir),
          },
          depth + 1,
        );
        if (outcome.kind !== "ok") return outcome;
      }
      return { kind: "ok" };
    }
    const result = interpretEslintOutput(out, { tolerateNoMatch: true });
    if (result.kind !== "ok") return result;
    const kept =
      chunk.dir === null
        ? result.results
        : result.results.filter((r) =>
            canonicalPath(r.filePath).startsWith(
              `${canonicalPath(joinPosix(args.binary.root, chunk.dir)).replace(/\/+$/, "")}/`,
            ),
          );
    allResults.push(...kept);
    return { kind: "ok" };
  };

  for (const chunk of chunks) {
    const outcome = await runChunk(chunk, 0);
    if (outcome.kind !== "ok") return outcome;
  }
  return { kind: "ok", results: allResults };
}

type CacheEntry = {
  value: EslintBinary | null;
  detection: EslintDetection;
  at: number;
};
const binaryCache = new Map<string, CacheEntry>();
const MISS_TTL_MS = 60_000;

export function clearEslintBinaryCache(): void {
  binaryCache.clear();
}

export type EslintBinaryResolution = {
  binary: EslintBinary | null;
  /** Walk diagnosis from `detectEslint` (levels checked, cap, control stat). */
  detection: EslintDetection;
};

/**
 * Resolves the ESLint binary for a file: project-installed first, then
 * npx without install. Misses are cached briefly so a project without
 * ESLint does not pay a shell spawn on every trigger. The detection
 * diagnosis rides along so a miss can say why the binary was not found.
 */
export async function resolveEslintBinary(
  filePath: string,
  deps: {
    stat?: StatFn;
    runCommand?: RunCommand;
    windows?: boolean;
  } = {},
): Promise<EslintBinaryResolution> {
  const dir = dirnameOf(filePath);
  const cached = binaryCache.get(dir);
  if (
    cached &&
    (cached.value !== null || Date.now() - cached.at < MISS_TTL_MS)
  ) {
    return { binary: cached.value, detection: cached.detection };
  }
  const stat = deps.stat ?? statExists;
  const windows = deps.windows ?? IS_WINDOWS;
  const detected = await detectEslint(filePath, { stat, windows });
  if (detected.status === "found") {
    const value: EslintBinary = {
      kind: "path",
      root: detected.root,
      binary: detected.binary,
    };
    binaryCache.set(dir, { value, detection: detected, at: Date.now() });
    return { binary: value, detection: detected };
  }
  const runCommand = deps.runCommand ?? tauriRunCommand;
  const npxOk = await probeNpxEslint(runCommand, dir);
  const value: EslintBinary | null = npxOk ? { kind: "npx", root: dir } : null;
  binaryCache.set(dir, { value, detection: detected, at: Date.now() });
  return { binary: value, detection: detected };
}
