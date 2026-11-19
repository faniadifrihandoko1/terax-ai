import { useCallback, useEffect, useRef, useState } from "react";

type Params<T> = {
  enabled: boolean;
  term: string;
  minLength: number;
  debounceMs: number;
  run: (term: string) => Promise<T[]>;
  /**
   * Extra key that re-triggers the query when it changes, for inputs the
   * effect cannot see (e.g. search options held outside `run`).
   */
  refreshKey?: string;
};

export type AsyncQueryState<T> = {
  results: T[];
  loading: boolean;
  error: string | null;
  retry: () => void;
};

export function useAsyncQuery<T>({
  enabled,
  term,
  minLength,
  debounceMs,
  run,
  refreshKey,
}: Params<T>): AsyncQueryState<T> {
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const runRef = useRef(run);
  runRef.current = run;

  const execute = useCallback((q: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    runRef
      .current(q)
      .then((hits) => {
        if (requestId !== requestIdRef.current) return;
        setResults(hits);
      })
      .catch((e) => {
        if (requestId !== requestIdRef.current) return;
        setResults([]);
        setError(String(e));
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies(refreshKey): refreshKey is a manual re-run trigger — the search re-runs when the options change, read only through the dependency array
  useEffect(() => {
    requestIdRef.current += 1;
    if (!enabled || term.length < minLength) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setResults([]);
    setLoading(true);
    setError(null);
    const handle = window.setTimeout(() => execute(term), debounceMs);
    return () => window.clearTimeout(handle);
  }, [enabled, term, minLength, debounceMs, execute, refreshKey]);

  const retry = useCallback(() => {
    if (enabled && term.length >= minLength) execute(term);
  }, [enabled, term, minLength, execute]);

  return { results, loading, error, retry };
}
