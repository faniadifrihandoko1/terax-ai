import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { toast } from "sonner";
import { useDiagnosticsStore } from "@/modules/editor/lib/diagnosticsStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setEslintEditorPresence } from "./eslintRequests";
import {
  clearEslintBinaryCache,
  type RunCommand,
} from "./eslintRunner";
import { useEslintStore } from "./eslintStore";
import { requestEslintProjectLint } from "./runEslintProject";

const ROOT = "/proj";

const projectJson = JSON.stringify([
  {
    filePath: "/proj/src/a.ts",
    messages: [
      {
        ruleId: "no-unused-vars",
        severity: 2,
        message: "'x' is assigned a value but never used.",
        line: 3,
        column: 5,
      },
      {
        ruleId: "no-console",
        severity: 1,
        message: "Unexpected console statement.",
        line: 8,
        column: 1,
      },
    ],
    errorCount: 1,
    warningCount: 1,
    fatalErrorCount: 0,
  },
  {
    filePath: "/proj/src/clean.ts",
    messages: [],
    errorCount: 0,
    warningCount: 0,
    fatalErrorCount: 0,
  },
]);

function fakeLint(output: {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  timed_out?: boolean;
  truncated?: boolean;
}): RunCommand {
  return async () => ({
    stdout: output.stdout ?? "",
    stderr: output.stderr ?? "",
    exit_code: output.exit_code ?? 1,
    timed_out: output.timed_out ?? false,
    truncated: output.truncated ?? false,
  });
}

const foundBinary = {
  stat: async (p: string) => p === "/proj/node_modules/.bin/eslint",
  windows: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearEslintBinaryCache();
  useEslintStore.setState({
    projectLint: { status: { kind: "idle" }, files: [] },
    notifiedRoots: {},
  });
  useDiagnosticsStore.setState({ byPath: {} });
  usePreferencesStore.setState({ eslintEnabled: true });
});

afterEach(() => {
  setEslintEditorPresence("/proj/src/a.ts", null);
});

describe("requestEslintProjectLint", () => {
  it("refuses to run when ESLint diagnostics are off", async () => {
    usePreferencesStore.setState({ eslintEnabled: false });
    await requestEslintProjectLint(ROOT, foundBinary);
    expect(toast.warning).toHaveBeenCalledWith(
      "ESLint diagnostics mati",
      expect.anything(),
    );
    expect(useEslintStore.getState().projectLint.status.kind).toBe("idle");
  });

  it("refuses to run without a project root", async () => {
    await requestEslintProjectLint(null, foundBinary);
    expect(toast.warning).toHaveBeenCalledWith(
      "Tidak ada project terbuka",
      expect.anything(),
    );
  });

  it("reports a missing binary with the walk diagnosis", async () => {
    const runCommand = fakeLint({ stdout: "9.0.0", exit_code: 0 });
    await requestEslintProjectLint(ROOT, {
      stat: async () => false,
      runCommand: async (cmd, opts) =>
        cmd.includes("npx") && cmd.includes("--version")
          ? { stdout: "", stderr: "", exit_code: 1, timed_out: false }
          : runCommand(cmd, opts),
      windows: false,
    });
    const status = useEslintStore.getState().projectLint.status;
    expect(status.kind).toBe("missing-binary");
    expect(toast.warning).toHaveBeenCalledWith(
      "ESLint: binary tidak ditemukan",
      expect.objectContaining({
        description: expect.stringContaining("fs_stat gagal"),
      }),
    );
  });

  it("fills the panel and the explorer counts on success", async () => {
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ stdout: projectJson, exit_code: 1 }),
    });
    const { status, files } = useEslintStore.getState().projectLint;
    expect(status).toEqual({
      kind: "ok",
      root: ROOT,
      errors: 1,
      warnings: 1,
      files: 1,
      at: expect.any(Number),
    });
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/proj/src/a.ts");
    expect(useDiagnosticsStore.getState().byPath["/proj/src/a.ts"]).toEqual({
      errors: 1,
      warnings: 1,
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Lint project selesai",
      expect.objectContaining({
        description: "1 error · 1 warning di 1 file",
      }),
    );
  });

  it("keeps per-file counts for open files and still lists them", async () => {
    setEslintEditorPresence("/proj/src/a.ts", "ready");
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ stdout: projectJson, exit_code: 1 }),
    });
    expect(useDiagnosticsStore.getState().byPath["/proj/src/a.ts"]).toBeUndefined();
    expect(useEslintStore.getState().projectLint.files).toHaveLength(1);
  });

  it("clears stale counts for files that are clean now", async () => {
    useDiagnosticsStore
      .getState()
      .report("/proj/src/old.ts", { errors: 2, warnings: 0 });
    useEslintStore.setState({
      projectLint: {
        status: {
          kind: "ok",
          root: ROOT,
          errors: 2,
          warnings: 0,
          files: 1,
          at: 1,
        },
        files: [{ path: "/proj/src/old.ts", errors: 2, warnings: 0, messages: [] }],
      },
    });
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ stdout: projectJson, exit_code: 1 }),
    });
    expect(
      useDiagnosticsStore.getState().byPath["/proj/src/old.ts"],
    ).toBeUndefined();
  });

  it("marks a truncated run as incomplete, never as clean", async () => {
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({
        stdout: projectJson,
        exit_code: 1,
        truncated: true,
      }),
    });
    expect(useEslintStore.getState().projectLint.status.kind).toBe(
      "truncated",
    );
    expect(useEslintStore.getState().projectLint.files).toEqual([]);
    expect(toast.warning).toHaveBeenCalledWith(
      "Hasil lint project tidak lengkap",
      expect.objectContaining({
        description: expect.stringContaining("256 KiB"),
      }),
    );
  });

  it("records timeout, missing config, and failure", async () => {
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ timed_out: true }),
    });
    expect(useEslintStore.getState().projectLint.status.kind).toBe("timeout");

    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({
        stderr: "Could not find config file",
        exit_code: 2,
      }),
    });
    expect(useEslintStore.getState().projectLint.status.kind).toBe(
      "missing-config",
    );

    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ stderr: "boom", exit_code: 2 }),
    });
    const failed = useEslintStore.getState().projectLint.status;
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") expect(failed.message).toBe("boom");
  });

  it("refuses a second run while one is active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCommand: RunCommand = async () => {
      await gate;
      return { stdout: projectJson, stderr: "", exit_code: 1, timed_out: false };
    };
    const first = requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useEslintStore.getState().projectLint.status.kind).toBe("running");
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ stdout: projectJson, exit_code: 1 }),
    });
    expect(toast.warning).toHaveBeenCalledWith(
      "Lint project masih berjalan",
      expect.anything(),
    );
    release();
    await first;
    expect(useEslintStore.getState().projectLint.status.kind).toBe("ok");
  });
});

