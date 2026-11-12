import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("./runEslintProject", () => ({
  requestEslintProjectLint: requestMock,
}));

import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  AUTO_PROJECT_LINT_DEBOUNCE_MS,
  cancelScheduledEslintProjectLint,
  scheduleEslintProjectLint,
  scheduleEslintProjectLintForFile,
} from "./eslintAutoProjectLint";
import { useEslintStore } from "./eslintStore";

const ROOT = "/proj";

function setStatus(kind: "idle" | "running"): void {
  useEslintStore.setState({
    projectLint: {
      status:
        kind === "idle"
          ? { kind: "idle" }
          : { kind: "running", root: ROOT, startedAt: 1 },
      files: [],
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  cancelScheduledEslintProjectLint();
  usePreferencesStore.setState({
    eslintEnabled: true,
    eslintAutoProjectLint: true,
  });
  setStatus("idle");
});

afterEach(() => {
  cancelScheduledEslintProjectLint();
  vi.useRealTimers();
});

describe("scheduleEslintProjectLint", () => {
  it("runs once after the debounce, as an auto run", () => {
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS - 1);
    expect(requestMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(ROOT, { source: "auto" });
  });

  it("debounces repeated schedules into one run", () => {
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(1000);
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(1000);
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS - 1);
    expect(requestMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the auto toggle is off", () => {
    usePreferencesStore.setState({ eslintAutoProjectLint: false });
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS * 2);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("does nothing when ESLint diagnostics are off", () => {
    usePreferencesStore.setState({ eslintEnabled: false });
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS * 2);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("drops a pending run when the toggle is switched off mid-debounce", () => {
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(1000);
    usePreferencesStore.setState({ eslintAutoProjectLint: false });
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("cancels the pending run for a null root", () => {
    scheduleEslintProjectLint(ROOT);
    scheduleEslintProjectLint(null);
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS * 2);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("re-arms while a run is active and fires after it ends", () => {
    setStatus("running");
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS);
    expect(requestMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS);
    expect(requestMock).not.toHaveBeenCalled();
    setStatus("idle");
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(ROOT, { source: "auto" });
  });

  it("drops the pending run after too many re-arms", () => {
    setStatus("running");
    scheduleEslintProjectLint(ROOT);
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS * 25);
    expect(requestMock).not.toHaveBeenCalled();
    setStatus("idle");
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS * 2);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe("scheduleEslintProjectLintForFile", () => {
  it("schedules the file's project root", async () => {
    await scheduleEslintProjectLintForFile("/proj/src/a.ts", {
      resolveBinary: async () => ({
        binary: { kind: "path", root: ROOT, binary: "/proj/eslint" },
      }),
    });
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS);
    expect(requestMock).toHaveBeenCalledWith(ROOT, { source: "auto" });
  });

  it("schedules nothing for a non-lintable file", async () => {
    const resolveBinary = vi.fn(async () => ({ binary: null }));
    await scheduleEslintProjectLintForFile("/proj/README.md", {
      resolveBinary,
    });
    expect(resolveBinary).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("schedules nothing when no binary resolves", async () => {
    await scheduleEslintProjectLintForFile("/proj/src/a.ts", {
      resolveBinary: async () => ({ binary: null }),
    });
    vi.advanceTimersByTime(AUTO_PROJECT_LINT_DEBOUNCE_MS);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
