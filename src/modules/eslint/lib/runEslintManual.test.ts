import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

import { toast } from "sonner";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  onEslintRunRequested,
  setEslintEditorPresence,
} from "./eslintRequests";
import { useEslintStore, type EslintRunStatus } from "./eslintStore";
import {
  MANUAL_RUN_TIMEOUT_MS,
  requestEslintRunWithReport,
} from "./runEslintManual";

const PATH = "/proj/src/a.ts";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  useEslintStore.setState({ runStatus: {}, notifiedRoots: {} });
  usePreferencesStore.setState({ eslintEnabled: true });
});

// Listeners registered by a test must not leak into the next one:
// a leaked listener answers the next test's run request first, so
// its waiter reports the previous test's outcome.
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
  // Presence entries registered by a test must not leak into the next one.
  setEslintEditorPresence(PATH, null);
});

/** A fake editor plugin: answers a run request by recording a status. */
function answerRun(status: EslintRunStatus) {
  cleanups.push(
    onEslintRunRequested(PATH, () => {
      useEslintStore.getState().setRunStatus(PATH, status);
    }),
  );
}

describe("requestEslintRunWithReport", () => {
  it("reports the error/warning counts on success", async () => {
    answerRun({ kind: "ok", errors: 1, warnings: 1 });
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("ESLint: 1 error · 1 warning", {
      description: expect.stringContaining("1 error"),
    });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("reports a clean run as success", async () => {
    answerRun({ kind: "ok", errors: 0, warnings: 0 });
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.success).toHaveBeenCalledWith("ESLint: bersih", {
      description: expect.stringContaining("tidak menemukan"),
    });
  });

  it("waits past the running status and reports the terminal one", async () => {
    cleanups.push(
      onEslintRunRequested(PATH, () => {
        const store = useEslintStore.getState();
        store.setRunStatus(PATH, { kind: "running" });
        store.setRunStatus(PATH, { kind: "skipped-dirty" });
      }),
    );
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("ESLint: menunggu save", {
      description: expect.stringContaining("Ctrl+S"),
    });
  });

  it("warns immediately when ESLint diagnostics are off", async () => {
    usePreferencesStore.setState({ eslintEnabled: false });
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.warning).toHaveBeenCalledWith(
      "ESLint diagnostics mati",
      { description: expect.stringContaining("Settings") },
    );
  });

  it("warns immediately when no editor listens for the path", async () => {
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.warning).toHaveBeenCalledWith(
      "Tidak ada editor ESLint untuk file ini",
      { description: expect.stringContaining("tab review (ai-diff)") },
    );
  });

  it("says the editor is still loading when presence is loading", async () => {
    setEslintEditorPresence(PATH, "loading");
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.warning).toHaveBeenCalledWith("Editor masih memuat file", {
      description: expect.stringContaining("masih dibaca dari disk"),
    });
  });

  it("says the plugin is still attaching when the editor is ready but has no listener", async () => {
    setEslintEditorPresence(PATH, "ready");
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.warning).toHaveBeenCalledWith("Editor ESLint belum siap", {
      description: expect.stringContaining("masih dipasang"),
    });
  });

  it("says the file cannot be opened when presence is unavailable", async () => {
    setEslintEditorPresence(PATH, "unavailable");
    requestEslintRunWithReport(PATH);
    await Promise.resolve();
    expect(toast.warning).toHaveBeenCalledWith(
      "File tidak bisa dibuka di editor",
      { description: expect.stringContaining("Tutup dan buka lagi") },
    );
  });

  it("warns when no terminal status arrives before the timeout", () => {
    vi.useFakeTimers();
    // A listener exists, but it never records a status.
    cleanups.push(onEslintRunRequested(PATH, () => {}));
    requestEslintRunWithReport(PATH);
    expect(toast.warning).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MANUAL_RUN_TIMEOUT_MS);
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith("ESLint belum selesai", {
      description: expect.stringContaining("35 detik"),
    });
  });
});
