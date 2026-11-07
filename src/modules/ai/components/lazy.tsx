import type { PresenceState } from "@/lib/usePresence";
import { lazy, Suspense } from "react";
import type { AgentRunBridgeProps } from "./AgentRunBridge";
import type { SelectionAskAiProps } from "./SelectionAskAi";

const AgentRunBridgeInner = lazy(() =>
  import("./AgentRunBridge").then((m) => ({ default: m.AgentRunBridge })),
);

const AiMiniWindowInner = lazy(() =>
  import("./AiMiniWindow").then((m) => ({ default: m.AiMiniWindow })),
);

const AiInputBarConnectInner = lazy(() =>
  import("./AiInputBar").then((m) => ({ default: m.AiInputBarConnect })),
);

const SelectionAskAiInner = lazy(() =>
  import("./SelectionAskAi").then((m) => ({ default: m.SelectionAskAi })),
);

export function AgentRunBridge(props: AgentRunBridgeProps) {
  return (
    <Suspense fallback={null}>
      <AgentRunBridgeInner {...props} />
    </Suspense>
  );
}

export function AiMiniWindow({
  state,
  onOpenFileDiff,
  reviewStatusByApproval,
  restorableApprovals,
  onRestoreFile,
}: {
  state: PresenceState;
  onOpenFileDiff?: (approvalId: string) => void;
  reviewStatusByApproval?: Map<string, import("@/modules/tabs").AiDiffStatus>;
  restorableApprovals?: ReadonlySet<string>;
  onRestoreFile?: (approvalId: string) => void;
}) {
  return (
    <Suspense fallback={null}>
      <AiMiniWindowInner
        state={state}
        onOpenFileDiff={onOpenFileDiff}
        reviewStatusByApproval={reviewStatusByApproval}
        restorableApprovals={restorableApprovals}
        onRestoreFile={onRestoreFile}
      />
    </Suspense>
  );
}

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  return (
    <Suspense fallback={null}>
      <AiInputBarConnectInner onAdd={onAdd} />
    </Suspense>
  );
}

export function SelectionAskAi(props: SelectionAskAiProps) {
  return (
    <Suspense fallback={null}>
      <SelectionAskAiInner {...props} />
    </Suspense>
  );
}
