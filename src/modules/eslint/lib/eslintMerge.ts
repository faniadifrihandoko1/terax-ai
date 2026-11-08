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
