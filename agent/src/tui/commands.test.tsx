import { test } from "node:test";
import assert from "node:assert/strict";
import { completions, slash } from "./commands.js";
import type { Snapshot } from "../interface.js";

test("completion replaces only the token at the cursor and omits disabled agents", () => {
  const state = {
    profiles: [
      { id: "default", name: "Default", model: "model-a" },
      { id: "deep-think", name: "Deep Think", model: "model-b" },
      { id: "codex", name: "Codex", model: "model-c", enabled: false },
    ],
  } as Snapshot;
  assert.deepEqual(
    completions("@", 1, state).map((c) => c.value),
    ["@default", "@deep-think"],
  );
  assert.equal(
    completions("Please ask @de about this", 14, state)[1]?.value,
    "@deep-think",
  );
  assert.equal(completions("@deep-think tail", 3, state)[1]?.end, 11);
  assert.equal(completions("mail@example", 12, state).length, 0);
  assert.equal(completions("/set", 4, state)[0]?.value, "/settings");
  assert.equal(completions("message /set", 12, state).length, 0);
  assert.deepEqual(slash("/settings", state), {
    action: "navigate",
    view: "settings",
  });
  assert.deepEqual(slash("/history", state), {
    action: "navigate",
    view: "history",
  });
  assert.throws(() => slash("/unknown", state), /Unknown command/);
});
