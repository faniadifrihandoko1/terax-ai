import { describe, expect, it } from "vitest";
import {
  MAX_ESLINT_FILES,
  VERIFY_TOTAL_TIMEOUT_SECS,
  buildVerifyPlan,
  detectVerifyProject,
  formatVerifyReport,
  runPostConfirmVerification,
  type VerifyDeps,
  type VerifyOutcome,
} from "./verifyAfterConfirm";
import type { CommandOutput } from "@/modules/eslint/lib/eslintRunner";

function okOutput(stdout = "", stderr = ""): CommandOutput {
  return { stdout, stderr, exit_code: 0, timed_out: false };
}

function failOutput(stderr: string): CommandOutput {
  return { stdout: "", stderr, exit_code: 1, timed_out: false };
}

function timeoutOutput(): CommandOutput {
  return { stdout: "", stderr: "", exit_code: null, timed_out: true };
}

type FakeFs = {
  files: Map<string, string>;
  dirs: Set<string>;
};

function fakeDeps(fs: FakeFs, runImpl: (cmd: string) => CommandOutput) {
  const commands: { command: string; cwd: string; timeoutSecs: number }[] =
    [];
  const deps: VerifyDeps = {
    stat: async (p) => fs.files.has(p) || fs.dirs.has(p),
    readFile: async (p) => fs.files.get(p) ?? null,
    runCommand: async (command, opts) => {
      commands.push({
        command,
        cwd: opts.cwd,
        timeoutSecs: opts.timeoutSecs,
      });
      return runImpl(command);
    },
    resolveEslintBinary: async () => null,
    runEslintFile: async () => ({ kind: "ok", results: [] }),
    runEslintProjectChunked: async () => ({ kind: "ok", results: [] }),
  };
  return { deps, commands };
}

const PKG_SCRIPTS = JSON.stringify({
  scripts: {
    typecheck: "tsc --noEmit",
    lint: "eslint .",
    test: "vitest run",
  },
});

describe("buildVerifyPlan", () => {
  it("memakai script package.json dengan package manager proyek (npm)", () => {
    const plan = buildVerifyPlan(
      {
        root: "/proj",
        hasPackageJson: true,
        scripts: { typecheck: "tsc", lint: "eslint .", test: "vitest" },
        packageManager: "npm",
        hasTsconfig: true,
        tscAvailable: true,
      },
      ["/proj/src/a.ts"],
    );
    expect(plan).toEqual({
      checks: [
        { kind: "typecheck", mode: "shell", label: "typecheck", command: "npm run typecheck" },
        { kind: "lint", mode: "shell", label: "lint", command: "npm run lint" },
        { kind: "test", mode: "shell", label: "test", command: "npm run test" },
      ],
    });
  });

  it("memakai pnpm bila ada pnpm-lock.yaml", () => {
    const plan = buildVerifyPlan(
      {
        root: "/proj",
        hasPackageJson: true,
        scripts: { test: "vitest" },
        packageManager: "pnpm",
        hasTsconfig: false,
        tscAvailable: false,
      },
      [],
    );
    expect(plan).toEqual({
      checks: [
        { kind: "test", mode: "shell", label: "test", command: "pnpm run test" },
      ],
    });
  });

  it("tanpa script tapi ada tsconfig → fallback tsc --noEmit", () => {
    const plan = buildVerifyPlan(
      {
        root: "/proj",
        hasPackageJson: true,
        scripts: {},
        packageManager: "npm",
        hasTsconfig: true,
        tscAvailable: true,
      },
      ["/proj/src/a.ts"],
    );
    expect(plan).toEqual({
      checks: [
        {
          kind: "typecheck",
          mode: "shell",
          label: "typecheck",
          command: "npx --no-install tsc --noEmit",
        },
        {
          kind: "lint",
          mode: "eslint-files",
          label: "lint",
          targets: ["/proj/src/a.ts"],
        },
      ],
    });
  });

  it("tanpa script, tanpa tsconfig, tanpa file → tidak ada yang bisa diverifikasi", () => {
    const plan = buildVerifyPlan(
      {
        root: "/proj",
        hasPackageJson: true,
        scripts: {},
        packageManager: "npm",
        hasTsconfig: false,
        tscAvailable: false,
      },
      [],
    );
    expect(plan).toEqual({
      nothing:
        "tidak ada script typecheck/lint/test di package.json, tidak ada tsconfig, dan tidak ada file untuk di-lint",
    });
  });

  it("verifikasi manual tanpa file → lint project, bukan nothing", () => {
    const plan = buildVerifyPlan(
      {
        root: "/proj",
        hasPackageJson: true,
        scripts: {},
        packageManager: "npm",
        hasTsconfig: false,
        tscAvailable: false,
      },
      [],
      { manual: true },
    );
    expect(plan).toEqual({
      checks: [{ kind: "lint", mode: "eslint-project", label: "lint" }],
    });
  });

  it("file berubah lebih dari batas → lint project, bukan per file", () => {
    const files = Array.from({ length: MAX_ESLINT_FILES + 1 }, (_, i) => `/proj/src/f${i}.ts`);
    const plan = buildVerifyPlan(
      {
        root: "/proj",
        hasPackageJson: true,
        scripts: {},
        packageManager: "npm",
        hasTsconfig: false,
        tscAvailable: false,
      },
      files,
    );
    expect(plan).toEqual({
      checks: [
        { kind: "lint", mode: "eslint-project", label: "lint" },
      ],
    });
  });
});

