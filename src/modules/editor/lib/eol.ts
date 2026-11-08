export type Eol = "\n" | "\r\n";

export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (text.charCodeAt(i - 1) === 13) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? "\r\n" : "\n";
}

// Buffers live in LF space (CodeMirror joins with "\n"); EOL is restored on save.
export function normalizeToLf(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/**
 * True when raw on-disk text matches buffer text. Buffers live in LF
 * space, so a CRLF file on disk matches its LF buffer — comparing raw
 * bytes would report every CRLF file as dirty forever (this is what
 * silently disabled ESLint runs for CRLF files: the dirty check
 * compared raw disk text against the LF buffer and never matched).
 */
export function diskTextMatchesBuffer(
  diskText: string,
  bufferText: string,
): boolean {
  return normalizeToLf(diskText) === bufferText;
}

export function restoreEol(text: string, eol: Eol): string {
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}
