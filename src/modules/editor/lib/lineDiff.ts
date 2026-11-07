import { presentableDiff } from "@codemirror/merge";
import type {
  HunkDecision,
  HunkDecisions,
  LineDecision,
  LineDecisions,
} from "@/modules/ai/lib/reviewApply";

/**
 * Line-level diff model for review (FR-03, Fase 2).
 *
 * presentableDiff gives character ranges; this module turns them into
 * whole-line changes grouped into hunks, plus a pure reconstruction of
 * the file that results from the user's decisions. The model is
 * deliberately independent of React so it can be unit tested without UI.
 *
 * Line identity includes the terminator: a line that only gains or loses
 * its trailing newline is a changed line, not context. That keeps the
 * reconstruction exact (accept-all equals the proposal, reject-all
 * equals the original) even for edits at the end of a file without a
 * trailing newline.
 *
 * Fase 4 (Antigravity-style): the hunk — not the line — is the unit of
 * decision. The per-line functions below stay as the reconstruction
 * engine; `hunkDecisionsToLineDecisions` expands a per-hunk decision
 * into the per-line decisions the engine consumes.
 */

export type LineChangeKind = "added" | "removed";

export type LineChange = {
  /** Stable position in the change list; decisions are keyed by this. */
  index: number;
  kind: LineChangeKind;
  /** Line text without its terminator. */
  text: string;
  terminator: string;
  /** 0-based line in the original, null for added lines. */
  baseLine: number | null;
  /** 0-based line in the proposal, null for removed lines. */
  proposedLine: number | null;
  hunkIndex: number;
  /**
   * Id shared by a removed line and the added line at the same slot of a
   * hunk (a change pair), null when the slot has only one side. Splitting
   * a pair is allowed but warned about in the UI.
   */
  pairId: string | null;
};

export type LineHunk = {
  index: number;
  /** 0-based [from, to) range in the original lines. */
  baseFrom: number;
  baseTo: number;
  /** 0-based [from, to) range in the proposed lines. */
  proposedFrom: number;
  proposedTo: number;
};

export type LineChangeSet = {
  hunks: LineHunk[];
  changes: LineChange[];
};

type DocLine = {
  text: string;
  terminator: string;
  start: number;
  end: number;
};

/** Splits a document into lines, keeping each line's terminator. */
export function splitLines(doc: string): DocLine[] {
  if (doc === "") return [];
  const lines: DocLine[] = [];
  let start = 0;
  for (let i = 0; i < doc.length; i++) {
    if (doc.charCodeAt(i) !== 10) continue;
    const crlf = i > start && doc.charCodeAt(i - 1) === 13;
    const textEnd = crlf ? i - 1 : i;
    lines.push({
      text: doc.slice(start, textEnd),
      terminator: doc.slice(textEnd, i + 1),
      start,
      end: i + 1,
    });
    start = i + 1;
  }
  if (start < doc.length) {
    lines.push({
      text: doc.slice(start),
      terminator: "",
      start,
      end: doc.length,
    });
  }
  return lines;
}

function fullLine(line: DocLine): string {
  return line.text + line.terminator;
}

/**
 * Lines touched by a character range. A non-empty range touches every
 * line it overlaps. An empty range is an insertion or deletion point:
 * it touches the line it falls strictly inside, or, at a line boundary,
 * the preceding line when the inserted or deleted text starts with a
 * newline (that line gains or loses its terminator), and no line
 * otherwise (a whole line inserted or deleted between two lines).
 * `otherText` is the text on the other side of the empty range.
 */
function lineRange(
  lines: DocLine[],
  from: number,
  to: number,
  otherText: string,
): [number, number] {
  if (from !== to) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].start < to && lines[i].end > from) {
        if (first === -1) first = i;
        last = i;
      }
    }
    if (first === -1) return [0, 0];
    return [first, last + 1];
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start < from && from < lines[i].end) return [i, i + 1];
  }
  if (otherText.startsWith("\n") || otherText.startsWith("\r")) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].end === from) return [i, i + 1];
    }
    return [0, 0];
  }
  // Appending at the end of the document extends the last line when it
  // has no terminator; when it does, a whole new line starts instead.
  if (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.end === from && last.terminator === "") {
      return [lines.length - 1, lines.length];
    }
  }
  let idx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].start >= from) {
      idx = i;
      break;
    }
  }
  return [idx, idx];
}

