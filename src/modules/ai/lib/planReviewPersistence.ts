import { LazyStore } from "@tauri-apps/plugin-store";
import type { PlanReviewRecord } from "./planReview";

/**
 * Persistence for plan-review state (Fase 30): the composer's
 * Agent/Plan mode and the current plan draft, per chat session.
 * Same pattern as todos.ts — a Tauri LazyStore file, one key per
 * session, autoSave 200ms. Kept in its own module so store tests
 * can mock the persistence boundary without touching Tauri.
 */
const STORE_PATH = "terax-ai-plan-review.json";
const planReviewKey = (sessionId: string) => `planReview:${sessionId}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadPlanReview(
  sessionId: string,
): Promise<PlanReviewRecord | null> {
  return (await store.get<PlanReviewRecord>(planReviewKey(sessionId))) ?? null;
}

export async function savePlanReview(
  sessionId: string,
  record: PlanReviewRecord,
): Promise<void> {
  await store.set(planReviewKey(sessionId), record);
}

export async function deletePlanReview(sessionId: string): Promise<void> {
  await store.delete(planReviewKey(sessionId));
}
