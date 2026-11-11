import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

type Event = { type: string; turn_id?: number; [key: string]: any };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
class Client {
  events: Event[] = []; buffer = "";
  constructor(readonly socket: Socket) {
    socket.setEncoding("utf8"); socket.on("data", (part: string) => { this.buffer += part; let at: number; while ((at = this.buffer.indexOf("\n")) >= 0) { this.events.push(JSON.parse(this.buffer.slice(0, at))); this.buffer = this.buffer.slice(at + 1); } });
  }
  send(event: object) { this.socket.write(JSON.stringify(event) + "\n"); }
  async wait(type: string, id?: number, start = 0, predicate = (_e: Event) => true): Promise<Event> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const values = this.events.slice(start);
      const error = values.find(e => e.type === "error" && e.turn_id === id);
      assert(!error, JSON.stringify(error));
      const value = values.find(e => e.type === type && (id === undefined || e.turn_id === id) && predicate(e));
      if (value) return value;
      await sleep(5);
    }
    throw new Error(`Timed out waiting for ${type}/${id}: ${JSON.stringify(this.events.slice(start))}`);
  }
  async turn(id: number, text: string) { const start = this.events.length; this.send({ type: "prompt", turn_id: id, text }); await this.wait("done", id, start); return this.events.slice(start).filter(e => e.turn_id === id); }
}

for (const backend of ["exec", "app-server"] as const) test(`simulated shared-room conversations with ${backend}: streaming, delegation, voice control and durable restart`, { timeout: 40000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "vc-room-integration-"));
  const a = deferred(), b = deferred(), startedA = deferred(), startedB = deferred();
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString()); requests.push(payload);
    const last = payload.messages.at(-1);
    const content = [...payload.messages].reverse().find((m: any) => m.role === "user")?.content ?? "";
    const text: string = typeof content === "string" ? content : content.map((c: any) => c.text ?? "").join("");
    const toolResult = last.role === "tool";
    if (text === "WORK_BACKGROUND_A") { startedA.resolve(); await a.promise; }
    if (text === "WORK_BACKGROUND_B") { startedB.resolve(); await b.promise; }
    if (res.destroyed) return;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const event = (delta: any, finish: string | null = null, usage?: object) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
    let tool: { name: string; args: object } | undefined;
    if (!toolResult && text.includes("delegate A")) tool = { name: "consult_agent", args: { agent: "deep-think", instruction: "WORK_BACKGROUND_A" } };
    if (!toolResult && text.includes("delegate B")) tool = { name: "consult_agent", args: { agent: "deep-think", instruction: "WORK_BACKGROUND_B" } };
    if (!toolResult && text.includes("delegate coding")) tool = { name: "consult_agent", args: { agent: "codex", instruction: "Create answer.txt containing 42", mode: "modify" } };
    if (!toolResult && /retrieve task (\d+)/.test(text)) tool = { name: "tasks", args: { action: "get", id: /retrieve task (\d+)/.exec(text)![1] } };
    if (!toolResult && text.includes("remember preference")) tool = { name: "remember", args: { text: "Use PostgreSQL for our database" } };
    if (!toolResult && text.includes("find database memory")) tool = { name: "search_memory", args: { query: "PostgreSQL", kind: "memory" } };
    if (!toolResult && text.includes("time tool")) tool = { name: "current_time", args: { timezone: "UTC" } };
    if (tool) event({ role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] });
    else {
      const values = text.includes("long reply") ? Array(80).fill("A long spoken explanation. ")
        : toolResult ? [`Tool result: ${String(last.content)}.`]
        : text === "WORK_BACKGROUND_A" ? ["The alternatives are PostgreSQL and SQLite."]
        : text === "WORK_BACKGROUND_B" ? ["The second task is complete."]
        : ["Here is the answer. ", "We can keep talking."];
      try { for (const value of values) { if (res.destroyed) return; event({ content: value }); await sleep(10); } } catch { return; }
    }
    event({}, tool ? "tool_calls" : "stop", { prompt_tokens: 21, completion_tokens: 12, total_tokens: 33, cost: 0.0000081 });
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const port = (provider.address() as { port: number }).port;
  const executable = backend === "exec" ? join(temp, "codex-fixture") : new URL("../test/fixtures/codex-app-server.cjs", import.meta.url).pathname;
  if (backend === "exec") await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