describe("detectVerifyProject", () => {
  it("menemukan package.json dengan walk-up dan membaca script + lockfile", async () => {
    const fs: FakeFs = {
      files: new Map([
        ["/proj/package.json", PKG_SCRIPTS],
        ["/proj/pnpm-lock.yaml", ""],
        ["/proj/tsconfig.json", "{}"],
      ]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const { deps, commands } = fakeDeps(fs, () => okOutput("5.9.3"));
    const info = await detectVerifyProject("/proj/src/deep/a.ts", deps);
    expect(info.root).toBe("/proj");
    expect(info.hasPackageJson).toBe(true);
    expect(info.scripts).toEqual({
      typecheck: "tsc --noEmit",
      lint: "eslint .",
      test: "vitest run",
    });
    expect(info.packageManager).toBe("pnpm");
    expect(info.hasTsconfig).toBe(true);
    expect(info.tscAvailable).toBe(true);
    expect(commands.map((c) => c.command)).toEqual([
      "npx --no-install tsc --version",
    ]);
    expect(commands[0]?.cwd).toBe("/proj");
  });

  it("package.json rusak → script dianggap kosong, bukan throw", async () => {
    const fs: FakeFs = {
      files: new Map([["/proj/package.json", "{bukan json"]]),
      dirs: new Set(["/proj"]),
    };
    const { deps } = fakeDeps(fs, () => okOutput());
    const info = await detectVerifyProject("/proj/src/a.ts", deps);
    expect(info.hasPackageJson).toBe(true);
    expect(info.scripts).toEqual({});
    expect(info.packageManager).toBe("npm");
  });

  it("tanpa package.json dan tanpa tsconfig → root tetap direktori file", async () => {
    const fs: FakeFs = { files: new Map(), dirs: new Set(["/proj/src"]) };
    const { deps, commands } = fakeDeps(fs, () => okOutput());
    const info = await detectVerifyProject("/proj/src/a.ts", deps);
    expect(info.root).toBe("/proj/src");
    expect(info.hasPackageJson).toBe(false);
    expect(info.hasTsconfig).toBe(false);
    expect(info.tscAvailable).toBe(false);
    expect(commands).toEqual([]);
  });
});

describe("runPostConfirmVerification", () => {
  it("menjalankan script sesuai urutan dan lolos bila semua exit 0", async () => {
    const fs: FakeFs = {
      files: new Map([
        ["/proj/package.json", PKG_SCRIPTS],
        ["/proj/tsconfig.json", "{}"],
        ["/proj/src/a.ts", ""],
      ]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const { deps, commands } = fakeDeps(fs, (cmd) =>
      cmd.includes("tsc --version") ? okOutput("5.9.3") : okOutput(),
    );
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/a.ts"],
      deps,
    });
    expect(outcome.status).toBe("passed");
    expect(commands.map((c) => c.command)).toEqual([
      "npx --no-install tsc --version",
      "npm run typecheck",
      "npm run lint",
      "npm run test",
    ]);
    for (const c of commands) expect(c.cwd).toBe("/proj");
    expect(commands[1]?.timeoutSecs).toBeLessThanOrEqual(
      VERIFY_TOTAL_TIMEOUT_SECS,
    );
  });

  it("satu check gagal → berhenti (fail-fast), laporan menyebut check + ringkasan error", async () => {
    const fs: FakeFs = {
      files: new Map([["/proj/package.json", PKG_SCRIPTS]]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const { deps, commands } = fakeDeps(fs, (cmd) => {
      if (cmd.includes("tsc --version")) return okOutput("5.9.3");
      if (cmd === "npm run lint")
        return failOutput(
          "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/a.ts(20,3): error TS2339: Property 'x' does not exist.\n",
        );
      return okOutput();
    });
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/a.ts"],
      deps,
    });
    expect(outcome.status).toBe("failed");
    expect(commands.map((c) => c.command)).not.toContain("npm run test");
    if (outcome.status === "failed") {
      expect(outcome.checks.map((c) => c.kind)).toEqual([
        "typecheck",
        "lint",
      ]);
      expect(outcome.checks[1]?.status).toBe("failed");
      expect(outcome.checks[1]?.summary).toContain("TS2322");
    }
    const report = formatVerifyReport(outcome, ["/proj/src/a.ts"]);
    expect(report).toContain("lint");
    expect(report).toContain("TS2322");
    expect(report).not.toMatch(/auto-fix|otomatis memperbaiki/i);
  });

  it("timeout dilaporkan sebagai timeout, bukan gagal diam-diam", async () => {
    const fs: FakeFs = {
      files: new Map([["/proj/package.json", PKG_SCRIPTS]]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const { deps } = fakeDeps(fs, (cmd) =>
      cmd.includes("tsc --version") ? okOutput("5.9.3") : timeoutOutput(),
    );
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/a.ts"],
      deps,
    });
    expect(outcome.status).toBe("timeout");
    const report = formatVerifyReport(outcome, ["/proj/src/a.ts"]);
    expect(report).toContain("waktu habis");
    expect(report).toContain("typecheck");
  });

  it("tidak ada script, tsconfig, maupun file lintable → nothing-to-verify, bukan lolos", async () => {
    const fs: FakeFs = { files: new Map(), dirs: new Set(["/proj/src"]) };
    const { deps, commands } = fakeDeps(fs, () => okOutput());
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/a.ts"],
      deps,
    });
    expect(outcome.status).toBe("nothing-to-verify");
    expect(commands).toEqual([]);
    const report = formatVerifyReport(outcome, ["/proj/src/a.ts"]);
    expect(report).toContain("tidak ada yang bisa diverifikasi");
  });

  it("lint fallback memakai ESLint pada file yang berubah; pelanggaran → gagal", async () => {
    const fs: FakeFs = {
      files: new Map([
        ["/proj/tsconfig.json", "{}"],
        ["/proj/package.json", JSON.stringify({})],
        ["/proj/src/a.ts", "const x = 1;\n"],
      ]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const { deps } = fakeDeps(fs, (cmd) =>
      cmd.includes("tsc --version") ? okOutput("5.9.3") : okOutput(),
    );
    deps.resolveEslintBinary = async () => ({
      kind: "path",
      root: "/proj",
      binary: "/proj/node_modules/.bin/eslint",
    });
    deps.runEslintFile = async () => ({
      kind: "ok",
      results: [
        {
          filePath: "/proj/src/a.ts",
          messages: [
            {
              ruleId: "@typescript-eslint/no-unused-vars",
              severity: 2,
              message: "'x' is defined but never used.",
              line: 3,
              column: 7,
            },
          ],
          errorCount: 1,
          warningCount: 0,
          fatalErrorCount: 0,
        },
      ],
    });
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/a.ts"],
      deps,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.checks.map((c) => c.kind)).toEqual([
        "typecheck",
        "lint",
      ]);
      expect(outcome.checks[1]?.summary).toContain("1 pelanggaran");
    }
  });

  it("semua check ter-skip (mis. binary ESLint tidak ada) → nothing-to-verify", async () => {
    const fs: FakeFs = {
      files: new Map([["/proj/package.json", JSON.stringify({})]]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const { deps } = fakeDeps(fs, (cmd) =>
      cmd.includes("tsc --version")
        ? { stdout: "", stderr: "command not found", exit_code: 127, timed_out: false }
        : okOutput(),
    );
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/a.ts"],
      deps,
    });
    expect(outcome.status).toBe("nothing-to-verify");
  });

  it("ringkasan error dipotong: baris pertama saja, maksimal 1000 karakter", async () => {
    const fs: FakeFs = {
      files: new Map([["/proj/package.json", PKG_SCRIPTS]]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const longError = Array.from(
      { length: 50 },
      (_, i) => `src/a.ts(${i},1): error TS0000: baris error ke-${i} yang sangat panjang `.repeat(5),
    ).join("\n");
    const { deps } = fakeDeps(fs, (cmd) => {
      if (cmd.includes("tsc --version")) return okOutput("5.9.3");
      if (cmd === "npm run typecheck") return failOutput(longError);
      return okOutput();
    });
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/a.ts"],
      deps,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      const summary = outcome.checks[0]?.summary ?? "";
      expect(summary.length).toBeLessThanOrEqual(1000);
      expect(summary).toContain("baris error ke-0");
      expect(summary).not.toContain("baris error ke-49");
    }
  });

  it("file yang sudah dihapus tidak di-lint (dilewati, bukan gagal)", async () => {
    const fs: FakeFs = {
      files: new Map([["/proj/package.json", JSON.stringify({})]]),
      dirs: new Set(["/proj/src", "/proj"]),
    };
    const { deps } = fakeDeps(fs, () => okOutput());
    deps.resolveEslintBinary = async () => ({
      kind: "path",
      root: "/proj",
      binary: "/proj/node_modules/.bin/eslint",
    });
    const linted: string[] = [];
    deps.runEslintFile = async (args) => {
      linted.push(args.file);
      return { kind: "ok", results: [] };
    };
    const outcome = await runPostConfirmVerification({
      sessionId: "s1",
      files: ["/proj/src/gone.ts"],
      deps,
    });
    expect(linted).toEqual([]);
    expect(outcome.status).toBe("nothing-to-verify");
  });
});

describe("formatVerifyReport", () => {
  it("lolos menyebut semua check dan file", () => {
    const outcome: VerifyOutcome = {
      status: "passed",
      checks: [
        { kind: "typecheck", label: "typecheck", status: "passed", durationMs: 3000 },
        { kind: "lint", label: "lint", status: "passed", durationMs: 1000 },
      ],
      durationMs: 4000,
      files: ["/proj/src/a.ts"],
    };
    const report = formatVerifyReport(outcome, ["/proj/src/a.ts"]);
    expect(report).toContain("lolos");
    expect(report).toContain("typecheck");
    expect(report).toContain("a.ts");
  });
});
