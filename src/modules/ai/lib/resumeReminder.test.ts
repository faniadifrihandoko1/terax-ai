import { describe, expect, it } from "vitest";
import { buildResumeReminder } from "./resumeReminder";

describe("buildResumeReminder (Fase 9)", () => {
  it("returns null after a clean finish and when there was no run", () => {
    expect(buildResumeReminder("finished", ["todo"])).toBeNull();
    expect(buildResumeReminder(null, ["todo"])).toBeNull();
  });

  it("warns that the previous summary is unverified after an interruption", () => {
    const reminder = buildResumeReminder("interrupted", [
      "Nonaktifkan section CV",
    ]);
    expect(reminder).toContain("<previous-run>");
    expect(reminder).toContain("terputus karena koneksi");
    expect(reminder).toContain("a summary is not proof");
    expect(reminder).toContain("verify the changes are really on disk");
    expect(reminder).toContain("- Nonaktifkan section CV");
  });

  it("covers stopped and errored runs with their own wording", () => {
    expect(buildResumeReminder("stopped", [])).toContain("dihentikan");
    expect(buildResumeReminder("error", [])).toContain("gagal");
  });

  it("omits the todo list when there are no open todos", () => {
    const reminder = buildResumeReminder("interrupted", []);
    expect(reminder).not.toContain("Open todos:");
  });
});
