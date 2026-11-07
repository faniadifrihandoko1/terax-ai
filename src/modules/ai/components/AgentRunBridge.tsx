import { useChat, type UIMessage } from "@ai-sdk/react";
import type { UIMessagePart } from "ai";
import type { AiDiffStatus } from "@/modules/tabs";
import type { ToolPartLike } from "../lib/fileMutations";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  deriveProposed,
  extractFileMutation,
  readOriginal,
  resolveMutationPath,
  type EditOp,
} from "../lib/fileMutations";
import {
  clearAllReviewedApplies,
  clearReviewedApply,
  isReviewedApply,
  type LineDecision,
} from "../lib/reviewApply";
import { loadReviewState } from "../lib/sessions";
import { restoreStatus, type PersistedReviewState } from "../lib/reviewPersistence";
import {
  flushPersist,
  useChatStore,
  type AgentRunStatus,
} from "../store/chatStore";
import { getOrCreateChat } from "../store/chatRuntime";

/**
 * Headless bridge that mirrors chat lifecycle into the store, so the status
 * pill / mini-window / panel can react without being inside the chat hook tree.
 *
 * Side effects:
 *  - Patches `agentMeta` on every status / approvals change.
 *  - Auto-opens the mini-window when an approval is pending — the user has
 *    to act on it; hiding it would be hostile.
 *  - For pending `write_file` calls, opens an AI diff tab in the editor area
 *    so the user can review the proposed change before approving.
 *  - Persists messages of the active session on every change.
 */

export type DiffOpenInput = {
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  isNewFile: boolean;
  /** FR-10: restored review progress; defaults to a fresh pending tab. */
  status?: AiDiffStatus;
  lineDecisions?: Record<number, LineDecision>;
};

export type AgentRunBridgeProps = {
  openAiDiffTab: (input: DiffOpenInput) => number | null;
  setAiDiffStatus: (approvalId: string, status: AiDiffStatus) => void;
};

export function AgentRunBridge(props: AgentRunBridgeProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  if (!sessionId) return null;
  return <Bridge sessionId={sessionId} {...props} />;
}

type BridgeProps = { sessionId: string } & AgentRunBridgeProps;

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

