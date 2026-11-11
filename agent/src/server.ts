import { type Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EventEmitter, once } from "node:events";
import { z } from "zod";
import { RoomInterface } from "./interface.js";
import { controlSocket } from "./control-socket.js";
import { SpeechChunker } from "./chunker.js";
import { retainInterruptedReply } from "./history.js";
import { profiles, integer, type AgentId } from "./profiles.js";
import { RoomStore, messageText } from "./store.js";
import { Room } from "./room.js";
import { roomTools } from "./room-tools.js";
import { PiFactory } from "./pi.js";
import { codexRunner } from "./codex.js";
import { codexAppServerRunner } from "./codex-app-server.js";
import { NeedsInput, type Task } from "./tasks.js";

const socketPath = resolve(process.env.VC_AGENT_SOCKET ?? "run/agent.sock");
const mock = process.env.VC_MOCK_AGENT === "1";
if (!mock && !process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required (set it in .env).");
const maxTokens = integer(process.env, "VC_MAX_TOKENS", 1024, 32, 4096);
const maxHistory = integer(process.env, "VC_HISTORY_TURNS", 64, 1, 512);
const concurrency = integer(process.env, "VC_TASK_CONCURRENCY", 2, 1, 4);
const pending = integer(process.env, "VC_TASK_LIMIT", 8, 1, 32);
const taskTimeout = integer(process.env, "VC_TASK_TIMEOUT_SECS", 600, 1, 3600) * 1000;
const maxUsd = z.coerce.number().positive().max(100).parse(process.env.VC_RUN_MAX_USD ?? 0.25);
const agents = profiles();
for (const profile of Object.values(agents)) z.object({ pocket: z.enum(["default", "alba", "marius", "jean", "javert", "fantine", "cosette", "eponine", "azelma"]), kitten: z.enum(["default", "Bella", "Jasper", "Luna", "Bruno", "Rosie", "Hugo", "Kiki", "Leo"]), speed: z.number().min(0.5).max(2) }).parse(profile.voice);
const factory = new PiFactory(maxTokens, maxHistory, maxUsd);
await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
try {
  const stat = await lstat(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw new Error("Refusing to replace unowned/non-socket IPC path");
  const active = await new Promise<boolean>(resolve => {
    const probe = createConnection(socketPath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", error => { if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(false); else resolve(true); });
  });
  if (active) throw new Error("Agent already listening");
  await unlink(socketPath);
} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
const store = new RoomStore(process.env.VC_ROOM_DB ?? "run/room.sqlite");
let ui: RoomInterface | undefined;
const log = (event: string, data: object = {}) => { ui?.audit(event, data); process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), component: "agent", event, ...data }) + "\n"); };
const codexBackend = z.enum(["app-server", "exec"]).parse(process.env.VC_CODEX_BACKEND ?? "app-server");
const codexOptions = { executable: process.env.VC_CODEX_BIN ?? "codex", project: resolve(process.env.VC_CODEX_PROJECT ?? "."), model: process.env.VC_CODEX_MODEL, allowExecute: process.env.VC_CODEX_ALLOW_EXECUTE !== "false" };
const codex = (codexBackend === "app-server" ? codexAppServerRunner : codexRunner)(codexOptions);
const room = new Room(store, async (task, signal, progress, interaction) => {
  if (mock) { await new Promise(r => setTimeout(r, 120)); signal.throwIfAborted(); return { text: "Demo task completed. No model, tool, or Codex process was called." }; }
  if (task.agent === "codex") return codex(task, signal, progress, interaction);
  let question: string | undefined;
  const agent = factory.create(agents[task.agent]!, roomTools(room, task.agent, true, value => { question = value; }), task.context, true);
  const abort = () => agent.abort(); signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const usage = { model: agents[task.agent]!.model, input: 0, output: 0, usd: 0, cost_source: "provider" };
  const unsubscribe = agent.subscribe(event => {
    if (event.type === "tool_execution_start") progress(`tool:${event.toolName}`);
    if (event.type === "message_end" && event.message.role === "assistant") {
      usage.input += event.message.usage.input; usage.output += event.message.usage.output;
      usage.usd += event.message.usage.cost.total;
      if (!event.message.usage.cost.totalFromProvider) usage.cost_source = "catalog_estimate";
    }
  });
  try {
    signal.throwIfAborted(); await agent.prompt(task.prompt); signal.throwIfAborted();
    if (question) throw new NeedsInput(question);
    const last = agent.state.messages.filter(m => m.role === "assistant").at(-1);
    if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") throw new Error("Background provider request failed");
    const text = messageText(last);
    if (!text.trim()) throw new Error("Background agent returned no answer");
    return { text, usage };
  } finally { unsubscribe(); signal.removeEventListener("abort", abort); }
}, maxHistory, log, { concurrency, pending, timeoutMs: taskTimeout, codexAccess: z.enum(["sandboxed", "full"]).parse(process.env.VC_CODEX_ACCESS ?? "sandboxed") });

