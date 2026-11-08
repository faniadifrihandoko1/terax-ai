import { describe, expect, it } from "vitest";
import {
  isAbnormalOutcome,
  resolveRunOutcome,
  runOutcomeLabel,
} from "./runOutcome";

describe("resolveRunOutcome (Fase 9)", () => {
  it("maps a clean end to finished", () => {
    expect(
      resolveRunOutcome({ isAbort: false, isDisconnect: false, isError: false }),
    ).toBe("finished");
  });

  it("maps an abort (user pressed Stop) to stopped", () => {
    expect(
      resolveRunOutcome({ isAbort: true, isDisconnect: false, isError: false }),
    ).toBe("stopped");
  });

  it("maps a network end to interrupted, even when isError is also set", () => {
    expect(
      resolveRunOutcome({ isAbort: false, isDisconnect: true, isError: true }),
    ).toBe("interrupted");
  });

  it("maps a provider error to error", () => {
    expect(
      resolveRunOutcome({ isAbort: false, isDisconnect: false, isError: true }),
    ).toBe("error");
  });

  it("prefers abort over disconnect", () => {
    expect(
      resolveRunOutcome({ isAbort: true, isDisconnect: true, isError: true }),
    ).toBe("stopped");
  });

  it("classifies stopped/interrupted/error as abnormal, finished as not", () => {
    expect(isAbnormalOutcome("stopped")).toBe(true);
    expect(isAbnormalOutcome("interrupted")).toBe(true);
    expect(isAbnormalOutcome("error")).toBe(true);
    expect(isAbnormalOutcome("finished")).toBe(false);
    expect(isAbnormalOutcome(null)).toBe(false);
  });

  it("labels every outcome in Indonesian", () => {
    expect(runOutcomeLabel("stopped")).toBe("dihentikan");
    expect(runOutcomeLabel("interrupted")).toBe("terputus karena koneksi");
    expect(runOutcomeLabel("error")).toBe("gagal");
    expect(runOutcomeLabel("finished")).toBe("selesai");
  });
});
