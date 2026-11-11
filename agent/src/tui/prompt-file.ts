import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import type { Profile } from "../profiles.js";

/** The file remains on disk even if editing, validation or socket submission fails. */
export async function editPromptFile(
  profile: Profile,
  terminal: { suspend: () => Promise<void>; resume: () => Promise<void> },
  directory = "run/prompts",
  editor = process.env.VISUAL || process.env.EDITOR || "vi",
): Promise<string> {
  const path = resolve(directory, `${profile.id}.txt`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Keep the preceding local draft before refreshing from the room.
  try {
    await copyFile(path, path + ".bak");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, profile.prompt, { mode: 0o600 });
  await terminal.suspend();
  try {
    await new Promise<void>((resolve, reject) => {
      // EDITOR is a user-controlled command. The file path is a separate argument.
      const child = spawn(
        "/bin/sh",
        ["-c", "exec " + editor + ' "$1"', "vc-editor", path],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Editor exited ${signal ?? code}; draft kept at ${path}`,
              ),
            ),
      );
    });
    const prompt = await readFile(path, "utf8");
    if (!prompt.trim() || prompt.length > 16000)
      throw new Error(
        `Prompt must contain 1–16000 characters; draft kept at ${path}`,
      );
    return prompt;
  } finally {
    await terminal.resume();
  }
}
