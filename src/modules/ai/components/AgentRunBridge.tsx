import { useChat, type UIMessage } from "@ai-sdk/react";
import type { UIMessagePart } from "ai";
import type { AiDiffStatus } from "@/modules/tabs";
import type { ToolPartLike } from "../lib/fileMutations";
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  deriveProposed,
  isFileMutationPart,
  readOriginal,
  resolveMutationPath,
} from "../lib/fileMutations";
import { collectPendingFileProposals } from "../lib/fileProposals";
import {
  clearAllPendingProposals,
  getPendingProposal,
} from "../lib/pendingProposals";
import { saveCheckpoint } from "../lib/reviewCheckpoint";
import {
  type HunkDecision,
  type LineDecision,
} from "../lib/reviewApply";
import {
  computeLineChanges,
  migrateLineDecisionsToHunks,
} from "@/modules/editor/lib/lineDiff";
import { loadReviewState } from "../lib/sessions";
import {
  restoreStatus,
  type PersistedReviewState,
} from "../lib/reviewPersistence";
import { usePreferencesStore } from "@/modules/settings/preferences";
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
 *    to act on it; hiding it would be hostile. Since Fase 6 only terminal
 *    commands (and managed-agent spawns) are approval-gated.
 *  - For finished file-mutation tool calls, opens an AI diff tab in the
 *    editor area so the user can review the proposed change. File tools
 *    are not approval-gated (Fase 6): their execute only records a
 *    proposal, so the tab opens once the tool call finished — the run
 *    never blocks waiting for the user. Edit proposals for one file
 *    compose into a single tab; delete/rename proposals open their own.
 *  - Persists messages of the active session on every change.
 *
 * The review tab owns the proposal's status (pending → reviewing → done
 * → applied / rejected / conflict / restored). The bridge never records
 * a status from an approval answer: file proposals have no approval to
 * answer anymore.
 */

export type DiffOpenInput = {
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  isNewFile: boolean;
  /** FR-10: restored review progress; defaults to a fresh pending tab. */
  status?: AiDiffStatus;
  /** Delete/rename proposal (Fase 5). Defaults to "edit". */
  mutationKind?: "edit" | "delete" | "rename";
  /** Rename destination. Only used when mutationKind is "rename". */
  targetPath?: string;
  /** Restored per-file decision for delete/rename proposals. */
  fileDecision?: "accepted" | "rejected";
  hunkDecisions?: Record<number, HunkDecision>;
  /** False when inline review is on: the tab opens in the background. */
  activate?: boolean;
};

export type AgentRunBridgeProps = {
  openAiDiffTab: (input: DiffOpenInput) => number | null;
  /** Absorbs a newer composed proposal into an existing tab (Fase 6). */
  updateAiDiffTab: (approvalId: string, proposedContent: string) => boolean;
};

export function AgentRunBridge(props: AgentRunBridgeProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  if (!sessionId) return null;
  return <Bridge sessionId={sessionId} {...props} />;
}

type BridgeProps = { sessionId: string } & AgentRunBridgeProps;

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

