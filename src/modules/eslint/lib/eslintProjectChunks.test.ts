import { describe, expect, it } from "vitest";
import {
  buildProjectLintChunks,
  runEslintProjectChunked,
  type EslintBinary,
  type ListDirFn,
  type RunCommand,
  type TopLevelEntry,
} from "./eslintRunner";

const BINARY: EslintBinary = {
  kind: "path",
  root: "/proj",
  binary: "/proj/node_modules/.bin/eslint",
};

function result(filePath: string, withError: boolean) {
  return {
    filePath,
    messages: withError
      ? [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "'x' is assigned a value but never used.",
            line: 1,
            column: 1,
          },
        ]
      : [],
    errorCount: withError ? 1 : 0,
    warningCount: 0,
    fatalErrorCount: 0,
  };
}

function asJson(results: unknown[]): string {
  return JSON.stringify(results);
}

type ScriptedOutput = {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  timed_out?: boolean;
  truncated?: boolean;
};

/**
 * Answers lint commands from a script keyed by the quoted target in
 * the command. Unscripted targets get an empty clean report.
 */
function scriptedLint(
  script: Record<string, ScriptedOutput>,
  seen: string[] = [],
): RunCommand {
  return async (cmd) => {
    seen.push(cmd);
    for (const [target, out] of Object.entries(script)) {
      if (cmd.includes(`'${target}'`)) {
        return {
          stdout: out.stdout ?? "",
          stderr: out.stderr ?? "",
          exit_code: out.exit_code ?? 1,
          timed_out: out.timed_out ?? false,
          truncated: out.truncated ?? false,
        };
      }
    }
    return {
      stdout: asJson([]),
      stderr: "",
      exit_code: 0,
      timed_out: false,
    };
  };
}

function listDirFrom(
  map: Record<string, TopLevelEntry[]>,
): ListDirFn {
  return async (path) => map[path] ?? [];
}

describe("buildProjectLintChunks", () => {
  it("splits per directory, skips node_modules and symlinks, groups root files", () => {
    const chunks = buildProjectLintChunks([
      { name: "src", kind: "dir" },
      { name: "node_modules", kind: "dir" },
      { name: "link", kind: "symlink" },
      { name: "public", kind: "dir" },
      { name: "root.ts", kind: "file" },
      { name: "index.js", kind: "file" },
      { name: "README.md", kind: "file" },
      { name: "package.json", kind: "file" },
    ]);
    expect(chunks).toEqual([
      { targets: ["public"], dir: "public" },
      { targets: ["src"], dir: "src" },
      { targets: ["index.js", "root.ts"], dir: null },
    ]);
  });

  it("returns no chunks when there is nothing lintable", () => {
    expect(
      buildProjectLintChunks([
        { name: "README.md", kind: "file" },
        { name: "node_modules", kind: "dir" },
      ]),
    ).toEqual([]);
  });
});

