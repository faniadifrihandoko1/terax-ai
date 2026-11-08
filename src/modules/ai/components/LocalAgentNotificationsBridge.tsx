import { routeAgentNotification } from "@/modules/agents/lib/route";
import { useWindowFocus } from "@/modules/agents/lib/useWindowFocus";
import { useAgentStore } from "@/modules/agents/store/agentStore";
import type { AgentStatus } from "@/modules/agents/lib/types";
import { useEffect, useRef } from "react";
import { useChatStore } from "../store/chatStore";

const AGENT = "Terax";

type RunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

function isBusy(s: RunStatus): boolean {
  return s === "thinking" || s === "streaming" || s === "awaiting-approval";
}

function liveStatus(s: RunStatus): AgentStatus | null {
  if (s === "awaiting-approval") return "waiting";
  if (s === "thinking" || s === "streaming") return "working";
  return null;
}

export function LocalAgentNotificationsBridge() {
  const status = useChatStore((s) => s.agentMeta.status) as RunStatus;
  const error = useChatStore((s) => s.agentMeta.error);
  // Fase 9: only a run that actually finished earns the "finished"
  // toast — Stop used to fire it too, because the status flip to idle
  // is identical for both.
  const lastRunOutcome = useChatStore((s) => s.agentMeta.lastRunOutcome);
  const visible = useChatStore((s) => s.panelOpen || s.mini.open);
  const focused = useWindowFocus();

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const prev = useRef<RunStatus>(status);
  // Latches while a run is busy and clears once its ending is reported,
  // so the toast fires exactly once however the status flip and the
  // outcome patch interleave.
  const wasBusyRef = useRef(false);

  useEffect(() => {
    useAgentStore.getState().setLocalAgent(
      liveStatus(status) ? { agent: AGENT, status: liveStatus(status)! } : null,
    );

    const fire = (
      kind: "attention" | "finished" | "error",
      title: string,
      body?: string,
    ) =>
      routeAgentNotification({
        source: "local",
        agent: AGENT,
        kind,
        title,
        body,
        focused: focusedRef.current,
        visible: visibleRef.current,
        allowToast: true,
        onActivate: () => useChatStore.getState().openPanel(),
      });

    const was = prev.current;
    prev.current = status;
    if (was !== status) {
      if (status === "awaiting-approval") {
        fire(
          "attention",
          "Terax needs your approval",
          "Approve a tool to continue",
        );
      } else if (status === "error") {
        fire("error", "Terax run failed", error ?? undefined);
        wasBusyRef.current = false;
      }
    }

    if (isBusy(status)) wasBusyRef.current = true;
    if (status === "idle" && wasBusyRef.current && lastRunOutcome !== null) {
      // The run is over; only a clean finish is announced as finished.
      // A stopped / interrupted / errored run reports nothing here —
      // the chat itself shows the interrupted-run notice.
      if (lastRunOutcome === "finished") {
        fire("finished", "Terax finished", "Your task is ready");
      }
      wasBusyRef.current = false;
    }
  }, [status, error, lastRunOutcome]);

  return null;
}
