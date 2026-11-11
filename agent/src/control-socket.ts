import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { z } from "zod";
import { dirname } from "node:path";
import { launchTerminal } from "./terminal.js";
import type { RoomInterface } from "./interface.js";

/** Separate owner-only socket: UI subscriptions never occupy the audio IPC client. */
export async function controlSocket(path: string, ui: RoomInterface) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isSocket() || info.uid !== process.getuid?.())
      throw new Error("Refusing to replace unowned/non-socket control path");
    const active = await new Promise<boolean>((resolve) => {
      const s = createConnection(path);
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", (e) =>
        resolve((e as NodeJS.ErrnoException).code !== "ECONNREFUSED"),
      );
    });
    if (active) throw new Error("Control socket already listening");
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const clients = new Set<Socket>();
  let launching: Promise<string> | undefined;
  let lastOpened = 0;
  ui.openClient = async () => {
    if (clients.size) return "already connected";
    if (process.env.VC_MOCK_AGENT === "1")
      throw new Error("Terminal launching is disabled in mock mode");
    if (launching) return launching;
    if (Date.now() - lastOpened < 10000) return "opening";
    launching = launchTerminal(path)
      .then((name) => {
        lastOpened = Date.now();
        return name;
      })
      .finally(() => {
        launching = undefined;
      });
    return launching;
  };
  const present = () => {
    if (process.env.VC_TUI_AUTO_OPEN === "1" && !clients.size)
      void ui.openClient!().catch((error) =>
        ui.audit("terminal_open_error", { error: String(error) }),
      );
  };
  ui.on("present", present);
  const send = (socket: Socket, data: unknown) => {
    if (!socket.destroyed) {
      if (socket.writableLength > 2 * 1024 * 1024) socket.destroy();
      else socket.write(JSON.stringify(data) + "\n");
    }
  };
  const changed = (state: unknown) => {
    for (const s of clients) send(s, { type: "state", state });
  };
  const notice = (error: string) => {
    for (const s of clients) send(s, { type: "error", error });
  };
  ui.on("state", changed);
  ui.on("notice", notice);
  const server = createServer((socket) => {
    if (clients.size >= 8) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let queued = 0;
    let sequence = Promise.resolve();
    send(socket, { type: "state", state: ui.snapshot() });
    socket.on("data", (part: string) => {
      buffer += part;
      if (Buffer.byteLength(buffer) > 256 * 1024) {
        socket.destroy();
        return;
      }
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (++queued > 32) {
          socket.destroy();
          return;
        }
        sequence = sequence.then(async () => {
          try {
            const { request_id, ...action } = JSON.parse(line);
            await ui.dispatch(action);
            send(socket, { type: "ack", request_id });
          } catch (e) {
            send(socket, {
              type: "error",
              error:
                e instanceof z.ZodError
                  ? e.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join("; ")
                  : e instanceof Error
                    ? e.message
                    : String(e),
            });
          } finally {
            queued--;
          }
        });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return async () => {
    ui.off("state", changed);
    ui.off("present", present);
    ui.openClient = undefined;
    ui.off("notice", notice);
    for (const s of clients) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    await unlink(path).catch(() => {});
    ui.close();
  };
}
