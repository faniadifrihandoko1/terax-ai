import type { HunkDecision } from "@/modules/ai/lib/reviewApply";
import type { AiDiffStatus, AiDiffTab, Tab } from "@/modules/tabs";
import { AiDiffPane } from "./AiDiffPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetStatus: (approvalId: string, status: AiDiffStatus) => void;
  onSetHunkDecision: (
    approvalId: string,
    hunkIndex: number,
    decision: HunkDecision,
  ) => void;
};

export function AiDiffStack({
  tabs,
  activeId,
  onSetStatus,
  onSetHunkDecision,
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
        hunkDecisions={active.hunkDecisions}
        onSetHunkDecision={(hunkIndex, decision) =>
          onSetHunkDecision(active.approvalId, hunkIndex, decision)
        }
        onSetStatus={(status) => onSetStatus(active.approvalId, status)}
      />
    </div>
  );
}
