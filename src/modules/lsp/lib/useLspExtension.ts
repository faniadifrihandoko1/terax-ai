import { usePreferencesStore } from "@/modules/settings/preferences";
import type { Extension } from "@codemirror/state";
import { useEffect, useState } from "react";
import { serversForLanguageEnabled } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";
import { acquireDocExtensions, type LspDocHandle } from "./sessionManager";

/**
 * Acquires an LSP extension for every enabled server that claims the
 * document's language, since Fase 12 a document can have several
 * servers at once (TypeScript for types, ESLint for lint), so this
 * returns a list, not a single extension. A language with one enabled
 * server behaves exactly as before.
 */
export function useLspExtensions(
  path: string,
  langId: string | null,
  ready: boolean,
): Extension[] {
  const [exts, setExts] = useState<Extension[]>([]);
  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const lspActivation = usePreferencesStore((s) => s.lspActivation);
  const presets = serversForLanguageEnabled(
    langId,
    customServers,
    lspActivation,
  );
  const presetIds = presets.map((p) => p.id).join(",");
  // Re-acquire after a crash tears a session down; keyed per enabled
  // preset so an unrelated server's bump does not tear these down.
  const generations = useLspRuntimeStore((s) =>
    presets.map((p) => s.generations[p.id] ?? 0).join(","),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies(generations): re-acquire after a server crash tears the session down
  // biome-ignore lint/correctness/useExhaustiveDependencies(presetIds): swapping the enabled servers for a language must rebind the doc
  useEffect(() => {
    if (!ready || !langId || presets.length === 0) {
      setExts([]);
      return;
    }
    let cancelled = false;
    const handles: LspDocHandle[] = [];
    acquireDocExtensions(path, langId)
      .then((hs) => {
        if (cancelled) {
          for (const h of hs) h.release();
          return;
        }
        handles.push(...hs);
        setExts(hs.map((h) => h.extension));
      })
      .catch((e) => console.error("[lsp] acquire failed", e));
    return () => {
      cancelled = true;
      for (const h of handles) h.release();
      setExts([]);
    };
  }, [path, langId, ready, presetIds, generations]);

  return exts;
}
