import { toast } from "sonner";
import { eslintPathKey } from "./eslintPaths";

/**
 * The request bus for ESLint code actions (Fase 18), kept in its own
 * module on purpose: this file imports nothing from CodeMirror, so
 * `App.tsx` and `EditorPane.tsx` can import the request functions
 * statically without pulling the editor stack into the eager startup
 * graph (see `src/app/eager-budget.test.ts`). The plugin itself
 * lives in `eslintCodeAction.ts` and registers on this bus.
 */

export type FixOutcome =
  | { kind: "applied"; title: string; edits?: number }
  | { kind: "no-diagnostic" }
  | { kind: "no-action" }
  | { kind: "no-plugin" }
  | { kind: "stale" }
  | { kind: "failed"; message: string };

export type EslintCodeActionHandler = {
  fixAtCursor(): Promise<FixOutcome>;
  fixAll(): Promise<FixOutcome>;
};

const codeActionHandlers = new Map<
  string,
  Set<EslintCodeActionHandler>
>();

export function registerEslintCodeActionHandler(
  path: string,
  handler: EslintCodeActionHandler,
): () => void {
  const key = eslintPathKey(path);
  let set = codeActionHandlers.get(key);
  if (!set) {
    set = new Set();
    codeActionHandlers.set(key, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) codeActionHandlers.delete(key);
  };
}

function firstHandler(path: string): EslintCodeActionHandler | null {
  const set = codeActionHandlers.get(eslintPathKey(path));
  if (!set || set.size === 0) return null;
  return [...set][0] ?? null;
}

export function toastFixOutcome(
  outcome: FixOutcome,
  opts?: { quiet?: boolean },
): void {
  const quiet = opts?.quiet ?? false;
  switch (outcome.kind) {
    case "applied":
      if (!quiet) {
        toast.success("Perbaikan diterapkan", {
          description:
            outcome.edits !== undefined
              ? `${outcome.title} (${outcome.edits} edit)`
              : outcome.title,
        });
      }
      break;
    case "no-diagnostic":
      if (!quiet) {
        toast.warning("Tidak ada pelanggaran ESLint di kursor", {
          description:
            "Pindahkan kursor ke garis merah/kuning, atau pakai fix-all untuk seluruh file.",
        });
      }
      break;
    case "no-action":
      if (!quiet) {
        toast.warning("Tidak ada perbaikan otomatis", {
          description:
            "Pelanggaran ini tidak punya quick fix (atau diagnostik sudah berubah). Perbaiki manual.",
        });
      }
      break;
    case "no-plugin":
      if (!quiet) {
        toast.warning("ESLint server belum aktif untuk file ini", {
          description:
            "Nyalakan language server ESLint, lalu coba lagi setelah diagnostik muncul.",
        });
      }
      break;
    case "stale":
      toast.warning("Dokumen berubah", {
        description:
          "Perbaikan dibatalkan karena file berubah sejak diminta. Coba lagi.",
      });
      break;
    case "failed":
      toast.error("Gagal meminta perbaikan", {
        description: outcome.message,
      });
      break;
  }
}

export async function requestEslintFixAtCursor(
  path: string,
  opts?: { quiet?: boolean },
): Promise<FixOutcome> {
  const handler = firstHandler(path);
  const outcome: FixOutcome = handler
    ? await handler.fixAtCursor().catch((e) => ({
        kind: "failed",
        message: String(e),
      }) as FixOutcome)
    : { kind: "no-plugin" };
  toastFixOutcome(outcome, opts);
  return outcome;
}

export async function requestEslintFixAll(
  path: string,
  opts?: { quiet?: boolean },
): Promise<FixOutcome> {
  const handler = firstHandler(path);
  const outcome: FixOutcome = handler
    ? await handler.fixAll().catch((e) => ({
        kind: "failed",
        message: String(e),
      }) as FixOutcome)
    : { kind: "no-plugin" };
  toastFixOutcome(outcome, opts);
  return outcome;
}
