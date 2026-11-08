import type { Diagnostic } from "@codemirror/lint";
import { ESLINT_SOURCE } from "./eslintJson";

/**
 * Merges a fresh ESLint result into the diagnostics already in the editor
 * state. The LSP plugin and the lint runner both publish through the one
 * shared lint state field, and each publish replaces the whole set, so
 * neither side may publish its own diagnostics alone: ESLint entries
 * (tagged with source "eslint") are replaced, everything else is kept.
 */
export function mergeDiagnostics(
  existing: readonly Diagnostic[],
  eslint: readonly Diagnostic[],
): Diagnostic[] {
  const kept = existing.filter((d) => d.source !== ESLINT_SOURCE);
  return [...kept, ...eslint].sort((a, b) => a.from - b.from || a.to - b.to);
}

export function diagnosticsEqual(
  a: readonly Diagnostic[],
  b: readonly Diagnostic[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.from !== y.from ||
      x.to !== y.to ||
      x.severity !== y.severity ||
      x.message !== y.message ||
      x.source !== y.source
    ) {
      return false;
    }
  }
  return true;
}

/**
 * True when the editor state lost ESLint diagnostics it should still
 * show: the store holds entries that are not in the current set. The
 * LSP plugin publishes its own diagnostics with setDiagnostics, which
 * replaces the whole set, so this is how an LSP publish is detected
 * and repaired. Identity comparison: the publisher would have to
 * merge the exact stored objects to count as keeping them.
 */
export function needsEslintReapply(
  current: readonly Diagnostic[],
  stored: readonly Diagnostic[],
): boolean {
  if (stored.length === 0) return false;
  return stored.some((d) => !current.includes(d));
}

export function countDiagnostics(diags: readonly Diagnostic[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const d of diags) {
    if (d.severity === "error") errors += 1;
    else if (d.severity === "warning") warnings += 1;
  }
  return { errors, warnings };
}