/** Longest common subsequence of two line lists, as matched index pairs. */
function lcsMatches(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }
  const matches: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      matches.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

type Window = {
  bf: number;
  bt: number;
  pf: number;
  pt: number;
  rbf: number;
  rbt: number;
  rpf: number;
  rpt: number;
};

/** Upper bound for the per-window LCS table; larger windows use raw ranges. */
const LCS_CELL_LIMIT = 1_000_000;

/**
 * Turns the character diff into per-line changes grouped into hunks.
 * Lines outside every hunk are context and never appear in the result.
 */
export function computeLineChanges(
  original: string,
  proposed: string,
): LineChangeSet {
  const origLines = splitLines(original);
  const propLines = splitLines(proposed);
  const sections = presentableDiff(original, proposed);
  if (sections.length === 0) return { hunks: [], changes: [] };

  const windows: Window[] = [];
  for (const s of sections) {
    const [rbf, rbt] = lineRange(
      origLines,
      s.fromA,
      s.toA,
      proposed.slice(s.fromB, s.toB),
    );
    const [rpf, rpt] = lineRange(
      propLines,
      s.fromB,
      s.toB,
      original.slice(s.fromA, s.toA),
    );
    windows.push({ bf: 0, bt: 0, pf: 0, pt: 0, rbf, rbt, rpf, rpt });
  }
  windows.sort((a, b) => a.rbf - b.rbf || a.rpf - b.rpf);
  // Merge only when the raw ranges overlap or touch. Padding is added
  // after merging and clamped to the neighboring raw boundaries, so one
  // line of context can never be claimed as changed by two windows.
  const merged: Window[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && (w.rbf <= last.rbt || w.rpf <= last.rpt)) {
      last.rbt = Math.max(last.rbt, w.rbt);
      last.rpt = Math.max(last.rpt, w.rpt);
    } else {
      merged.push({ ...w });
    }
  }
  for (let i = 0; i < merged.length; i++) {
    const w = merged[i];
    const prev = merged[i - 1];
    const next = merged[i + 1];
    w.bf = Math.max(prev ? prev.rbt : 0, w.rbf - 1);
    w.bt = Math.min(next ? next.rbf : origLines.length, w.rbt + 1);
    w.pf = Math.max(prev ? prev.rpt : 0, w.rpf - 1);
    w.pt = Math.min(next ? next.rpf : propLines.length, w.rpt + 1);
  }

  const hunks: LineHunk[] = [];
  const changes: LineChange[] = [];
  for (const w of merged) {
    const baseSlice = origLines.slice(w.bf, w.bt).map(fullLine);
    const propSlice = propLines.slice(w.pf, w.pt).map(fullLine);
    let removedIdx: number[];
    let addedIdx: number[];
    let matches: Array<[number, number]> = [];
    if ((baseSlice.length + 1) * (propSlice.length + 1) > LCS_CELL_LIMIT) {
      removedIdx = range(w.rbf - w.bf, w.rbt - w.bf);
      addedIdx = range(w.rpf - w.pf, w.rpt - w.pf);
    } else {
      matches = lcsMatches(baseSlice, propSlice);
      const matchedBase = new Set(matches.map(([i]) => i));
      const matchedProp = new Set(matches.map(([, j]) => j));
      removedIdx = baseSlice
        .map((_, i) => i)
        .filter((i) => !matchedBase.has(i));
      addedIdx = propSlice.map((_, j) => j).filter((j) => !matchedProp.has(j));
    }
    if (removedIdx.length === 0 && addedIdx.length === 0) continue;

    // Split the window into hunks at matched lines: a matched line
    // between two changed lines is context, not part of either hunk.
    // Without this, duplicate lines make the LCS match the wrong
    // occurrence and a line that should survive gets swallowed
    // (e.g. deleting "b\na" from "b\na\na\na" kept one "a" too few).
    // Boundaries are the LCS matches plus a sentinel at the window end;
    // the segment between two boundaries holds the lines changed there.
    const boundaries: Array<[number, number]> = [
      ...matches,
      [baseSlice.length, propSlice.length],
    ];
    let segB = 0;
    let segP = 0;
    for (const [mb, mp] of boundaries) {
      const startB = segB;
      const startP = segP;
      const segRemoved = removedIdx.filter((i) => i >= startB && i < mb);
      const segAdded = addedIdx.filter((j) => j >= startP && j < mp);
      segB = mb + 1;
      segP = mp + 1;
      if (segRemoved.length === 0 && segAdded.length === 0) continue;

      const hunkIndex = hunks.length;
      // A pure insertion has no removed lines: its base position is
      // the segment start, just after the last matched base line.
      // (The LCS fallback has no matches, so it uses the raw range
      // start.)
      const baseFrom =
        segRemoved.length > 0
          ? w.bf + segRemoved[0]
          : matches.length > 0
            ? w.bf + startB
            : w.rbf;
      const baseTo =
        segRemoved.length > 0
          ? w.bf + segRemoved[segRemoved.length - 1] + 1
          : baseFrom;
      const proposedFrom =
        segAdded.length > 0
          ? w.pf + segAdded[0]
          : matches.length > 0
            ? w.pf + startP
            : w.rpf;
      const proposedTo =
        segAdded.length > 0
          ? w.pf + segAdded[segAdded.length - 1] + 1
          : proposedFrom;
      hunks.push({
        index: hunkIndex,
        baseFrom,
        baseTo,
        proposedFrom,
        proposedTo,
      });

      const pairCount = Math.min(segRemoved.length, segAdded.length);
      for (let i = 0; i < segRemoved.length; i++) {
        const line = origLines[w.bf + segRemoved[i]];
        changes.push({
          index: changes.length,
          kind: "removed",
          text: line.text,
          terminator: line.terminator,
          baseLine: w.bf + segRemoved[i],
          proposedLine: null,
          hunkIndex,
          pairId: i < pairCount ? `h${hunkIndex}:${i}` : null,
        });
      }
      for (let j = 0; j < segAdded.length; j++) {
        const line = propLines[w.pf + segAdded[j]];
        changes.push({
          index: changes.length,
          kind: "added",
          text: line.text,
          terminator: line.terminator,
          baseLine: null,
          proposedLine: w.pf + segAdded[j],
          hunkIndex,
          pairId: j < pairCount ? `h${hunkIndex}:${j}` : null,
        });
      }
    }
  }
  return { hunks, changes };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

