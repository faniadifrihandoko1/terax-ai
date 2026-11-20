import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import {
  requestManualVerification,
  requestPostConfirmVerification,
  resetVerifySchedulerForTests,
  type VerifySchedulerDeps,
} from "./verifyScheduler";
import type { VerifyOutcome } from "./verifyAfterConfirm";

function passedOutcome(): VerifyOutcome {
  return {
    status: "passed",
    checks: [
      { kind: "typecheck", label: "typecheck", status: "passed", durationMs: 100 },
    ],
    durationMs: 100,
    files: [],
  };
}

function fakeDeps(overrides: Partial<VerifySchedulerDeps> = {}) {
  let resolveRun: ((v: VerifyOutcome) => void) | null = null;
  const runCalls: { sessionId: string; files: string[] }[] = [];
  const appended: { sessionId: string; message: UIMessage }[] = [];
  const replaced: { sessionId: string; id: string; message: UIMessage }[] = [];
  const deps: VerifySchedulerDeps = {
    settingEnabled: () => true,
    chatExists: () => true,
    appendMessage: (sessionId, message) => {
      appended.push({ sessionId, message });
    },
    replaceMessage: (sessionId, id, message) => {
      replaced.push({ sessionId, id, message });
    },
    runVerification: (args) => {
      runCalls.push(args);
      return new Promise<VerifyOutcome>((resolve) => {
        resolveRun = resolve;
      });
    },
    ...overrides,
  };
  return {
    deps,
    runCalls,
    appended,
    replaced,
    finishRun: (outcome: VerifyOutcome = passedOutcome()) => {
      const r = resolveRun;
      resolveRun = null;
      r?.(outcome);
    },
  };
}

describe("requestPostConfirmVerification", () => {
  it("setting OFF → tidak jalan (off), manual tetap bisa", async () => {
    resetVerifySchedulerForTests();
    const f = fakeDeps({ settingEnabled: () => false });
    expect(
      requestPostConfirmVerification(
        { sessionId: "s1", path: "/proj/src/a.ts" },
        f.deps,
      ),
    ).toBe("off");
    expect(f.runCalls).toEqual([]);
    expect(
      requestManualVerification({ sessionId: "s1", root: "/proj" }, f.deps),
    ).toBe("started");
    expect(f.runCalls).toHaveLength(1);
    f.finishRun();
    await new Promise((r) => setTimeout(r, 0));
    resetVerifySchedulerForTests();
  });

  it("tidak ada chat → dilewati (no-chat), tidak jalan buta", () => {
    resetVerifySchedulerForTests();
    const f = fakeDeps({ chatExists: () => false });
    expect(
      requestPostConfirmVerification(
        { sessionId: "s1", path: "/proj/src/a.ts" },
        f.deps,
      ),
    ).toBe("no-chat");
    expect(f.runCalls).toEqual([]);
    resetVerifySchedulerForTests();
  });

  it("Confirm kedua saat verifikasi masih jalan → diantre, lalu jalan dengan semua file", async () => {
    resetVerifySchedulerForTests();
    const f = fakeDeps();
    expect(
      requestPostConfirmVerification(
        { sessionId: "s1", path: "/proj/src/a.ts" },
        f.deps,
      ),
    ).toBe("started");
    expect(
      requestPostConfirmVerification(
        { sessionId: "s1", path: "/proj/src/b.ts" },
        f.deps,
      ),
    ).toBe("queued");
    expect(f.runCalls).toHaveLength(1);
    expect(f.runCalls[0]?.files).toEqual(["/proj/src/a.ts"]);
    // Pesan "sedang berjalan" sudah ditempel di chat.
    expect(f.appended).toHaveLength(1);
    expect(f.appended[0]?.message.parts).toEqual([
      { type: "text", text: expect.stringContaining("sedang berjalan") },
    ]);
    f.finishRun();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(f.runCalls).toHaveLength(2);
    expect(f.runCalls[1]?.files).toEqual(["/proj/src/b.ts"]);
    // Pesan pertama diganti hasil, bukan ditumpuk.
    expect(f.replaced).toHaveLength(1);
    expect(f.replaced[0]?.id).toBe(f.appended[0]?.message.id);
    expect(f.replaced[0]?.message.parts).toEqual([
      { type: "text", text: expect.stringContaining("lolos") },
    ]);
    f.finishRun();
    await new Promise((r) => setTimeout(r, 0));
    resetVerifySchedulerForTests();
  });

  it("pesan hasil memakai id yang sama dengan pesan berjalan", async () => {
    resetVerifySchedulerForTests();
    const f = fakeDeps();
    requestPostConfirmVerification(
      { sessionId: "s1", path: "/proj/src/a.ts" },
      f.deps,
    );
    const runningId = f.appended[0]?.message.id;
    expect(runningId).toMatch(/^verify-/);
    f.finishRun({
      status: "failed",
      checks: [
        {
          kind: "lint",
          label: "lint",
          status: "failed",
          durationMs: 50,
          summary: "1 pelanggaran",
        },
      ],
      durationMs: 50,
      files: ["/proj/src/a.ts"],
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.replaced).toHaveLength(1);
    expect(f.replaced[0]?.id).toBe(runningId);
    expect(f.replaced[0]?.message.parts).toEqual([
      { type: "text", text: expect.stringContaining("gagal di lint") },
    ]);
    resetVerifySchedulerForTests();
  });
});