const withInterface = (speaker: AgentId, background = false, onInput?: (question: string) => void, liveContext?: () => AgentMessage[]) => [...roomTools(room, speaker, background, onInput, liveContext), ...(ui && !background ? [ui.tool()] : [])];

const request = z.discriminatedUnion("type", [
  z.object({ type: z.literal("audio_settings"), provider: z.enum(["pocket", "kitten", "mock"]) }).strict(),
  z.object({ type: z.literal("speech_test_status"), status: z.string().max(1000) }).strict(),
  z.object({ type: z.literal("prompt"), turn_id: z.number().int().positive(), text: z.string().min(1).max(12000) }).strict(),
  z.object({ type: z.literal("cancel"), turn_id: z.number().int().positive(), playback_elapsed_ms: z.number().finite().nonnegative().nullable().optional() }).strict(),
  z.object({ type: z.literal("poll_notifications"), turn_id: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("playback_complete"), turn_id: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("reset") }).strict(), z.object({ type: z.literal("ping") }).strict(),
]);

type Run = { id: number; speaker: AgentId; abort: AbortController; agent?: Agent; baseline: number;
  complete: boolean; playbackComplete?: boolean; cancelled: boolean; settled: Promise<void>; resolve: () => void;
  timing?: number | null; noteSaved: boolean; notificationIds: string[] };

