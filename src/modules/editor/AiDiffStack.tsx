import type { HunkDecision } from "@/modules/ai/lib/reviewApply";
import type { AiDiffStatus, AiDiffTab, Tab } from "@/modules/tabs";
import { AiDiffPane } from "./AiDiffPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Owning session, stamped on checkpoints for session-delete cleanup. */
  sessionId?: string;
  onSetStatus: (approvalId: string, status: AiDiffStatus) => void;
  onSetHunkDecision: (
    approvalId: string,
    hunkIndex: number,
    decision: HunkDecision,
  ) => void;
  onSetFileDecision: (
    approvalId: string,
    decision: "accepted" | "rejected" | "undecided",
  ) => void;
};

export function AiDiffStack({
  tabs,
  activeId,
  sessionId,
  onSetStatus,
  onSetHunkDecision,
  onSetFileDecision,
}: Props) {
  const active = tabs.find(
    (t): t is AiDiffTab => t.kind === "ai-diff" && t.id === activeId,
  );
  if (!active) return null;
  return (
    <div className="h-full w-full">
      <AiDiffPane
        key={active.id}
        path={active.path}
        originalContent={active.originalContent}
        proposedContent={active.proposedContent}
        status={active.status}
        isNewFile={active.isNewFile}
        approvalId={active.approvalId}
        sessionId={sessionId}
        mutationKind={active.mutationKind}
        targetPath={active.targetPath}
        fileDecision={active.fileDecision}
        hunkDecisions={active.hunkDecisions}
        written={active.written}
        onSetHunkDecision={(hunkIndex, decision) =>
          onSetHunkDecision(active.approvalId, hunkIndex, decision)
        }
        onSetFileDecision={(decision) =>
          onSetFileDecision(active.approvalId, decision)
        }
        onSetStatus={(status) => onSetStatus(active.approvalId, status)}
      />
    </div>
  );
}
