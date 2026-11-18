import { describe, expect, it, vi } from "vitest";
import {
  applyPlanReviewGuard,
  isPlanReviewBlockedTool,
  PLAN_REVIEW_PROMPT,
  planToExecutionMessage,
  planToTodos,
  validatePlan,
  type PlanReviewPlan,
} from "./planReview";

function samplePlan(over: Partial<PlanReviewPlan> = {}): PlanReviewPlan {
  return {
    goal: "Migrate the import-excel helpers to ExcelJS",
    files: [
      {
        path: "src/lib/excel.ts",
        reason: "Holds the import-excel helpers to replace",
      },
    ],
    steps: [
      {
        title: "Replace xlsx reads with ExcelJS",
        detail: "Swap the reader in excel.ts",
        files: ["src/lib/excel.ts"],
      },
      { title: "Run the type-check and fix errors" },
    ],
    risks: ["ExcelJS streaming API differs for large files"],
    verification: ["pnpm check-types", "pnpm test"],
    ...over,
  };
}

describe("isPlanReviewBlockedTool", () => {
  it("blocks every file-mutating tool", () => {
    for (const name of [
      "write_file",
      "edit",
      "multi_edit",
      "delete_file",
      "rename_file",
      "create_directory",
    ]) {
      expect(isPlanReviewBlockedTool(name)).toBe(true);
    }
  });

  it("blocks bash and agent-spawning tools wholesale (no clean read-only split)", () => {
    for (const name of [
      "bash_run",
      "bash_background",
      "bash_kill",
      "spawn_coding_agent",
      "send_to_agent",
      "run_subagent",
      "suggest_command",
      "open_preview",
    ]) {
      expect(isPlanReviewBlockedTool(name)).toBe(true);
    }
  });

  it("blocks todo_write — plan steps become todos only after approval", () => {
    expect(isPlanReviewBlockedTool("todo_write")).toBe(true);
  });

  it("allows the read-only tools", () => {
    for (const name of [
      "read_file",
      "list_directory",
      "grep",
      "glob",
      "bash_logs",
      "bash_list",
      "get_terminal_output",
      "read_agent_output",
    ]) {
      expect(isPlanReviewBlockedTool(name)).toBe(false);
    }
  });

  it("does not block submit_plan itself", () => {
    expect(isPlanReviewBlockedTool("submit_plan")).toBe(false);
  });

  it("does not block unknown tools", () => {
    expect(isPlanReviewBlockedTool("some_future_tool")).toBe(false);
  });
});

describe("applyPlanReviewGuard", () => {
  it("refuses blocked tools without calling the original execute", async () => {
    const original = vi.fn(async () => ({ ok: true }));
    const tools = {
      read_file: { execute: vi.fn(async () => ({ ok: "read" })) },
      write_file: { execute: original },
      bash_run: { execute: original, needsApproval: true },
    };
    const guarded = applyPlanReviewGuard(tools);
    const writeResult = await (
      guarded.write_file as { execute: (...a: unknown[]) => unknown }
    ).execute({ path: "x.ts" });
    expect(writeResult).toMatchObject({ error: expect.any(String) });
    expect(original).not.toHaveBeenCalled();
    const bashResult = await (
      guarded.bash_run as { execute: (...a: unknown[]) => unknown }
    ).execute({ command: "ls" });
    expect(bashResult).toMatchObject({ error: expect.any(String) });
    expect(original).not.toHaveBeenCalled();
    // No approval card is raised for a call that will be refused.
    expect(
      (guarded.bash_run as { needsApproval?: boolean }).needsApproval,
    ).toBe(false);
    // Read tools pass through untouched.
    await (
      guarded.read_file as { execute: (...a: unknown[]) => unknown }
    ).execute({ path: "x.ts" });
    expect(tools.read_file.execute).toHaveBeenCalledOnce();
  });

  it("refusal message tells the model to finish the plan instead", async () => {
    const tools = {
      edit: { execute: vi.fn(async () => ({ ok: true })) },
    };
    const guarded = applyPlanReviewGuard(tools);
    const result = (await (
      guarded.edit as { execute: (...a: unknown[]) => unknown }
    ).execute({ path: "x.ts" })) as { error: string };
    expect(result.error).toMatch(/plan review|read-only/i);
    expect(result.error).toMatch(/submit_plan/);
  });
});

describe("validatePlan", () => {
  it("accepts a well-formed plan", () => {
    expect(validatePlan(samplePlan())).toBeNull();
  });

  it("rejects an empty goal", () => {
    expect(validatePlan(samplePlan({ goal: "   " }))).toMatch(/goal/i);
  });

  it("rejects zero steps", () => {
    expect(validatePlan(samplePlan({ steps: [] }))).toMatch(/step/i);
  });

  it("rejects a step without a title", () => {
    expect(
      validatePlan(samplePlan({ steps: [{ title: "  " }] })),
    ).toMatch(/step/i);
  });

  it("rejects a file entry without a path", () => {
    expect(
      validatePlan(samplePlan({ files: [{ path: "", reason: "x" }] })),
    ).toMatch(/path/i);
  });
});

describe("planToTodos", () => {
  it("turns each step into a pending todo, preserving order", () => {
    const todos = planToTodos(samplePlan());
    expect(todos).toHaveLength(2);
    expect(todos[0]).toMatchObject({
      title: "Replace xlsx reads with ExcelJS",
      description: "Swap the reader in excel.ts",
      status: "pending",
    });
    expect(todos[1]).toMatchObject({
      title: "Run the type-check and fix errors",
      status: "pending",
    });
    expect(todos[0].id).not.toBe(todos[1].id);
  });
});

describe("planToExecutionMessage", () => {
  it("renders the whole approved plan as markdown for the execution run", () => {
    const text = planToExecutionMessage(samplePlan());
    expect(text).toContain("Migrate the import-excel helpers to ExcelJS");
    expect(text).toContain("src/lib/excel.ts");
    expect(text).toContain("Replace xlsx reads with ExcelJS");
    expect(text).toContain("Run the type-check and fix errors");
    expect(text).toContain("ExcelJS streaming API differs");
    expect(text).toContain("pnpm check-types");
    expect(text).toMatch(/rencana yang sudah disetujui/i);
  });
});

describe("PLAN_REVIEW_PROMPT", () => {
  it("tells the model to submit the plan and stop, never to mutate", () => {
    expect(PLAN_REVIEW_PROMPT).toMatch(/submit_plan/);
    expect(PLAN_REVIEW_PROMPT).toMatch(/read-only/i);
    expect(PLAN_REVIEW_PROMPT).toMatch(/do not.*(?:edit|write|delete)/i);
  });
});
