import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editPromptFile } from "./tui/prompt-file.js";
import { profiles } from "./profiles.js";

test("external TXT editor reloads changes, backs up drafts and always restores the terminal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vc prompt ' $-"));
  const calls: string[] = [];
  const terminal = {
    suspend: async () => {
      calls.push("suspend");
    },
    resume: async () => {
      calls.push("resume");
    },
  };
  const profile = profiles({}).default;
  try {
    const prompt = await editPromptFile(
      profile,
      terminal,
      dir,
      `python3 -c 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text("Edited prompt")'`,
    );
    assert.equal(prompt, "Edited prompt");
    assert.deepEqual(calls, ["suspend", "resume"]);
    await assert.rejects(
      editPromptFile(profile, terminal, dir, "false"),
      /Editor exited/,
    );
    assert.deepEqual(calls, ["suspend", "resume", "suspend", "resume"]);
    assert.equal(
      await readFile(join(dir, "default.txt.bak"), "utf8"),
      "Edited prompt",
    );
    assert.equal(
      await readFile(join(dir, "default.txt"), "utf8"),
      profile.prompt,
    );
    await assert.rejects(
      editPromptFile(
        profile,
        terminal,
        dir,
        `python3 -c 'import pathlib,sys; pathlib.Path(sys.argv[1]).write_text(" ")'`,
      ),
      /1–16000/,
    );
    assert.equal(calls.at(-1), "resume");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
