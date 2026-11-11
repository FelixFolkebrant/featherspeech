import { test } from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RoomStore } from "../store.js";
import { Room } from "../room.js";
import { profiles } from "../profiles.js";
import { RoomInterface, type Snapshot, type Action } from "../interface.js";
import { RoomClient } from "./client.js";
import { App } from "./app.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindingDefaults } from "../keybindings.js";

function fixture() {
  const store = new RoomStore();
  const room = new Room(store, async () => ({ text: "Done" }));
  const ui = new RoomInterface(room, profiles({}), {
    message: async () => {},
    cancel: async () => {},
    reset: async () => {},
    mode: async () => {},
    models: () => [
      { id: "openai/gpt-6-luna", input: 0.2, output: 1, reasoning: false },
    ],
  });
  return { ui, room, store };
}
class FakeClient extends RoomClient {
  actions: Action[] = [];
  state: ReturnType<RoomClient["getSnapshot"]>;
  notify = new Set<() => void>();
  constructor(state: Snapshot) {
    super("");
    this.state = { connected: true, snapshot: state };
  }
  override getSnapshot = () => this.state;
  override subscribe = (fn: () => void) => {
    this.notify.add(fn);
    return () => {
      this.notify.delete(fn);
    };
  };
  override send(action: Action) {
    this.actions.push(action);
    return true;
  }
  publish(snapshot: Snapshot) {
    this.state = { connected: true, snapshot };
    this.notify.forEach((fn) => fn());
  }
}