describe("runEslintProjectChunked", () => {
  it("merges per-folder results into one report, in chunk order", async () => {
    const seen: string[] = [];
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint(
        {
          src: { stdout: asJson([result("/proj/src/a.ts", true)]) },
          "root.ts": { stdout: asJson([result("/proj/root.ts", true)]) },
        },
        seen,
      ),
      listDir: listDirFrom({
        "/proj": [
          { name: "src", kind: "dir" },
          { name: "root.ts", kind: "file" },
        ],
      }),
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.results.map((r) => r.filePath)).toEqual([
        "/proj/src/a.ts",
        "/proj/root.ts",
      ]);
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("'src'");
    expect(seen[1]).toContain("'root.ts'");
  });

  it("treats an empty or fully ignored chunk as an empty ok, not a failure", async () => {
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint({
        src: { stdout: asJson([result("/proj/src/a.ts", true)]) },
        empty: {
          stderr:
            'Oops! Something went wrong! :(\n\nESLint: 8.57.0\n\nNo files matching the pattern "empty" were found.',
          exit_code: 2,
        },
        dist: {
          stderr:
            'You are linting "dist", but all of the files matching the glob pattern "dist" are ignored.',
          exit_code: 2,
        },
      }),
      listDir: listDirFrom({
        "/proj": [
          { name: "src", kind: "dir" },
          { name: "empty", kind: "dir" },
          { name: "dist", kind: "dir" },
        ],
      }),
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.results.map((r) => r.filePath)).toEqual(["/proj/src/a.ts"]);
    }
  });

  it("treats a no-match chunk as an empty ok whatever exit code the shell reports", async () => {
    // Fase 15.1: on Windows the command runs through
    // `powershell -NoProfile -Command` (no `exit $LASTEXITCODE`), so
    // the exit code ESLint reports (2) is not what Terax observes.
    // The ok-empty classification must come from the output text,
    // not the exit code — otherwise every auto project lint fails
    // while a folder with nothing lintable (e.g. `messages`, JSON
    // translations only) exists.
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint({
        src: { stdout: asJson([result("/proj/src/a.ts", true)]) },
        messages: {
          stderr:
            'Oops! Something went wrong! :(\n\nESLint: 8.57.0\n\nNo files matching the pattern "messages" were found. Please check for typing mistakes in the pattern.',
          exit_code: 0,
        },
        empty: {
          stderr:
            'Oops! Something went wrong! :(\n\nESLint: 8.57.0\n\nNo files matching the pattern "empty" were found.',
          exit_code: 1,
        },
        ignored: {
          stderr:
            'You are linting "ignored", but all of the files matching the glob pattern "ignored" are ignored.',
          exit_code: 1,
        },
      }),
      listDir: listDirFrom({
        "/proj": [
          { name: "src", kind: "dir" },
          { name: "messages", kind: "dir" },
          { name: "empty", kind: "dir" },
          { name: "ignored", kind: "dir" },
        ],
      }),
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.results.map((r) => r.filePath)).toEqual(["/proj/src/a.ts"]);
    }
  });

  it("reports missing config even when the shell does not report exit code 2", async () => {
    // Fase 15.1: same exit-code problem as the no-match case — the
    // config-missing classification is by output text, not exit code.
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint({
        src: { stderr: "Could not find config file", exit_code: 1 },
      }),
      listDir: listDirFrom({
        "/proj": [{ name: "src", kind: "dir" }],
      }),
    });
    expect(out.kind).toBe("missing-config");
  });

  it("splits a truncated folder one level deeper and merges the pieces", async () => {
    const seen: string[] = [];
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint(
        {
          big: { truncated: true, stdout: asJson([]), exit_code: 1 },
          "big/deep": {
            stdout: asJson([result("/proj/big/deep/a.ts", true)]),
          },
          "big/top.ts": {
            stdout: asJson([result("/proj/big/top.ts", true)]),
          },
        },
        seen,
      ),
      listDir: listDirFrom({
        "/proj": [{ name: "big", kind: "dir" }],
        "/proj/big": [
          { name: "deep", kind: "dir" },
          { name: "top.ts", kind: "file" },
        ],
      }),
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.results.map((r) => r.filePath)).toEqual([
        "/proj/big/deep/a.ts",
        "/proj/big/top.ts",
      ]);
    }
    expect(seen.some((c) => c.includes("'big'"))).toBe(true);
    expect(seen.some((c) => c.includes("'big/deep'"))).toBe(true);
    expect(seen.some((c) => c.includes("'big/top.ts'"))).toBe(true);
  });

  it("reports truncated when a chunk still overflows at max depth", async () => {
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint({
        big: { truncated: true, stdout: asJson([]), exit_code: 1 },
        "big/sub": { truncated: true, stdout: asJson([]), exit_code: 1 },
        "big/sub/sub": { truncated: true, stdout: asJson([]), exit_code: 1 },
      }),
      listDir: listDirFrom({
        "/proj": [{ name: "big", kind: "dir" }],
        "/proj/big": [{ name: "sub", kind: "dir" }],
        "/proj/big/sub": [{ name: "sub", kind: "dir" }],
      }),
    });
    expect(out.kind).toBe("truncated");
  });

  it("drops results outside the chunked directory", async () => {
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint({
        src: {
          stdout: asJson([
            result("/proj/src/a.ts", true),
            result("/proj/other.ts", true),
          ]),
        },
      }),
      listDir: listDirFrom({
        "/proj": [{ name: "src", kind: "dir" }],
      }),
    });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") {
      expect(out.results.map((r) => r.filePath)).toEqual(["/proj/src/a.ts"]);
    }
  });

  it("falls back to a single eslint . run when the listing fails", async () => {
    const seen: string[] = [];
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint(
        {
          ".": { stdout: asJson([result("/proj/src/a.ts", true)]) },
        },
        seen,
      ),
      listDir: async () => {
        throw new Error("fs_read_dir failed");
      },
    });
    expect(out.kind).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("'.'");
  });

  it("falls back to a single run when there is nothing to chunk", async () => {
    const seen: string[] = [];
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint(
        {
          ".": { stdout: asJson([]), exit_code: 0 },
        },
        seen,
      ),
      listDir: listDirFrom({
        "/proj": [{ name: "README.md", kind: "file" }],
      }),
    });
    expect(out.kind).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("'.'");
  });

  it("stops at the first timeout and reports it", async () => {
    const seen: string[] = [];
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint(
        {
          aaa: { timed_out: true },
          bbb: { stdout: asJson([result("/proj/bbb/a.ts", true)]) },
        },
        seen,
      ),
      listDir: listDirFrom({
        "/proj": [
          { name: "aaa", kind: "dir" },
          { name: "bbb", kind: "dir" },
        ],
      }),
    });
    expect(out.kind).toBe("timeout");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("'aaa'");
  });

  it("stops at missing config on the first chunk", async () => {
    const out = await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint({
        src: { stderr: "Could not find config file", exit_code: 2 },
      }),
      listDir: listDirFrom({
        "/proj": [{ name: "src", kind: "dir" }],
      }),
    });
    expect(out.kind).toBe("missing-config");
  });

  it("never lints node_modules as a chunk", async () => {
    const seen: string[] = [];
    await runEslintProjectChunked({
      binary: BINARY,
      runCommand: scriptedLint({}, seen),
      listDir: listDirFrom({
        "/proj": [
          { name: "node_modules", kind: "dir" },
          { name: "src", kind: "dir" },
        ],
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("'src'");
    // The binary path itself contains node_modules; the check is that
    // it was never passed as a lint target (quoted on its own).
    expect(seen[0]).not.toContain("'node_modules'");
  });
});
