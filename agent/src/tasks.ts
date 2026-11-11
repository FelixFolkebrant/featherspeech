import { EventEmitter } from "node:events";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentId } from "./profiles.js";
import type { RoomStore } from "./store.js";

export type TaskStatus = "queued" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
export type Capability = "read" | "execute" | "modify" | "full";
export type TaskRequest = { kind: "approval" | "question"; question: string };
export type TaskAnswer = { decision: "accept" | "decline" } | { text: string };
export type TaskInteraction = {
  request: (request: TaskRequest, signal?: AbortSignal) => Promise<TaskAnswer>;
  checkpoint: (threadId: string) => void;
  fullAccess: () => boolean;
};
export type Task = {
  id: string; recordId: number; conversation: string; requester: AgentId; agent: AgentId;
  prompt: string; context: AgentMessage[]; mode: "read" | "modify"; grants: Capability[];
  status: TaskStatus; created: number; updated: number; result?: string; error?: string;
  question?: string; threadId?: string; resumeTask?: string; notified: boolean;
  usage?: unknown;
  access?: "sandboxed" | "full";
  pendingInput?: TaskRequest;
};
export type TaskResult = { text: string; threadId?: string; usage?: unknown };
export type TaskRunner = (task: Readonly<Task>, signal: AbortSignal, progress: (event: string) => void, interaction?: TaskInteraction) => Promise<TaskResult>;
export class NeedsInput extends Error {}

