import {
  isAbnormalOutcome,
  runOutcomeLabel,
  type LastRunOutcome,
} from "./runOutcome";

/**
 * Fase 9: a run that ended abnormally (stopped, interrupted, error) leaves
 * a history that lies by omission — its summary may describe work that was
 * never actually done, and there is no marker in the history saying the
 * run died mid-way. When the user sends the next message in the same
 * session, this block is prepended to it (same mechanism as the <env>
 * block) so the model verifies against disk instead of trusting the old
 * summary. Returns null for a clean finish (or no previous run).
 */
export function buildResumeReminder(
  outcome: LastRunOutcome | null,
  openTodos: string[],
): string | null {
  if (!isAbnormalOutcome(outcome)) return null;
  const lines = [
    "<previous-run>",
    `The previous run ended abnormally (${runOutcomeLabel(outcome)}). Its summary in the history may describe work that was never actually done — a summary is not proof.`,
    "Before claiming anything is complete: re-read the files this task touches and verify the changes are really on disk; finish the open todos below; do not treat the previous summary as proof of completion.",
  ];
  if (openTodos.length > 0) {
    lines.push("Open todos:");
    for (const title of openTodos) lines.push(`- ${title}`);
  }
  lines.push("</previous-run>");
  return lines.join("\n");
}