function Bridge({
  sessionId,
  openAiDiffTab,
  setAiDiffStatus,
}: BridgeProps) {
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const { status, messages, addToolApprovalResponse } = useChat<UIMessage>({
    chat,
  });
  const patch = useChatStore((s) => s.patchAgentMeta);
  const openMini = useChatStore((s) => s.openMini);
  const persistMessages = useChatStore((s) => s.persistMessages);
  const setApprovalResponder = useChatStore((s) => s.setApprovalResponder);

  // Expose the approval responder so the diff tab can resolve approvals.
  // We keep it in a ref-stable closure so identity is stable per render.
  // Every answer is also recorded: it is the only place that knows whether
  // an approval was accepted or rejected.
  const decisionsRef = useRef(new Map<string, boolean>());
  const statusRecordedRef = useRef(new Set<string>());
  useEffect(() => {
    setApprovalResponder((id, approved) => {
      decisionsRef.current.set(id, approved);
      addToolApprovalResponse({ id, approved });
    });
    return () => setApprovalResponder(null);
  }, [setApprovalResponder, addToolApprovalResponse]);

  useEffect(() => {
    persistMessages(sessionId, messages);
  }, [sessionId, messages, persistMessages]);

  // Flush the debounced write whenever the chat goes idle (or errors),
  // and on unmount, so a closed app or session-switch never loses the tail.
  useEffect(() => {
    if (status !== "submitted" && status !== "streaming") {
      flushPersist(sessionId);
    }
  }, [sessionId, status]);
  useEffect(() => {
    return () => flushPersist(sessionId);
  }, [sessionId]);

  const approvalsPending = useMemo(() => {
    let n = 0;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts) {
        if ((p as { state?: string }).state === "approval-requested") n++;
      }
    }
    return n;
  }, [messages]);

  useEffect(() => {
    let runStatus: AgentRunStatus;
    if (approvalsPending > 0) runStatus = "awaiting-approval";
    else if (status === "submitted") runStatus = "thinking";
    else if (status === "streaming") runStatus = "streaming";
    else if (status === "error") runStatus = "error";
    else runStatus = "idle";
    patch({
      status: runStatus,
      approvalsPending,
      ...(runStatus === "idle" || runStatus === "error"
        ? { step: null }
        : {}),
      ...(runStatus === "idle" ? { error: null } : {}),
    });
  }, [status, approvalsPending, patch]);

  useEffect(() => {
    if (approvalsPending > 0) openMini();
  }, [approvalsPending, openMini]);

  // ---- AI diff tab management ----------------------------------------------
  // We track which approvalIds have already opened a tab so re-renders don't
  // open duplicates. Reset when the session changes.
  const openedRef = useRef<Set<string>>(new Set());
  const fileMutationFingerprintRef = useRef<string>("");
  // FR-10: saved review state for this session, loaded once (the bridge
  // re-derives the reviewed contents from the messages; only the status
  // and line decisions are restored).
  const reviewStateCacheRef = useRef<{
    sessionId: string;
    state: PersistedReviewState | null;
  } | null>(null);
  const reviewToastShownRef = useRef<Set<string>>(new Set());
  // biome-ignore lint/correctness/useExhaustiveDependencies(sessionId): sessionId is a manual reset trigger — the per-session caches reset when the session changes
  useEffect(() => {
    openedRef.current = new Set();
    fileMutationFingerprintRef.current = "";
    decisionsRef.current = new Map();
    statusRecordedRef.current = new Set();
    reviewStateCacheRef.current = null;
    clearAllReviewedApplies();
  }, [sessionId]);

  // Cheap fingerprint of file-mutation tool parts only. The diff-tab effect
  // is the most expensive thing on the streaming path, so we skip it when
  // only text/reasoning tokens have arrived (the common case).
  const fileMutationFingerprint = useMemo(() => {
    let fp = "";
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        const t = (p as { type?: string }).type;
        if (
          t === "tool-write_file" ||
          t === "tool-edit" ||
          t === "tool-multi_edit"
        ) {
          const state = (p as { state?: string }).state ?? "";
          const id =
            (p as { approval?: { id?: string } }).approval?.id ?? "";
          fp += `${id}:${state}|`;
        }
      }
    }
    return fp;
  }, [messages]);

  useEffect(() => {
    type Pending = {
      approvalId: string;
      path: string;
      /**
       * Either a literal proposed content (write_file), or a function that
       * derives proposed content from the on-disk original (edit/multi_edit).
       */
      derive:
        | { kind: "literal"; content: string }
        | { kind: "edits"; edits: EditOp[] };
    };
    if (fileMutationFingerprint === fileMutationFingerprintRef.current) {
      return;
    }
    fileMutationFingerprintRef.current = fileMutationFingerprint;

    const pending: Pending[] = [];
    const toResolve = new Set<string>();

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts as AnyPart[]) {
        const info = extractFileMutation(part as unknown as ToolPartLike);
        if (!info) continue;
        const { state, approvalId, path, derive } = info;
        if (!approvalId) continue;
        if (state === "approval-requested") {
          if (!openedRef.current.has(approvalId)) {
            pending.push({ approvalId, path, derive });
          }
        } else if (
          state === "approval-responded" ||
          state === "output-available" ||
          state === "output-error"
        ) {
          if (openedRef.current.has(approvalId)) toResolve.add(approvalId);
        }
      }
    }

    // The diff tab stays open until the user closes it, so the change can
    // be re-opened from the Changed Files card after the task finishes
    // (FR-02). The recorded decision becomes the file's review status.
    for (const id of toResolve) {
      if (statusRecordedRef.current.has(id)) continue;
      // A reviewed apply answers the approval false on purpose, so the
      // agent tool never writes; the pane owns the real outcome. Skip the
      // bridge's own applied/rejected recording for those ids, and
      // consume the registry entry.
      if (isReviewedApply(id)) {
        clearReviewedApply(id);
        continue;
      }
      const approved = decisionsRef.current.get(id);
      if (approved === undefined) continue;
      statusRecordedRef.current.add(id);
      setAiDiffStatus(id, approved ? "applied" : "rejected");
    }

    if (pending.length === 0) return;

    let cancelled = false;
    void (async () => {
      const cwd = useChatStore.getState().live.getCwd();
      // FR-10: load the saved review state once per session so reopened
      // proposals carry their status and line decisions.
      if (reviewStateCacheRef.current?.sessionId !== sessionId) {
        reviewStateCacheRef.current = {
          sessionId,
          state: await loadReviewState(sessionId).catch(() => null),
        };
      }
      const restored = reviewStateCacheRef.current.state;
      let restoredCount = 0;
      for (const p of pending) {
        if (cancelled) return;
        // Mark as opened up-front so a re-render mid-await doesn't double-open.
        openedRef.current.add(p.approvalId);
        const abs = resolveMutationPath(p.path, cwd);
        const original = await readOriginal(abs);
        if (cancelled) return;
        const r = deriveProposed(original.content, p.derive);
        if (!r.ok) {
          // Edit precondition failed (string not found / not unique).
          // Skip opening the tab; the approval modal will surface the error.
          continue;
        }
        const proposed = r.content;
        const saved = restored?.proposals.find(
          (pr) => pr.approvalId === p.approvalId,
        );
        const lineDecisions: Record<number, LineDecision> = {};
        if (saved) {
          for (const [index, decision] of Object.entries(
            saved.lineDecisions,
          )) {
            lineDecisions[Number(index)] = decision;
          }
          restoredCount += 1;
        }
        openAiDiffTab({
          path: abs,
          originalContent: original.content,
          proposedContent: proposed,
          approvalId: p.approvalId,
          isNewFile: original.isNewFile,
          status: saved ? restoreStatus(saved.status) : undefined,
          lineDecisions: saved ? lineDecisions : undefined,
        });
      }
      if (restoredCount > 0 && !reviewToastShownRef.current.has(sessionId)) {
        reviewToastShownRef.current.add(sessionId);
        toast.info(
          `Restored ${restoredCount} pending AI review${restoredCount === 1 ? "" : "s"} from the last session`,
          {
            description:
              "Open a file from the Changed Files card to continue reviewing.",
          },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, fileMutationFingerprint, openAiDiffTab, setAiDiffStatus, sessionId]);

  return null;
}
