/** Opt-in real CLI/auth/model smoke test. Writes only a new disposable project. */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { codexRunner } from "./codex.js";
import { codexAppServerRunner } from "./codex-app-server.js";
import type { Task } from "./tasks.js";

if (process.env.VC_LIVE_CODEX_TEST !== "1") throw new Error("Set VC_LIVE_CODEX_TEST=1 to opt in to a real model call using your Codex CLI login.");
const project = await mkdtemp(join(tmpdir(), "vc-live-codex-"));
const task: Task = { id: "1", recordId: 0, conversation: "smoke", requester: "default", agent: "codex",
  prompt: "In this empty disposable project, create sum.mjs exporting function sum(a,b) that adds two numbers. Verify it with a Node assertion that sum(2,3) is 5. Report the file created and the actual test result. Keep work bounded to this tiny task.",
  context: [], mode: "modify", grants: [process.env.VC_LIVE_CODEX_FULL_ACCESS === "1" ? "full" : "modify"], status: "running", created: Date.now(), updated: Date.now(), notified: false };
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error("Live Codex smoke-test deadline")), 90000);
try {
  const backend = process.env.VC_CODEX_BACKEND ?? "app-server";
  const result = await (backend === "app-server" ? codexAppServerRunner : codexRunner)({ executable: process.env.VC_CODEX_BIN ?? "codex", project, model: process.env.VC_CODEX_MODEL })(task, controller.signal, event => console.log(JSON.stringify({ event })));
  await readFile(join(project, "sum.mjs"));
  const { sum } = await import(join(project, "sum.mjs"));
  assert.equal(sum(2, 3), 5);
  console.log(JSON.stringify({ status: "passed", backend, project, summary: result.text, thread_id: result.threadId, usage: result.usage }));
} finally { clearTimeout(timer); }
