import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { retainInterruptedReply, toLlmMessages, trimHistory } from "./history.js";

const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
function reply(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text }], stopReason,
    api: "openai-completions", provider: "openrouter", model: "openai/gpt-6-luna", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

test("interrupted playback retains a completed answer and records approximate progress", () => {
  const answer = reply("First sentence. Second sentence that was not heard.");
  const history = retainInterruptedReply([user("Explain"), answer], 0, 1234);
  assert.equal(history[1], answer);
  const wire = toLlmMessages(history);
  assert.match(String(wire[2]!.content), /1.2 seconds.*not word alignment/);
  assert.match(String(wire[2]!.content), /may not have heard all/);
});

test("cancelled generation retains partial prose and completed tools, drops unfinished tool arguments", () => {
  const partial = reply("The result was seven. Next, I was going to", "aborted");
  partial.content.push({ type: "toolCall", id: "pending", name: "current_time", arguments: {} });
  partial.errorMessage = "aborted";
  const toolCall = reply("Checking the time", "toolUse");
  toolCall.content.push({ type: "toolCall", id: "done", name: "current_time", arguments: {} });
  const toolResult: AgentMessage = { role: "toolResult", toolCallId: "done", toolName: "current_time",
    content: [{ type: "text", text: "Seven" }], isError: false, timestamp: 1 };
  const history = retainInterruptedReply([user("Earlier"), reply("Earlier answer"), user("Now"), toolCall, toolResult, partial], 2, null);
  assert.equal(history[3], toolCall);
  assert.equal(history[4], toolResult);
  const kept = history[5] as AssistantMessage;
  assert.deepEqual(kept.content, [{ type: "text", text: "The result was seven. Next, I was going to" }]);
  assert.equal(kept.stopReason, "stop");
  assert.equal(kept.errorMessage, undefined);
  assert.match(String(toLlmMessages(history).at(-1)!.content), /had not been observed to start/);
});

test("interruption notes do not spend history turns or become orphaned when trimming", () => {
  const system: AgentMessage = { role: "system", content: "Voice assistant", timestamp: 1 };
  let history: AgentMessage[] = [system];
  for (const text of ["One", "Two", "Three", "Four"]) {
    const baseline = history.length;
    history = retainInterruptedReply([...history, user(text), reply(`Answer ${text}`)], baseline);
  }
  assert.equal(trimHistory(history, 4).length, history.length);
  const trimmed = trimHistory(history, 2);
  assert.equal(trimmed[0], system);
  assert.deepEqual(trimmed.filter(m => m.role === "user").map(m => m.content), ["Three", "Four"]);
  assert.equal(trimmed.filter(m => m.role === "playback_note").length, 2);
  assert.equal(trimmed.length, 7);
});
