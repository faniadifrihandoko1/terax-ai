import type { LineDecision } from "@/modules/ai/lib/reviewApply";
import type { AiDiffStatus, AiDiffTab, Tab } from "@/modules/tabs";
import { AiDiffPane } from "./AiDiffPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetStatus: (approvalId: string, status: AiDiffStatus) => void;
  onSetLineDecision: (
    approvalId: string,
    index: number,
    decision: LineDecision,
  ) => void;
};

export function AiDiffStack({
  tabs,
  activeId,
  onSetStatus,
  onSetLineDecision,
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
        lineDecisions={active.lineDecisions}
        onSetLineDecision={(index, decision) =>
          onSetLineDecision(active.approvalId, index, decision)
        }
        onSetStatus={(status) => onSetStatus(active.approvalId, status)}
      />
    </div>
  );
}
