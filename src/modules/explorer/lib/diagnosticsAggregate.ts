export type DiagnosticCounts = { errors: number; warnings: number };

function canonical(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Diagnostics for one explorer entry: the exact file for a file row,
 * the sum of everything underneath for a folder row. Null when there
 * is nothing to show, so the row stays unchanged.
 */
export function diagnosticsForEntry(
  byPath: Record<string, DiagnosticCounts>,
  path: string,
  isDir: boolean,
): DiagnosticCounts | null {
  const want = canonical(path);
  if (!isDir) {
    const counts = byPath[want];
    if (!counts || (counts.errors === 0 && counts.warnings === 0)) {
      return null;
    }
    return counts;
  }
  const prefix = want.endsWith("/") ? want : `${want}/`;
  let errors = 0;
  let warnings = 0;
  for (const [key, counts] of Object.entries(byPath)) {
    if (!canonical(key).startsWith(prefix)) continue;
    errors += counts.errors;
    warnings += counts.warnings;
  }
  if (errors === 0 && warnings === 0) return null;
  return { errors, warnings };
}
