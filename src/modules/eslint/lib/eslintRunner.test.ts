import { exec } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEslintCommand,
  buildEslintProjectCommand,
  clearEslintBinaryCache,
  PROJECT_LINT_TIMEOUT_SECS,
  resolveEslintBinary,
  runEslintFile,
  runEslintProject,
  type CommandOutput,
  type RunCommand,
} from "./eslintRunner";

const okJson = JSON.stringify([
  {
    filePath: "/proj/a.ts",
    messages: [
      {
        ruleId: "no-console",
        severity: 2,
        message: "Unexpected console statement.",
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 8,
      },
    ],
    errorCount: 1,
    warningCount: 0,
    fatalErrorCount: 0,
  },
]);

function fakeRun(output: Partial<CommandOutput>): RunCommand {
  return async () => ({
    stdout: "",
    stderr: "",
    exit_code: 0,
    timed_out: false,
    ...output,
  });
}

describe("buildEslintCommand", () => {
  it("quotes a binary path with spaces", () => {
    const cmd = buildEslintCommand(
      { kind: "path", root: "/proj", binary: "/my proj/node_modules/.bin/eslint" },
      "/proj/a file.ts",
    );
    expect(cmd).toContain("'/my proj/node_modules/.bin/eslint'");
    expect(cmd).toContain("--format json");
    expect(cmd).toContain("'/proj/a file.ts'");
  });

  it("uses npx without install for the npx binary", () => {
    const cmd = buildEslintCommand(
      { kind: "npx", root: "/proj" },
      "/proj/a.ts",
    );
    expect(cmd.startsWith("npx --no-install eslint ")).toBe(true);
  });
});

describe("runEslintFile", () => {
  it("treats exit 1 with valid JSON as ok", async () => {
    const res = await runEslintFile({
      binary: { kind: "path", root: "/proj", binary: "/proj/eslint" },
      file: "/proj/a.ts",
      runCommand: fakeRun({ stdout: okJson, exit_code: 1 }),
    });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.results[0].messages).toHaveLength(1);
    }
  });

  it("treats exit 0 with an empty list as ok", async () => {
    const res = await runEslintFile({
      binary: { kind: "path", root: "/proj", binary: "/proj/eslint" },
      file: "/proj/a.ts",
      runCommand: fakeRun({ stdout: "[]", exit_code: 0 }),
    });
    expect(res).toEqual({ kind: "ok", results: [] });
  });

  it("detects a missing config on exit 2", async () => {
    const res = await runEslintFile({
      binary: { kind: "path", root: "/proj", binary: "/proj/eslint" },
      file: "/proj/a.ts",
      runCommand: fakeRun({
        stdout: "",
        stderr: "ESLint couldn't find a configuration file.",
        exit_code: 2,
      }),
    });
    expect(res).toEqual({ kind: "missing-config" });
  });

  it("reports other exit 2 failures with the stderr tail", async () => {
    const res = await runEslintFile({
      binary: { kind: "path", root: "/proj", binary: "/proj/eslint" },
      file: "/proj/a.ts",
      runCommand: fakeRun({ stderr: "boom", exit_code: 2 }),
    });
    expect(res).toEqual({ kind: "failed", message: "boom" });
  });

  it("reports timeouts and malformed JSON", async () => {
    const timeout = await runEslintFile({
      binary: { kind: "path", root: "/proj", binary: "/proj/eslint" },
      file: "/proj/a.ts",
      runCommand: fakeRun({ timed_out: true }),
    });
    expect(timeout).toEqual({ kind: "timeout" });
    const bad = await runEslintFile({
      binary: { kind: "path", root: "/proj", binary: "/proj/eslint" },
      file: "/proj/a.ts",
      runCommand: fakeRun({ stdout: "garbage", exit_code: 0 }),
    });
    expect(bad.kind).toBe("failed");
  });

  it("reports a truncated run as a failure", async () => {
    const res = await runEslintFile({
      binary: { kind: "path", root: "/proj", binary: "/proj/eslint" },
      file: "/proj/a.ts",
      runCommand: fakeRun({ stdout: okJson, exit_code: 1, truncated: true }),
    });
    expect(res.kind).toBe("failed");
  });
});

