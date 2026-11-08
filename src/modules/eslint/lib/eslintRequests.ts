type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

/** Asks the open editor for a path to run ESLint now (e.g. after a save). */
export function requestEslintRun(path: string): void {
  const set = listeners.get(path);
  if (!set) return;
  for (const cb of [...set]) cb();
}

export function onEslintRunRequested(
  path: string,
  cb: Listener,
): () => void {
  let set = listeners.get(path);
  if (!set) {
    set = new Set();
    listeners.set(path, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(path);
  };
}

/** True when an open editor is listening for run requests for this path. */
export function hasEslintRunListener(path: string): boolean {
  return (listeners.get(path)?.size ?? 0) > 0;
}
