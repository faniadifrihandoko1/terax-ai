import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  CheckmarkCircle01Icon,
  CopyIcon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolUIPart } from "ai";
import { memo, useEffect, useRef, useState } from "react";
import {
  describeShellCommand,
  type ShellApprovalInfo,
  type ShellRisk,
} from "../lib/shellApproval";
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

/** Risk badge on the approval header (Fase 38). Colors mirror the
 * destructive warning below: green for read-only, amber for writes,
 * rose for deletes. */
const RISK_BADGE: Record<ShellRisk, { label: string; className: string }> = {
  safe: {
    label: "Aman",
    className:
      "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  caution: {
    label: "Hati-hati",
    className:
      "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  dangerous: {
    label: "Berbahaya",
    className:
      "border-rose-500/50 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
};

function AiToolApprovalImpl({ part, toolName, onRespond }: Props) {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const Icon = meta?.icon ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;
  const isShell = toolName === "bash_run" || toolName === "bash_background";
  const info = isShell
    ? describeShellCommand(String(input.command ?? ""))
    : null;

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
        {info && (
          <span
            className={cn(
              "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
              RISK_BADGE[info.risk].className,
            )}
          >
            {RISK_BADGE[info.risk].label}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          needs approval
        </span>
      </div>

      <div className="px-3 py-2.5">
        <PreviewBlock toolName={toolName} input={input} info={info} />
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
  info,
}: {
  toolName: string;
  input: Record<string, unknown>;
  info: ShellApprovalInfo | null;
}) {
  // The approval card shows the command so the user can judge it; the
  // file tools never reach this card (Fase 6), so there is no file
  // preview branch anymore.
  const [expanded, setExpanded] = useState(false);
  if (toolName === "bash_run" || toolName === "bash_background") {
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    const command = String(input.command ?? "");
    const destructive = detectDestructiveShellCommand(command);
    // A command longer than the preview is never silently truncated:
    // the block scrolls, expands, and copies in full.
    const isLong = command.length > 240;
    return (
      <div className="space-y-1.5">
        {cwd && (
          <div className="text-[10.5px] text-muted-foreground">
            Dijalankan di: <span className="font-mono">{cwd}</span>
          </div>
        )}
        {destructive && (
          <DestructiveWarning destructive={destructive} />
        )}
        <div className="relative">
          <pre
            className={cn(
              "max-h-40 overflow-auto rounded-md bg-muted/60 p-2 pr-8 font-mono text-[11px] leading-relaxed",
              expanded && "max-h-none",
            )}
          >
            {command}
          </pre>
          <div className="absolute right-1.5 top-1.5">
            <CopyButton text={command} />
          </div>
        </div>
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Tutup" : "Lihat selengkapnya"}
          </button>
        )}
        {info && (
          <p className="text-[11px] leading-relaxed text-foreground">
            {info.explanation}
          </p>
        )}
        {info && info.segments.length > 1 && (
          <ol className="list-decimal space-y-0.5 pl-4 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {info.segments.map((segment) => (
              // Keyed by content: the step list is static (the card is
              // memoized and never re-renders with different content),
              // so identical steps render twice without reordering risk.
              <li key={segment} className="break-all">
                {segment}
              </li>
            ))}
          </ol>
        )}
        {info && !destructive && info.touchedPaths.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            Menyentuh:{" "}
            <span className="font-mono">{info.touchedPaths.join(", ")}</span>
          </div>
        )}
      </div>
    );
  }
  return (
    <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

/** Copy button for the full command (same idiom as the code-block copy
 * button in chat-code.tsx). Copies the entire command, not the visible
 * preview slice, so a truncated-looking command still copies in full. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onCopy = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  };

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={onCopy}
      className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
      aria-label="Salin perintah"
    >
      <HugeiconsIcon
        icon={copied ? CheckmarkCircle01Icon : CopyIcon}
        size={11}
        strokeWidth={1.75}
      />
    </Button>
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