// The room outlives engine connections. A handshake probe never resets history/tasks.
let stopForeground: () => Promise<void> = async () => {};
let steerForeground: (text: string) => void = () => { throw new Error("No running turn to steer"); };
let sequence = Promise.resolve();
let epoch = 0;
// A text transport runs the same prompt/tool/history path without allocating audio.
class TextPeer extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  setEncoding(_encoding: string) {}
  write(_data: string) { return true; }
  destroy(_error?: Error) { this.destroyed = true; this.emit("close"); return this; }
  input(message: object) { this.emit("data", JSON.stringify(message) + "\n"); }
}
function serve(socket: EventEmitter & { destroyed: boolean; writableLength: number; write(data: string): boolean; setEncoding(encoding: BufferEncoding): unknown; destroy(error?: Error): unknown; on(event: string, listener: (...args: any[]) => void): unknown }) {
  let run: Run | undefined;
  async function send(event: object, signal?: AbortSignal) {
    if (socket.destroyed || signal?.aborted) return;
    ui?.event(event);
    if (socket.writableLength > 256 * 1024) { socket.destroy(new Error("IPC backpressure limit")); return; }
    if (!socket.write(JSON.stringify({ v: 1, ...event }) + "\n")) await once(socket, "drain", { signal: signal ?? AbortSignal.timeout(5000) });
  }
  const notify = (task: Task) => {
    void send({ type: "task_status", task_id: task.id, agent: task.agent, status: task.status }).catch(() => socket.destroy());
    if (room.tasks.pendingNotifications().length) void send({ type: "notification_available" }).catch(() => socket.destroy());
  };
  room.tasks.on("changed", notify);
  async function cancel(id?: number, playbackElapsedMs?: number | null) {
    const old = run;
    if (!old || (id !== undefined && old.id !== id)) return;
    if (old.complete && (socket === textPeer || old.playbackComplete)) return;
    if (old.cancelled) { await old.settled; return; }
    old.cancelled = true; old.timing = playbackElapsedMs; old.abort.abort(); old.agent?.abort();
    await old.settled;
    if (!old.noteSaved) { room.append(old.speaker, retainInterruptedReply([], 0, playbackElapsedMs)); old.noteSaved = true; }
    if (run === old) run = undefined;
    await send({ type: "cancelled", turn_id: old.id });
    if (room.tasks.pendingNotifications().length) await send({ type: "notification_available" });
  }
  async function prompt(id: number, text: string | undefined, ticket: number) {
    if (ticket !== epoch || socket.destroyed) return;
    const speaker = text === undefined ? room.active : room.activate(text);
    const profile = structuredClone(agents[speaker]!);
    stopForeground = () => cancel();
    steerForeground = value => { if (!run?.agent || run.complete || run.cancelled) throw new Error("No running model turn to steer"); run.agent.steer({ role: "user", content: value, timestamp: Date.now() }); };
    if (ui) { ui.live = { id, agent: speaker, model: profile.model, user: text, text: "", status: "thinking", started: Date.now() }; ui.changed(); }
    let settle!: () => void;
    const current: Run = { id, speaker, abort: new AbortController(), baseline: 0, complete: false,
      cancelled: false, settled: new Promise<void>(resolve => { settle = resolve; }), resolve: () => settle(), noteSaved: false, notificationIds: [] };
    run = current;
    const signal = current.abort.signal, started = performance.now(), chunker = new SpeechChunker();
    let token = false, chunk = false, failure = false, timerBusy = false;
    const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0, cost_source: "provider" };
    const metric = (name: string) => send({ type: "metric", turn_id: id, name, elapsed_ms: performance.now() - started }, signal);
    let speechChain = Promise.resolve();
    const chunks = (values: string[]) => {
      speechChain = speechChain.then(async () => {
        for (const value of values) {
          if (signal.aborted) return;
          if (!chunk) { chunk = true; await metric("first_chunk"); }
          await send({ type: "speak", turn_id: id, text: value, agent: speaker, voice: profile.voice }, signal);
        }
      });
      return speechChain;
    };
    const delta = async (value: string) => {
      if (!token) { token = true; await metric("llm_first_token"); }
      await send({ type: "text_delta", turn_id: id, agent: speaker, delta: value }, signal);
      await chunks(chunker.push(value));
    };
    let unsubscribe = () => {};
    const timer = setInterval(() => {
      if (timerBusy || signal.aborted) return;
      timerBusy = true;
      chunks(chunker.tick()).catch(() => { current.abort.abort(); current.agent?.abort(); }).finally(() => { timerBusy = false; });
    }, 50);
    const deadline = setTimeout(() => { failure = true; current.abort.abort(); current.agent?.abort(); void send({ type: "error", turn_id: id, error: "Agent deadline exceeded" }); }, 75000);
    try {
      await send({ type: "metric", turn_id: id, name: "llm_start", elapsed_ms: 0 }, signal);
      let local: string | undefined;
      if (text === undefined) {
        const batch = room.notificationBatch(); current.notificationIds = batch.ids; local = batch.text;
        log("notification_delivery", { agent: speaker, task_ids: batch.ids });
      } else local = room.userCommand(text);
      if (local !== undefined) {
        if (local) { await delta(local); room.append(speaker, [...(text ? [{ role: "user" as const, content: text, timestamp: Date.now() }] : []), reply(local, speaker)]); }
      } else if (mock) {
        const values = ["This is a ", "streaming test. ", "The next turn is ready."];
        let spoken = "";
        for (const value of values) { await new Promise(r => setTimeout(r, 30)); if (signal.aborted) break; spoken += value; await delta(value); }
        room.append(speaker, [{ role: "user", content: text!, timestamp: Date.now() }, reply(spoken, speaker)]);
      } else {
        const agent = factory.create(profile, withInterface(speaker, false, undefined, () => current.agent?.state.messages ?? []), room.context(speaker));
        current.agent = agent; current.baseline = agent.state.messages.length;
        unsubscribe = agent.subscribe(async event => {
          if (event.type === "message_end" && event.message.role === "assistant") {
            const m = event.message;
            usage.input += m.usage.input; usage.output += m.usage.output;
            usage.cache_read += m.usage.cacheRead; usage.cache_write += m.usage.cacheWrite;
            usage.usd += m.usage.cost.total;
            if (!m.usage.cost.totalFromProvider) usage.cost_source = "catalog_estimate";
            if (m.stopReason === "error") { failure = true; await send({ type: "error", turn_id: id, error: "Provider request failed; see agent logs" }, signal); log("provider_error", { turn_id: id, agent: speaker, error: m.errorMessage }); }
            await send({ type: "usage", turn_id: id, agent: speaker, usage });
            if (!signal.aborted) await chunks(chunker.flush());
          }
          if (signal.aborted) return;
          if (event.type === "message_update") {
            const e = event.assistantMessageEvent;
            if (["text_delta", "thinking_delta", "toolcall_delta"].includes(e.type) && !token) { token = true; await metric("llm_first_token"); }
            if (e.type === "text_delta") await delta(e.delta);
          }
          if (event.type === "tool_execution_start") await send({ type: "tool", turn_id: id, agent: speaker, phase: "start", name: event.toolName }, signal);
          if (event.type === "tool_execution_end") await send({ type: "tool", turn_id: id, agent: speaker, phase: "end", name: event.toolName, is_error: event.isError }, signal);
        });
        await agent.prompt(text!);
      }
      if (!signal.aborted && !failure) { await chunks(chunker.flush()); current.complete = true; await send({ type: "done", turn_id: id, agent: speaker }, signal); }
    } catch (error) {
      if (!signal.aborted) { log("turn_error", { turn_id: id, agent: speaker, error: String(error) }); await send({ type: "error", turn_id: id, error: String(error).slice(0, 500) }); }
    } finally {
      clearInterval(timer); clearTimeout(deadline); unsubscribe();
      try {
        if (current.agent) {
          let tail = current.agent.state.messages.slice(current.baseline);
          if (signal.aborted) { tail = retainInterruptedReply(tail, 0, current.timing); current.noteSaved = true; }
          room.append(speaker, tail);
        }
      } catch (error) { log("history_save_error", { turn_id: id, error: String(error) }); await send({ type: "error", turn_id: id, error: "Could not save conversation history" }); }
      finally { if (ui?.live?.id === id) { ui.live = undefined; ui.changed(); } current.resolve(); }
    }
  }
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (data: string) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 65536) { socket.destroy(new Error("IPC frame too large")); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = request.parse(JSON.parse(line));
        if (message.type === "audio_settings" && ui) { ui.ttsProvider = message.provider === "mock" ? undefined : message.provider; ui.changed(); }
        if (message.type === "speech_test_status" && ui) { ui.speechTest = message.status; ui.changed(); }
        if (message.type === "cancel" && run?.id === message.turn_id) { epoch++; void cancel(message.turn_id, message.playback_elapsed_ms).catch(() => socket.destroy()); }
        if (message.type === "reset") { ++epoch; const pending = stopForeground(); sequence = sequence.then(async () => { await pending; if (!socket.destroyed) room.reset(); }); }
        if (message.type === "ping") void send({ type: "pong" }).catch(() => socket.destroy());
        if (message.type === "playback_complete" && run?.id === message.turn_id && run.complete && !run.cancelled) {
          run.playbackComplete = true;
          room.tasks.acknowledge(run.notificationIds);
          if (room.tasks.pendingNotifications().length) void send({ type: "notification_available" }).catch(() => socket.destroy());
        }
        if (message.type === "prompt" || message.type === "poll_notifications") {
          const ticket = ++epoch;
          const pending = stopForeground();
          sequence = sequence.then(async () => { await pending; await prompt(message.turn_id, message.type === "prompt" ? message.text : undefined, ticket); }).catch(e => { log("dispatch_error", { error: String(e) }); void send({ type: "error", turn_id: message.turn_id, error: "Room dispatch failed" }); });
        }
      } catch { void send({ type: "error", error: "Invalid IPC request" }).catch(() => socket.destroy()); }
    }
  });
  socket.on("error", error => log("socket_error", { error: error.message }));
  socket.on("close", () => { room.tasks.off("changed", notify); void cancel().catch(e => log("disconnect_cancel_error", { error: String(e) })); });
  void send({ type: "ready", config: { model: agents.default.model, pi_version: "1.5.0", max_tokens: maxTokens, history_turns: maxHistory, reasoning: "none", mock,
    active_agent: room.active, agents: Object.values(agents).map(({ id, name, model, reasoning, voice }) => ({ id, name, model, reasoning, voice })),
    tools: roomTools(room, "default").map(t => t.name), codex_backend: codexBackend, codex_access: room.codexAccess, task_concurrency: concurrency, task_limit: pending, persistence: process.env.VC_ROOM_DB !== ":memory:" } }).then(async () => { if (room.tasks.pendingNotifications().length) await send({ type: "notification_available" }); }).catch(() => socket.destroy());
}
function reply(text: string, speaker: AgentId): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: "openai-completions", provider: "openrouter", model: agents[speaker]!.model, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

