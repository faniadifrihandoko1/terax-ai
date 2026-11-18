import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTools, type ToolContext } from "./tools";
import { buildPlanReviewTools } from "./planReview";
import { usePlanReviewStore } from "../store/planReviewStore";
import type { PlanReviewPlan } from "../lib/planReview";

const persistence = vi.hoisted(() => ({
  loadPlanReview: vi.fn(async (_sessionId: string) => null),
  savePlanReview: vi.fn(async (_sessionId: string, _record: unknown) => {}),
  deletePlanReview: vi.fn(async (_sessionId: string) => {}),
}));
vi.mock("@/modules/ai/lib/planReviewPersistence", () => persistence);

function fakeCtx(mode: "agent" | "plan"): ToolContext {
  return {
    getCwd: () => "/repo",
    getWorkspaceRoot: () => "/repo",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "s-1",
    isPlanReviewMode: () => mode === "plan",
  };
}

function samplePlan(): PlanReviewPlan {
  return {
    goal: "Migrate the import-excel helpers to ExcelJS",
    files: [{ path: "src/lib/excel.ts", reason: "Holds the helpers" }],
    steps: [{ title: "Replace xlsx reads with ExcelJS" }],
    risks: [],
    verification: ["pnpm check-types"],
  };
}

beforeEach(() => {
  usePlanReviewStore.setState({ bySession: {}, hydrated: new Set() });
  vi.clearAllMocks();
});

describe("buildPlanReviewTools / submit_plan", () => {
  it("submit_plan stores the plan as a draft for the session", async () => {
    const tools = buildPlanReviewTools(fakeCtx("plan"));
    const result = (await (
      tools.submit_plan as { execute: (...a: unknown[]) => unknown }
    ).execute(samplePlan(), {})) as { ok: boolean };
    expect(result.ok).toBe(true);
    const record = usePlanReviewStore.getState().bySession["s-1"];
    expect(record.status).toBe("draft");
    expect(record.plan?.goal).toBe(
      "Migrate the import-excel helpers to ExcelJS",
    );
  });

  it("submit_plan refuses an invalid plan without touching the draft", async () => {
    const store = usePlanReviewStore.getState();
    store.submitPlan("s-1", samplePlan());
    const tools = buildPlanReviewTools(fakeCtx("plan"));
    const result = (await (
      tools.submit_plan as { execute: (...a: unknown[]) => unknown }
    ).execute({ ...samplePlan(), steps: [] }, {})) as { error: string };
    expect(result.error).toMatch(/step/i);
    expect(
      usePlanReviewStore.getState().bySession["s-1"].plan?.steps,
    ).toHaveLength(1);
  });
});

describe("buildTools in plan-review mode", () => {
  it("includes submit_plan only in plan mode", () => {
    expect("submit_plan" in buildTools(fakeCtx("plan"))).toBe(true);
    expect("submit_plan" in buildTools(fakeCtx("agent"))).toBe(false);
  });

  it("refuses a mutation tool in plan mode without executing it", async () => {
    const tools = buildTools(fakeCtx("plan"));
    const result = (await (
      tools.write_file as { execute: (...a: unknown[]) => unknown }
    ).execute(
      { path: "/repo/x.ts", content: "hi" },
      {},
    )) as { error: string };
    expect(result.error).toMatch(/plan review|read-only/i);
  });

  it("lets a read tool through in plan mode", async () => {
    const tools = buildTools(fakeCtx("plan"));
    // read_file on a missing file returns its own error, not the
    // plan-review refusal — that proves the guard did not intercept it.
    const result = (await (
      tools.read_file as { execute: (...a: unknown[]) => unknown }
    ).execute({ path: "/repo/does-not-exist-xyz.ts" }, {})) as {
      error?: string;
    };
    expect(result.error ?? "").not.toMatch(/plan review|read-only/i);
  });
});
