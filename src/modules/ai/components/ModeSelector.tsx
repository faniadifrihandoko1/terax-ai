import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ArrowDown01Icon, Task01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useChatStore } from "../store/chatStore";
import { usePlanReviewStore } from "../store/planReviewStore";
import type { ComposerMode } from "../lib/planReview";

const MODES: {
  id: ComposerMode;
  label: string;
  hint: string;
}[] = [
  {
    id: "agent",
    label: "Agent",
    hint: "Execute tasks directly",
  },
  {
    id: "plan",
    label: "Plan",
    hint: "Draft a plan for approval first",
  },
];

/**
 * Fase 30: composer mode selector, next to the agent switcher.
 * "Agent" is the default (unchanged behaviour); "Plan" puts the run
 * in read-only plan-review mode — the agent explores and submits a
 * structured plan, nothing is written until the user approves it.
 * The mode is per chat session and persists with the plan record.
 * Plan mode is highlighted amber so the current mode is always
 * obvious at a glance.
 */
export function ModeSelector() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const mode = usePlanReviewStore((s) =>
    sessionId ? (s.bySession[sessionId]?.mode ?? "agent") : "agent",
  );
  const setMode = usePlanReviewStore((s) => s.setMode);

  const active = MODES.find((m) => m.id === mode) ?? MODES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="xs"
          variant="outline"
          className={cn(
            "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10.5px] transition-colors",
            mode === "plan"
              ? "border-amber-500/60 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-400"
              : "border-border/60 bg-card text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
          )}
          title={
            mode === "plan"
              ? "Mode Plan — agent hanya menyusun rencana, tidak mengubah file"
              : "Mode Agent — agent langsung mengeksekusi"
          }
        >
          <HugeiconsIcon icon={Task01Icon} size={11} strokeWidth={1.75} />
          <span>{active.label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={10}
            strokeWidth={2}
            className="opacity-70"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Mode
        </div>
        {MODES.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onClick={() => {
              if (sessionId) setMode(sessionId, m.id);
            }}
            className="flex items-start gap-2"
          >
            <HugeiconsIcon
              icon={Tick02Icon}
              size={12}
              strokeWidth={2}
              className={cn(
                "mt-0.5 shrink-0",
                m.id === mode ? "text-foreground" : "opacity-0",
              )}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-xs font-medium text-foreground">
                {m.label}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {m.hint}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