let client: Socket | undefined;
let textId = 1_000_000_000;
const textPeer = new TextPeer();
ui = new RoomInterface(room, agents, {
  message: async (text, steer, task) => {
    if (steer && task) {
      const t = room.tasks.get(task);
      if (t.pendingInput?.kind === "question") room.tasks.answer(task, { text });
      else throw new Error("This task is not awaiting an answer; cancel/retry it with a revised instruction");
    } else if (steer) steerForeground(text);
    else if (ui!.mode === "voice" && client && !client.destroyed) client.write(JSON.stringify({ v: 1, type: "ui_prompt", text }) + "\n");
    else textPeer.input({ type: "prompt", turn_id: ++textId, text });
  },
  cancel: async () => { if (client && !client.destroyed) client.write(JSON.stringify({ v: 1, type: "ui_cancel" }) + "\n"); ++epoch; await stopForeground(); },
  reset: async () => { ++epoch; if (client && !client.destroyed) client.write(JSON.stringify({ v: 1, type: "ui_cancel" }) + "\n"); await stopForeground(); room.reset(); ui!.live = undefined; },
  mode: async mode => { ++epoch; await stopForeground(); if (client && !client.destroyed) client.write(JSON.stringify({ v: 1, type: "ui_mode", text_only: mode === "text" }) + "\n"); },
  testSpeech: async (profile, text) => {
    if (!client || client.destroyed) throw new Error("Audio service disconnected");
    ++epoch;
    await stopForeground();
    if (!client || client.destroyed) throw new Error("Audio service disconnected");
    client.write(JSON.stringify({ v: 1, type: "ui_test_speech", text, voice: profile.voice }) + "\n");
  },
  models: () => factory.models.getModels("openrouter").map(m => ({ id: m.id, input: m.cost.input, output: m.cost.output, reasoning: m.reasoning })),
});
ui.mode = process.env.VC_TEXT_ONLY === "1" ? "text" : "voice";
serve(textPeer);
if (process.env.VC_TUI_DEMO === "1") {
  room.append("default", [{ role: "user", content: "How do the agents in this room work together?", timestamp: Date.now() }, reply("We share one conversation. I handle everyday questions, Deep Think can work through a harder problem, and Codex can build alongside us. You can keep talking while background work continues.", "default")]);
  await ui.dispatch({ action: "artifact", title: "One room. Different perspectives.", content: "## A little room to think out loud.\n\n| Agent | A good place to start |\n|---|---|\n| Default | Everyday conversation |\n| Deep Think | Research and reasoning |\n| Codex | Building and debugging |\n\nAsk an agent to show a table, explain some code, or put the details on your screen.\n\n**Demo mode** · Responses are local fixtures. No microphone, cloud calls, or Codex processes.", kind: "markdown" });
}
const closeControl = await controlSocket(resolve(process.env.VC_CONTROL_SOCKET ?? socketPath.replace(/\.sock$/, "") + ".control.sock"), ui);
void ui.refresh();
const server = createServer(socket => {
  if (client && !client.destroyed) { socket.end(); return; }
  client = socket; ui!.engineConnected = true; ui!.changed();
  socket.on("close", () => { if (client === socket) { client = undefined; ui!.engineConnected = false; ui!.ttsProvider = undefined; ui!.speechTest = "Audio service disconnected"; ui!.changed(); } });
  serve(socket);
  if (ui!.mode === "text") socket.write(JSON.stringify({ v: 1, type: "ui_mode", text_only: true }) + "\n");
});
server.listen(socketPath); await once(server, "listening"); await chmod(socketPath, 0o600);
log("ready", { socket: socketPath, model: agents.default.model, mock, task_concurrency: concurrency });
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (closing) return; closing = true; client?.destroy();
  server.close(() => { void stopForeground().then(() => room.tasks.close()).then(closeControl).then(() => { store.close(); return unlink(socketPath); }).finally(() => process.exit(0)); });
});
