import { describe, expect, it } from "vitest";
import {
  diagnosticsSeverityClass,
  severityForCounts,
} from "./diagnosticsSeverity";

describe("severityForCounts", () => {
  it("returns null for no counts", () => {
    expect(severityForCounts(null)).toBeNull();
  });

  it("returns null for a clean file", () => {
    expect(severityForCounts({ errors: 0, warnings: 0 })).toBeNull();
  });

  it("returns error when there is at least one error", () => {
    expect(severityForCounts({ errors: 1, warnings: 0 })).toBe("error");
    expect(severityForCounts({ errors: 2, warnings: 5 })).toBe("error");
  });

  it("returns warning only when there are warnings and no errors", () => {
    expect(severityForCounts({ errors: 0, warnings: 1 })).toBe("warning");
    expect(severityForCounts({ errors: 0, warnings: 3 })).toBe("warning");
  });
});

describe("diagnosticsSeverityClass", () => {
  it("colors errors red, like the count badge", () => {
    expect(diagnosticsSeverityClass("error")).toBe("text-destructive");
  });

  it("colors warnings amber, like the count badge", () => {
    expect(diagnosticsSeverityClass("warning")).toBe(
      "text-amber-700 dark:text-amber-400",
    );
  });

  it("returns undefined when there is nothing to show", () => {
    expect(diagnosticsSeverityClass(null)).toBeUndefined();
  });
});
