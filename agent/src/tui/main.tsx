import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { resolve } from "node:path";
import { RoomClient } from "./client.js";
import { App } from "./app.js";
import { c } from "./theme.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(
    "VC needs an interactive terminal. Run scripts/vc tui in a terminal window.\n",
  );
  process.exit(1);
}
const path = resolve(
  process.env.VC_CONTROL_SOCKET ??
    (process.env.VC_AGENT_SOCKET ?? "run/agent.sock").replace(/\.sock$/, "") +
      ".control.sock",
);
const client = new RoomClient(path);
const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: true,
  backgroundColor: c.bg,
});
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  client.close();
  renderer.destroy();
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, close);
process.on("uncaughtException", (error) => {
  close();
  process.stderr.write(String(error.stack ?? error) + "\n");
  process.exitCode = 1;
});
process.on("unhandledRejection", (error) => {
  close();
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
});
renderer.once("destroy", () => client.close());
createRoot(renderer).render(<App client={client} onQuit={close} />);
client.connect();
