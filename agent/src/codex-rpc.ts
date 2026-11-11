import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { codexEnvironment } from "./codex.js";
import { NeedsInput } from "./tasks.js";

export type RpcMessage = { id?: string | number; method?: string; params?: any; result?: any; error?: { message?: string; code?: number } };

/** Private stdio connection, one coding task; no network listener or daemon to manage. */
export class CodexRpc extends EventEmitter {
  readonly process: ChildProcessWithoutNullStreams;
  private next = 1;
  private buffer = "";
  private bytes = 0;
  private closing = false;
  private failure?: Error;
  private stderr = "";
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }>();
  private readonly exited: Promise<void>;
  constructor(executable: string, cwd: string) {
    super();
    this.process = spawn(executable, ["app-server", "--listen", "stdio://"], { cwd, env: codexEnvironment(), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.exited = new Promise(resolve => this.process.once("close", () => resolve()));
    this.process.stdin.on("error", () => this.fail(new Error("Codex App Server input closed")));
    this.process.once("error", error => this.fail(new NeedsInput(`Cannot start Codex App Server (${(error as NodeJS.ErrnoException).code ?? "process error"}). Install a recent Codex CLI and sign in with codex login.`)));
    this.process.stderr.on("data", data => { this.stderr = (this.stderr + String(data)).slice(-2000); });
    this.process.once("close", code => {
      if (!this.closing) this.fail(/auth|login|401|403|credential/i.test(this.stderr)
        ? new NeedsInput("Codex authentication is unavailable. Run codex login outside voice mode, then retry the task.")
        : new Error(`Codex App Server exited (${code}); no automatic fallback or task replay was attempted`));
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (data: string) => {
      this.bytes += Buffer.byteLength(data); this.buffer += data;
      if (this.bytes > 16 * 1024 * 1024 || Buffer.byteLength(this.buffer) > 2 * 1024 * 1024) { this.fail(new Error("Codex App Server output limit exceeded")); this.terminate(); return; }
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line) as RpcMessage;
          if (!m || typeof m !== "object") throw new Error("Invalid message");
          if (m.method) this.emit(m.id === undefined ? "notification" : "request", m);
          else if (typeof m.id === "number") {
            const pending = this.pending.get(m.id);
            if (!pending) continue;
            this.pending.delete(m.id); clearTimeout(pending.timer);
            if (m.error) pending.reject(new Error(`Codex request failed: ${String(m.error.message ?? m.error.code).slice(0, 600)}`));
            else pending.resolve(m.result);
          }
        } catch { this.fail(new Error("Invalid JSON-RPC from Codex App Server")); this.terminate(); }
      }
    });
  }
  private fail(error: Error) {
    if (this.closing || this.failure) return;
    this.failure = error;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit("failure", error);
  }
  send(message: RpcMessage) {
    if (this.failure) throw this.failure;
    if (this.closing || this.process.stdin.destroyed) throw new Error("Codex App Server is closed");
    if (this.process.stdin.writableLength > 256 * 1024) throw new Error("Codex App Server backpressure limit");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: object, timeoutMs = 30000): Promise<any> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private kill(signal: NodeJS.Signals) {
    try { if (process.platform !== "win32" && this.process.pid) process.kill(-this.process.pid, signal); else this.process.kill(signal); } catch {}
  }
  terminate() { this.kill("SIGTERM"); }
  async close() {
    if (this.closing) return;
    this.closing = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Codex App Server closed")); }
    this.pending.clear(); this.process.stdin.end();
    const term = setTimeout(() => this.kill("SIGTERM"), 300);
    const kill = setTimeout(() => this.kill("SIGKILL"), 1300);
    try { await this.exited; } finally { clearTimeout(term); clearTimeout(kill); this.removeAllListeners(); }
  }
}