describe("requestEslintProjectLint with source auto (Fase 15)", () => {
  it("fills the panel silently on success", async () => {
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ stdout: projectJson, exit_code: 1 }),
      source: "auto",
    });
    expect(useEslintStore.getState().projectLint.status.kind).toBe("ok");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("reports a failure only once per root per session", async () => {
    const deps = {
      ...foundBinary,
      runCommand: fakeLint({ stderr: "boom", exit_code: 2 }),
      source: "auto" as const,
    };
    await requestEslintProjectLint(ROOT, deps);
    await requestEslintProjectLint(ROOT, deps);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "Lint project gagal",
      expect.anything(),
    );
  });

  it("returns silently when a run is already active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCommand: RunCommand = async () => {
      await gate;
      return { stdout: projectJson, stderr: "", exit_code: 1, timed_out: false };
    };
    const first = requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand,
      source: "auto",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand: fakeLint({ stdout: projectJson, exit_code: 1 }),
      source: "auto",
    });
    expect(toast.warning).not.toHaveBeenCalled();
    release();
    await first;
    expect(useEslintStore.getState().projectLint.status.kind).toBe("ok");
  });

  it("is silent when ESLint diagnostics are off", async () => {
    usePreferencesStore.setState({ eslintEnabled: false });
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      source: "auto",
    });
    expect(toast.warning).not.toHaveBeenCalled();
    expect(useEslintStore.getState().projectLint.status.kind).toBe("idle");
  });

  it("manual run uses the chunked engine and merges the chunks", async () => {
    const seen: string[] = [];
    const runCommand: RunCommand = async (cmd) => {
      seen.push(cmd);
      if (cmd.includes("'src'")) {
        return {
          stdout: projectJson,
          stderr: "",
          exit_code: 1,
          timed_out: false,
        };
      }
      return {
        stdout: JSON.stringify([]),
        stderr: "",
        exit_code: 0,
        timed_out: false,
      };
    };
    await requestEslintProjectLint(ROOT, {
      ...foundBinary,
      runCommand,
      listDir: async () => [
        { name: "src", kind: "dir" },
        { name: "lib", kind: "dir" },
      ],
    });
    // Chunks run in sorted order (buildProjectLintChunks sorts by name).
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("'lib'");
    expect(seen[1]).toContain("'src'");
    expect(useEslintStore.getState().projectLint.files).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith(
      "Lint project selesai",
      expect.anything(),
    );
  });
});
