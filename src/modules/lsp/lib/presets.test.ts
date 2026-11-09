import { describe, expect, it } from "vitest";
import type { LspCustomServer } from "@/modules/settings/store";
import {
  allServers,
  LSP_PRESETS,
  serverById,
  serverForLanguage,
  serversForLanguage,
  serversForLanguageEnabled,
} from "./presets";

const customPy: LspCustomServer = {
  id: "my-py",
  name: "Mine",
  command: "x",
  args: [],
  languages: { py: "python" },
  rootMarkers: [],
};

describe("serversForLanguage", () => {
  it("returns the built-in servers that claim a language", () => {
    expect(serversForLanguage("py", []).map((p) => p.id)).toEqual([
      "pyright",
      "ruff",
    ]);
  });

  it("includes matching custom servers after the presets", () => {
    expect(serversForLanguage("py", [customPy]).map((p) => p.id)).toEqual([
      "pyright",
      "ruff",
      "my-py",
    ]);
  });

  it("returns nothing for a null or unknown language", () => {
    expect(serversForLanguage(null, [])).toEqual([]);
    expect(serversForLanguage("cobol", [])).toEqual([]);
  });
});

describe("serverForLanguage", () => {
  it("returns the first candidate when no activation is given", () => {
    expect(serverForLanguage("py", [])?.id).toBe("pyright");
  });

  it("prefers the enabled server over preset order", () => {
    expect(serverForLanguage("py", [], { ruff: "enabled" })?.id).toBe("ruff");
  });

  it("skips a dismissed server and offers the next fresh one", () => {
    expect(serverForLanguage("py", [], { pyright: "dismissed" })?.id).toBe(
      "ruff",
    );
  });

  it("returns null when nothing claims the language", () => {
    expect(serverForLanguage("cobol", [])).toBeNull();
  });
});

describe("serverById", () => {
  it("finds a preset by id", () => {
    expect(serverById("pyright", [])?.id).toBe("pyright");
  });

  it("finds a custom server by id", () => {
    expect(serverById("my-py", [customPy])?.name).toBe("Mine");
  });

  it("returns null for an unknown id", () => {
    expect(serverById("nope", [])).toBeNull();
  });
});

describe("allServers", () => {
  it("appends custom servers to the presets", () => {
    const servers = allServers([customPy]);
    expect(servers).toHaveLength(LSP_PRESETS.length + 1);
    expect(servers.map((s) => s.id)).toEqual([
      ...LSP_PRESETS.map((p) => p.id),
      "my-py",
    ]);
  });
});

describe("eslint preset (Fase 12)", () => {
  it("is registered with the VS Code server binary and stdio args", () => {
    const preset = serverById("eslint", []);
    expect(preset?.command).toBe("vscode-eslint-language-server");
    expect(preset?.args).toEqual(["--stdio"]);
    expect(preset?.install?.command).toBe(
      "npm install -g vscode-langservers-extracted",
    );
  });

  it("claims the same languages as TypeScript, so both can serve one file", () => {
    expect(serversForLanguage("tsx", []).map((p) => p.id)).toEqual([
      "typescript",
      "eslint",
    ]);
    expect(serversForLanguage("js", []).map((p) => p.id)).toEqual([
      "typescript",
      "eslint",
    ]);
  });

  it("carries a shaped workspace/configuration answer and pulls diagnostics", () => {
    const preset = serverById("eslint", []);
    expect(preset?.pullDiagnostics).toBe(true);
    const config = preset?.workspaceConfiguration as
      | Record<string, unknown>
      | undefined;
    // The server crashes on a null or empty answer; the shaped
    // defaults (validate probe, nodePath null) are load-bearing.
    expect(config?.validate).toBe("probe");
    expect(config?.nodePath).toBeNull();
    expect(config?.problems).toEqual({ shortenToSingleLine: false });
  });

  it("recognises legacy and flat config markers plus package.json", () => {
    const preset = serverById("eslint", []);
    expect(preset?.rootMarkers).toContain(".eslintrc.json");
    expect(preset?.rootMarkers).toContain("eslint.config.js");
    expect(preset?.rootMarkers).toContain("package.json");
  });
});

describe("serversForLanguageEnabled", () => {
  it("returns TS + ESLint for tsx when both are enabled", () => {
    expect(
      serversForLanguageEnabled("tsx", [], {
        typescript: "enabled",
        eslint: "enabled",
      }).map((p) => p.id),
    ).toEqual(["typescript", "eslint"]);
  });

  it("returns only the enabled ones", () => {
    expect(
      serversForLanguageEnabled("tsx", [], { typescript: "enabled" }).map(
        (p) => p.id,
      ),
    ).toEqual(["typescript"]);
  });

  it("returns nothing without an activation map", () => {
    expect(serversForLanguageEnabled("tsx", [])).toEqual([]);
  });
});
