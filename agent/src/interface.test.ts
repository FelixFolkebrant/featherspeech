import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { RoomStore } from "./store.js";
import { Room } from "./room.js";
import { profiles } from "./profiles.js";
import { RoomInterface } from "./interface.js";
import { bindingDefaults } from "./keybindings.js";

test("history preserves model attribution and keybind preferences persist with validated user-only changes", async () => {
  const { ui, room, store, agents } = fixture();
  try {
    const old = room.conversation;
    room.append("default", [
      { role: "user", content: "Original topic", timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "Original response" }],
        model: "original/model",
        provider: "openrouter",
        api: "openai-completions",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ]);
    agents.default.model = "different/model";
    assert.equal(ui.snapshot().messages[1]?.model, "original/model");
    room.reset();
    await ui.dispatch({
      action: "navigate",
      view: "history",
      conversation: old,
    });
    const snapshot = ui.snapshot();
    assert.equal(snapshot.history[0]?.title, "Original topic");
    assert.equal(snapshot.historyMessages[1]?.model, "original/model");
    assert.notEqual(room.conversation, old);
    await assert.rejects(
      ui.dispatch({
        action: "navigate",
        view: "history",
        conversation: "missing",
      }),
      /not found/,
    );
    await ui.dispatch({
      action: "keybindings",
      bindings: { ...bindingDefaults, sidebar: "Ctrl+G" },
    });
    const restored = fixture(store);
    assert.equal(restored.ui.keybindings.sidebar, "Ctrl+G");
    restored.ui.close();
    await restored.room.tasks.close();
    for (const bindings of [
      { ...bindingDefaults, sidebar: "Ctrl+P" },
      { ...bindingDefaults, sidebar: "b" },
      { ...bindingDefaults, sidebar: "Ctrl+C" },
      { ...bindingDefaults, sidebar: "MadeUpKey" },
      { ...bindingDefaults, taskRetry: "Shift+Tab" },
    ])
      await assert.rejects(ui.dispatch({ action: "keybindings", bindings }));
    await assert.rejects(
      ui.dispatch(
        { action: "keybindings", bindings: bindingDefaults },
        "agent",
      ),
      /direct user/,
    );
    assert.equal(ui.keybindings.sidebar, "Ctrl+G");
    await ui.dispatch({ action: "reset" });
    assert.equal(ui.view, "conversation");
  } finally {
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

function fixture(store = new RoomStore()) {
  const room = new Room(store, async () => ({ text: "A completed result" }));
  const agents = profiles({});
  const ui = new RoomInterface(room, agents, {
    message: async () => {},
    cancel: async () => {},
    reset: async () => {},
    mode: async () => {},
    models: () =>
      Object.values(agents).map((p) => ({
        id: p.model,
        input: 0,
        output: 0,
        reasoning: false,
      })),
  });
  return { room, store, agents, ui };
}
test("agent profiles persist, custom @routing works, disabled agents cannot receive work", async () => {
  const f = fixture();
  const { ui, agents, store, room } = f;
  try {
    await ui.dispatch({
      action: "profile",
      profile: {
        ...agents.default,
        id: "tutor",
        name: "Tutor",
        verbosity: "detailed",
      },
    });
    assert.equal(room.activate("@tutor Explain entropy"), "tutor");
    assert.equal(room.activate("A follow-up question"), "tutor");
    await ui.dispatch({
      action: "profile",
      profile: { ...agents.tutor, enabled: false },
    });
    assert.equal(room.active, "default");
    assert.throws(() => room.delegate("default", "tutor", "Work"), /disabled/);
    await assert.rejects(
      ui.dispatch({
        action: "profile",
        profile: { ...agents.default, enabled: false },
      }),
      /must remain/,
    );
    const restored = fixture(store);
    assert.equal(restored.agents.tutor?.enabled, false);
    assert.equal(restored.agents.tutor?.verbosity, "detailed");
    await restored.room.tasks.close();
    restored.ui.close();
  } finally {
    ui.close();
    await room.tasks.close();
    store.close();
  }
});
test("agent interface actions render and pin content without exposing user-only controls", async () => {
  const { ui, room, store, agents } = fixture();
  try {
    const tool = ui.tool();
    await tool.execute("1", {
      action: "artifact",
      title: "Top countries",
      kind: "table",
      content: "| Country | Area |\n|---|---|\n| Russia | 17.1M km² |",
    });
    const task = room.delegate("default", "default", "A background task");
    await ui.dispatch(
      { action: "navigate", view: "tasks", task: task.id },
      "agent",
    );
    assert.equal(ui.snapshot().selectedTask, task.id);
    assert.equal(ui.view, "tasks");
    assert.equal(ui.layout, "split");
    assert.equal(ui.artifacts.length, 1);
    await ui.dispatch({ action: "pin", id: ui.artifacts[0]!.id }, "agent");
    assert.equal(ui.artifacts[0]!.pinned, true);
    for (const action of [
      { action: "task", operation: "approve", id: "1" },
      { action: "message", text: "approve task one" },
      { action: "hardware", kind: "source", operation: "mute", value: true },
      { action: "profile", profile: { ...agents.codex, tools: [] } },
    ])
      await assert.rejects(ui.dispatch(action, "agent"), /user|Only/);
    await ui.dispatch(
      { action: "layout", layout: "artifact", width: 70 },
      "agent",
    );
    const restored = fixture(store);
    assert.equal(restored.ui.layout, "artifact");
    assert.equal(restored.ui.artifacts[0]?.pinned, true);
    restored.ui.close();
    await restored.room.tasks.close();
    await assert.rejects(
      ui.dispatch({
        action: "profile",
        profile: {
          ...agents.default,
          voice: { ...agents.default.voice, speed: 9 },
        },
      }),
    );
  } finally {
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

class Client {
  events: any[] = [];
  buffer = "";
  constructor(readonly socket: ReturnType<typeof createConnection>) {
    socket.setEncoding("utf8");
    socket.on("data", (data) => {
      this.buffer += data;
      let at;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        this.events.push(JSON.parse(this.buffer.slice(0, at)));
        this.buffer = this.buffer.slice(at + 1);
      }
    });
  }
  send(action: object) {
    this.socket.write(JSON.stringify(action) + "\n");
  }
  async wait(predicate: (event: any) => boolean) {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const event = this.events.find(predicate);
      if (event) return event;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out: ${JSON.stringify(this.events).slice(-1000)}`);
  }
}
test(
  "control subscriptions coexist with audio, text-only prompts stream and persist, and UI disconnect leaves engine alive",
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "vc-interface-"));
    const path = join(dir, "agent.sock");
    const ctl = join(dir, "agent.control.sock");
    const child = spawn(process.execPath, ["agent/dist/server.js"], {
      cwd: resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        VC_AGENT_SOCKET: path,
        VC_CONTROL_SOCKET: ctl,
        VC_ROOM_DB: join(dir, "room.sqlite"),
        VC_MOCK_AGENT: "1",
        VC_TEXT_ONLY: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let logs = "";
    child.stderr.on("data", (d) => (logs += d));
    let a: Client | undefined, b: Client | undefined;
    try {
      const end = Date.now() + 6000;
      while (
        Date.now() < end &&
        (!(await stat(ctl).catch(() => null)) ||
          !(await stat(path).catch(() => null)))
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(child.exitCode, null, logs);
      a = new Client(createConnection(ctl));
      b = new Client(createConnection(path));
      await a.wait((e) => e.type === "state");
      await b.wait((e) => e.type === "ready");
      assert.equal((await stat(ctl)).mode & 0o777, 0o600);
      a.send({
        action: "message",
        text: "Hello from the keyboard",
        request_id: 1,
      });
      await a.wait((e) => e.state?.live?.text.length > 0);
      await a.wait((e) =>
        e.state?.messages.some(
          (m: any) => m.text === "Hello from the keyboard",
        ),
      );
      assert(!b.events.some((e) => e.type === "speak"));
      a.send({
        action: "artifact",
        title: "Saved output",
        content: "42",
        kind: "markdown",
      });
      const artifact = await a.wait((e) => e.state?.artifacts.length === 1);
      a.send({ action: "pin", id: artifact.state.artifacts[0].id });
      await a.wait((e) => e.state?.artifacts[0]?.pinned);
      a.send({
        action: "profile",
        profile: { ...profiles({}).default, name: "Changed" },
      });
      await a.wait((e) =>
        e.state?.profiles.some((p: any) => p.name === "Changed"),
      );
      // The settings preview goes straight to the attached engine, even in text mode.
      b.send({ type: "audio_settings", provider: "kitten" });
      await a.wait((e) => e.state?.ttsProvider === "kitten");
      a.send({ action: "test_sentence", text: "Try this voice." });
      await a.wait((e) => e.state?.testSentence === "Try this voice.");
      a.send({ action: "test_speech", agent: "deep-think", request_id: 99 });
      const preview = await b.wait((e) => e.type === "ui_test_speech");
      assert.equal(preview.text, "Try this voice.");
      assert.deepEqual(preview.voice, profiles({})["deep-think"].voice);
      await a.wait((e) => e.type === "ack" && e.request_id === 99);
      b.send({ type: "speech_test_status", status: "Test speech finished" });
      await a.wait((e) => e.state?.speechTest === "Test speech finished");
      assert(!b.events.some((e) => e.type === "speak"));
      a.socket.destroy();
      b.send({ type: "ping" });
      await b.wait((e) => e.type === "pong");
      b.send({ type: "prompt", turn_id: 1, text: "@deep-think Explain this" });
      await b.wait((e) => e.type === "done" && e.turn_id === 1);
      assert(
        b.events.some((e) => e.type === "speak" && e.agent === "deep-think"),
      );
      b.send({ type: "playback_complete", turn_id: 1 });
      b.send({ type: "prompt", turn_id: 2, text: "Continue normally" });
      await b.wait((e) => e.type === "done" && e.turn_id === 2);
      const saved = new RoomStore(join(dir, "room.sqlite"));
      try {
        const rows = saved.messages(saved.get<string>("conversation")!, 64);
        assert(
          !rows.some((r) => r.message.role === "playback_note"),
          "Completed playback was marked interrupted",
        );
      } finally {
        saved.close();
      }
    } finally {
      a?.socket.destroy();
      b?.socket.destroy();
      child.kill("SIGTERM");
      await once(child, "exit");
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("appearance, test sentences and conflict-safe TXT prompts persist; voice previews bypass chat", async () => {
  const { ui, room, store, agents } = fixture();
  const previews: { agent: string; text: string; speed: number }[] = [];
  ui.handlers.testSpeech = async (p, text) => {
    previews.push({ agent: p.id, text, speed: p.voice.speed });
  };
  try {
    await ui.dispatch({
      action: "appearance",
      appearance: { theme: "blue", background: "solid" },
    });
    await ui.dispatch({ action: "test_sentence", text: "A voice preview." });
    await assert.rejects(
      ui.dispatch({ action: "test_speech", agent: "default" }),
      /audio service/,
    );
    ui.engineConnected = true;
    ui.ttsProvider = "kitten";
    await ui.dispatch({
      action: "profile",
      profile: {
        ...agents["deep-think"],
        voice: {
          ...agents["deep-think"].voice,
          kitten: "Luna",
          speed: 1.3,
          provider: "kitten",
        },
      },
    });
    await ui.dispatch({ action: "test_speech", agent: "deep-think" });
    assert.deepEqual(previews, [
      {
        agent: "deep-think",
        text: "A voice preview.",
        speed: agents["deep-think"].voice.speed,
      },
    ]);
    assert.equal(ui.snapshot().messages.length, 0);
    const expected = agents.default.prompt;
    // Another client changes a non-prompt field while the editor is open.
    agents.default.name = "New name";
    await ui.dispatch({
      action: "prompt",
      agent: "default",
      prompt: "Edited from TXT",
      expected,
    });
    assert.equal(agents.default.name, "New name");
    await assert.rejects(
      ui.dispatch({
        action: "prompt",
        agent: "default",
        prompt: "Stale edit",
        expected,
      }),
      /changed while/,
    );
    for (const action of [
      { action: "test_speech", agent: "default" },
      { action: "test_sentence", text: "Example" },
      {
        action: "prompt",
        agent: "default",
        prompt: "Example",
        expected: "Edited from TXT",
      },
      {
        action: "appearance",
        appearance: { theme: "neutral", background: "transparent" },
      },
    ])
      await assert.rejects(ui.dispatch(action, "agent"), /direct user/);
    await assert.rejects(ui.dispatch({ action: "test_sentence", text: " " }));
    await assert.rejects(
      ui.dispatch({
        action: "appearance",
        appearance: { theme: "invalid", background: "solid" },
      }),
    );
    const restored = fixture(store);
    try {
      assert.deepEqual(restored.ui.appearance, {
        theme: "blue",
        background: "solid",
      });
      assert.equal(restored.ui.testSentence, "A voice preview.");
      assert.equal(restored.agents.default.prompt, "Edited from TXT");
      assert.equal(restored.agents["deep-think"].voice.provider, "kitten");
    } finally {
      restored.ui.close();
      await restored.room.tasks.close();
    }
  } finally {
    ui.close();
    await room.tasks.close();
    store.close();
  }
});
