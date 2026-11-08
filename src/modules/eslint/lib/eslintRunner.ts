import { IS_WINDOWS } from "@/lib/platform";
import { quoteShellArg } from "@/lib/shellQuote";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { detectEslint, type EslintDetection, type StatFn } from "./eslintDetect";
import {
  parseEslintJsonOutput,
  type EslintFileResult,
} from "./eslintJson";
import { dirnameOf } from "./eslintPaths";

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
  const bin =
    binary.kind === "path"
      ? quoteShellArg(binary.binary)
      : "npx --no-install eslint";
  return `${bin} --format json --no-warn-ignored -- ${quoteShellArg(file)}`;
}

export type EslintRunResult =
  | { kind: "ok"; results: EslintFileResult[] }
  | { kind: "missing-config" }
  | { kind: "timeout" }
  | { kind: "failed"; message: string };

const CONFIG_MISSING =
  /couldn'?t find (a )?configuration file|no eslint configuration|Could not find config file/i;

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
  if (out.timed_out) return { kind: "timeout" };
  if (out.truncated) {
    return {
      kind: "failed",
      message: "ESLint output was truncated; too many violations to display",
    };
  }
  const combined = `${out.stdout}\n${out.stderr}`;
  if (out.exit_code === 2 && CONFIG_MISSING.test(combined)) {
    return { kind: "missing-config" };
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
