import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechChunker } from "./chunker.js";
test("sentence crosses token boundaries and flushes remainder", () => {
  const c = new SpeechChunker(); assert.deepEqual(c.push("Hello", 0), []); assert.deepEqual(c.push(" world. Next", 10), ["Hello world."]); assert.deepEqual(c.flush(), ["Next"]);
});
test("deadline releases a phrase without cutting a word", () => {
  const c = new SpeechChunker(180, 250); c.push("The current time in the office is", 0);
  assert.deepEqual(c.tick(249), []); assert.deepEqual(c.tick(251), ["The current time in the office"]); assert.deepEqual(c.flush(), ["is"]);
});
test("decimal split over deltas stays intact", () => { const c = new SpeechChunker(); c.push("It costs 3.", 0); assert.deepEqual(c.push("14 euros. ", 2), ["It costs 3.14 euros."]); });
test("bounded chunks preserve all words", () => { const c = new SpeechChunker(40); const text = "This is a fairly long sentence without punctuation that should arrive in several parts"; const parts = [...c.push(text), ...c.flush()]; assert.equal(parts.join(" "), text); assert.ok(parts.length > 1); });
