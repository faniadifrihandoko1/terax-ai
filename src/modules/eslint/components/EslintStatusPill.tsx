import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { Loading03Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { eslintPathKey, isLintablePath } from "../lib/eslintPaths";
import { useEslintStore } from "../lib/eslintStore";
import {
  describeEslintRunStatus,
  type EslintStatusTone,
} from "../lib/eslintStatusText";
import { requestEslintRunWithReport } from "../lib/runEslintManual";

type Props = {
  filePath: string | null;
};

const PILL_CLASS =
  "terax-pill-in ml-1.5 flex h-6 shrink-0 cursor-pointer [&_button]:cursor-pointer items-center gap-1 rounded-full border border-border/50 bg-accent/50 px-2 text-[10.5px] font-medium text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground";

const DOT_CLASS: Record<EslintStatusTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
  muted: "bg-muted-foreground/50",
};

/**
 * Shows the last ESLint run outcome for the active file next to the
 * diagnostics badge: clean, counts, or the reason the run produced
 * nothing (binary missing, dirty buffer, disk read failed, result
 * mismatch, …). The popover explains the outcome and offers a
 * manual re-run. Hidden when ESLint is off, the file is not
 * lintable, or no run has recorded a status for it yet.
 */
export function EslintStatusPill({ filePath }: Props) {
  const enabled = usePreferencesStore((s) => s.eslintEnabled);
  const status = useEslintStore((s) =>
    filePath ? s.runStatus[eslintPathKey(filePath)] : undefined,
  );
  if (!filePath || !enabled || !isLintablePath(filePath) || !status) {
    return null;
  }
  const { label, detail, tone } = describeEslintRunStatus(status);
  const running = status.kind === "running";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={PILL_CLASS} title={label}>
          {running ? (
            <HugeiconsIcon
              icon={Loading03Icon}
              size={11}
              strokeWidth={2}
              className="animate-spin"
            />
          ) : (
            <span className={`size-1.5 rounded-full ${DOT_CLASS[tone]}`} />
          )}
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 p-3 text-xs [&_button]:cursor-pointer"
      >
        <div className="mb-1 font-medium text-foreground">{label}</div>
        <p className="mb-2 text-muted-foreground">{detail}</p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => requestEslintRunWithReport(filePath)}
          >
            <HugeiconsIcon icon={RefreshIcon} size={11} strokeWidth={1.9} />
            Jalankan ulang
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
