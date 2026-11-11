import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { RoomStore } from "./store.js";
import { Room } from "./room.js";
import { route, profiles } from "./profiles.js";
import { roomTools } from "./room-tools.js";
import { codexRunner } from "./codex.js";
import { NeedsInput, TaskManager, type TaskRunner } from "./tasks.js";

function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(r => setImmediate(r));
const done = async (manager: TaskManager, id: string) => { while (["queued", "running"].includes(manager.get(id).status)) await once(manager, "changed"); return manager.get(id); };
const request = { conversation: "conversation", requester: "default" as const, agent: "deep-think" as const, prompt: "Evaluate PostgreSQL", context: [], mode: "read" as const };

test("routing is sticky, explicit switching is immediate, guests return focus, and mentions don't route", () => {
  assert.deepEqual(route("Deep Think, explain that", "default"), { agent: "deep-think", guest: false });
  assert.equal(route("What about latency?", "deep-think").agent, "deep-think");
  assert.equal(route("Could you ask Codex about this?", "deep-think").agent, "deep-think");
  assert.equal(route("Codex is useful", "default").agent, "default");
  assert.deepEqual(route("Let me hear from Codex", "deep-think"), { agent: "codex", guest: true });
  assert.deepEqual(route("Let me hear what Coding has to say", "deep-think"), { agent: "codex", guest: true });
  assert.equal(route("Codex.", "default").agent, "codex");
  assert.equal(route("Back to Default", "codex").agent, "default");
  assert.equal(route("No thanks, that was it", "codex").agent, "default");
  const p = profiles({});
  assert.equal(p["deep-think"].model, "openai/gpt-6.1-terra");
  assert.equal(p["deep-think"].reasoning, "high");
  assert.equal(p.codex.model, "openai/gpt-6-luna");
  assert.equal(p.codex.reasoning, "none");
  assert.equal(new Set(Object.values(p).map(a => a.voice.pocket)).size, 3);
});

test("persistent room shares attributed context, specialized memory and prior conversations across agents", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vc-room-store-")); const path = join(temp, "room.sqlite");
  let store = new RoomStore(path);
  let room = new Room(store, async () => ({ text: "unused" }));
  room.append("default", [{ role: "user", content: "We chose PostgreSQL for the database", timestamp: 1 }]);
  room.activate("Codex, what did we choose?");
  assert.match(JSON.stringify(room.context("codex")), /PostgreSQL/);
  const remember = roomTools(room, "codex").find(t => t.name === "remember")!;
  await remember.execute("1", { text: "Prefer SQLite for small local caches" });
  room.reset();
  const search = roomTools(room, "deep-think").find(t => t.name === "search_memory")!;
  const found = await search.execute("2", { query: "SQLite", agent: "codex", kind: "memory" });
  assert.match(JSON.stringify(found.content), /local caches/);
  assert.equal(room.context("default").length, 0);
  assert.match(JSON.stringify(store.search("PostgreSQL")), /database/);
  room.activate("Deep Think, hello");
  await room.tasks.close(); store.close();
  store = new RoomStore(path); room = new Room(store, async () => ({ text: "unused" }));
  assert.equal(room.active, "deep-think");
  assert.match(JSON.stringify(store.search("SQLite")), /local caches/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await room.tasks.close(); store.close();
});

test("consultation returns immediately, respects concurrency, and all agents can retrieve the result", async () => {
  const finish = deferred<{ text: string }>(); let starts = 0;
  const store = new RoomStore();
  const room = new Room(store, async (_t, signal) => { starts++; signal.throwIfAborted(); return finish.promise; }, 64, () => {}, { concurrency: 1, pending: 2 });
  const consult = roomTools(room, "default").find(t => t.name === "consult_agent")!;
  await consult.execute("1", { agent: "deep-think", instruction: "Evaluate databases" });
  const second = room.delegate("default", "deep-think", "Compare alternatives");
  await tick(); assert.equal(starts, 1); assert.equal(second.status, "queued");
  assert.throws(() => room.delegate("default", "deep-think", "One too many"), /limit/);
  room.activate("Codex, continue talking");
  assert.equal(room.active, "codex");
  assert.equal(room.tasks.get("1").status, "running");
  assert.equal(room.notificationBatch().ids.length, 0);
  finish.resolve({ text: "PostgreSQL is the best fit" });
  await done(room.tasks, "2");
  const tools = roomTools(room, "codex");
  const result = await tools.find(t => t.name === "tasks")!.execute("2", { action: "get", id: "1" });
  assert.match(JSON.stringify(result.content), /PostgreSQL is the best fit/);
  assert.deepEqual(room.notificationBatch().ids, ["1", "2"]);
  room.tasks.acknowledge(["1", "2"]); assert.equal(room.notificationBatch().ids.length, 0);
  assert(!roomTools(room, "deep-think", true).some(t => t.name === "consult_agent"));
  await room.tasks.close(); store.close();
});

