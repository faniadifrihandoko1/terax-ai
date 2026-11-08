import { buildManagedAgentTools } from "./agent";
import { buildEditTools } from "./edit";
import { buildFsTools } from "./fs";
import { buildSearchTools } from "./search";
import { buildShellTools } from "./shell";
import { buildSubagentTools } from "./subagent";
import { buildTerminalTools } from "./terminal";
import { buildTodoTools } from "./todo";

export { resolvePath, type ToolContext } from "./context";

/**
 * AI tool definitions.
 *
 * Approval policy (Fase 6, Antigravity-style):
 *  - Read-only tools (`read_file`, `list_directory`, `grep`, `glob`)
 *    auto-execute, but go through the security guard which refuses obvious
 *    secret paths (.env*, .ssh/, credentials, etc.).
 *  - File mutation tools (`write_file`, `edit`, `multi_edit`,
 *    `delete_file`, `rename_file`) do NOT ask for approval and do NOT
 *    block the run: their `execute` writes to disk immediately
 *    (write-first, Fase 8) and records the baseline in the
 *    pending-proposal registry for the review tab. The user reviews
 *    the change afterwards in the AI diff tab — Accept keeps it,
 *    Reject reverts it from the checkpoint. `create_directory`
 *    also runs immediately (workspace writes need no per-call approval).
 *  - Command tools (`bash_run`, `bash_background`) and managed-agent
 *    tools (`spawn_coding_agent`, `send_to_agent`) still require explicit
 *    user approval — the AI SDK pauses on tool-call and surfaces a
 *    `tool-approval-request` part that the UI renders as a confirmation
 *    card. This is the only approval gate left.
 *  - `edit` / `multi_edit` additionally enforce a read-before-edit invariant
 *    (the model must have called read_file on the path earlier in the
 *    session).
 *
 * The model sees absolute paths only after they are resolved against the
 * active terminal's cwd (provided via `getCwd`); it should not invent paths
 * outside that.
 */
export function buildTools(ctx: import("./context").ToolContext) {
  return {
    ...buildFsTools(ctx),
    ...buildEditTools(ctx),
    ...buildSearchTools(ctx),
    ...buildShellTools(ctx),
    ...buildSubagentTools(ctx),
    ...buildTerminalTools(ctx),
    ...buildTodoTools(ctx),
    ...buildManagedAgentTools(ctx),
  } as const;
}
