import type { UIMessagePart } from "ai";
import { isFileMutationPart } from "./fileMutations";

export type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

export type Group =
  | { kind: "single"; part: AnyPart; idx: number; key: string }
  | { kind: "reads"; parts: AnyPart[]; key: string }
  | { kind: "changes"; parts: AnyPart[]; key: string };

export function partType(p: AnyPart): string {
  return (p as { type?: string }).type ?? "";
}

function isReadFilePart(p: AnyPart): boolean {
  if (partType(p) !== "tool-read_file") return false;
  const state = (p as { state?: string }).state ?? "";
  return state !== "approval-requested";
}

function partKey(p: AnyPart, idx: number): string {
  const tc = (p as { toolCallId?: string }).toolCallId;
  if (tc) return tc;
  const id = (p as { approval?: { id?: string } }).approval?.id;
  if (id) return id;
  return `i-${idx}`;
}

/**
 * Groups an assistant message's parts for rendering.
 *
 * File-mutation parts collapse into a single "changes" group that is always
 * emitted LAST, after every text/tool part — the Changed Files card sits at
 * the end of the message, below the agent's summary text (like the Todos
 * block), instead of at the point the edits happened mid-message. Mutation
 * parts scattered across the message (edit, text, edit) still render as one
 * card at the end.
 *
 * Gating (whether the card shows at all while a run is active) is NOT
 * decided here — see `shouldShowChangesCard` in changesCardVisibility.ts;
 * this only decides position.
 */
export function buildPartGroups(parts: AnyPart[]): Group[] {
  const out: Group[] = [];
  let run: { parts: AnyPart[]; startIdx: number } | null = null;
  let changes: { parts: AnyPart[]; startIdx: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    if (run.parts.length >= 2) {
      out.push({
        kind: "reads",
        parts: run.parts,
        key: `reads-${partKey(run.parts[0], run.startIdx)}`,
      });
    } else {
      run.parts.forEach((p, k) => {
        const idx = run!.startIdx + k;
        out.push({ kind: "single", part: p, idx, key: partKey(p, idx) });
      });
    }
    run = null;
  };
  const flushChanges = () => {
    if (!changes) return;
    out.push({
      kind: "changes",
      parts: changes.parts,
      key: `changes-${partKey(changes.parts[0], changes.startIdx)}`,
    });
    changes = null;
  };
  parts.forEach((p, i) => {
    if (isReadFilePart(p)) {
      if (!run) run = { parts: [], startIdx: i };
      run.parts.push(p);
      return;
    }
    if (isFileMutationPart(partType(p))) {
      flushRun();
      if (!changes) changes = { parts: [], startIdx: i };
      changes.parts.push(p);
      return;
    }
    flushRun();
    out.push({ kind: "single", part: p, idx: i, key: partKey(p, i) });
  });
  flushRun();
  // The changes card goes last, below the summary text.
  flushChanges();
  return out;
}