test("room layout renders and composer submits, preserves newlines and steers without duplicate sends", async () => {
  const { ui, room, store } = fixture();
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 140,
    height: 42,
    kittyKeyboard: true,
  });
  try {
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /● Conversation/);
    assert.match(setup.captureCharFrame(), /History/);
    assert.doesNotMatch(
      setup.captureCharFrame(),
      /YOURROOM|Default|Deep Think|local audio|ready when you are|Shift\+Enter|made clear/,
    );
    await act(async () => {
      await setup.mockInput.typeText("Hello room");
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "message",
      text: "Hello room",
    });
    await act(async () => {
      await setup.mockInput.typeText("first");
      setup.mockInput.pressEnter({ shift: true });
      await setup.mockInput.typeText("second");
      setup.mockInput.pressEnter({ ctrl: true });
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "message",
      text: "first\nsecond",
      steer: true,
    });
    assert.equal(client.actions.length, 2);
    await writeFile("/tmp/vc-tui-empty.txt", setup.captureCharFrame());
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("command palette filters and selects a backend action", async () => {
  const { ui, room, store } = fixture();
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 120,
    height: 38,
    kittyKeyboard: true,
  });
  try {
    await act(async () => {
      setup.mockInput.pressKey("p", { ctrl: true });
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Command palette/);
    await act(async () => {
      await setup.mockInput.typeText("hardware");
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "navigate",
      view: "hardware",
    });
    await act(async () => {
      ui.view = "agents";
      client.publish(ui.snapshot());
      setup.mockInput.pressTab();
    });
    // Focus is content after navigating; move sidebar → content as needed via direct settings shortcut.
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Settings \/ Default/);
    assert.doesNotMatch(
      setup.captureCharFrame(),
      /Message…|Changes save|Different minds/,
    );
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("agent settings preserve values, save edited prompts and create a named custom profile", async () => {
  const { ui, room, store } = fixture();
  ui.view = "agents";
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 120,
    height: 38,
    kittyKeyboard: true,
  });
  try {
    await act(async () => {
      setup.mockInput.pressTab();
    });
    await act(async () => {
      setup.mockInput.pressTab();
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Agent name/);
    assert.match(setup.captureCharFrame(), /Default/);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    const saved = client.actions.at(-1);
    assert.equal(saved?.action, "profile");
    if (saved?.action === "profile")
      assert.equal(saved.profile.name, "Default");
    await act(async () => {
      setup.mockInput.pressKey("p", { ctrl: true });
    });
    await act(async () => {
      await setup.mockInput.typeText("Add a new agent");
      setup.mockInput.pressEnter();
    });
    await act(async () => {
      await setup.mockInput.typeText("Tutor");
      setup.mockInput.pressEnter();
    });
    const profile = client.actions.find(
      (a) => a.action === "profile" && a.profile.id === "tutor",
    );
    assert.equal(profile?.action, "profile");
    if (profile?.action === "profile") {
      assert.equal(profile.profile.name, "Tutor");
      assert.match(profile.profile.prompt, /You are Tutor:/);
    }
    assert.deepEqual(client.actions.at(-1), {
      action: "navigate",
      view: "agents",
      agent: "tutor",
    });
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("populated split view renders rich artifacts, task state, and narrow terminal layouts", async () => {
  const { ui, room, store } = fixture();
  room.append("default", [
    {
      role: "user",
      content: "Show me how the room fits together.",
      timestamp: Date.now(),
    },
  ]);
  await ui.dispatch({
    action: "artifact",
    title: "The room, at a glance",
    content:
      "## Three voices. One conversation.\n\n| Agent | Focus |\n|---|---|\n| Default | Everyday conversation |\n| Deep Think | Research and reasoning |\n| Codex | Building and debugging |\n\nYour audio stays local. Background work keeps moving.",
  });
  ui.live = {
    id: 1,
    agent: "default",
    model: ui.profiles.default!.model,
    text: "We share the conversation, and each agent brings a different perspective. The details are on your screen.",
    status: "streaming",
    started: Date.now(),
    firstTokenMs: 320,
  };
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 140,
    height: 42,
  });
  try {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    await setup.waitForFrame(
      (frame) => frame.includes("Your audio stays local"),
      { maxPasses: 50 },
    );
    const frame = setup.captureCharFrame();
    assert.match(frame, /The room, at a glance/);
    assert.match(frame, /Your audio stays local/);
    await writeFile("/tmp/vc-tui-populated.txt", frame);
    await writeFile(
      "/tmp/vc-tui-spans.json",
      JSON.stringify(setup.captureSpans()),
    );
    await act(async () => {
      setup.resize(70, 26);
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Show me how/);
    await writeFile("/tmp/vc-tui-narrow.txt", setup.captureCharFrame());
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("composer completes mentions and commands without submitting or losing the draft", async () => {
  const { ui, room, store } = fixture();
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 120,
    height: 36,
    kittyKeyboard: true,
  });
  try {
    await act(async () => {
      await setup.mockInput.typeText("@de");
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /@default/);
    assert.match(setup.captureCharFrame(), /@deep-think/);
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressTab();
    });
    assert.equal(client.actions.length, 0);
    await act(async () => {
      await setup.mockInput.typeText("Explain this");
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "message",
      text: "@deep-think Explain this",
    });
    await act(async () => {
      await setup.mockInput.typeText("/har");
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /\/hardware/);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.equal(client.actions.length, 1, "first Enter accepts completion");
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "navigate",
      view: "hardware",
    });
    await act(async () => {
      ui.view = "hardware";
      client.publish(ui.snapshot());
    });
    await act(async () => {
      ui.view = "conversation";
      client.publish(ui.snapshot());
    });
    await act(async () => {
      await setup.mockInput.typeText("Keep this draft");
    });
    await act(async () => {
      ui.view = "settings";
      client.publish(ui.snapshot());
    });
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /Keep this draft|Message…/);
    await act(async () => {
      ui.view = "conversation";
      client.publish(ui.snapshot());
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Keep this draft/);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "message",
      text: "Keep this draft",
    });
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("settings replaces navigation with Back and a folding agent list, and menu toggles at narrow widths", async () => {
  const { ui, room, store } = fixture();
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 120,
    height: 36,
    kittyKeyboard: true,
  });
  try {
    await act(async () => {
      setup.mockInput.pressTab();
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "navigate",
      view: "settings",
    });
    await act(async () => {
      ui.view = "settings";
      client.publish(ui.snapshot());
    });
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    assert.match(frame, /Back/);
    assert.match(frame, /Agents ▸/);
    assert.match(frame, /Hardware/);
    assert.match(frame, /Keybinds/);
    await writeFile(
      "/tmp/vc-tui-settings-spans.json",
      JSON.stringify(setup.captureSpans()),
    );
    assert.doesNotMatch(
      frame,
      /Message…|Deep Think|Agent settings|Models & usage|Diagnostics/,
    );
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Deep Think/);
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "navigate",
      view: "agents",
      agent: "default",
    });
    await act(async () => {
      ui.hardware = {
        available: true,
        source: "mic",
        sink: "speakers",
        input: 100,
        output: 60,
        muted: false,
        sources: [{ name: "mic", description: "Microphone" }],
        sinks: [{ name: "speakers", description: "Speakers" }],
      };
      ui.view = "hardware";
      client.publish(ui.snapshot());
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /● Hardware/);
    assert.match(setup.captureCharFrame(), /Input gain  100%/);
    await writeFile(
      "/tmp/vc-tui-hardware-spans.json",
      JSON.stringify(setup.captureSpans()),
    );
    assert.doesNotMatch(
      setup.captureCharFrame(),
      /Message…|Set microphone|Voice uses|built-in cues/,
    );
    await act(async () => {
      ui.view = "conversation";
      client.publish(ui.snapshot());
      setup.resize(70, 26);
    });
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /History/);
    await act(async () => {
      setup.mockInput.pressKey("b", { ctrl: true });
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /History/);
    await act(async () => {
      setup.mockInput.pressKey("b", { ctrl: true });
    });
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /History/);
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("keybind editor saves changes and the new send binding takes effect", async () => {
  const { ui, room, store } = fixture();
  ui.view = "keybinds";
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 120,
    height: 38,
    kittyKeyboard: true,
  });
  try {
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Send message  Enter/);
    await writeFile(
      "/tmp/vc-tui-keybinds-spans.json",
      JSON.stringify(setup.captureSpans()),
    );
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await act(async () => {
      for (let i = 0; i < 5; i++) setup.mockInput.pressBackspace();
      await setup.mockInput.typeText("F2");
      setup.mockInput.pressEnter();
    });
    const saved = client.actions.at(-1);
    assert.equal(saved?.action, "keybindings");
    if (saved?.action !== "keybindings") return;
    assert.equal(saved.bindings.send, "F2");
    await ui.dispatch(saved);
    await act(async () => {
      ui.view = "conversation";
      client.publish(ui.snapshot());
    });
    await act(async () => {
      await setup.mockInput.typeText("Remapped send");
      setup.mockInput.pressKey("F2");
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "message",
      text: "Remapped send",
    });
    await act(async () => {
      client.publish({
        ...ui.snapshot(),
        keybindings: { ...bindingDefaults, sidebar: "Ctrl+G" },
      });
    });
    await act(async () => {
      setup.mockInput.pressKey("g", { ctrl: true });
    });
    await setup.renderOnce();
    assert.doesNotMatch(setup.captureCharFrame(), /History/);
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("history opens saved messages with original model labels and no composer", async () => {
  const { ui, room, store } = fixture();
  const old = room.conversation;
  room.append("default", [
    { role: "user", content: "An earlier conversation", timestamp: Date.now() },
  ]);
  room.reset();
  ui.view = "history";
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 120,
    height: 36,
  });
  try {
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /An earlier conversation/);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "navigate",
      view: "history",
      conversation: old,
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /An earlier conversation/);
    assert.doesNotMatch(setup.captureCharFrame(), /Message…/);
    assert.notEqual(room.conversation, old);
    await act(async () => {
      ui.view = "conversation";
      client.publish({
        ...ui.snapshot(),
        messages: [
          {
            id: 10,
            agent: "default",
            role: "assistant",
            text: "Original reply",
            timestamp: Date.now(),
            model: "original-model",
          },
        ],
        live: {
          id: 11,
          agent: "deep-think",
          model: "live-model",
          text: "Streaming reply",
          status: "streaming",
          started: Date.now(),
        },
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    await setup.waitForFrame((frame) => frame.includes("Original reply"));
    const frame = setup.captureCharFrame();
    assert.match(frame, /Default · original-model/);
    assert.match(frame, /Deep Think · live-model/);
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("agent settings show prompt beside controls, contextual previews and external prompt editing", async () => {
  const { ui, room, store } = fixture();
  ui.view = "agents";
  ui.settingsAgent = "deep-think";
  ui.appearance = { theme: "blue", background: "solid" };
  ui.engineConnected = true;
  ui.ttsProvider = "kitten";
  const client = new FakeClient(ui.snapshot());
  const edited: string[] = [];
  const setup = await testRender(
    <App
      client={client}
      onQuit={() => {}}
      onEditPrompt={async (p) => {
        edited.push(p.id);
        return "A new TXT prompt";
      }}
    />,
    { width: 150, height: 44, kittyKeyboard: true },
  );
  try {
    await setup.renderOnce();
    let frame = setup.captureCharFrame();
    assert.match(frame, /Voice provider/);
    assert.match(frame, /Kitten/);
    assert.match(frame, /Speak naturally in plain text/);
    assert.match(frame, /Ctrl\+O prompt TXT/);
    assert.match(frame, /Ctrl\+T test speech/);
    await writeFile("/tmp/vc-tui-agent-settings.txt", frame);
    await writeFile(
      "/tmp/vc-tui-agent-settings-spans.json",
      JSON.stringify(setup.captureSpans()),
    );
    for (let i = 0; i < 9; i++) {
      await act(async () => {
        setup.mockInput.pressArrow("down");
      });
    }
    await act(async () => {
      setup.mockInput.pressArrow("right");
    });
    const speedChange = client.actions.at(-1);
    assert.equal(speedChange?.action, "profile");
    if (speedChange?.action === "profile")
      assert.equal(speedChange.profile.voice.speed, 0.97);
    await act(async () => {
      setup.mockInput.pressKey("t", { ctrl: true });
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "test_speech",
      agent: "deep-think",
    });
    await act(async () => {
      setup.mockInput.pressKey("l", { ctrl: true });
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Test speech sentence/);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "test_sentence",
      text: ui.testSentence,
    });
    await act(async () => {
      setup.mockInput.pressKey("o", { ctrl: true });
    });
    assert.deepEqual(edited, ["deep-think"]);
    assert.deepEqual(client.actions.at(-1), {
      action: "prompt",
      agent: "deep-think",
      prompt: "A new TXT prompt",
      expected: ui.profiles["deep-think"]!.prompt,
    });
    await act(async () => {
      ui.ttsProvider = "pocket";
      client.publish(ui.snapshot());
    });
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    assert.match(frame, /Pocket voice/);
    assert.doesNotMatch(frame, /Speech speed/);
    await act(async () => {
      await setup.resize(65, 24);
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /test speech/);
    assert.match(setup.captureCharFrame(), /Pocket voice/);
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test("UI menu applies blue solid colors then restores terminal transparency", async () => {
  const { ui, room, store } = fixture();
  ui.view = "appearance";
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 120,
    height: 36,
    kittyKeyboard: true,
  });
  const background = () =>
    Array.from(setup.captureSpans().lines[0]!.spans[0]!.bg.buffer).slice(0, 3);
  try {
    await setup.renderOnce();
    const transparent = background();
    assert.match(setup.captureCharFrame(), /Settings \/ UI/);
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Classic blue/);
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    assert.deepEqual(client.actions.at(-1), {
      action: "appearance",
      appearance: { theme: "blue", background: "transparent" },
    });
    await act(async () => {
      ui.appearance = { theme: "blue", background: "solid" };
      client.publish(ui.snapshot());
    });
    await setup.renderOnce();
    assert.deepEqual(background(), [11, 16, 23]);
    await act(async () => {
      ui.appearance.background = "transparent";
      client.publish(ui.snapshot());
    });
    await setup.renderOnce();
    assert.deepEqual(background(), transparent);
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});

test(
  "a pre-redesign backend renders agent settings safely and upgrades without reconnecting",
  { timeout: 10000 },
  async () => {
    const { ui, room, store } = fixture();
    ui.view = "agents";
    const legacy = structuredClone(ui.snapshot());
    for (const key of [
      "appearance",
      "testSentence",
      "speechTest",
      "ttsProvider",
    ])
      Reflect.deleteProperty(legacy, key);
    Reflect.deleteProperty(legacy.keybindings, "promptFile");
    legacy.keybindings.sidebar = "Ctrl+G";
    const dir = await mkdtemp(join(tmpdir(), "vc-legacy-tui-"));
    const path = join(dir, "control.sock");
    let peer: Socket | undefined;
    const received: Action[] = [];
    const server = createServer((socket) => {
      peer = socket;
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (data) => {
        buffer += data;
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          received.push(JSON.parse(buffer.slice(0, end)));
          buffer = buffer.slice(end + 1);
        }
      });
      socket.write(JSON.stringify({ type: "state", state: legacy }) + "\n");
    });
    const client = new RoomClient(path);
    const waitFor = (predicate: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        if (predicate()) return resolve();
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error("Timed out waiting for client state"));
        }, 2000);
        const unsubscribe = client.subscribe(() => {
          if (predicate()) {
            clearTimeout(timer);
            unsubscribe();
            resolve();
          }
        });
      });
    let setup: Awaited<ReturnType<typeof testRender>> | undefined;
    let editorCalls = 0;
    try {
      server.listen(path);
      await once(server, "listening");
      client.connect();
      await waitFor(() => !!client.getSnapshot().snapshot);
      assert.equal(client.getSnapshot().settingsSupported, false);
      assert.equal(
        client.getSnapshot().snapshot?.keybindings.sidebar,
        "Ctrl+G",
      );
      assert.equal(
        client.getSnapshot().snapshot?.keybindings.promptFile,
        "Ctrl+O",
      );
      assert.equal(Object.hasOwn(legacy, "testSentence"), false);
      setup = await testRender(
        <App
          client={client}
          onQuit={() => {}}
          onEditPrompt={async () => {
            editorCalls++;
            return "Draft";
          }}
        />,
        { width: 120, height: 38, kittyKeyboard: true },
      );
      await setup.renderOnce();
      assert.match(setup.captureCharFrame(), /Ctrl\+O prompt TXT/);
      assert.doesNotMatch(setup.captureCharFrame(), /undefined/);
      await act(async () => {
        setup!.mockInput.pressKey("o", { ctrl: true });
      });
      await setup.renderOnce();
      assert.equal(editorCalls, 0);
      assert.match(setup.captureCharFrame(), /running room backend predates/);
      await act(async () => {
        setup!.mockInput.pressKey("t", { ctrl: true });
      });
      assert.equal(received.length, 0);
      assert.match(client.getSnapshot().error!, /Restart the voice assistant service/);
      // A restarted/upgraded backend can send a new snapshot on the same connection.
      await act(async () => {
        peer!.write(
          JSON.stringify({ type: "state", state: ui.snapshot() }) + "\n",
        );
        await waitFor(() => client.getSnapshot().settingsSupported === true);
      });
      await act(async () => {
        setup!.mockInput.pressKey("t", { ctrl: true });
      });
      // Let the socket write reach the fixture before asserting.
      if (!received.length) await once(peer!, "data");
      assert.equal(received.at(-1)?.action, "test_speech");
    } finally {
      if (setup)
        await act(async () => {
          await setup!.dispose();
        });
      client.close();
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ui.close();
      await room.tasks.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("provider selection shows matching voice controls and Delete resets the selected voice field", async () => {
  const { ui, room, store } = fixture();
  ui.view = "agents";
  ui.settingsAgent = "deep-think";
  ui.ttsProvider = "pocket";
  const client = new FakeClient(ui.snapshot());
  const setup = await testRender(<App client={client} onQuit={() => {}} />, {
    width: 135,
    height: 42,
    kittyKeyboard: true,
  });
  try {
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Pocket voice/);
    assert.doesNotMatch(setup.captureCharFrame(), /Speech speed/);
    for (let i = 0; i < 7; i++)
      await act(async () => {
        setup.mockInput.pressArrow("down");
      });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Voice provider/);
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressEnter();
    });
    const providerChange = client.actions.at(-1);
    assert.equal(providerChange?.action, "profile");
    if (providerChange?.action === "profile") {
      assert.equal(providerChange.profile.voice.provider, "kitten");
      await act(async () => {
        ui.profiles["deep-think"] = providerChange.profile;
        client.publish(ui.snapshot());
      });
    }
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Kitten voice/);
    assert.match(setup.captureCharFrame(), /Speech speed/);
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressKey("DELETE");
    });
    const voiceReset = client.actions.at(-1);
    assert.equal(voiceReset?.action, "profile");
    if (voiceReset?.action === "profile")
      assert.equal(voiceReset.profile.voice.kitten, "default");
    await act(async () => {
      setup.mockInput.pressArrow("down");
    });
    await act(async () => {
      setup.mockInput.pressKey("DELETE");
    });
    const speedReset = client.actions.at(-1);
    assert.equal(speedReset?.action, "profile");
    if (speedReset?.action === "profile")
      assert.equal(speedReset.profile.voice.speed, 1);
    await act(async () => {
      setup.mockInput.pressArrow("up");
    });
    await act(async () => {
      setup.mockInput.pressArrow("up");
    });
    await act(async () => {
      setup.mockInput.pressKey("DELETE");
    });
    const providerReset = client.actions.at(-1);
    assert.equal(providerReset?.action, "profile");
    if (providerReset?.action === "profile") {
      assert.equal(providerReset.profile.voice.provider, undefined);
      await act(async () => {
        ui.profiles["deep-think"] = providerReset.profile;
        client.publish(ui.snapshot());
      });
    }
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), /Pocket voice/);
    assert.doesNotMatch(setup.captureCharFrame(), /Speech speed/);
  } finally {
    await act(async () => {
      await setup.dispose();
    });
    ui.close();
    await room.tasks.close();
    store.close();
  }
});
