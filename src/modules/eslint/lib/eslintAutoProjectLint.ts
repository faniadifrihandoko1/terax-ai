import { usePreferencesStore } from "@/modules/settings/preferences";
import { isLintablePath } from "./eslintPaths";
import {
  resolveEslintBinary,
  type EslintBinary,
} from "./eslintRunner";
import { useEslintStore } from "./eslintStore";
import { requestEslintProjectLint } from "./runEslintProject";

/**
 * Fase 15: automatic project lint, Antigravity-style. The panel
 * fills itself — nobody has to open the Command Palette — while the
 * manual commands keep working on the same engine.
 *
 * Triggers (all debounced by the same delay, never per keystroke):
 * project open / root change, editor save, and agent writes. The
 * per-file diagnostics while typing still come from the Fase 12
 * language server; a whole-project run is too expensive for that.
 *
 * Decision notes (see also TERAX.md):
 * - One uniform debounce for every trigger: a root switch (e.g.
 *   hopping between terminal tabs) must not start a lint storm.
 * - A fire that finds a run already active does not start a second
 *   one — it re-arms the timer and retries, up to MAX_REARMS times
 *   (~60 s at the default delay). Past that it drops: the panel
 *   keeps the last snapshot, and the next save re-triggers. The
 *   total wait is bounded and the runs never stack.
 * - The toggle is checked twice (at schedule time and at fire
 *   time), so turning it off mid-debounce cancels the run.
 */
export const AUTO_PROJECT_LINT_DEBOUNCE_MS = 3000;
export const AUTO_PROJECT_LINT_MAX_REARMS = 20;

let timer: ReturnType<typeof setTimeout> | null = null;
let pendingRoot: string | null = null;
let rearms = 0;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Whether an automatic project run is allowed right now. */
function autoProjectLintAllowed(): boolean {
  const prefs = usePreferencesStore.getState();
  return prefs.eslintEnabled && prefs.eslintAutoProjectLint;
}

/**
 * Schedules an automatic project lint for the root after the
 * debounce. Calling it again before the timer fires restarts the
 * delay. A null root cancels anything pending.
 */
export function scheduleEslintProjectLint(root: string | null): void {
  clearTimer();
  if (root === null || !autoProjectLintAllowed()) {
    pendingRoot = null;
    rearms = 0;
    return;
  }
  pendingRoot = root;
  rearms = 0;
  timer = setTimeout(fireScheduledProjectLint, AUTO_PROJECT_LINT_DEBOUNCE_MS);
}

function fireScheduledProjectLint(): void {
  timer = null;
  const root = pendingRoot;
  if (root === null || !autoProjectLintAllowed()) {
    pendingRoot = null;
    rearms = 0;
    return;
  }
  if (useEslintStore.getState().projectLint.status.kind === "running") {
    if (rearms >= AUTO_PROJECT_LINT_MAX_REARMS) {
      pendingRoot = null;
      rearms = 0;
      return;
    }
    rearms += 1;
    timer = setTimeout(
      fireScheduledProjectLint,
      AUTO_PROJECT_LINT_DEBOUNCE_MS,
    );
    return;
  }
  pendingRoot = null;
  rearms = 0;
  void requestEslintProjectLint(root, { source: "auto" });
}

/**
 * Schedules an automatic project lint for the project a file
 * belongs to (save, agent write). Non-lintable files and files
 * without a resolvable ESLint binary schedule nothing — the
 * per-file path already reports a missing binary for those.
 */
export async function scheduleEslintProjectLintForFile(
  path: string,
  deps: {
    resolveBinary?: (
      path: string,
    ) => Promise<{ binary: EslintBinary | null }>;
  } = {},
): Promise<void> {
  if (!isLintablePath(path)) return;
  const resolveBinary = deps.resolveBinary ?? resolveEslintBinary;
  const resolution = await resolveBinary(path);
  if (resolution.binary === null) return;
  scheduleEslintProjectLint(resolution.binary.root);
}

/** Cancels a pending automatic run (toggle off, tests, teardown). */
export function cancelScheduledEslintProjectLint(): void {
  clearTimer();
  pendingRoot = null;
  rearms = 0;
}
