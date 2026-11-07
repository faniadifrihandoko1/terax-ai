import { beforeEach, describe, expect, it, vi } from "vitest";

// `store` is created at module load, so the plugin mock must be in place
// before `./store` is imported.
const entries = vi.hoisted(() => ({ value: [] as [string, unknown][] }));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    entries = async () => entries.value;
    get = async () => undefined;
    set = async () => undefined;
    save = async () => undefined;
  },
  Store: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: async () => undefined,
  listen: async () => () => undefined,
}));

describe("aiReviewInline default (Fase 4)", () => {
  beforeEach(() => {
    entries.value = [];
    vi.resetModules();
  });

  it("is on by default", async () => {
    const { DEFAULT_PREFERENCES } = await import("./store");
    expect(DEFAULT_PREFERENCES.aiReviewInline).toBe(true);
  });

  it("applies to users who never stored a choice", async () => {
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).aiReviewInline).toBe(true);
  });

  it("never overrides an explicit stored choice", async () => {
    entries.value = [["aiReviewInline", false]];
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).aiReviewInline).toBe(false);
  });

  it("migrates the Fase 3 aiReviewPerLine choice", async () => {
    entries.value = [["aiReviewPerLine", false]];
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).aiReviewInline).toBe(false);
  });

  it("prefers the new key when both are stored", async () => {
    entries.value = [
      ["aiReviewPerLine", false],
      ["aiReviewInline", true],
    ];
    const { loadPreferences } = await import("./store");
    expect((await loadPreferences()).aiReviewInline).toBe(true);
  });
});
