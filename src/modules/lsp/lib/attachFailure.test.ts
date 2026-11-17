import { beforeEach, describe, expect, it } from "vitest";

import {
  attachFailureReason,
  clearAttachFailure,
  recordAttachFailure,
} from "./attachFailure";
import type { LspPreset } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";

const tsPreset: LspPreset = {
  id: "typescript",
  name: "TypeScript",
  command: "typescript-language-server",
  args: ["--stdio"],
  languages: {
    typescript: "typescript",
    typescriptreact: "typescriptreact",
  },
  rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
};

describe("attachFailureReason", () => {
  it("binary-missing names the command and tells the user how to recover", () => {
    const reason = attachFailureReason(tsPreset, "binary-missing");
    expect(reason).toContain("typescript-language-server");
    expect(reason).toContain("not found");
    expect(reason).toContain("Restart");
  });

  it("no-root lists the markers that were looked for and the file", () => {
    const reason = attachFailureReason(tsPreset, "no-root", {
      path: "C:\\proj\\modernize-next-free\\src\\app\\container.tsx",
    });
    expect(reason).toContain("tsconfig.json");
    expect(reason).toContain("jsconfig.json");
    expect(reason).toContain("package.json");
    expect(reason).toContain("container.tsx");
  });

  it("no-root falls back to .git when the preset has no root markers", () => {
    const preset: LspPreset = { ...tsPreset, rootMarkers: [] };
    const reason = attachFailureReason(preset, "no-root");
    expect(reason).toContain(".git");
  });

  it("crashed-out says the server kept crashing and offers a retry", () => {
    const reason = attachFailureReason(tsPreset, "crashed-out");
    expect(reason).toContain("crash");
    expect(reason).toContain("Restart");
  });

  it("session-cap names the cap that was hit", () => {
    const reason = attachFailureReason(tsPreset, "session-cap", {
      maxSessions: 4,
    });
    expect(reason).toContain("4");
    expect(reason).toContain("Restart");
  });

  it("initialize-failed says the server never finished starting", () => {
    const reason = attachFailureReason(tsPreset, "initialize-failed");
    expect(reason).toContain("initializ");
    expect(reason).toContain("Restart");
  });
});

describe("recordAttachFailure / clearAttachFailure", () => {
  beforeEach(() => {
    useLspRuntimeStore.setState({ failed: {} });
  });

  it("records the reason in the runtime store so the status pill shows it", () => {
    recordAttachFailure("typescript", "boom");
    expect(useLspRuntimeStore.getState().failed.typescript).toBe("boom");
  });

  it("overwrites a previous reason for the same preset", () => {
    recordAttachFailure("typescript", "first");
    recordAttachFailure("typescript", "second");
    expect(useLspRuntimeStore.getState().failed.typescript).toBe("second");
  });

  it("clears the failure once the preset attaches again", () => {
    recordAttachFailure("typescript", "boom");
    clearAttachFailure("typescript");
    expect(useLspRuntimeStore.getState().failed.typescript).toBeUndefined();
  });

  it("clearing a preset that never failed is a no-op", () => {
    clearAttachFailure("typescript");
    expect(useLspRuntimeStore.getState().failed).toEqual({});
  });
});
