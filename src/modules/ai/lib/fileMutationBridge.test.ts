import { describe, expect, it } from "vitest";
import { FileMutationBridgeTracker } from "./fileMutationBridge";

describe("FileMutationBridgeTracker", () => {
  it("processes a new fingerprint once, then skips it", () => {
    const tracker = new FileMutationBridgeTracker();
    expect(tracker.shouldProcess("fp-1")).toBe(true);
    const flight = tracker.beginFlight();
    expect(tracker.finishFlight(flight, "fp-1", false)).toBe(false);
    expect(tracker.shouldProcess("fp-1")).toBe(false);
    expect(tracker.shouldProcess("fp-2")).toBe(true);
  });

  it("requests a retry when cancelled before any proposal was marked", () => {
    const tracker = new FileMutationBridgeTracker();
    const flight = tracker.beginFlight();
    // Cancelled during the loadReviewState await: nothing marked, but
    // the fingerprint must not count as done.
    expect(tracker.finishFlight(flight, "fp-1", true)).toBe(true);
    expect(tracker.shouldProcess("fp-1")).toBe(true);
    const retry = tracker.beginFlight();
    expect(tracker.finishFlight(retry, "fp-1", false)).toBe(false);
    expect(tracker.shouldProcess("fp-1")).toBe(false);
  });

  it("unmarks stranded proposals on cancel, keeps completed ones marked", () => {
    const tracker = new FileMutationBridgeTracker();
    const flight = tracker.beginFlight();
    expect(tracker.markOpened(flight, "p-1")).toBe(true);
    tracker.markCompleted(flight, "p-1");
    // p-2 was marked, then the run was cancelled before opening its tab.
    expect(tracker.markOpened(flight, "p-2")).toBe(true);
    expect(tracker.finishFlight(flight, "fp-1", true)).toBe(true);

    expect(tracker.opened.has("p-1")).toBe(true);
    expect(tracker.opened.has("p-2")).toBe(false);
    expect(tracker.shouldProcess("fp-1")).toBe(true);

    const retry = tracker.beginFlight();
    // p-1 is already handled: the retry must not open it again.
    expect(tracker.markOpened(retry, "p-1")).toBe(false);
    // p-2 is picked up again.
    expect(tracker.markOpened(retry, "p-2")).toBe(true);
    tracker.markCompleted(retry, "p-2");
    expect(tracker.finishFlight(retry, "fp-1", false)).toBe(false);
    expect(tracker.shouldProcess("fp-1")).toBe(false);
  });

  it("never double-marks a proposal across overlapping runs", () => {
    const tracker = new FileMutationBridgeTracker();
    const first = tracker.beginFlight();
    expect(tracker.markOpened(first, "p-1")).toBe(true);
    // A second run starting while the first is still in flight.
    const second = tracker.beginFlight();
    expect(tracker.markOpened(second, "p-1")).toBe(false);
    tracker.markCompleted(first, "p-1");
    expect(tracker.finishFlight(first, "fp-1", false)).toBe(false);
  });

  it("a cancelled run's retry still works when another run completed first", () => {
    const tracker = new FileMutationBridgeTracker();
    const old = tracker.beginFlight();
    expect(tracker.markOpened(old, "p-1")).toBe(true);
    // The retry run starts and completes while the old run's tail is
    // still awaiting; the old run then exits cancelled.
    const next = tracker.beginFlight();
    expect(tracker.markOpened(next, "p-1")).toBe(false);
    expect(tracker.finishFlight(next, "fp-1", false)).toBe(false);
    expect(tracker.finishFlight(old, "fp-1", true)).toBe(true);
    // The stranded id is unmarked and the retry flag is set, so the
    // next effect run picks it up instead of waiting for a new mutation.
    expect(tracker.opened.has("p-1")).toBe(false);
    expect(tracker.shouldProcess("fp-1")).toBe(true);
  });

  it("reset forgets fingerprints and opened ids", () => {
    const tracker = new FileMutationBridgeTracker();
    const flight = tracker.beginFlight();
    tracker.markOpened(flight, "p-1");
    tracker.finishFlight(flight, "fp-1", false);
    tracker.reset();
    expect(tracker.shouldProcess("fp-1")).toBe(true);
    expect(tracker.opened.size).toBe(0);
    const fresh = tracker.beginFlight();
    expect(tracker.markOpened(fresh, "p-1")).toBe(true);
  });
});