test("task cancellation is explicit, deadlines release slots, and blocked work needs input", async () => {
  const store = new RoomStore();
  const runner: TaskRunner = async (task, signal) => {
    if (task.prompt === "blocked") throw new NeedsInput("Which project?");
    await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return { text: "unreachable" };
  };
  const manager = new TaskManager(store, runner, 1, 4, 30);
  const blocked = manager.submit({ ...request, prompt: "blocked" });
  assert.equal((await done(manager, blocked.id)).status, "needs_input");
  const cancel = manager.submit(request); await tick(); manager.cancel(cancel.id); await tick();
  assert.equal(manager.get(cancel.id).status, "cancelled");
  const timeout = manager.submit(request);
  assert.equal((await done(manager, timeout.id)).status, "failed");
  assert.match(manager.get(timeout.id).error!, /deadline/);
  await manager.close(); store.close();
});

test("Codex subprocess uses JSONL, task-scoped write grants, exact thread resumes and process cancellation", async () => {
  const temp = await mkdtemp(join(tmpdir(), "vc-codex-fixture-"));
  const executable = join(temp, "codex-fixture");
  await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);let input='';
process.stdin.on('data',d=>input+=d);
process.stdin.on('end',()=>{
 fs.writeFileSync('args.json',JSON.stringify(args));
 if(input.includes('WAIT_FOREVER')) {setInterval(()=>{},100);return;}
 if(args.includes('sandbox_mode="workspace-write"')) fs.writeFileSync('answer.txt','42\\n');
 console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
 console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Wrote answer.txt; test result: 42.'}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
});\n`);
  await chmod(executable, 0o700);
  await assert.rejects(codexRunner({ executable, project: temp, allowExecute: false })({ ...request, id: "0", recordId: 0, agent: "codex", grants: [], status: "queued", created: 1, updated: 1, notified: false }, new AbortController().signal, () => {}), /permission to execute/);
  const store = new RoomStore(); const runner = codexRunner({ executable, project: temp });
  const room = new Room(store, runner);
  const task = room.delegate("default", "codex", "Create answer.txt", "modify");
  assert.equal((await done(room.tasks, task.id)).status, "needs_input");
  await assert.rejects(readFile(join(temp, "answer.txt")), { code: "ENOENT" });
  assert(!roomTools(room, "codex").some(t => /permit|grant/.test(t.name)));
  assert.match(room.userCommand(`allow task ${task.id} to modify files`)!, /approved/);
  const completed = await done(room.tasks, task.id);
  assert.equal(completed.status, "completed", completed.error ?? completed.question);
  assert.equal(await readFile(join(temp, "answer.txt"), "utf8"), "42\n");
  const args: string[] = JSON.parse(await readFile(join(temp, "args.json"), "utf8"));
  assert(args.includes('sandbox_mode="workspace-write"')); assert(args.includes('approval_policy="never"'));
  assert(!args.some(a => a.includes("danger") || a === "--last"));
  const continuation = room.delegate("deep-think", "codex", "Read answer", "read", task.id);
  assert.equal((await done(room.tasks, continuation.id)).status, "completed");
  const resume: string[] = JSON.parse(await readFile(join(temp, "args.json"), "utf8"));
  assert.equal(resume[resume.indexOf("resume") + 1], "fixture-thread");
  assert(resume.includes('sandbox_mode="read-only"'));
  const waiter = room.delegate("default", "codex", "WAIT_FOREVER");
  await tick(); room.tasks.cancel(waiter.id); await room.tasks.close();
  assert.equal(room.tasks.get(waiter.id).status, "cancelled");
  store.close();
});

test("restart never replays unfinished tasks or persists permission grants", async () => {
  const store = new RoomStore();
  const saved = { ...request, id: "1", recordId: 1, grants: ["modify"], status: "running", created: 1, updated: 1, notified: true };
  store.add(request.conversation, request.agent, "task", saved, "unfinished");
  store.add(request.conversation, "codex", "task", { ...saved, id: "2", recordId: 2, agent: "codex", status: "needs_input", access: "full", pendingInput: { kind: "approval", question: "Run command?" } }, "pending approval");
  let starts = 0; const tasks = new TaskManager(store, async () => { starts++; return { text: "wrong" }; });
  await tick(); assert.equal(starts, 0); assert.equal(tasks.get("1").status, "needs_input");
  assert.deepEqual(tasks.get("1").grants, []);
  assert.equal(tasks.get("2").pendingInput, undefined);
  assert.equal(tasks.get("2").access, "sandboxed");
  assert.deepEqual(tasks.get("2").grants, []);
  assert.match(tasks.get("2").question!, /process stopped/);
  await tasks.close(); store.close();
});
