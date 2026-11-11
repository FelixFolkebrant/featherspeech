import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Room } from "./room.js";
import { RoomStore } from "./store.js";
import { codexAppServerRunner } from "./codex-app-server.js";
import type { TaskManager, TaskStatus } from "./tasks.js";

const executable = new URL("../test/fixtures/codex-app-server.cjs", import.meta.url).pathname;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(tasks: TaskManager, id: string, status: TaskStatus, question?: string) {
  for (let i = 0; i < 500; i++) { const t = tasks.get(id); if (t.status === status && (!question || t.question?.includes(question))) return t; await sleep(5); }
  throw new Error(JSON.stringify(tasks.get(id)));
}
async function fixture() {
  const project = await mkdtemp(join(tmpdir(), "vc-app-server-test-"));
  const store = new RoomStore();
  const room = new Room(store, codexAppServerRunner({ executable, project }));
  return { room, store, project, close: async () => { await room.tasks.close(); store.close(); } };
}

test("App Server approvals and structured answers resume the same running task without blocking the room", async () => {
  const f = await fixture();
  try {
    const task = f.room.delegate("default", "codex", "INPUT_FLOW");
    await until(f.room.tasks, task.id, "needs_input", "echo approved");
    f.room.activate("Deep Think, keep talking");
    assert.equal(f.room.active, "deep-think");
    assert.match(f.room.userCommand("approve it")!, /approved/);
    await until(f.room.tasks, task.id, "needs_input", "Which database");
    assert.throws(() => f.room.tasks.grant(task.id, ["full"]), /answer/);
    assert(!f.room.tasks.get(task.id).grants.includes("full"));
    assert.match(f.room.userCommand("answer task one: SQLite")!, /answer was sent/);
    const result = await until(f.room.tasks, task.id, "completed");
    assert.match(result.result!, /User chose SQLite/);
    assert.equal(result.threadId, "fixture-thread");
    assert.equal(await readFile(join(f.project, "answer.txt"), "utf8"), "42\n");
    const audit = (await readFile(join(f.project, "rpc-audit.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert.equal(audit.filter(m => m.method === "turn/start").length, 1);
    assert.equal(audit.find(m => m.id === "approval-1").result.decision, "accept");
    assert.equal(audit.find(m => m.method === "turn/start").params.sandboxPolicy.type, "readOnly");
    assert.match(f.room.userCommand("approve task one")!, /awaiting|pending|request/i);
  } finally { await f.close(); }
});

test("ambiguous approval never chooses a task, and declining does not perform the action", async () => {
  const f = await fixture();
  try {
    const first = f.room.delegate("default", "codex", "change files", "modify");
    const second = f.room.delegate("default", "codex", "other change", "modify");
    await until(f.room.tasks, first.id, "needs_input"); await until(f.room.tasks, second.id, "needs_input");
    assert.match(f.room.userCommand("approve it")!, /Which task/);
    assert.match(f.room.userCommand("approve task one")!, /approved/);
    await until(f.room.tasks, first.id, "needs_input", "echo approved");
    f.room.userCommand("decline task one");
    const result = await until(f.room.tasks, first.id, "completed");
    assert.match(result.result!, /declined/);
    await assert.rejects(readFile(join(f.project, "answer.txt")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("explicit full access selects dangerFullAccess/never; grants never leak to other tasks", async () => {
  const f = await fixture();
  try {
    const task = f.room.delegate("default", "codex", "full access test", "modify");
    await until(f.room.tasks, task.id, "needs_input");
    assert.match(f.room.userCommand("give task one full access")!, /full access/);
    await until(f.room.tasks, task.id, "completed");
    const audit = (await readFile(join(f.project, "rpc-audit.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert.equal(audit.find(m => m.method === "thread/start").params.sandbox, "danger-full-access");
    assert.equal(audit.find(m => m.method === "turn/start").params.sandboxPolicy.type, "dangerFullAccess");
    assert.equal(audit.find(m => m.method === "turn/start").params.approvalPolicy, "never");
    assert.deepEqual(f.room.tasks.get(task.id).grants, []);
    const second = f.room.delegate("codex", "codex", "another modification", "modify", task.id);
    await until(f.room.tasks, second.id, "needs_input");
    assert.equal(f.room.tasks.get(second.id).pendingInput, undefined);
    f.room.userCommand("approve task two");
    await until(f.room.tasks, second.id, "needs_input", "echo approved");
    f.room.userCommand("approve task two"); await until(f.room.tasks, second.id, "completed");
    const resumed = (await readFile(join(f.project, "rpc-audit.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l)).find(m => m.method === "thread/resume");
    assert.equal(resumed.params.threadId, "fixture-thread"); assert.equal(resumed.params.sandbox, "workspace-write");
  } finally { await f.close(); }
});

test("session full access is revocable, cancels work using it and resets with the conversation", async () => {
  const f = await fixture();
  try {
    f.room.userCommand("give Codex full access for this session");
    const task = f.room.delegate("default", "codex", "FOREVER", "modify");
    await until(f.room.tasks, task.id, "running");
    for (let i = 0; i < 200 && !f.room.tasks.get(task.id).threadId; i++) await sleep(5);
    assert.equal(f.room.tasks.get(task.id).access, "full");
    f.room.userCommand("disable Codex full access");
    assert.equal(f.room.tasks.get(task.id).status, "cancelled");
    assert.equal(f.room.codexAccess, "sandboxed");
    f.room.userCommand("give Codex full access"); f.room.reset();
    assert.equal(f.room.codexAccess, "sandboxed");
  } finally { await f.close(); }
});

test("permissions requests are answered with only the requested subset and cancelled requests cannot be approved later", async () => {
  const f = await fixture();
  try {
    const task = f.room.delegate("default", "codex", "PERMISSIONS");
    await until(f.room.tasks, task.id, "needs_input"); f.room.userCommand("approve task one");
    await until(f.room.tasks, task.id, "completed");
    const audit = (await readFile(join(f.project, "rpc-audit.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(audit.find(m => m.id === "approval-1").result, { permissions: { network: { enabled: true } }, scope: "turn" });
    const cancel = f.room.delegate("default", "codex", "CANCEL_FLOW");
    await until(f.room.tasks, cancel.id, "needs_input");
    f.room.tasks.cancel(cancel.id); await sleep(20);
    assert.equal(f.room.tasks.get(cancel.id).status, "cancelled");
    assert.throws(() => f.room.tasks.answer(cancel.id, { decision: "accept" }), /No live request/);
  } finally { await f.close(); }
});

test("cleared requests and failed turns settle without hidden approval prompts or replay", async () => {
  const f = await fixture();
  try {
    const cleared = f.room.delegate("default", "codex", "CLEAR_REQUEST");
    await until(f.room.tasks, cleared.id, "completed");
    assert.equal(f.room.tasks.get(cleared.id).pendingInput, undefined);
    const failed = f.room.delegate("default", "codex", "RPC_FAIL");
    assert.match((await until(f.room.tasks, failed.id, "failed")).error!, /fixture failure/);
  } finally { await f.close(); }
});

test("approving an existing blocked task during a full-access session preserves session scope", async () => {
  const f = await fixture();
  try {
    const task = f.room.delegate("default", "codex", "FOREVER", "modify");
    await until(f.room.tasks, task.id, "needs_input");
    f.room.userCommand("give Codex full access for this session");
    f.room.userCommand("approve task one");
    await until(f.room.tasks, task.id, "running");
    assert.equal(f.room.tasks.get(task.id).access, "full");
    assert(!f.room.tasks.get(task.id).grants.includes("full"));
    f.room.reset();
    assert.equal(f.room.tasks.get(task.id).status, "cancelled");
  } finally { await f.close(); }
});
