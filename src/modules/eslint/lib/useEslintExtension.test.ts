import { beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { toast } from "sonner";
import { useEslintStore } from "./eslintStore";
import { notifyEslintRunFailed } from "./useEslintExtension";

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
