import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlanReviewStore } from "./planReviewStore";
import type { PlanReviewPlan } from "../lib/planReview";

const persistence = vi.hoisted(() => ({
  loadPlanReview: vi.fn(async (_sessionId: string): Promise<unknown> => null),
  savePlanReview: vi.fn(async (_sessionId: string, _record: unknown) => {}),
  deletePlanReview: vi.fn(async (_sessionId: string) => {}),
}));
vi.mock("@/modules/ai/lib/planReviewPersistence", () => persistence);

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

describe("planReviewStore", () => {
  it("defaults a session to agent mode", () => {
    expect(usePlanReviewStore.getState().modeOf("s-1")).toBe("agent");
  });

  it("setMode switches the session mode and persists it", async () => {
    usePlanReviewStore.getState().setMode("s-1", "plan");
    expect(usePlanReviewStore.getState().modeOf("s-1")).toBe("plan");
    expect(persistence.savePlanReview).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ mode: "plan" }),
    );
  });

  it("submitPlan stores a draft and marks it draft", () => {
    usePlanReviewStore.getState().submitPlan("s-1", samplePlan());
    const record = usePlanReviewStore.getState().bySession["s-1"];
    expect(record.status).toBe("draft");
    expect(record.plan?.goal).toBe(
      "Migrate the import-excel helpers to ExcelJS",
    );
    expect(record.plan?.steps).toHaveLength(1);
  });

  it("submitPlan overwrites a previous draft (user asked for a revision)", () => {
    const store = usePlanReviewStore.getState();
    store.submitPlan("s-1", samplePlan());
    store.submitPlan("s-1", {
      ...samplePlan(),
      goal: "Revised goal",
      steps: [{ title: "Step one" }, { title: "Step two" }],
    });
    const record = usePlanReviewStore.getState().bySession["s-1"];
    expect(record.status).toBe("draft");
    expect(record.plan?.goal).toBe("Revised goal");
    expect(record.plan?.steps).toHaveLength(2);
  });

  it("approvePlan flips status to approved and mode back to agent", () => {
    const store = usePlanReviewStore.getState();
    store.setMode("s-1", "plan");
    store.submitPlan("s-1", samplePlan());
    const plan = store.approvePlan("s-1");
    expect(plan?.goal).toBe("Migrate the import-excel helpers to ExcelJS");
    const record = usePlanReviewStore.getState().bySession["s-1"];
    expect(record.status).toBe("approved");
    expect(record.mode).toBe("agent");
  });

  it("approvePlan returns null when there is no draft", () => {
    expect(usePlanReviewStore.getState().approvePlan("s-1")).toBeNull();
  });

  it("rejectPlan clears the draft", () => {
    const store = usePlanReviewStore.getState();
    store.submitPlan("s-1", samplePlan());
    store.rejectPlan("s-1");
    const record = usePlanReviewStore.getState().bySession["s-1"];
    expect(record.plan).toBeNull();
    expect(record.status).toBeNull();
    expect(persistence.savePlanReview).toHaveBeenCalledWith(
      "s-1",
      expect.objectContaining({ plan: null, status: null }),
    );
  });

  it("hydrate loads a persisted record once", async () => {
    persistence.loadPlanReview.mockResolvedValueOnce({
      mode: "plan",
      plan: samplePlan(),
      status: "draft",
      updatedAt: 123,
    });
    await usePlanReviewStore.getState().hydrate("s-1");
    const record = usePlanReviewStore.getState().bySession["s-1"];
    expect(record.mode).toBe("plan");
    expect(record.status).toBe("draft");
    expect(record.plan?.goal).toBe(
      "Migrate the import-excel helpers to ExcelJS",
    );
    await usePlanReviewStore.getState().hydrate("s-1");
    expect(persistence.loadPlanReview).toHaveBeenCalledTimes(1);
  });
});
