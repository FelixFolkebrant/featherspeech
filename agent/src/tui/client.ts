import { createConnection, type Socket } from "node:net";
import type { Action, Snapshot } from "../interface.js";
import { defaultAppearance, defaultTestSpeech } from "../appearance.js";
import { bindingDefaults } from "../keybindings.js";

export const settingsUpgradeMessage =
  "The running room backend predates these settings. Restart the voice assistant service to enable prompt files, voice tests and appearance settings.";

export function supportsSettings(snapshot: Snapshot) {
  return (
    snapshot.testSentence !== undefined &&
    snapshot.appearance !== undefined &&
    snapshot.keybindings?.promptFile !== undefined
  );
}

/** Add defaults for fields absent from pre-redesign backend snapshots. */
export function normalizeSnapshot(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    appearance: snapshot.appearance ?? { ...defaultAppearance },
    testSentence: snapshot.testSentence ?? defaultTestSpeech,
    speechTest: snapshot.speechTest ?? "",
    keybindings: { ...bindingDefaults, ...snapshot.keybindings },
  };
}

export type ClientState = {
  connected: boolean;
  snapshot?: Snapshot;
  error?: string;
  settingsSupported?: boolean;
};
export class RoomClient {
  private socket?: Socket;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private listeners = new Set<() => void>();
  private value: ClientState = { connected: false };
  private id = 0;
  constructor(readonly path: string) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: ClientState) {
    this.value = value;
    for (const fn of this.listeners) fn();
  }
  connect() {
    this.stopped = false;
    const socket = (this.socket = createConnection(this.path));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      this.update({ ...this.value, connected: true, error: undefined }),
    );
    socket.on("data", (part: string) => {
      buffer += part;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        socket.destroy(new Error("Control frame exceeded 4 MiB"));
        return;
      }
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "state")
            this.update({
              ...this.value,
              connected: true,
              snapshot: normalizeSnapshot(event.state),
              settingsSupported: supportsSettings(event.state),
            });
          if (event.type === "error")
            this.update({ ...this.value, error: event.error });
        } catch {
          socket.destroy(new Error("Invalid control frame"));
          return;
        }
      }
    });
    socket.on("error", (error) =>
      this.update({
        ...this.value,
        connected: false,
        error:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "Waiting for the room backend"
            : error.message,
      }),
    );
    socket.on("close", () => {
      this.update({ ...this.value, connected: false });
      if (!this.stopped) this.timer = setTimeout(() => this.connect(), 1200);
    });
  }
  send(action: Action) {
    if (!this.value.connected || !this.socket || this.socket.destroyed) {
      this.update({
        ...this.value,
        error: "Room is disconnected. Your message has not been sent.",
      });
      return false;
    }
    if (
      this.value.settingsSupported === false &&
      (["prompt", "test_speech", "test_sentence", "appearance"].includes(
        action.action,
      ) ||
        (action.action === "navigate" && action.view === "appearance"))
    ) {
      this.update({ ...this.value, error: settingsUpgradeMessage });
      return false;
    }
    if (
      this.value.settingsSupported === false &&
      action.action === "keybindings"
    ) {
      // The old backend does not know the new binding. Preserve all its supported edits.
      const { promptFile, ...bindings } = action.bindings;
      if (
        promptFile !== undefined &&
        promptFile !== bindingDefaults.promptFile
      ) {
        this.update({ ...this.value, error: settingsUpgradeMessage });
        return false;
      }
      action = { ...action, bindings };
    }
    if (this.socket.writableLength > 256 * 1024) {
      this.update({ ...this.value, error: "Room is busy; try again shortly." });
      return false;
    }
    this.socket.write(
      JSON.stringify({ ...action, request_id: ++this.id }) + "\n",
    );
    return true;
  }
  dismissError() {
    this.update({ ...this.value, error: undefined });
  }
  close() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.destroy();
  }
}
