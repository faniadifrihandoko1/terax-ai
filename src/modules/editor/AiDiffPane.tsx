import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AiDiffStatus } from "@/modules/tabs";
import { presentableDiff, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
} from "./lib/extensions";
import { computeLineStats } from "./lib/diffStats";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";

type Props = {
  path: string;
  originalContent: string;
  proposedContent: string;
  status: AiDiffStatus;
  isNewFile: boolean;
  onAccept: () => void;
  onReject: () => void;
};

const SHARED_EXT: readonly Extension[] = buildSharedExtensions();
const READONLY_EXT: Extension[] = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];

const DIFF_THEME = EditorView.theme({
  // ".cm-changedLine": {
  //   backgroundColor:
  //     "color-mix(in srgb, #22c55e 10%, transparent) !important",
  // },
  // ".cm-merge-b .cm-changedText, .cm-merge-b ins.cm-insertedLine": {
  //   background:
  //     "color-mix(in srgb, #22c55e 28%, transparent) !important",
  //   textDecoration: "none !important",
  //   borderRadius: "2px",
  // },
  // ".cm-deletedChunk": {
  //   backgroundColor:
  //     "color-mix(in srgb, #ef4444 8%, transparent)",
  //   paddingLeft: "6px",
  //   paddingTop: "1px",
  //   paddingBottom: "1px",
  // },
  // ".cm-deletedChunk .cm-deletedText, .cm-deletedLine del": {
  //   background:
  //     "color-mix(in srgb, #ef4444 26%, transparent) !important",
  //   textDecoration: "none !important",
  //   borderRadius: "2px",
  // },
  // ".cm-changeGutter": {
  //   width: "3px",
  // },
  // ".cm-changedLineGutter": {
  //   backgroundColor: "#22c55e",
  // },
  // ".cm-deletedLineGutter": {
  //   backgroundColor: "#ef4444",
  // },
  ".cm-changedText": {
    background: "#88ff881a !important",
  },
});

const STATUS_LABEL: Record<AiDiffStatus, string> = {
  pending: "Pending review",
  reviewing: "Reviewing",
  done: "Reviewed",
  applied: "Applied",
  rejected: "Rejected",
  conflict: "Conflict",
};

const STATUS_BADGE: Record<
  AiDiffStatus,
  "outline" | "secondary" | "destructive"
> = {
  pending: "outline",
  reviewing: "secondary",
  done: "secondary",
  applied: "secondary",
  rejected: "destructive",
  conflict: "destructive",
};

export function AiDiffPane({
  path,
  originalContent,
  proposedContent,
  status,
  isNewFile,
  onAccept,
  onReject,
}: Props) {
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const themeExt = useEditorThemeExt();

  // Language resolves before mount; reconfiguring after would leave the
  // merge view's deleted-chunk widgets unhighlighted.
  const [lang, setLang] = useState<Extension | null>(
    () => resolveLanguageSync(path)?.ext ?? null,
  );
  useEffect(() => {
    if (lang) return;
    let cancelled = false;
    resolveLanguage(path).then((res) => {
      if (!cancelled && res) setLang(res.ext);
    });
    return () => {
      cancelled = true;
    };
  }, [path, lang]);

  const extensions = useMemo(
    () => [
      ...SHARED_EXT,
      DEFAULT_INDENT,
      languageCompartment.of(lang ?? []),
      ...READONLY_EXT,
      unifiedMergeView({
        original: originalContent,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      }),
      DIFF_THEME,
    ],
    [originalContent, lang],
  );

  const stats = useMemo(
    () => computeLineStats(originalContent, proposedContent),
    [originalContent, proposedContent],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            className="text-[11px] px-2.5 py-2.5"
            variant={STATUS_BADGE[status]}
          >
            {STATUS_LABEL[status]}
          </Badge>
          {isNewFile ? (
            <span className="shrink-0 rounded-full border border-border/60 bg-accent/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              New file
            </span>
          ) : null}
          <span
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={path}
          >
            {path}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{stats.added}
            </span>
            <span className="text-rose-600 dark:text-rose-400">
              −{stats.removed}
            </span>
          </span>
        </div>
        {status === "pending" ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="default"
              onClick={onAccept}
              className="h-7 gap-1.5"
            >
              <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2} />
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onReject}
              className="h-7 gap-1.5"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
              Reject
            </Button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <CodeMirror
          ref={cmRef}
          value={proposedContent}
          theme={themeExt}
          extensions={extensions}
          editable={false}
          height="100%"
          className="h-full"
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            searchKeymap: true,
          }}
        />
      </div>
    </div>
  );
}

