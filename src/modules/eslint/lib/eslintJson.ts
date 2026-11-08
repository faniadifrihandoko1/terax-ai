import type { Diagnostic } from "@codemirror/lint";
import { canonicalPath } from "./eslintPaths";

/** Source tag on every ESLint-derived CodeMirror diagnostic. */
export const ESLINT_SOURCE = "eslint";

export type EslintMessage = {
  ruleId: string | null;
  severity: 1 | 2;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  fatal?: boolean;
};

export type EslintFileResult = {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
  fatalErrorCount: number;
};

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeMessage(raw: unknown): EslintMessage {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("ESLint message entry is not an object");
  }
  const m = raw as Record<string, unknown>;
  return {
    ruleId: typeof m.ruleId === "string" ? m.ruleId : null,
    severity: m.severity === 1 ? 1 : 2,
    message: typeof m.message === "string" ? m.message : "",
    line: asNumber(m.line, 1),
    column: asNumber(m.column, 1),
    endLine:
      typeof m.endLine === "number" ? m.endLine : undefined,
    endColumn:
      typeof m.endColumn === "number" ? m.endColumn : undefined,
    fatal: m.fatal === true,
  };
}

/** Parses `eslint --format json` stdout. Throws on malformed output. */
export function parseEslintJsonOutput(stdout: string): EslintFileResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("ESLint output is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ESLint output is not an array");
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`ESLint output entry ${index} is not an object`);
    }
    const e = entry as Record<string, unknown>;
    return {
      filePath: typeof e.filePath === "string" ? e.filePath : "",
      messages: (Array.isArray(e.messages) ? e.messages : []).map(
        normalizeMessage,
      ),
      errorCount: asNumber(e.errorCount, 0),
      warningCount: asNumber(e.warningCount, 0),
      fatalErrorCount: asNumber(e.fatalErrorCount, 0),
    };
  });
}

export function findResultForFile(
  results: readonly EslintFileResult[],
  filePath: string,
): EslintFileResult | undefined {
  const want = canonicalPath(filePath);
  return results.find((r) => canonicalPath(r.filePath) === want);
}

/** Minimal document surface needed for offset mapping. Satisfied by CodeMirror Text. */
export type DocLike = {
  readonly length: number;
  readonly lines: number;
  line(n: number): { readonly from: number; readonly to: number };
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Maps ESLint messages (1-based line/column) to CodeMirror diagnostics.
 * Out-of-range positions are clamped to the document; a message on an
 * empty line yields no diagnostic because there is nothing to underline.
 */
export function eslintMessagesToDiagnostics(
  doc: DocLike,
  messages: readonly EslintMessage[],
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const m of messages) {
    const lineNo = clamp(Math.trunc(m.line) || 1, 1, doc.lines);
    const line = doc.line(lineNo);
    const lineLen = line.to - line.from;
    const col = clamp((Math.trunc(m.column) || 1) - 1, 0, lineLen);
    const from0 = line.from + col;
    let from = from0;
    let to = from;
    if (m.endLine != null && m.endColumn != null) {
      const endLineNo = clamp(Math.trunc(m.endLine) || lineNo, 1, doc.lines);
      const endLine = doc.line(endLineNo);
      const endLen = endLine.to - endLine.from;
      const endCol = clamp((Math.trunc(m.endColumn) || 1) - 1, 0, endLen);
      to = Math.max(from, endLine.from + endCol);
    }
    if (to === from) to = Math.min(from + 1, line.to);
    if (to === from && lineLen > 0) {
      // Pointing at end of line: underline the last character instead.
      from = Math.max(line.from, from - 1);
    }
    if (to === from) continue;
    out.push({
      from,
      to,
      severity: m.severity === 1 ? "warning" : "error",
      message: m.ruleId ? `${m.message} (${m.ruleId})` : m.message,
      source: ESLINT_SOURCE,
    });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}