/** Task controllers never inherit the foreground speech controller. */
export class TaskManager extends EventEmitter {
  private readonly values = new Map<string, Task>();
  private readonly running = new Map<string, AbortController>();
  private readonly waiting = new Map<string, { resolve: (answer: TaskAnswer) => void; reject: (error: unknown) => void; cleanup: () => void }>();
  private next = 1;
  private closing = false;
  constructor(readonly store: RoomStore, readonly runner: TaskRunner, readonly concurrency = 2,
    readonly maxPending = 8, readonly timeoutMs = 600000) {
    super();
    for (const task of store.allTasks<Task>()) {
      task.grants = [];
      task.access = "sandboxed";
      const hadLiveInput = !!task.pendingInput;
      task.pendingInput = undefined;
      this.values.set(task.id, task);
      this.next = Math.max(this.next, Number(task.id) + 1);
      // Never automatically replay side effects after a crash/restart.
      if (["queued", "running"].includes(task.status) || hadLiveInput) {
        task.status = "needs_input";
        task.question = "The agent process stopped. Ask to retry this task after checking any partial changes.";
        task.grants = [];
        task.notified = false;
        this.save(task);
      }
    }
  }
  list(): Task[] { return [...this.values.values()].map(t => this.public(t)); }
  get(id: string): Task { const task = this.values.get(id); if (!task) throw new Error(`Unknown task ${id}`); return this.public(task); }
  private public(t: Task): Task { return structuredClone(t); }
  private save(task: Task) {
    task.updated = Date.now();
    this.store.update(task.recordId, task, `${task.prompt}\n${task.result ?? task.question ?? task.error ?? task.status}`);
  }
  private changed(task: Task) { this.save(task); this.emit("changed", this.public(task)); }
  submit(input: Pick<Task, "conversation" | "requester" | "agent" | "prompt" | "context" | "mode"> & { resumeTask?: string; access?: Task["access"] }): Task {
    if (this.closing) throw new Error("Room is shutting down");
    if ([...this.values.values()].filter(t => ["queued", "running", "needs_input"].includes(t.status)).length >= this.maxPending) throw new Error("Background task limit reached; cancel or finish an existing task first");
    const parent = input.resumeTask ? this.get(input.resumeTask) : undefined;
    if (parent && (parent.agent !== input.agent || !["completed", "failed", "cancelled", "needs_input"].includes(parent.status))) throw new Error("Only a settled task for the same agent can be continued");
    const task: Task = { ...structuredClone(input), id: String(this.next++), recordId: 0,
      grants: [], status: "queued", created: Date.now(), updated: Date.now(), notified: false,
      threadId: parent?.threadId };
    task.recordId = this.store.add(task.conversation, task.agent, "task", task, task.prompt);
    this.values.set(task.id, task);
    this.changed(task);
    queueMicrotask(() => this.pump());
    return this.public(task);
  }
  /** Only the trusted inbound user-command path calls this; it is not an LLM tool. */
  grant(id: string, capabilities: Capability[], access?: Task["access"]): Task {
    const task = this.values.get(id);
    if (!task || task.status !== "needs_input") throw new Error("Permissions can only be granted to a task awaiting input");
    if (this.waiting.has(id)) {
      if (task.pendingInput?.kind !== "approval") throw new Error("This task needs an answer, not a permission grant");
      if (access) task.access = access;
      if (capabilities.includes("full")) task.grants = [...new Set([...task.grants, "full" as const])];
      return this.answer(id, { decision: "accept" });
    }
    if (access) task.access = access;
    task.grants = [...new Set([...task.grants, ...capabilities])];
    if (capabilities.includes("modify")) task.mode = "modify";
    task.question = undefined; task.error = undefined; task.status = "queued"; task.notified = false;
    this.changed(task); queueMicrotask(() => this.pump()); return this.public(task);
  }
  retry(id: string, prompt?: string, access: Task["access"] = "sandboxed"): Task {
    const task = this.values.get(id);
    if (!task || !["needs_input", "failed", "cancelled"].includes(task.status) || this.running.has(id)) throw new Error("Task must be stopped before retrying");
    if (prompt) task.prompt = prompt;
    task.access = access; task.pendingInput = undefined;
    task.status = "queued"; task.error = undefined; task.question = undefined; task.notified = false;
    this.changed(task); queueMicrotask(() => this.pump()); return this.public(task);
  }
  cancel(id: string): Task {
    const task = this.values.get(id);
    if (!task) throw new Error(`Unknown task ${id}`);
    if (["completed", "failed", "cancelled"].includes(task.status)) return this.public(task);
    task.status = "cancelled"; task.grants = []; task.notified = false;
    this.running.get(id)?.abort(); this.changed(task); this.pump(); return this.public(task);
  }
  /** Resolves only an actual outstanding request; no model tool exposes this method. */
  answer(id: string, answer: TaskAnswer): Task {
    const task = this.values.get(id), waiting = this.waiting.get(id);
    if (!task || !waiting || !task.pendingInput) throw new Error("No live request for this task; retry it explicitly instead");
    if ((task.pendingInput.kind === "approval") !== ("decision" in answer)) throw new Error("This request needs a different kind of answer");
    waiting.cleanup(); this.waiting.delete(id);
    task.status = "running"; task.question = undefined; task.pendingInput = undefined; task.notified = true;
    this.changed(task); waiting.resolve(answer); return this.public(task);
  }
  private request(task: Task, request: TaskRequest, signal: AbortSignal): Promise<TaskAnswer> {
    signal.throwIfAborted();
    if (this.waiting.has(task.id)) return Promise.reject(new Error("Task already has a pending question"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(task.id);
        if (!this.running.get(task.id)?.signal.aborted && task.pendingInput === request) {
          task.pendingInput = undefined; task.question = undefined; task.status = "running"; this.changed(task);
        }
        reject(signal.reason);
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      this.waiting.set(task.id, { resolve, reject, cleanup });
      signal.addEventListener("abort", abort, { once: true });
      task.status = "needs_input"; task.question = request.question.slice(0, 1600) + (request.kind === "question" ? ` Say answer task ${task.id}, followed by your answer.` : ""); task.pendingInput = request; task.notified = false;
      this.changed(task);
    });
  }
  pendingNotifications(): Task[] {
    return [...this.values.values()].filter(t => !t.notified && ["completed", "failed", "needs_input", "cancelled"].includes(t.status)).map(t => this.public(t));
  }
  acknowledge(ids: string[]) { for (const id of ids) { const t = this.values.get(id); if (t) { t.notified = true; this.save(t); } } }
  private pump() {
    if (this.closing) return;
    for (const task of this.values.values()) {
      if (this.running.size >= this.concurrency) break;
      if (task.status !== "queued" || this.running.has(task.id)) continue;
      // All Codex jobs share one configured project; never race edits within it.
      if (task.agent === "codex" && [...this.running.keys()].some(id => this.values.get(id)?.agent === "codex")) continue;
      const controller = new AbortController();
      this.running.set(task.id, controller); task.status = "running"; this.changed(task);
      void this.execute(task, controller);
    }
  }
  private async execute(task: Task, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(new Error("Background task deadline exceeded")), this.timeoutMs);
    try {
      const result = await this.runner(this.public(task), controller.signal, phase => this.emit("progress", { id: task.id, agent: task.agent, phase }), {
        request: (request, signal) => this.request(task, request, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal),
        checkpoint: threadId => { task.threadId = threadId; this.save(task); },
        fullAccess: () => task.access === "full" || task.grants.includes("full"),
      });
      controller.signal.throwIfAborted();
      task.result = result.text.slice(0, 24000); task.threadId = result.threadId ?? task.threadId;
      task.usage = result.usage; task.status = "completed";
    } catch (error) {
      if (task.status !== "cancelled" && !this.closing) {
        task.status = error instanceof NeedsInput ? "needs_input" : "failed";
        if (task.status === "needs_input") task.question = String((error as Error).message);
        else task.error = controller.signal.aborted ? String(controller.signal.reason) : String(error);
      }
    } finally {
      clearTimeout(timer); this.running.delete(task.id);
      this.waiting.get(task.id)?.cleanup(); this.waiting.delete(task.id); task.pendingInput = undefined;
      if (task.status !== "needs_input") task.grants = [];
      task.notified = false; this.changed(task); this.pump();
      if (!this.running.size) this.emit("idle");
    }
  }
  async close() {
    this.closing = true;
    for (const task of this.values.values()) if (["queued", "running"].includes(task.status)) {
      task.status = "needs_input"; task.grants = []; task.notified = false;
      task.question = "Service stopped. Check partial changes, then retry explicitly.";
      this.running.get(task.id)?.abort(); this.changed(task);
    }
    if (this.running.size) await new Promise<void>(resolve => this.once("idle", resolve));
  }
}
