import { currentWorkspaceEnv } from "@/modules/workspace";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { Transport } from "codemirror-languageserver";
import { handleApplyEditRequest } from "./applyEdit";

export type LspSpawnConfig = {
  command: string;
  args: string[];
  root: string;
  env?: Record<string, string>;
  maxMemoryMb?: number;
  /**
   * Answer for this server's `workspace/configuration` requests.
   * Only servers that need a shaped answer carry one (the ESLint
   * server crashes on null); the rest keep the previous null answers.
   */
  workspaceConfiguration?: Record<string, unknown>;
};

export type LspExitInfo = {
  code: number | null;
  stderrTail: string;
  reason: string | null;
};

type ServerRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

function isServerRequest(msg: unknown): msg is ServerRequest {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "id" in msg &&
    (msg as ServerRequest).id != null &&
    "method" in msg
  );
}

export class TauriLspTransport implements Transport {
  private sessionId: number | null = null;
  private closed = false;
  private onMsg: ((message: string) => void) | null = null;
  private onCloseCb: (() => void) | null = null;
  private onErrorCb: ((error: Error) => void) | null = null;
  private backlog: string[] = [];
  private workspaceConfiguration: Record<string, unknown> | null = null;
  exitInfo: LspExitInfo | null = null;

  async start(config: LspSpawnConfig): Promise<void> {
    this.workspaceConfiguration = config.workspaceConfiguration ?? null;
    const decoder = new TextDecoder();
    const onMessage = new Channel<ArrayBuffer>();
    onMessage.onmessage = (buf) => {
      const text = decoder.decode(buf);
      // A request Terax answers itself must not reach the client
      // library: it would reply a second, competing answer (null)
      // for the same id, and for workspace/applyEdit that null could
      // win the race and make the server report the fix as failed.
      // All other requests keep today's reply-and-forward behaviour.
      if (this.answerServerRequest(text)) return;
      if (this.onMsg) this.onMsg(text);
      else this.backlog.push(text);
    };
    const onExit = new Channel<LspExitInfo>();
    onExit.onmessage = (info) => {
      this.exitInfo = info;
      this.closed = true;
      this.onCloseCb?.();
    };
    this.sessionId = await invoke<number>("lsp_spawn", {
      command: config.command,
      args: config.args,
      env: config.env ?? null,
      root: config.root,
      maxRssMb: config.maxMemoryMb ?? null,
      workspace: currentWorkspaceEnv(),
      onMessage,
      onExit,
    });
  }

  // The client library ignores server-to-client requests entirely.
  // Returns true only for requests Terax answers itself (today just
  // workspace/applyEdit): the caller must not forward those to the
  // library, or its competing null reply could win the race. All
  // other requests are answered here AND forwarded, as before.
  private answerServerRequest(text: string): boolean {
    // Cheap pre-check: requests carry both markers; skips a redundant
    // JSON.parse of large notification payloads like publishDiagnostics.
    if (!text.includes('"id"') || !text.includes('"method"')) return false;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isServerRequest(msg)) return false;
    const reply = (body: Record<string, unknown>) =>
      this.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...body }));
    switch (msg.method) {
      case "workspace/applyEdit": {
        // Fase 18: the ESLint server applies quick fixes by sending
        // the edit back here. Route it to the editor registered for
        // the target document and answer with the outcome; the reply
        // is async because the handler may apply CodeMirror changes.
        // No handler (or a declined edit) answers applied:false so
        // the server can report the failure instead of hanging.
        void handleApplyEditRequest(msg.params).then((outcome) =>
          reply({ result: { applied: outcome.applied } }),
        );
        return true;
      }
      case "workspace/configuration": {
        const items =
          (msg.params as { items?: unknown[] } | undefined)?.items ?? [];
        // A server that carries shaped configuration (the ESLint
        // server) gets it once per requested item; the rest keep the
        // previous null answers. The ESLint server crashes on null
        // (it reads configuration.workingDirectory unconditionally)
        // and on {} (nodePath/problems are read unconditionally too),
        // so the shaped object is load-bearing (see
        // lib/eslintServerConfig.ts).
        const value = this.workspaceConfiguration;
        reply({ result: items.map(() => value) });
        return false;
      }
      case "workspace/diagnostic/refresh":
      case "window/workDoneProgress/create":
      case "client/registerCapability":
      case "client/unregisterCapability":
      case "window/showMessageRequest":
      case "workspace/workspaceFolders":
        reply({ result: null });
        return false;
      default:
        reply({
          error: { code: -32601, message: `unhandled method ${msg.method}` },
        });
        return false;
    }
  }

  send(message: string): void {
    if (this.sessionId == null || this.closed) return;
    void invoke("lsp_send", { id: this.sessionId, message }).catch((e) => {
      this.onErrorCb?.(new Error(String(e)));
    });
  }

  onMessage(callback: (message: string) => void): void {
    this.onMsg = callback;
    if (this.backlog.length > 0) {
      const queued = this.backlog;
      this.backlog = [];
      for (const m of queued) callback(m);
    }
  }

  onClose(callback: () => void): void {
    this.onCloseCb = callback;
    if (this.closed) callback();
  }

  onError(callback: (error: Error) => void): void {
    this.onErrorCb = callback;
  }

  close(): void {
    if (this.closed) {
      this.sessionId = null;
      return;
    }
    this.closed = true;
    if (this.sessionId != null) {
      void invoke("lsp_kill", { id: this.sessionId }).catch(() => {});
      this.sessionId = null;
    }
  }
}
