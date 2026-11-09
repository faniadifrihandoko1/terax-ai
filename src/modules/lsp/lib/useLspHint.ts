import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useState } from "react";
import { detectBinary } from "./detect";
import { type LspPreset, serversForLanguage } from "./presets";
import { type LspSessionStatus, useLspRuntimeStore } from "./runtimeStore";

export type LspHint =
  | { kind: "enable"; preset: LspPreset }
  | { kind: "install"; preset: LspPreset }
  | { kind: "active"; preset: LspPreset; status: LspSessionStatus }
  | { kind: "error"; preset: LspPreset; reason: string };

export function useLspHint(filePath: string | null): LspHint | null {
  const [langId, setLangId] = useState<string | null>(null);
  const envKind = useWorkspaceEnvStore((s) => s.env.kind);

  useEffect(() => {
    if (!filePath) {
      setLangId(null);
      return;
    }
    let cancelled = false;
    void resolveLanguage(filePath).then((result) => {
      if (cancelled) return;
      const ext = filePath.split(".").pop()?.toLowerCase() ?? null;
      setLangId(result?.id || ext);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const customServers = usePreferencesStore((s) => s.lspCustomServers);
  const lspActivation = usePreferencesStore((s) => s.lspActivation);
  const candidates = serversForLanguage(langId, customServers);
  const candidateIds = candidates.map((p) => p.id).join(",");
  const detected = useLspRuntimeStore((s) => s.detected);
  const sessions = useLspRuntimeStore((s) => s.sessions);
  const failed = useLspRuntimeStore((s) => s.failed);

  // Detect binaries for candidates nobody touched yet.
  // biome-ignore lint/correctness/useExhaustiveDependencies(candidateIds): candidates are derived from the ids
  useEffect(() => {
    if (envKind !== "local") return;
    for (const p of candidates) {
      if (lspActivation[p.id] === undefined) void detectBinary(p.command);
    }
  }, [candidateIds, envKind, lspActivation]);

  if (envKind !== "local" || candidates.length === 0) return null;

  // A language can have several servers (TypeScript + ESLint). The
  // pill reports the first candidate that needs attention, so an
  // enabled ESLint is never hidden behind an install hint for
  // TypeScript, or the other way round. Priority: an enabled
  // server's live state first, then a fresh candidate to enable or
  // install. A candidate with nothing to report is skipped, not
  // returned as null, so a later candidate can still surface.
  for (const preset of candidates) {
    const activation = lspActivation[preset.id];
    if (activation === "dismissed") continue;
    if (activation === "enabled") {
      const session = Object.values(sessions).find(
        (x) => x.presetId === preset.id,
      );
      if (session) return { kind: "active", preset, status: session.status };
      const failure = failed[preset.id];
      if (failure) return { kind: "error", preset, reason: failure };
      continue;
    }
    const isDetected = detected[preset.command];
    if (isDetected === undefined) continue;
    return isDetected ? { kind: "enable", preset } : { kind: "install", preset };
  }
  return null;
}
