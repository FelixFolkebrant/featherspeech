import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentId, Profile } from "./profiles.js";
import { route } from "./profiles.js";
import { trimHistory } from "./history.js";
import type { RoomStore } from "./store.js";
import { TaskManager, type Task, type TaskRunner } from "./tasks.js";
import { parseUserControl } from "./permissions.js";

export type Audit = (event: string, data?: object) => void;
export const note = (text: string): AgentMessage => ({ role: "room_note", text, timestamp: Date.now() });

export class Room {
  registry?: Record<AgentId, Profile>;
  conversation: string;
  active: AgentId;
  readonly tasks: TaskManager;
  codexAccess: "sandboxed" | "full";
  constructor(readonly store: RoomStore, runner: TaskRunner, readonly historyTurns = 64,
    readonly audit: Audit = () => {}, limits: { concurrency?: number; pending?: number; timeoutMs?: number; codexAccess?: "sandboxed" | "full" } = {}) {
    this.codexAccess = limits.codexAccess ?? "sandboxed";
    this.conversation = store.get<string>("conversation") ?? randomUUID();
    this.active = store.get<AgentId>("active") ?? "default";
    this.persist();
    this.tasks = new TaskManager(store, runner, limits.concurrency, limits.pending, limits.timeoutMs);
    this.tasks.on("changed", (task: Task) => audit("task_state", { task_id: task.id, agent: task.agent, requester: task.requester, status: task.status, usage: task.usage }));
    this.tasks.on("progress", event => audit("task_progress", event));
  }
  private persist() { this.store.set("conversation", this.conversation); this.store.set("active", this.active); }
  reset() { this.conversation = randomUUID(); this.active = "default"; this.restrictCodex(); this.persist(); this.audit("conversation_reset"); }
  private restrictCodex(includeTaskGrants = false) {
    this.codexAccess = "sandboxed";
    for (const task of this.tasks.list()) if (task.agent === "codex" && (task.access === "full" || includeTaskGrants && task.grants.includes("full")) && ["queued", "running", "needs_input"].includes(task.status)) this.tasks.cancel(task.id);
  }
  activate(text: string): AgentId {
    const selected = route(text, this.active, this.registry);
    if (this.registry && (!this.registry[selected.agent] || this.registry[selected.agent]?.enabled === false)) throw new Error("That agent is disabled or unavailable");
    if (!selected.guest && selected.agent !== this.active) {
      this.audit("agent_switch", { from: this.active, to: selected.agent });
      this.active = selected.agent; this.persist();
    }
    if (selected.guest) this.audit("guest_response", { agent: selected.agent, return_to: this.active });
    return selected.agent;
  }
  context(agent: AgentId): AgentMessage[] {
    const rows = this.store.messages(this.conversation, this.historyTurns);
    const messages: AgentMessage[] = [];
    let previous: AgentId | undefined;
    for (const row of rows) {
      if (row.agent !== previous) messages.push(note(`[Room speaker: ${row.agent}]`));
      messages.push(row.message); previous = row.agent;
    }
    const tasks = this.tasks.list().slice(-8).map(t => ({ id: t.id, agent: t.agent, requester: t.requester, status: t.status, question: t.question, result_available: !!t.result }));
    const context = trimHistory(messages, this.historyTurns);
    if (tasks.length) context.push(note(`[Room task directory; use tasks to retrieve details: ${JSON.stringify(tasks)}]`));
    this.audit("context_retrieved", { agent, messages: context.length, tasks: tasks.length });
    return context;
  }
  append(agent: AgentId, messages: AgentMessage[]) {
    this.store.appendMessages(this.conversation, agent, messages);
  }
  delegate(requester: AgentId, agent: AgentId, prompt: string, mode: "read" | "modify" = "read", resumeTask?: string, liveContext?: AgentMessage[]): Task {
    if (this.registry && (!this.registry[agent] || this.registry[agent]?.enabled === false)) throw new Error("That agent is disabled or unavailable");
    const context = liveContext ? delegationContext(liveContext) : this.context(agent);
    return this.tasks.submit({ conversation: this.conversation, requester, agent, prompt, mode, context, resumeTask, access: agent === "codex" ? this.codexAccess : "sandboxed" });
  }
  /** Parse grants from actual user input only, not model output or delegated prompts. */
  userCommand(text: string): string | undefined {
    const command = parseUserControl(text);
    if (!command) return;
    try {
      if (command.action === "session") {
        if (command.full) this.codexAccess = "full"; else this.restrictCodex(true);
        this.audit("permission_changed", { scope: "session", access: this.codexAccess });
        return command.full ? "Codex has full access for this conversation, including files outside the project and network access. Existing blocked tasks still need an explicit approval or retry." : "Codex is restricted again. Work using full access was cancelled.";
      }
      let id = command.id;
      if (!id) {
        const pending = this.tasks.list().filter(t => t.status === "needs_input" && (t.pendingInput?.kind === "approval" || !t.pendingInput));
        if (pending.length !== 1) return pending.length ? `Which task do you mean? Say approve task ${pending.map(t => t.id).join(" or task ")}.` : "There is no pending permission request.";
        id = pending[0]!.id;
      }
      if (command.action === "answer") { this.tasks.answer(id, { text: command.text }); return `Your answer was sent to task ${id}.`; }
      if (command.action === "revoke") { this.tasks.cancel(id); this.audit("permission_revoked", { task_id: id }); return `Task ${id} was cancelled and its permissions revoked.`; }
      if (command.action === "decline") {
        const task = this.tasks.get(id);
        if (task.pendingInput?.kind === "approval") this.tasks.answer(id, { decision: "decline" }); else this.tasks.cancel(id);
        this.audit("permission_declined", { task_id: id }); return `The request for task ${id} was declined.`;
      }
      const task = this.tasks.get(id);
      const session = this.codexAccess === "full" && task.agent === "codex" && command.capability !== "full";
      const capabilities = [command.capability];
      this.tasks.grant(id, capabilities, session ? "full" : undefined);
      this.audit("permission_granted", { task_id: id, capabilities, scope: session ? "session" : "task" });
      return `Task ${id} is approved and will continue${session || capabilities.includes("full") ? " with full access" : ""}.`;
    } catch (error) {
      this.audit("permission_control_error", { error: String(error) });
      return `I couldn't apply that request. ${error instanceof Error ? error.message : "Please specify the task and try again."}`;
    }
  }
  notificationBatch(): { ids: string[]; text: string } {
    const batch = this.tasks.pendingNotifications().slice(0, 3);
    return { ids: batch.map(t => t.id), text: batch.map(t => t.status === "completed"
      ? `${t.agent === "deep-think" ? "Deep Think" : t.agent === "codex" ? "Codex" : "Default"} has finished task ${t.id}. The result is available.`
      : t.status === "needs_input" ? `Task ${t.id} needs your input. ${t.question ?? "Ask me for the details."}`
      : t.status === "cancelled" ? `Task ${t.id} was cancelled.` : `Task ${t.id} failed. Ask me for the details.`).join(" ") };
  }
}

/** Snapshot the current user turn too, without the in-flight consultation call. */
function delegationContext(messages: AgentMessage[]): AgentMessage[] {
  const completed = new Set(messages.flatMap(m => m.role === "toolResult" ? [m.toolCallId] : []));
  return messages.flatMap<AgentMessage>(m => {
    if (m.role === "system") return [];
    if (m.role !== "assistant") return [m];
    const content = m.content.filter(c => c.type !== "toolCall" || completed.has(c.id));
    return content.length ? [{ ...m, content, stopReason: content.some(c => c.type === "toolCall") ? m.stopReason : "stop" }] : [];
  });
}