/**
 * Rebuilds the file from the original plus the per-line decisions.
 * Context lines always pass through; a removed line survives only when
 * its deletion was rejected; an added line survives only when accepted.
 * Returns the content plus the 1-based result lines that came from a
 * user decision (for the FR-08 preview highlight).
 */
export function reconstructFile(
  original: string,
  changeSet: LineChangeSet,
  decisions: LineDecisions,
): { content: string; decidedLines: number[] } {
  const origLines = splitLines(original);
  const byHunk = new Map<
    number,
    { removed: LineChange[]; added: LineChange[] }
  >();
  for (const c of changeSet.changes) {
    let entry = byHunk.get(c.hunkIndex);
    if (!entry) {
      entry = { removed: [], added: [] };
      byHunk.set(c.hunkIndex, entry);
    }
    if (c.kind === "removed") entry.removed.push(c);
    else entry.added.push(c);
  }
  const out: string[] = [];
  const decidedLines: number[] = [];
  let cursor = 0;
  for (const hunk of changeSet.hunks) {
    for (let i = cursor; i < hunk.baseFrom; i++) {
      out.push(fullLine(origLines[i]));
    }
    const entry = byHunk.get(hunk.index) ?? { removed: [], added: [] };
    const n = Math.max(entry.removed.length, entry.added.length);
    for (let i = 0; i < n; i++) {
      const removed = entry.removed[i];
      if (removed && decisions.get(removed.index) === "rejected") {
        out.push(fullLine(origLines[removed.baseLine ?? 0]));
        decidedLines.push(out.length);
      }
      const added = entry.added[i];
      if (added && decisions.get(added.index) === "accepted") {
        out.push(added.text + added.terminator);
        decidedLines.push(out.length);
      }
    }
    cursor = hunk.baseTo;
  }
  for (let i = cursor; i < origLines.length; i++) {
    out.push(fullLine(origLines[i]));
  }
  return { content: out.join(""), decidedLines };
}

