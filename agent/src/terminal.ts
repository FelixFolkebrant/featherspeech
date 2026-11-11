import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const terminals: [string, string[]][] = [
  ["kitty", ["-e"]],
  ["alacritty", ["-e"]],
  ["wezterm", ["start", "--"]],
  ["ghostty", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["x-terminal-emulator", ["-e"]],
  ["xterm", ["-e"]],
];
async function executable(name: string) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(dir, name);
    if (
      await access(path, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
}
/** Graphical terminal launch has no shell interpolation and never opens a second room. */
export async function launchTerminal(controlPath: string): Promise<string> {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    throw new Error("No graphical session; run scripts/vc tui in a terminal");
  if (process.env.XDG_SESSION_ID) {
    const session = await exec(
      "loginctl",
      [
        "show-session",
        process.env.XDG_SESSION_ID,
        "-p",
        "Active",
        "-p",
        "LockedHint",
      ],
      { timeout: 1500 },
    ).then(
      (r) => r.stdout,
      () => "",
    );
    if (/Active=no|LockedHint=yes/.test(session))
      throw new Error("The graphical session is inactive or locked");
  }
  if (process.env.DISPLAY && (await executable("xset"))) {
    const display = await exec("xset", ["q"], { timeout: 1500 }).then(
      (r) => r.stdout,
      () => "",
    );
    if (/Monitor is (?:Off|Standby|Suspend)/i.test(display))
      throw new Error("The display is asleep");
  }
  const preferred = process.env.VC_TUI_TERMINAL;
  for (const [name, args] of terminals.filter(
    ([name]) => !preferred || name === preferred,
  )) {
    const path = await executable(name);
    if (!path) continue;
    const child = spawn(
      path,
      [
        ...args,
        process.execPath,
        "--experimental-ffi",
        resolve(import.meta.dirname, "tui/main.js"),
      ],
      {
        cwd: resolve(import.meta.dirname, "../.."),
        env: { ...process.env, VC_CONTROL_SOCKET: controlPath },
        detached: true,
        stdio: "ignore",
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return name;
  }
  throw new Error(
    "No supported terminal found; set VC_TUI_TERMINAL or run scripts/vc tui",
  );
}
