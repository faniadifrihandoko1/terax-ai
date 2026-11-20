import type { UIMessage } from "@ai-sdk/react";
import {
  appendChatMessage,
  hasMessageAppender,
  replaceChatMessage,
} from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  formatVerifyReport,
  runPostConfirmVerification,
  type VerifyOutcome,
} from "./verifyAfterConfirm";

/**
 * Penjadwal auto-verifikasi (Fase 37): satu verifikasi dalam satu
 * waktu untuk seluruh aplikasi. Confirm yang datang saat sebuah run
 * masih berjalan tidak menumpuk — file-nya diantre dan diverifikasi
 * begitu run yang berjalan selesai. Hasilnya ditempel sebagai pesan
 * asisten di chat sesi itu (via `Chat.setMessages`, jadi ikut
 * ter-persist seperti pesan lain), mula-mula sebagai "sedang
 * berjalan" lalu diganti hasil akhirnya dengan id yang sama.
 */

export type VerifySchedulerDeps = {
  settingEnabled: () => boolean;
  chatExists: (sessionId: string) => boolean;
  appendMessage: (sessionId: string, message: UIMessage) => void;
  replaceMessage: (sessionId: string, id: string, message: UIMessage) => void;
  runVerification: (args: {
    sessionId: string;
    files: string[];
    rootHint?: string;
    manual?: boolean;
  }) => Promise<VerifyOutcome>;
};

export function defaultVerifySchedulerDeps(): VerifySchedulerDeps {
  return {
    settingEnabled: () =>
      usePreferencesStore.getState().verifyAfterConfirm,
    chatExists: (sessionId) => hasMessageAppender(sessionId),
    appendMessage: (sessionId, message) => {
      appendChatMessage(sessionId, message);
    },
    replaceMessage: (sessionId, id, message) => {
      replaceChatMessage(sessionId, id, message);
    },
    runVerification: (args) => runPostConfirmVerification(args),
  };
}

export type VerifyRequestResult = "started" | "queued" | "off" | "no-chat";

type PendingRun = {
  sessionId: string;
  files: string[];
  rootHint?: string;
  manual: boolean;
};

let running: { sessionId: string; runId: string } | null = null;
let pending: PendingRun[] = [];
let runCounter = 0;

/** Test-only: kembalikan state modul ke kosong. */
export function resetVerifySchedulerForTests(): void {
  running = null;
  pending = [];
  runCounter = 0;
}

function reportMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

async function startNext(deps: VerifySchedulerDeps): Promise<void> {
  const next = pending.shift();
  if (!next) return;
  runCounter += 1;
  const runId = `verify-${runCounter}-${Date.now()}`;
  running = { sessionId: next.sessionId, runId };
  deps.appendMessage(
    next.sessionId,
    reportMessage(runId, "Verifikasi setelah Confirm sedang berjalan…"),
  );
  let outcome: VerifyOutcome;
  try {
    outcome = await deps.runVerification({
      sessionId: next.sessionId,
      files: next.files,
      rootHint: next.rootHint,
      manual: next.manual,
    });
  } catch (e) {
    outcome = {
      status: "failed",
      checks: [],
      durationMs: 0,
      files: next.files,
      error: String(e),
    };
  }
  deps.replaceMessage(
    next.sessionId,
    runId,
    reportMessage(runId, formatVerifyReport(outcome, next.files)),
  );
  running = null;
  if (pending.length > 0) void startNext(deps);
}

function enqueue(req: PendingRun, deps: VerifySchedulerDeps): VerifyRequestResult {
  if (!req.manual && !deps.settingEnabled()) return "off";
  if (!deps.chatExists(req.sessionId)) return "no-chat";
  const existing = pending.find((p) => p.sessionId === req.sessionId);
  if (existing) {
    for (const f of req.files) {
      if (!existing.files.includes(f)) existing.files.push(f);
    }
    if (req.rootHint) existing.rootHint = req.rootHint;
    return "queued";
  }
  pending.push(req);
  if (running) return "queued";
  void startNext(deps);
  return "started";
}

/** Confirm otomatis: dihormati hanya bila setting menyala. */
export function requestPostConfirmVerification(
  trigger: { sessionId: string; path: string },
  deps: VerifySchedulerDeps = defaultVerifySchedulerDeps(),
): VerifyRequestResult {
  return enqueue(
    { sessionId: trigger.sessionId, files: [trigger.path], manual: false },
    deps,
  );
}

/** Verifikasi manual dari Command Palette: melewati setting. */
export function requestManualVerification(
  trigger: { sessionId: string; root: string },
  deps: VerifySchedulerDeps = defaultVerifySchedulerDeps(),
): VerifyRequestResult {
  return enqueue(
    {
      sessionId: trigger.sessionId,
      files: [],
      rootHint: trigger.root,
      manual: true,
    },
    deps,
  );
}
