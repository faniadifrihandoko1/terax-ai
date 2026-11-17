import { describe, expect, it } from "vitest";
import {
  describeAcceptAllSkips,
  type AcceptAllSkipReason,
} from "./acceptAllSkips";

describe("describeAcceptAllSkips (Fase 28)", () => {
  it("returns undefined when nothing was skipped", () => {
    expect(describeAcceptAllSkips([])).toBeUndefined();
  });

  it("names the single reason with its count", () => {
    const skipped: { reason: AcceptAllSkipReason }[] = [
      { reason: "missing-tab" },
      { reason: "missing-tab" },
      { reason: "missing-tab" },
    ];
    expect(describeAcceptAllSkips(skipped)).toBe(
      "Dilewati: tab review belum ada (3)",
    );
  });

  it("groups mixed reasons in first-seen order", () => {
    const skipped: { reason: AcceptAllSkipReason }[] = [
      { reason: "missing-tab" },
      { reason: "already-resolved" },
      { reason: "missing-tab" },
      { reason: "no-changes" },
    ];
    expect(describeAcceptAllSkips(skipped)).toBe(
      "Dilewati: tab review belum ada (2), sudah selesai/ditolak (1), tidak ada perubahan (1)",
    );
  });

  it("labels a rejected file decision honestly", () => {
    expect(
      describeAcceptAllSkips([{ reason: "file-rejected" }]),
    ).toBe("Dilewati: sudah ditolak — konfirmasi dari tab-nya (1)");
  });
});
