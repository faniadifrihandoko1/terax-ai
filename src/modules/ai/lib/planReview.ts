import { newTodoId, type Todo } from "./todos";

/**
 * Plan review ala Antigravity (Fase 30, DEL-129).
 *
 * Distinct from the upstream `/plan` queue mode (`usePlanStore`): that
 * mode lets the agent work but queues its edits for later apply, while
 * plan-review mode is read-only — the agent explores, submits a
 * structured plan, and nothing is written until the user presses
 * "Setujui & jalankan". The two modes share nothing except the word
 * "plan"; when plan-review mode is on, the upstream plan-mode prompt
 * is suppressed (see transport.ts) so the model never gets
 * contradictory instructions.
 */

export type ComposerMode = "agent" | "plan";

export type PlanReviewStep = {
  title: string;
  detail?: string;
  /** Files this step touches (paths as shown to the user). */
  files?: string[];
};

export type PlanReviewFile = {
  path: string;
  reason: string;
};

export type PlanReviewPlan = {
  goal: string;
  files: PlanReviewFile[];
  steps: PlanReviewStep[];
  risks: string[];
  verification: string[];
};

export type PlanReviewStatus = "draft" | "approved";

export type PlanReviewRecord = {
  mode: ComposerMode;
  plan: PlanReviewPlan | null;
  status: PlanReviewStatus | null;
  updatedAt: number;
};

export function emptyPlanReviewRecord(): PlanReviewRecord {
  return { mode: "agent", plan: null, status: null, updatedAt: 0 };
}

/**
 * System-prompt block for a plan-review run. Belt-and-suspenders next
 * to the tool-level enforcement in tools.ts: the model is told to
 * explore read-only and to submit the plan via `submit_plan`, then
 * stop — but even a model that ignores this cannot mutate anything,
 * because the mutation tools refuse before executing.
 */
export const PLAN_REVIEW_PROMPT = `## PLAN REVIEW MODE — ACTIVE (read-only)
You are in plan-review mode. Explore the codebase with the read-only tools (read_file, list_directory, grep, glob) and then present an implementation plan — do NOT change anything.
- Do not call any mutating tool (write_file, edit, multi_edit, delete_file, rename_file, create_directory, bash_run, bash_background, todo_write, spawn_coding_agent, send_to_agent, run_subagent): they are disabled in this mode and will refuse.
- When you have explored enough, call submit_plan ONCE with the full structured plan (goal, files with reasons, ordered steps, risks, verification). If the user asks to revise the plan, call submit_plan again with the revised plan.
- After submitting, stop and write a short summary of the plan in your own words. Do not start executing — the user reviews the plan first and presses "Setujui & jalankan" to run it.`;

/**
 * Tools that must refuse in plan-review mode. This is an explicit
 * blocklist (not an allowlist) so a future read-only tool stays
 * usable without a code change — but note the asymmetry is deliberate:
 * a future MUTATING tool must be added here, or it would slip
 * through. The blocklist is asserted in planReview.test.ts.
 *
 * Bash is blocked wholesale: bash_run takes a free-form command
 * string and there is no clean read-only classifier for it, so even
 * `git status` / `ls` are refused in plan mode (recorded limitation).
 * Read-only shell inspection stays available via bash_logs / bash_list.
 */
export const PLAN_REVIEW_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "delete_file",
  "rename_file",
  "create_directory",
  "bash_run",
  "bash_background",
  "bash_kill",
  "spawn_coding_agent",
  "send_to_agent",
  "run_subagent",
  "todo_write",
  "suggest_command",
  "open_preview",
]);

export function isPlanReviewBlockedTool(name: string): boolean {
  return PLAN_REVIEW_BLOCKED_TOOLS.has(name);
}

export const PLAN_REVIEW_REFUSAL =
  "Blocked: plan review mode is read-only — this tool cannot run while a plan is being drafted. " +
  "Finish exploring with the read-only tools and submit the plan with submit_plan; " +
  "the user reviews it first and only then approves execution.";

type ToolLike = {
  execute?: (...args: never[]) => unknown;
  // AI SDK tools may carry needsApproval as a boolean or a function;
  // the guard only ever writes `false` here, so the type stays loose.
  needsApproval?: unknown;
};

/**
 * Test seam + enforcement core: wrap every blocked tool so its
 * `execute` refuses before running, and drop `needsApproval` so no
 * approval card is raised for a call that will be refused anyway.
 * Tools not in the blocklist pass through untouched (same reference).
 * `buildTools` (tools.ts) applies this once per run when the run
 * starts in plan-review mode; the mode is snapshotted at build time,
 * so flipping the selector mid-run does not change the in-flight run.
 */
export function applyPlanReviewGuard<T extends Record<string, ToolLike>>(
  tools: T,
): T {
  const out = { ...tools };
  for (const [name, tool] of Object.entries(tools)) {
    if (!isPlanReviewBlockedTool(name)) continue;
    if (typeof tool.execute !== "function") continue;
    out[name as keyof T] = {
      ...tool,
      needsApproval: false,
      execute: async (..._args: never[]) => ({ error: PLAN_REVIEW_REFUSAL }),
    } as T[keyof T];
  }
  return out;
}

/** Validate a submitted plan; null = valid, otherwise an error string. */
export function validatePlan(plan: PlanReviewPlan): string | null {
  if (!plan.goal.trim()) return "plan goal cannot be empty";
  if (plan.steps.length === 0) return "plan needs at least one step";
  for (const s of plan.steps) {
    if (!s.title.trim()) return "plan step title cannot be empty";
  }
  for (const f of plan.files) {
    if (!f.path.trim()) return "plan file path cannot be empty";
  }
  return null;
}

/** Plan steps become the execution todos (all pending) on approval. */
export function planToTodos(plan: PlanReviewPlan): Todo[] {
  return plan.steps.map((s) => ({
    id: newTodoId(),
    title: s.title,
    description: s.detail,
    status: "pending" as const,
  }));
}

/**
 * The execution run is a fresh agent run, so the approved plan must be
 * carried in the chat history as text — the model cannot read the
 * store. Rendered from the structured plan (never from free prose).
 */
export function planToExecutionMessage(plan: PlanReviewPlan): string {
  const lines: string[] = [
    "Laksanakan rencana yang sudah disetujui berikut ini langkah demi langkah. " +
      "Jangan menyatakan selesai sebelum semua todo completed dan perubahan terverifikasi.",
    "",
    `## Tujuan\n${plan.goal}`,
  ];
  if (plan.files.length > 0) {
    lines.push("", "## File yang diubah");
    for (const f of plan.files) {
      lines.push(`- \`${f.path}\` — ${f.reason}`);
    }
  }
  lines.push("", "## Langkah");
  plan.steps.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`);
    if (s.detail) lines.push(`   ${s.detail}`);
  });
  if (plan.risks.length > 0) {
    lines.push("", "## Risiko");
    for (const r of plan.risks) lines.push(`- ${r}`);
  }
  if (plan.verification.length > 0) {
    lines.push("", "## Verifikasi");
    for (const v of plan.verification) lines.push(`- ${v}`);
  }
  return lines.join("\n");
}