function Bridge({ sessionId, openAiDiffTab, updateAiDiffTab }: BridgeProps) {
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const { status, messages, addToolApprovalResponse } = useChat<UIMessage>({
    chat,
  });
  const patch = useChatStore((s) => s.patchAgentMeta);
  const openMini = useChatStore((s) => s.openMini);
  const persistMessages = useChatStore((s) => s.persistMessages);
  const setApprovalResponder = useChatStore((s) => s.setApprovalResponder);

  // Expose the approval responder so the approval card can resolve
  // approvals. Only terminal commands (and managed-agent spawns) are
  // approval-gated since Fase 6; file proposals have no approval.
  useEffect(() => {
    setApprovalResponder((id, approved) => {
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
      ...(runStatus === "idle" || runStatus === "error" ? { step: null } : {}),
      ...(runStatus === "idle" ? { error: null } : {}),
    });
  }, [status, approvalsPending, patch]);

  useEffect(() => {
    if (approvalsPending > 0) openMini();
  }, [approvalsPending, openMini]);

  // ---- AI diff tab management ----------------------------------------------
  // We track which proposal ids have already opened a tab so re-renders
  // don't open duplicates, and which tab each path's composed proposal
  // lives in so later proposals for the same file update it. Reset when
  // the session changes.
  const openedRef = useRef<Set<string>>(new Set());
  const tabByPathRef = useRef<Map<string, string>>(new Map());
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
    tabByPathRef.current = new Map();
    fileMutationFingerprintRef.current = "";
    reviewStateCacheRef.current = null;
    clearAllPendingProposals();
  }, [sessionId]);

  // Cheap fingerprint of file-mutation tool parts only. The diff-tab effect
  // is the most expensive thing on the streaming path, so we skip it when
  // only text/reasoning tokens have arrived (the common case). The path
  // and rename target are part of the fingerprint so a changed input
  // re-runs the effect instead of reusing a stale proposal. The id is
  // the tool call id (Fase 6) or a legacy approval id.
  const fileMutationFingerprint = useMemo(() => {
    let fp = "";
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        const t = (p as { type?: string }).type;
        if (!t || !isFileMutationPart(t)) continue;
        const state = (p as { state?: string }).state ?? "";
        const id =
          (p as { toolCallId?: string }).toolCallId ??
          (p as { approval?: { id?: string } }).approval?.id ??
          "";
        const input = (p as { input?: unknown }).input as
          | { path?: unknown; to?: unknown }
          | undefined;
        const path = typeof input?.path === "string" ? input.path : "";
        const to = typeof input?.to === "string" ? input.to : "";
        fp += `${id}:${state}:${path}:${to}|`;
      }
    }
    return fp;
  }, [messages]);

  useEffect(() => {
    if (fileMutationFingerprint === fileMutationFingerprintRef.current) {
      return;
    }
    fileMutationFingerprintRef.current = fileMutationFingerprint;

    const allParts: AnyPart[] = [];
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      allParts.push(...(m.parts as AnyPart[]));
    }
    const pending = collectPendingFileProposals(
      allParts as unknown as ToolPartLike[],
      openedRef.current,
    );
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
        openedRef.current.add(p.proposalId);
        const abs = p.resultPath ?? resolveMutationPath(p.path, cwd);

        // Fase 6: edit proposals compose per file. The registry holds the
        // accumulated content; the tab for the path absorbs it so the
        // user reviews one diff per file, not one tab per tool call.
        if (p.mutationKind === "edit") {
          const registry = getPendingProposal(abs);
          if (registry) {
            const existingId = tabByPathRef.current.get(abs);
            if (
              existingId !== undefined &&
              updateAiDiffTab(existingId, registry.proposedContent)
            ) {
              continue;
            }
            openAiDiffTab({
              path: abs,
              originalContent: registry.originalContent,
              proposedContent: registry.proposedContent,
              approvalId: p.proposalId,
              isNewFile: registry.isNewFile,
              mutationKind: "edit",
              // Fase 4: with inline review on, the proposal shows in the
              // editor; the ai-diff tab opens in the background as the
              // side-by-side alternative instead of stealing focus.
              activate: !usePreferencesStore.getState().aiReviewInline,
            });
            tabByPathRef.current.set(abs, p.proposalId);
            continue;
          }
        }

        // Fallback: no registry entry (session restore, or a delete/rename
        // proposal, which never composes). Derive from the on-disk content.
        const original = await readOriginal(abs);
        if (cancelled) return;
        const r = deriveProposed(original.content, p.derive);
        if (!r.ok) {
          // Edit precondition failed (string not found / not unique).
          // Skip opening the tab; the tool result already told the model.
          continue;
        }
        const proposed = r.content;
        const saved = restored?.proposals.find(
          (pr) => pr.approvalId === p.proposalId,
        );
        // v2 states carry hunk decisions; v1 states carry line decisions,
        // migrated to hunks against the re-derived change set.
        const hunkDecisions: Record<number, HunkDecision> = {};
        if (saved) {
          for (const [index, decision] of Object.entries(saved.hunkDecisions)) {
            hunkDecisions[Number(index)] = decision;
          }
          if (saved.lineDecisions) {
            const lineDecisions: Record<number, LineDecision> = {};
            for (const [index, decision] of Object.entries(
              saved.lineDecisions,
            )) {
              lineDecisions[Number(index)] = decision;
            }
            const changeSet = computeLineChanges(original.content, proposed);
            for (const [hunkIndex, decision] of Object.entries(
              migrateLineDecisionsToHunks(lineDecisions, changeSet),
            )) {
              hunkDecisions[Number(hunkIndex)] = decision;
            }
          }
          // v3: an applied proposal restores its checkpoint, so Restore
          // still works after a restart.
          if (saved.checkpoint) saveCheckpoint(saved.checkpoint);
          restoredCount += 1;
        }
        openAiDiffTab({
          path: abs,
          originalContent: original.content,
          proposedContent: proposed,
          approvalId: p.proposalId,
          isNewFile: original.isNewFile,
          status: saved ? restoreStatus(saved.status) : undefined,
          mutationKind: p.mutationKind,
          ...(p.targetPath !== undefined
            ? { targetPath: resolveMutationPath(p.targetPath, cwd) }
            : {}),
          ...(saved?.fileDecision !== undefined
            ? { fileDecision: saved.fileDecision }
            : {}),
          hunkDecisions: saved ? hunkDecisions : undefined,
          // Fase 4: with inline review on, the proposal shows in the
          // editor; the ai-diff tab opens in the background as the
          // side-by-side alternative instead of stealing focus.
          // Delete/rename proposals (Fase 5) have no inline view, so
          // their tab always activates.
          activate:
            p.mutationKind === "edit"
              ? !usePreferencesStore.getState().aiReviewInline
              : true,
        });
        tabByPathRef.current.set(abs, p.proposalId);
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
  }, [
    messages,
    fileMutationFingerprint,
    openAiDiffTab,
    updateAiDiffTab,
    sessionId,
  ]);

  return null;
}
