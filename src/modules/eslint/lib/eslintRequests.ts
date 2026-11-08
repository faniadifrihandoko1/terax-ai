import { eslintPathKey } from "./eslintPaths";

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

/**
 * Whether an editor pane is open for a path, and whether its document
 * has finished loading. The ESLint plugin — and therefore the run
 * listener — only exists once the document is "ready", so a manual
 * run issued while the file is still loading (or unreadable) finds
 * no listener. Recording presence separately lets the manual-run
 * helper tell "editor open but not ready yet" apart from "no editor
 * for this file at all" instead of blaming the user for not opening
 * the file.
 */
export type EslintEditorPresence = "loading" | "ready" | "unavailable";

const editorPresence = new Map<string, EslintEditorPresence>();

export function setEslintEditorPresence(
  path: string,
  presence: EslintEditorPresence | null,
): void {
  const key = eslintPathKey(path);
  if (presence === null) {
    editorPresence.delete(key);
  } else {
    editorPresence.set(key, presence);
  }
}

export function getEslintEditorPresence(
  path: string,
): EslintEditorPresence | null {
  return editorPresence.get(eslintPathKey(path)) ?? null;
}

/** Asks the open editor for a path to run ESLint now (e.g. after a save). */
export function requestEslintRun(path: string): void {
  const set = listeners.get(eslintPathKey(path));
  if (!set) return;
  for (const cb of [...set]) cb();
}

export function onEslintRunRequested(
  path: string,
  cb: Listener,
): () => void {
  const key = eslintPathKey(path);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(key);
  };
}

/** True when an open editor is listening for run requests for this path. */
export function hasEslintRunListener(path: string): boolean {
  return (listeners.get(eslintPathKey(path))?.size ?? 0) > 0;
}
