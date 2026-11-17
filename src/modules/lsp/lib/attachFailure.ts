import type { LspPreset } from "./presets";
import { useLspRuntimeStore } from "./runtimeStore";

/**
 * Why a preset could not be attached to a document (Fase 26).
 *
 * Diagnosis (Fase 26): every attach gate in sessionManager's
 * acquireForPreset — binary missing, no project root, crashed out,
 * session cap — used to `return null` with no record anywhere. The
 * editor then showed nothing at all: no diagnostics, no squiggle,
 * no error, and the status pill showed nothing either (it only
 * renders a session or a `failed` entry, and none existed). A user
 * whose TypeScript server never attached could not tell whether
 * Terax was broken, the server was missing, or the project was not
 * recognised — and neither could we, from the user's report.
 *
 * These reasons are recorded into the runtime store's existing
 * `failed` map, which the LSP status pill already renders as an
 * error with Restart/Disable (useLspHint.ts), so no new UI is
 * needed. The reason text is written for the user, not the log:
 * it names what is missing and what to do about it.
 */
export type AttachGate =
  | "binary-missing"
  | "no-root"
  | "crashed-out"
  | "session-cap"
  | "initialize-failed";

export function attachFailureReason(
  preset: LspPreset,
  gate: AttachGate,
  detail?: { path?: string; maxSessions?: number },
): string {
  switch (gate) {
    case "binary-missing":
      return `"${preset.command}" not found — install the ${preset.name} server, then press Restart.`;
    case "no-root": {
      const markers =
        preset.rootMarkers.length > 0 ? preset.rootMarkers : [".git"];
      const where = detail?.path ? ` above ${detail.path}` : "";
      return `No project root found${where} — looked for ${markers.join(", ")}. Open the project folder instead of a single file.`;
    }
    case "crashed-out":
      return `The ${preset.name} server crashed repeatedly and was given up on. Press Restart to try again.`;
    case "session-cap":
      return `Too many ${preset.name} sessions (max ${detail?.maxSessions ?? 4}) — close a project folder and press Restart.`;
    case "initialize-failed":
      return `The ${preset.name} server started but never finished initializing. Press Restart to try again.`;
  }
}

/** Record an attach failure so the status pill shows it as an error. */
export function recordAttachFailure(
  presetId: string,
  reason: string,
): void {
  useLspRuntimeStore.getState().setFailed(presetId, reason);
}

/** Clear the failure once the preset attaches again. */
export function clearAttachFailure(presetId: string): void {
  useLspRuntimeStore.getState().clearFailed(presetId);
}
