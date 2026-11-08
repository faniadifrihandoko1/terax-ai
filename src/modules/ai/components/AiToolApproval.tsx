import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolUIPart } from "ai";
import { memo } from "react";
import {
  detectDestructiveShellCommand,
  type DestructiveShellCommand,
} from "../lib/security";

type Props = {
  part: Extract<ToolUIPart, { state: "approval-requested" }>;
  toolName: string;
  onRespond: (approved: boolean) => void;
};

/**
 * Approval card. Since Fase 6 only terminal commands (and managed-agent
 * spawns) are approval-gated — file proposals never show a card, they go
 * straight to the review tab. Anything not listed here falls back to the
 * generic label + JSON preview.
 */
const TOOL_META: Record<string, { label: string; icon: typeof ToolsIcon }> =
  {
    bash_run: { label: "Run shell command", icon: TerminalIcon },
    bash_background: { label: "Spawn background process", icon: TerminalIcon },
  };

function AiToolApprovalImpl({ part, toolName, onRespond }: Props) {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const Icon = meta?.icon ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="size-1.5 shrink-0 rounded-full bg-amber-500 terax-attention-pulse" />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <span className="text-[12px] font-medium text-foreground">
          {label}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          needs approval
        </span>
      </div>

      <div className="px-3 py-2.5">
        <PreviewBlock toolName={toolName} input={input} />
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border/60 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRespond(false)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          Deny
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond(true)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          Approve
        </Button>
      </div>
    </div>
  );
}

export const AiToolApproval = memo(AiToolApprovalImpl, (a, b) => {
  // The approval card never changes content for a given approvalId — once
  // the model has emitted the approval-requested part with its input, we
  // don't want to re-render on every downstream token.
  return (
    a.toolName === b.toolName &&
    a.part.approval.id === b.part.approval.id &&
    a.onRespond === b.onRespond
  );
});

function PreviewBlock({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  // The approval card shows the command so the user can judge it; the
  // file tools never reach this card (Fase 6), so there is no file
  // preview branch anymore.
  if (toolName === "bash_run" || toolName === "bash_background") {
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    const destructive = detectDestructiveShellCommand(
      String(input.command ?? ""),
    );
    return (
      <div className="space-y-1.5">
        {cwd && (
          <div className="font-mono text-[10.5px] text-muted-foreground">
            {cwd}
          </div>
        )}
        {destructive && (
          <DestructiveWarning destructive={destructive} />
        )}
        <pre
          className={cn(
            "max-h-40 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed",
          )}
        >
          {String(input.command ?? "")}
        </pre>
      </div>
    );
  }
  return (
    <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

/**
 * Explicit warning for destructive shell commands on the approval card.
 * A bare command in a <pre> block is easy to approve without noticing
 * that it deletes files — and unlike a reviewed file proposal, a shell
 * delete has no checkpoint and cannot be Restored. Catastrophic targets
 * are refused when the tool executes, so the card says so instead of
 * pretending Approve will run them.
 */
function DestructiveWarning({
  destructive,
}: {
  destructive: DestructiveShellCommand;
}) {
  const shown = destructive.targets.slice(0, 4);
  const rest = destructive.targets.length - shown.length;
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-1.5 text-[11px] leading-relaxed",
        destructive.catastrophic
          ? "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300"
          : "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      <div className="font-medium">
        {destructive.catastrophic
          ? "Perintah ini akan ditolak saat dijalankan"
          : "Perintah destruktif — tanpa checkpoint"}
      </div>
      <div className="font-mono">
        {destructive.kind === "delete" ? "Menghapus: " : "Memindahkan: "}
        {shown.join(", ")}
        {rest > 0 ? ` (+${rest} lainnya)` : ""}
      </div>
      <div>
        {destructive.catastrophic
          ? "Target terlalu luas atau di lokasi sistem — perintah tidak dijalankan. Untuk hapus/rename file, minta agent memakai tool delete_file / rename_file."
          : "File yang dihapus/dipindah lewat terminal TIDAK punya checkpoint dan tidak bisa di-Restore. Untuk file, minta agent memakai tool delete_file / rename_file (direview, bisa di-Restore)."}
      </div>
    </div>
  );
}