describe("runEslintProject", () => {
  const binary = {
    kind: "path",
    root: "/proj",
    binary: "/proj/node_modules/.bin/eslint",
  } as const;

  it("lints the binary root with a longer timeout", async () => {
    const seen = { command: "", cwd: "", timeoutSecs: 0 };
    const runCommand: RunCommand = async (command, opts) => {
      seen.command = command;
      seen.cwd = opts.cwd;
      seen.timeoutSecs = opts.timeoutSecs;
      return { stdout: okJson, stderr: "", exit_code: 1, timed_out: false };
    };
    const res = await runEslintProject({ binary, runCommand });
    expect(res.kind).toBe("ok");
    expect(seen.cwd).toBe("/proj");
    expect(seen.timeoutSecs).toBe(PROJECT_LINT_TIMEOUT_SECS);
    expect(seen.command).toContain("--format json");
    expect(buildEslintProjectCommand(binary)).toContain("'.'");
  });

  it("returns truncated as its own outcome, not a failure", async () => {
    const res = await runEslintProject({
      binary,
      runCommand: fakeRun({
        stdout: okJson,
        exit_code: 1,
        truncated: true,
      }),
    });
    expect(res).toEqual({ kind: "truncated" });
  });

  it("maps missing config, timeout, and spawn failures", async () => {
    const noConfig = await runEslintProject({
      binary,
      runCommand: fakeRun({
        stderr: "Could not find config file",
        exit_code: 2,
      }),
    });
    expect(noConfig).toEqual({ kind: "missing-config" });
    const timeout = await runEslintProject({
      binary,
      runCommand: fakeRun({ timed_out: true }),
    });
    expect(timeout).toEqual({ kind: "timeout" });
    const failed = await runEslintProject({
      binary,
      runCommand: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(failed).toEqual({ kind: "failed", message: "Error: spawn ENOENT" });
  });
});

describe("resolveEslintBinary", () => {
  it("prefers the project binary and caches it", async () => {
    clearEslintBinaryCache();
    let probes = 0;
    const runCommand: RunCommand = async () => {
      probes += 1;
      return { stdout: "", stderr: "", exit_code: 1, timed_out: false };
    };
    const deps = {
      stat: async (p: string) => p === "/proj/node_modules/.bin/eslint",
      runCommand,
      windows: false,
    };
    const first = await resolveEslintBinary("/proj/src/a.ts", deps);
    const second = await resolveEslintBinary("/proj/src/a.ts", deps);
    expect(first).toEqual({
      binary: {
        kind: "path",
        root: "/proj",
        binary: "/proj/node_modules/.bin/eslint",
      },
      detection: {
        status: "found",
        root: "/proj",
        binary: "/proj/node_modules/.bin/eslint",
      },
    });
    expect(second).toEqual(first);
    expect(probes).toBe(0);
  });

  it("falls back to npx and returns null when nothing exists", async () => {
    clearEslintBinaryCache();
    const npxOk: RunCommand = async (cmd) => ({
      stdout: "9.0.0",
      stderr: "",
      exit_code: cmd.includes("npx") ? 0 : 1,
      timed_out: false,
    });
    const npx = await resolveEslintBinary("/proj/src/a.ts", {
      stat: async () => false,
      runCommand: npxOk,
      windows: false,
    });
    expect(npx).toEqual({
      binary: { kind: "npx", root: "/proj/src" },
      detection: {
        status: "missing",
        searchedLevels: 3,
        truncatedByCap: false,
        controlStatFailed: true,
      },
    });

    clearEslintBinaryCache();
    const none = await resolveEslintBinary("/proj/src/a.ts", {
      stat: async () => false,
      runCommand: fakeRun({ exit_code: 1 }),
      windows: false,
    });
    expect(none.binary).toBeNull();
    expect(none.detection).toEqual({
      status: "missing",
      searchedLevels: 3,
      truncatedByCap: false,
      controlStatFailed: true,
    });
  });
});

describe("runEslintFile with a real spawned process", () => {
  it("spawns a fixture eslint and parses its JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "terax-eslint-"));
    const binDir = join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const bin = join(binDir, "eslint");
    writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s' '${okJson.replace(/'/g, "'\\''")}'\nexit 1\n`,
    );
    chmodSync(bin, 0o755);
    const file = join(dir, "a.ts");
    writeFileSync(file, "console.log(1);\n");

    const execRun: RunCommand = (command, opts) =>
      new Promise((resolve) => {
        exec(
          command,
          { cwd: opts.cwd, timeout: opts.timeoutSecs * 1000 },
          (error, stdout, stderr) => {
            resolve({
              stdout,
              stderr,
              exit_code:
                error && typeof error === "object" && "code" in error
                  ? (error.code as number)
                  : 0,
              timed_out: false,
            });
          },
        );
      });

    const res = await runEslintFile({
      binary: { kind: "path", root: dir, binary: bin },
      file,
      runCommand: execRun,
    });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.results[0].messages[0].ruleId).toBe("no-console");
    }
  });
});