if(!process.argv.includes('sandbox_mode="workspace-write"')) process.exit(2);
fs.writeFileSync('answer.txt','42\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'room-coding-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Created answer.txt containing 42; verified file contents.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:8}}));});\n`);
  await chmod(executable, 0o700);
  let processHandle: ChildProcess | undefined, client: Client | undefined, logs = "";
  const start = async () => {
    const env = { ...process.env, VC_AGENT_SOCKET: join(temp, "agent.sock"), VC_ROOM_DB: join(temp, "room.sqlite"), VC_CODEX_BACKEND: backend, VC_CODEX_ACCESS: "sandboxed", VC_CODEX_BIN: executable, VC_CODEX_PROJECT: temp, OPENROUTER_API_KEY: "fixture-key", VC_OPENROUTER_BASE_URL: `http://127.0.0.1:${port}/v1`, VC_TASK_TIMEOUT_SECS: "30" };
    delete env.VC_MOCK_AGENT;
    processHandle = spawn(process.execPath, [new URL("../dist/server.js", import.meta.url).pathname], { env, stdio: ["ignore", "pipe", "pipe"] });
    processHandle.stderr!.on("data", d => { logs += d.toString(); });
    for (let attempt = 0; attempt < 200; attempt++) {
      try { const socket = createConnection(join(temp, "agent.sock")); await once(socket, "connect"); client = new Client(socket); await client.wait("ready"); return client; } catch { await sleep(10); }
    }
    throw new Error(`Server failed to start: ${logs}`);
  };
  const stop = async () => { client?.socket.destroy(); if (processHandle && processHandle.exitCode === null) { processHandle.kill("SIGTERM"); await once(processHandle, "exit"); } };
  try {
    let c = await start();
    await c.turn(1, "remember preference");
    const deep = await c.turn(2, "Deep Think, explain our database");
    assert(deep.some(e => e.type === "speak" && e.agent === "deep-think" && e.voice.pocket === "marius"));
    const deepRequest = requests.find(r => r.model === "openai/gpt-6.1-terra" && r.reasoning.effort === "high");
    assert.match(JSON.stringify(deepRequest.messages), /PostgreSQL/); assert.equal(deepRequest.reasoning.effort, "high");
    await c.turn(3, "back to default");
    await c.turn(4, "Please delegate A"); await startedA.promise;
    const background = requests.find(r => JSON.stringify(r.messages.at(-1)).includes("WORK_BACKGROUND_A"));
    assert.match(JSON.stringify(background.messages), /Please delegate A/);
    assert(!background.tools.some((t: any) => t.function.name === "consult_agent"));
    // A real independent provider request remains pending while more foreground requests finish.
    const timeStart = Date.now(); await c.turn(5, "Use the time tool"); assert(Date.now() - timeStart < 2000);
    await c.turn(6, "Codex, retrieve task 1");
    assert.equal(requests.at(-1).model, "openai/gpt-6-luna");
    assert.equal(requests.at(-1).reasoning.effort, "none");
    assert.equal(c.events.filter(e => e.turn_id === 6 && e.type === "speak").map(e => e.text).join(" ").includes("running"), true);
    const beforeCompletion = c.events.length; a.resolve();
    await c.wait("task_status", undefined, beforeCompletion, e => e.task_id === "1" && e.status === "completed");
    await c.wait("notification_available", undefined, beforeCompletion);
    await sleep(30);
    assert(!c.events.slice(beforeCompletion).some(e => e.type === "speak"), "Background work spoke without a playback-safe poll");
    c.send({ type: "poll_notifications", turn_id: 7 }); await c.wait("done", 7);
    assert(c.events.some(e => e.turn_id === 7 && e.type === "speak" && e.agent === "codex"));
    c.send({ type: "cancel", turn_id: 7, playback_elapsed_ms: 10 }); await c.wait("cancelled", 7);
    c.send({ type: "poll_notifications", turn_id: 8 }); await c.wait("done", 8);
    assert(c.events.some(e => e.turn_id === 8 && e.type === "speak"));
    c.send({ type: "playback_complete", turn_id: 8 });
    const retrieved = await c.turn(9, "Default, retrieve task 1");
    assert.match(retrieved.filter(e => e.type === "text_delta").map(e => e.delta).join(""), /PostgreSQL and SQLite/);
    await c.turn(10, "Please delegate B"); await startedB.promise;
    c.send({ type: "prompt", turn_id: 11, text: "Give a long reply" }); await c.wait("speak", 11);
    const cancelStart = Date.now(); c.send({ type: "cancel", turn_id: 11, playback_elapsed_ms: 1234 }); await c.wait("cancelled", 11);
    assert(Date.now() - cancelStart < 1500);
    const stillRunning = await c.turn(12, "retrieve task 2");
    assert.match(stillRunning.filter(e => e.type === "text_delta").map(e => e.delta).join(""), /running/);
    assert(!stillRunning.some(e => e.type === "speak" && e.turn_id === 11));
    b.resolve(); await c.wait("task_status", undefined, 0, e => e.task_id === "2" && e.status === "completed");
    await c.turn(13, "Codex, explain it");
    const guest = await c.turn(14, "Let me hear from Deep Think");
    assert(guest.some(e => e.type === "speak" && e.agent === "deep-think"));
    const next = await c.turn(15, "And the follow-up?"); assert(next.some(e => e.type === "speak" && e.agent === "codex"));
    await c.turn(16, "Please delegate coding");
    await c.wait("task_status", undefined, 0, e => e.task_id === "3" && e.status === "needs_input");
    await assert.rejects(readFile(join(temp, "answer.txt")), { code: "ENOENT" });
    const beforeGrant = c.events.length;
    await c.turn(17, "approve task three");
    if (backend === "app-server") {
      await c.wait("task_status", undefined, beforeGrant, e => e.task_id === "3" && e.status === "needs_input");
      c.send({ type: "prompt", turn_id: 18, text: "Give a long reply" }); await c.wait("speak", 18);
      c.send({ type: "cancel", turn_id: 18, playback_elapsed_ms: 100 }); await c.wait("cancelled", 18);
      const waiting = await c.turn(19, "retrieve task 3");
      assert.match(waiting.filter(e => e.type === "text_delta").map(e => e.delta).join(""), /needs_input/);
      await c.turn(20, "approve task three");
    }
    await c.wait("task_status", undefined, 0, e => e.task_id === "3" && e.status === "completed");
    assert.equal(await readFile(join(temp, "answer.txt"), "utf8"), "42\n");
    const coding = await c.turn(21, "Default, retrieve task 3");
    assert.match(coding.filter(e => e.type === "text_delta").map(e => e.delta).join(""), /Created answer.txt/);
    await stop(); c = await start();
    const restored = await c.turn(22, "Deep Think, find database memory");
    assert.match(restored.filter(e => e.type === "text_delta").map(e => e.delta).join(""), /PostgreSQL/);
    const old = await c.turn(23, "retrieve task 1"); assert.match(old.filter(e => e.type === "text_delta").map(e => e.delta).join(""), /PostgreSQL and SQLite/);
    assert.match(logs, /agent_switch/); assert.match(logs, /permission_granted/); assert.match(logs, /notification_delivery/);
  } catch (error) { console.error(logs); throw error; }
  finally { a.resolve(); b.resolve(); await stop(); provider.closeAllConnections(); await new Promise<void>(r => provider.close(() => r())); }
});