/**
 * Expands per-hunk decisions into per-line decisions (Fase 4): a hunk's
 * decision applies to every changed line inside it. Undecided hunks
 * leave their lines undecided (absent from the map), so the existing
 * reconstruction engine keeps working unchanged.
 */
export function hunkDecisionsToLineDecisions(
  changeSet: LineChangeSet,
  hunkDecisions: HunkDecisions,
): LineDecisions {
  const out = new Map<number, LineDecision>();
  for (const c of changeSet.changes) {
    const d = hunkDecisions.get(c.hunkIndex);
    if (d === "accepted" || d === "rejected") out.set(c.index, d);
  }
  return out;
}

/** Rebuilds the file from per-hunk decisions (Fase 4). */
export function reconstructFileFromHunks(
  original: string,
  changeSet: LineChangeSet,
  hunkDecisions: HunkDecisions,
): { content: string; decidedLines: number[] } {
  return reconstructFile(
    original,
    changeSet,
    hunkDecisionsToLineDecisions(changeSet, hunkDecisions),
  );
}

/** Decision counts at hunk level (Fase 4). */
export function countHunkDecisions(
  hunks: LineHunk[],
  decisions: HunkDecisions,
): { decided: number; total: number; accepted: number; rejected: number } {
  let decided = 0;
  let accepted = 0;
  let rejected = 0;
  for (const hunk of hunks) {
    const d = decisions.get(hunk.index);
    if (d === "accepted") {
      decided++;
      accepted++;
    } else if (d === "rejected") {
      decided++;
      rejected++;
    }
  }
  return { decided, total: hunks.length, accepted, rejected };
}

/**
 * Migrates v1 per-line decisions to per-hunk decisions (Fase 4, FR-10):
 * a hunk is accepted when every changed line in it was accepted,
 * rejected when every line was rejected, and undecided otherwise (mixed
 * decisions, or only part of its lines decided). Undecided hunks are
 * omitted from the result.
 */
export function migrateLineDecisionsToHunks(
  lineDecisions: Record<number, LineDecision>,
  changeSet: LineChangeSet,
): Record<number, HunkDecision> {
  const perHunk = new Map<
    number,
    { total: number; accepted: number; rejected: number }
  >();
  for (const c of changeSet.changes) {
    let entry = perHunk.get(c.hunkIndex);
    if (!entry) {
      entry = { total: 0, accepted: 0, rejected: 0 };
      perHunk.set(c.hunkIndex, entry);
    }
    entry.total++;
    const d = lineDecisions[c.index];
    if (d === "accepted") entry.accepted++;
    else if (d === "rejected") entry.rejected++;
  }
  const out: Record<number, HunkDecision> = {};
  for (const [hunkIndex, entry] of perHunk) {
    if (entry.accepted === entry.total) out[hunkIndex] = "accepted";
    else if (entry.rejected === entry.total) out[hunkIndex] = "rejected";
  }
  return out;
}

/** Decision counts for the header (FR-04). */
export function countDecisions(
  changes: LineChange[],
  decisions: LineDecisions,
): { decided: number; total: number; accepted: number; rejected: number } {
  let decided = 0;
  let accepted = 0;
  let rejected = 0;
  for (const c of changes) {
    const d = decisions.get(c.index);
    if (d === "accepted") {
      decided++;
      accepted++;
    } else if (d === "rejected") {
      decided++;
      rejected++;
    }
  }
  return { decided, total: changes.length, accepted, rejected };
}
