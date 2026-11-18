import { tool } from "ai";
import { z } from "zod";
import { validatePlan, type PlanReviewPlan } from "../lib/planReview";
import { usePlanReviewStore } from "../store/planReviewStore";
import type { ToolContext } from "./context";

/**
 * Plan-review tool (Fase 30): the only way a plan reaches the user.
 * Available only while the run starts in plan-review mode — see
 * buildTools in tools.ts. The model calls this once with the full
 * structured plan; the plan becomes the session's draft and the
 * PlanReviewCard renders it with "Setujui & jalankan" / "Tolak".
 * Calling it again overwrites the draft (user asked for a revision).
 */
export function buildPlanReviewTools(ctx: ToolContext) {
  return {
    submit_plan: tool({
      description:
        "Submit the implementation plan for the user's review. Call this ONCE when you have explored the codebase and are ready to present the plan — do not write prose instead of calling it, and do not call any mutating tool in plan-review mode. The plan is shown to the user with Approve / Reject buttons; after approval the agent executes it step by step. If the user asks to revise the plan, call submit_plan again with the revised plan.",
      inputSchema: z.object({
        goal: z.string().min(1).describe("What the plan achieves, in one sentence."),
        files: z
          .array(
            z.object({
              path: z.string().min(1),
              reason: z.string().min(1).describe("Why this file changes."),
            }),
          )
          .default([])
          .describe("Files the plan will change, with a reason per file."),
        steps: z
          .array(
            z.object({
              title: z.string().min(1),
              detail: z.string().optional(),
              files: z.array(z.string()).optional(),
            }),
          )
          .min(1)
          .describe("Ordered implementation steps; each becomes a todo on approval."),
        risks: z.array(z.string()).default([]).describe("Risks / edge cases."),
        verification: z
          .array(z.string())
          .default([])
          .describe("How to verify the result (commands, manual checks)."),
      }),
      execute: async (input) => {
        const sessionId = ctx.getSessionId();
        if (!sessionId)
          return { error: "no active session; cannot store the plan" };
        const plan: PlanReviewPlan = {
          goal: input.goal,
          files: input.files,
          steps: input.steps,
          risks: input.risks,
          verification: input.verification,
        };
        const err = validatePlan(plan);
        if (err) return { error: err };
        usePlanReviewStore.getState().submitPlan(sessionId, plan);
        return {
          ok: true,
          message:
            "Plan saved as a draft. It is shown to the user for review — stop here and write a short summary; do not start executing.",
        };
      },
    }),
  } as const;
}
