import {
  Component,
  Fragment,
  type ErrorInfo,
  type ReactNode,
} from "react";

/**
 * Laporan teks yang disalin tombol "Salin error": nama + pesan + stack
 * (bila ada) + component stack React (bila ada). Sengaja fungsi murni
 * supaya bisa diuji tanpa DOM.
 */
export function formatErrorReport(
  error: Error,
  componentStack: string | null,
): string {
  const lines = [
    "Terax — laporan error render",
    `Error: ${error.name}: ${error.message}`,
  ];
  if (error.stack) lines.push("", "Stack:", error.stack);
  if (componentStack) lines.push("", "Component stack:", componentStack);
  return lines.join("\n");
}

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
  componentStack: string | null;
  /** Naik setiap "Muat ulang": children di-render dengan key baru supaya
   * App benar-benar remount, bukan sekadar render ulang. */
  remountKey: number;
  copied: boolean;
};

const INITIAL_STATE: ErrorBoundaryState = {
  error: null,
  componentStack: null,
  remountKey: 0,
  copied: false,
};

/**
 * Batas terakhir di root App (dipasang di main.tsx): tanpa boundary ini,
 * satu exception saat render meng-unmount seluruh pohon React dan
 * jendelanya blank hitam — persis yang terjadi saat ESLint LSP
 * dinyalakan (2026-11-12). Dengan boundary, yang tampil adalah layar
 * fallback berisi error yang bisa disalin, bukan layar hitam.
 *
 * Yang ditangkap: error saat render / lifecycle / constructor di bawah
 * boundary, termasuk saat mount awal App. Yang TIDAK ditangkap (batas
 * React, bukan batas implementasi): error di event handler, error
 * async (setTimeout / promise), dan error di dalam boundary itu
 * sendiri.
 *
 * Fallback sengaja mandiri: tidak membaca store/hook apa pun, supaya
 * tetap bisa tampil walau tree App sudah rusak. Satu-satunya
 * ketergantungan luar adalah `setLspActivation` (di-import dinamis
 * saat tombol diklik, supaya modul settings tidak terseret ke eager
 * graph main.tsx).
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = INITIAL_STATE;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, componentStack: null, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[terax] render crash", {
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private reset = (): void => {
    this.setState((s) => ({
      error: null,
      componentStack: null,
      copied: false,
      remountKey: s.remountKey + 1,
    }));
  };

  private handleReload = (): void => {
    this.reset();
  };

  private handleCopy = async (): Promise<void> => {
    const error = this.state.error ?? new Error("unknown error");
    const text = formatErrorReport(error, this.state.componentStack);
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(text);
      } else if (typeof document !== "undefined") {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } else {
        throw new Error("clipboard tidak tersedia");
      }
      this.setState({ copied: true });
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          this.setState((s) => (s.copied ? { copied: false } : null));
        }, 1500);
      }
    } catch (e) {
      console.error("[terax] salin laporan error gagal", e);
    }
  };

  private handleDisableEslintLsp = async (): Promise<void> => {
    try {
      // Dynamic import: boundary ini dimuat di main.tsx, jadi static
      // import ke settings store bisa menyeret modul berat ke eager
      // graph (budget test).
      const { setLspActivation } = await import("@/modules/settings/store");
      await setLspActivation("eslint", "dismissed");
    } catch (e) {
      // Gagal menulis preferensi: tetap reset — bila crash disebabkan
      // ESLint LSP yang masih aktif, boundary akan menangkapnya lagi
      // dan fallback tampil kembali.
      console.error("[terax] matikan ESLint LSP gagal", e);
    }
    this.reset();
  };

  render(): ReactNode {
    const { error, componentStack, remountKey, copied } = this.state;
    if (!error) {
      // Key di fragment memaksa remount penuh saat "Muat ulang" menaikkan
      // remountKey: App di-mount ulang dari awal, bukan render ulang saja.
      return (
        <Fragment key={remountKey}>{this.props.children}</Fragment>
      );
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
        <div className="w-full max-w-xl rounded-lg border border-border bg-card p-5">
          <h1 className="text-sm font-semibold">
            Terax menemui error saat menampilkan antarmuka
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Bukan layar hitam: Terax menangkap error render ini supaya bisa
            dibaca dan dilaporkan. Salin error di bawah dan kirimkan ke
            pengembang supaya komponen penyebabnya bisa ditemukan.
          </p>
          <p className="mt-3 break-words rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11.5px]">
            {error.name}: {error.message}
          </p>
          <details className="mt-3 text-[11.5px]">
            <summary className="cursor-pointer text-muted-foreground">
              Detail error (stack trace)
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2.5 font-mono text-[11px]">
              {[
                error.stack,
                componentStack
                  ? `Component stack:${componentStack}`
                  : null,
              ]
                .filter(Boolean)
                .join("\n\n")}
            </pre>
          </details>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => void this.handleCopy()}
              className="cursor-pointer rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {copied ? "Disalin" : "Salin error"}
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="cursor-pointer rounded-md border border-border/60 bg-accent/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Muat ulang
            </button>
            <button
              type="button"
              onClick={() => void this.handleDisableEslintLsp()}
              className="cursor-pointer rounded-md border border-border/60 bg-accent/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Matikan ESLint LSP
            </button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Tombol &ldquo;Matikan ESLint LSP&rdquo; mematikan language server
            ESLint lalu memuat ulang antarmuka — berguna bila crash terjadi
            tepat setelah ESLint LSP dinyalakan. Bila &ldquo;Muat ulang&rdquo;
            saja dan penyebabnya masih aktif, layar ini akan muncul kembali.
          </p>
        </div>
      </div>
    );
  }
}
