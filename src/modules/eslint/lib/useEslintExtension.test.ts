import { beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { toast } from "sonner";
import { useEslintStore } from "./eslintStore";
import {
  notifyEslintDiskReadFailed,
  notifyEslintNoResultMatch,
  notifyEslintRunFailed,
} from "./useEslintExtension";

beforeEach(() => {
  vi.clearAllMocks();
  useEslintStore.setState({ notifiedRoots: {} });
});

describe("notifyEslintRunFailed", () => {
  it("warns once per root and passes the failure message through", () => {
    notifyEslintRunFailed("/proj", "ESLint timed out");
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("ESLint gagal dijalankan", {
      description: "ESLint timed out",
    });
    expect(useEslintStore.getState().notifiedRoots["/proj"]).toBe(true);
  });

  it("does not repeat the toast for the same root", () => {
    notifyEslintRunFailed("/proj", "ESLint timed out");
    notifyEslintRunFailed("/proj", "boom");
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });

  it("warns again for a different root", () => {
    notifyEslintRunFailed("/proj", "ESLint timed out");
    notifyEslintRunFailed("/other", "boom");
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });

  it("falls back to a helpful description when the message is empty", () => {
    notifyEslintRunFailed("/proj", "");
    expect(toast.warning).toHaveBeenCalledWith("ESLint gagal dijalankan", {
      description: expect.stringContaining("Settings"),
    });
  });
});

describe("notifyEslintDiskReadFailed", () => {
  it("names the unreadable file and warns once per root", () => {
    notifyEslintDiskReadFailed("/proj", "/proj/src/a.ts");
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(
      "ESLint gagal membaca file",
      { description: expect.stringContaining("/proj/src/a.ts") },
    );
    notifyEslintDiskReadFailed("/proj", "/proj/src/b.ts");
    expect(toast.warning).toHaveBeenCalledTimes(1);
  });
});

describe("notifyEslintNoResultMatch", () => {
  it("names the expected path and the path ESLint returned", () => {
    notifyEslintNoResultMatch("/proj", {
      filePath: "/proj/src/a.ts",
      returnedPaths: ["/PROJ/src/a.ts"],
    });
    const calls = vi.mocked(toast.warning).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("ESLint: hasil tidak cocok");
    expect(calls[0][1]?.description).toContain("/proj/src/a.ts");
    expect(calls[0][1]?.description).toContain("/PROJ/src/a.ts");
    // Once per root: a second mismatch for the same root stays silent.
    notifyEslintNoResultMatch("/proj", {
      filePath: "/proj/src/b.ts",
      returnedPaths: [],
    });
    expect(vi.mocked(toast.warning).mock.calls).toHaveLength(1);
  });
});
