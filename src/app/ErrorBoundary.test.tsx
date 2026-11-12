// Repo ini tidak punya lingkungan DOM untuk test (tanpa jsdom /
// happy-dom / @testing-library/react). Dua batas yang dicatat jujur
// di sini:
// - React TIDAK memulihkan error boundary saat server rendering
//   (verifikasi repro: renderToPipeableStream dengan boundary
//   minimal tetap memanggil onShellError dan melempar ulang) —
//   jadi jalur "child melempar → fallback" tidak bisa diuji lewat
//   SSR; yang diuji adalah render fallback dari state crash, dan
//   transisi state-nya. Pemulihan di client (createRoot di main.tsx,
//   jalur yang dipakai Terax) adalah jaminan React sendiri.
// - Logika boundary (reset, salin, matikan ESLint LSP, logging)
//   diuji langsung pada instance — setState di-stub supaya
//   diterapkan sinkron, karena setState React tidak berjalan pada
//   instance yang belum di-mount.
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { ErrorBoundary, formatErrorReport } from "./ErrorBoundary";

const mocks = vi.hoisted(() => ({
  setLspActivation: vi.fn(async () => undefined),
}));
vi.mock("@/modules/settings/store", () => ({
  setLspActivation: mocks.setLspActivation,
}));

type StateStub = (
  updater:
    | Record<string, unknown>
    | ((prev: Record<string, unknown>) => Record<string, unknown> | null),
) => void;

function instantiate(): ErrorBoundary {
  const boundary = new ErrorBoundary({ children: null });
  (boundary as unknown as { setState: StateStub }).setState = (updater) => {
    const partial =
      typeof updater === "function"
        ? updater(boundary.state as unknown as Record<string, unknown>)
        : updater;
    if (partial) {
      boundary.state = {
        ...boundary.state,
        ...partial,
      } as typeof boundary.state;
    }
  };
  return boundary;
}

function crash(boundary: ErrorBoundary): void {
  boundary.state = {
    error: new Error("boom-test"),
    componentStack: "    at Foo (foo.js:1:2)",
    remountKey: 2,
    copied: true,
  };
}

describe("ErrorBoundary", () => {
  it("me-render child yang sehat tanpa fallback", () => {
    const html = renderToString(
      <ErrorBoundary>
        <span>konten normal</span>
      </ErrorBoundary>,
    );
    expect(html).toContain("konten normal");
    expect(html).not.toContain("Terax menemui error");
  });

  it("menampilkan fallback berisi error dan ketiga tombol saat error tercatat di state", () => {
    const boundary = instantiate();
    const error = new Error("boom-test");
    error.stack = "Error: boom-test\n    at Thrower (test.js:1:2)";
    boundary.state = {
      error,
      componentStack: "    at Foo (foo.js:1:2)",
      remountKey: 0,
      copied: false,
    };
    const html = renderToString(boundary.render());
    expect(html).toContain("Terax menemui error");
    expect(html).toContain("Error: boom-test");
    expect(html).toContain("Salin error");
    expect(html).toContain("Muat ulang");
    expect(html).toContain("Matikan ESLint LSP");
    expect(html).toContain("at Thrower");
    expect(html).toContain("at Foo");
  });

  it("getDerivedStateFromError menyimpan error ke state", () => {
    const error = new Error("boom-test");
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({
      error,
      componentStack: null,
      copied: false,
    });
  });

  it("componentDidCatch mencatat error + component stack ke console", () => {
    const boundary = instantiate();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const error = new Error("boom-test");
      boundary.componentDidCatch(error, {
        componentStack: "    at Foo (foo.js:1:2)",
      });
      expect(boundary.state.componentStack).toBe("    at Foo (foo.js:1:2)");
      expect(errorSpy).toHaveBeenCalledWith(
        "[terax] render crash",
        expect.objectContaining({
          name: "Error",
          message: "boom-test",
          componentStack: "    at Foo (foo.js:1:2)",
        }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("'Muat ulang' me-reset error dan menaikkan remountKey", () => {
    const boundary = instantiate();
    crash(boundary);
    (boundary as unknown as { handleReload(): void }).handleReload();
    expect(boundary.state.error).toBeNull();
    expect(boundary.state.componentStack).toBeNull();
    expect(boundary.state.copied).toBe(false);
    expect(boundary.state.remountKey).toBe(3);
  });

  it("'Matikan ESLint LSP' memanggil setLspActivation dengan dismissed lalu me-reset", async () => {
    const boundary = instantiate();
    crash(boundary);
    mocks.setLspActivation.mockClear();
    await (
      boundary as unknown as { handleDisableEslintLsp(): Promise<void> }
    ).handleDisableEslintLsp();
    expect(mocks.setLspActivation).toHaveBeenCalledWith(
      "eslint",
      "dismissed",
    );
    expect(boundary.state.error).toBeNull();
    expect(boundary.state.remountKey).toBe(3);
  });

  it("'Salin error' tidak melempar saat clipboard tidak tersedia", async () => {
    const boundary = instantiate();
    crash(boundary);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await (boundary as unknown as { handleCopy(): Promise<void> }).handleCopy();
      expect(errorSpy).toHaveBeenCalledWith(
        "[terax] salin laporan error gagal",
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("formatErrorReport", () => {
  it("memuat nama, pesan, stack, dan component stack", () => {
    const error = new Error("boom-test");
    error.stack = "Error: boom-test\n    at Thrower (test.js:1:2)";
    const report = formatErrorReport(error, "    at Foo (foo.js:1:2)");
    expect(report).toContain("Error: boom-test");
    expect(report).toContain("Stack:");
    expect(report).toContain("at Thrower");
    expect(report).toContain("Component stack:");
    expect(report).toContain("at Foo");
  });

  it("tetap jalan tanpa stack dan tanpa component stack", () => {
    const error = new Error("boom-test");
    error.stack = undefined;
    const report = formatErrorReport(error, null);
    expect(report).toContain("Error: boom-test");
    expect(report).not.toContain("Stack:");
    expect(report).not.toContain("Component stack:");
  });
});
