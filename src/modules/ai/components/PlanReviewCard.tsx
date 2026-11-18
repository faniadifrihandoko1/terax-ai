import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { File01Icon, Task01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useState } from "react";
import {
  planToExecutionMessage,
  planToTodos,
} from "../lib/planReview";
import { useChatStore } from "../store/chatStore";
import { sendMessage } from "../store/chatRuntime";
import { usePlanReviewStore } from "../store/planReviewStore";
import { useTodosStore } from "../store/todoStore";

/**
 * Fase 30: the plan-review card. Rendered in AiChatView whenever the
 * active session has a draft plan (status "draft"). The agent wrote
 * nothing to disk to produce it — plan mode is read-only — so this
 * card is the only gate between the draft and execution.
 *
 * "Setujui & jalankan": approves the draft (mode flips back to
 * Agent), turns the plan steps into todos, and sends the approved
 * plan as the execution message — the run that follows is a normal
 * agent run, so the existing review flow (per-hunk review, Confirm,
 * checkpoint) still applies to everything it writes.
 * "Tolak": drops the draft; the user can ask for a new plan.
 * Revising the plan happens by replying in chat — the agent calls
 * submit_plan again and this card shows the revised draft.
 */
export const PlanReviewCard = memo(function PlanReviewCard() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const record = usePlanReviewStore((s) =>
    sessionId ? s.bySession[sessionId] : undefined,
  );
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy = status === "thinking" || status === "streaming";
  const [approving, setApproving] = useState(false);

  if (!sessionId || record?.status !== "draft" || !record.plan) {
    return null;
  }
  const plan = record.plan;

  const onApprove = () => {
    if (approving || isBusy) return;
    setApproving(true);
    try {
      const approved = usePlanReviewStore.getState().approvePlan(sessionId);
      if (!approved) return;
      // Steps become the execution todos (appended, never replacing
      // the session's existing todos).
      const existing = useTodosStore.getState().bySession[sessionId] ?? [];
      useTodosStore
        .getState()
        .setTodos(sessionId, [...existing, ...planToTodos(approved)]);
      void sendMessage(planToExecutionMessage(approved));
    } finally {
      setApproving(false);
    }
  };

  const onReject = () => {
    if (approving || isBusy) return;
    usePlanReviewStore.getState().rejectPlan(sessionId);
  };

  return (
    <div className="overflow-hidden rounded-md border border-amber-500/40 bg-amber-500/[0.06]">
      <div className="flex items-center gap-2 px-2.5 py-2">
        <HugeiconsIcon
          icon={Task01Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-amber-700 dark:text-amber-400"
        />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          Rencana implementasi
        </span>
        <Badge variant="outline" className="shrink-0 text-[10.5px]">
          Menunggu persetujuan
        </Badge>
      </div>
      <div className="border-t border-border/30 px-2.5 py-2 text-[12px] leading-relaxed">
        <p className="font-medium text-foreground">{plan.goal}</p>
        {plan.files.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {plan.files.map((f) => (
              <li key={f.path} className="flex items-start gap-1.5">
                <HugeiconsIcon
                  icon={File01Icon}
                  size={11}
                  strokeWidth={1.75}
                  className="mt-0.5 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0">
                  <span className="font-mono text-[11px] text-foreground">
                    {f.path}
                  </span>
                  <span className="text-muted-foreground"> — {f.reason}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <ol className="mt-2 flex flex-col gap-1.5">
          {plan.steps.map((s, i) => (
            <li
              key={`${s.title}::${s.detail ?? ""}`}
              className="flex items-start gap-2"
            >
              <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                {i + 1}
              </span>
              <span className="min-w-0">
                <span className="text-foreground">{s.title}</span>
                {s.detail ? (
                  <span className="block text-muted-foreground">
                    {s.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        {plan.risks.length > 0 ? (
          <div className="mt-2">
            <div className="text-[11px] font-medium text-muted-foreground">
              Risiko
            </div>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {plan.risks.map((r) => (
                <li key={r} className="text-muted-foreground">
                  • {r}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {plan.verification.length > 0 ? (
          <div className="mt-2">
            <div className="text-[11px] font-medium text-muted-foreground">
              Verifikasi
            </div>
            <ul className="mt-0.5 flex flex-col gap-0.5">
              {plan.verification.map((v) => (
                <li key={v} className="font-mono text-[11px] text-muted-foreground">
                  • {v}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Agent tidak mengubah file apa pun sampai rencana ini disetujui.
          Balas di chat bila ada yang perlu direvisi.
        </p>
      </div>
      <div className="flex items-center gap-2 border-t border-border/30 px-2.5 py-2">
        <Button
          size="sm"
          onClick={onApprove}
          disabled={approving || isBusy}
          className="h-7 gap-1"
          title="Setujui rencana ini dan jalankan sebagai agent"
        >
          <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
          {approving ? "Menjalankan…" : "Setujui & jalankan"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onReject}
          disabled={approving || isBusy}
          className={cn("h-7")}
          title="Tolak rencana ini"
        >
          Tolak
        </Button>
      </div>
    </div>
  );
});
