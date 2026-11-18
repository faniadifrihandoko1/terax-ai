import { create } from "zustand";
import {
  deletePlanReview as persistDelete,
  loadPlanReview as persistLoad,
  savePlanReview as persistSave,
} from "../lib/planReviewPersistence";
import {
  emptyPlanReviewRecord,
  type ComposerMode,
  type PlanReviewPlan,
  type PlanReviewRecord,
} from "../lib/planReview";

type PlanReviewState = {
  /** Map of sessionId -> plan-review record (mode + current plan). */
  bySession: Record<string, PlanReviewRecord>;
  /** Set of sessionIds whose record was hydrated. */
  hydrated: Set<string>;
  hydrate: (sessionId: string) => Promise<void>;
  /** Composer mode for a session; defaults to "agent". */
  modeOf: (sessionId: string) => ComposerMode;
  setMode: (sessionId: string, mode: ComposerMode) => void;
  /** Store a submitted plan as the session's draft (overwrites). */
  submitPlan: (sessionId: string, plan: PlanReviewPlan) => void;
  /** Approve the draft: returns it, flips mode back to "agent". */
  approvePlan: (sessionId: string) => PlanReviewPlan | null;
  /** Reject the draft: the plan is dropped. */
  rejectPlan: (sessionId: string) => void;
  clearSession: (sessionId: string) => Promise<void>;
};

function recordOf(
  bySession: Record<string, PlanReviewRecord>,
  sessionId: string,
): PlanReviewRecord {
  return bySession[sessionId] ?? emptyPlanReviewRecord();
}

function update(
  set: (
    fn: (s: PlanReviewState) => Partial<PlanReviewState>,
  ) => void,
  sessionId: string,
  fn: (r: PlanReviewRecord) => PlanReviewRecord,
): void {
  set((s) => ({
    bySession: {
      ...s.bySession,
      [sessionId]: fn(recordOf(s.bySession, sessionId)),
    },
  }));
}

export const usePlanReviewStore = create<PlanReviewState>((set, get) => ({
  bySession: {},
  hydrated: new Set(),

  async hydrate(sessionId) {
    if (get().hydrated.has(sessionId)) return;
    const record = await persistLoad(sessionId);
    set((s) => {
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.add(sessionId);
      return {
        bySession: record
          ? { ...s.bySession, [sessionId]: record }
          : s.bySession,
        hydrated: nextHydrated,
      };
    });
  },

  modeOf(sessionId) {
    return recordOf(get().bySession, sessionId).mode;
  },

  setMode(sessionId, mode) {
    update(set, sessionId, (r) => ({ ...r, mode, updatedAt: Date.now() }));
    void persistSave(sessionId, recordOf(get().bySession, sessionId));
  },

  submitPlan(sessionId, plan) {
    update(set, sessionId, (r) => ({
      ...r,
      plan,
      status: "draft",
      updatedAt: Date.now(),
    }));
    void persistSave(sessionId, recordOf(get().bySession, sessionId));
  },

  approvePlan(sessionId) {
    const record = recordOf(get().bySession, sessionId);
    if (!record.plan || record.status !== "draft") return null;
    update(set, sessionId, (r) => ({
      ...r,
      status: "approved",
      mode: "agent",
      updatedAt: Date.now(),
    }));
    void persistSave(sessionId, recordOf(get().bySession, sessionId));
    return record.plan;
  },

  rejectPlan(sessionId) {
    update(set, sessionId, (r) => ({
      ...r,
      plan: null,
      status: null,
      updatedAt: Date.now(),
    }));
    void persistSave(sessionId, recordOf(get().bySession, sessionId));
  },

  async clearSession(sessionId) {
    set((s) => {
      const next = { ...s.bySession };
      delete next[sessionId];
      const nextHydrated = new Set(s.hydrated);
      nextHydrated.delete(sessionId);
      return { bySession: next, hydrated: nextHydrated };
    });
    await persistDelete(sessionId);
  },
}));
