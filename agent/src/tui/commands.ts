import type { Action, Snapshot } from "../interface.js";
export type Command = {
  id: string;
  name: string;
  description: string;
  shortcut?: string;
  action?: Action;
  local?: "quit" | "new-agent" | "help" | "sidebar";
};
export function commands(state?: Snapshot): Command[] {
  return [
    {
      id: "chat",
      name: "Conversation",
      description: "Return to the room",
      action: { action: "navigate", view: "conversation" },
    },
    {
      id: "tasks",
      name: "Task manager",
      description: "Inspect background work, results and approvals",
      shortcut: "Ctrl+T",
      action: { action: "navigate", view: "tasks" },
    },
    ...(state?.tasks.length
      ? [
          {
            id: "last-task",
            name: "Show the last task",
            description: "Open the latest task and its result",
            action: {
              action: "navigate" as const,
              view: "tasks" as const,
              task: state.tasks.at(-1)!.id,
            },
          },
        ]
      : []),
    ...(state?.artifacts.map((a) => ({
      id: `artifact-${a.id}`,
      name: `Show artifact: ${a.title}`,
      description: a.pinned ? "Pinned in the room" : a.kind,
      action: { action: "select_artifact" as const, id: a.id },
    })) ?? []),
    {
      id: "settings",
      name: "Settings",
      description: "Agents, hardware, keybinds and UI",
      action: { action: "navigate", view: "settings" },
    },
    {
      id: "history",
      name: "History",
      description: "Past conversations",
      action: { action: "navigate", view: "history" },
    },
    {
      id: "agents",
      name: "Agents",
      description: "Personality, model, voice and tools",
      action: {
        action: "navigate",
        view: "agents",
        agent: state?.active ?? "default",
      },
    },
    {
      id: "new-agent",
      name: "Add a new agent",
      description: "Create an agent",
      local: "new-agent",
    },
    {
      id: "hardware",
      name: "Hardware",
      description: "Audio devices and volume",
      action: { action: "navigate", view: "hardware" },
    },
    {
      id: "appearance",
      name: "UI appearance",
      description: "Theme colors and transparent or solid background",
      action: { action: "navigate", view: "appearance" },
    },
    {
      id: "keybinds",
      name: "Keybinds",
      description: "View and change keyboard controls",
      action: { action: "navigate", view: "keybinds" },
    },
    {
      id: "sidebar",
      name: "Toggle menu",
      description: "Show or hide navigation",
      local: "sidebar",
    },
    {
      id: "usage",
      name: "Usage",
      description: "Recorded model costs and tokens",
      action: { action: "navigate", view: "models" },
    },
    {
      id: "text",
      name:
        state?.mode === "text" ? "Enable voice mode" : "Enable text-only mode",
      description: "Switch audio turn detection and playback",
      action: {
        action: "mode",
        mode: state?.mode === "text" ? "voice" : "text",
      },
    },
    ...(["conversation", "split", "artifact"] as const).map((layout) => ({
      id: `layout-${layout}`,
      name: `Layout: ${layout}`,
      description: "Arrange conversation and artifact panels",
      action: { action: "layout" as const, layout },
    })),
    {
      id: "wider",
      name: "Make artifact panel bigger",
      description: "Increase the right panel by ten percent",
      action: {
        action: "layout",
        layout: "split",
        width: Math.min(75, (state?.panelWidth ?? 45) + 10),
      },
    },
    ...(state?.selectedArtifact
      ? [
          {
            id: "pin",
            name: "Pin / unpin current artifact",
            description: "Keep this result in the room",
            action: { action: "pin" as const, id: state.selectedArtifact },
          },
        ]
      : []),
    {
      id: "stop",
      name: "Stop current response",
      description: "Leave background tasks running",
      action: { action: "cancel" },
    },
    {
      id: "reset",
      name: "New conversation",
      description: "Start fresh; previous history remains in memory",
      action: { action: "reset" },
    },
    {
      id: "refresh",
      name: "Refresh devices & local models",
      description: "Read current hardware and downloaded model files",
      action: { action: "refresh" },
    },
    ...(state?.profiles
      .filter((p) => p.enabled !== false)
      .map((p) => ({
        id: `agent-${p.id}`,
        name: `Talk to ${p.name}`,
        description: `@${p.id} · ${p.model}`,
        action: { action: "focus" as const, agent: p.id },
      })) ?? []),
    {
      id: "help",
      name: "Help",
      description: "All controls at a glance",
      local: "help",
    },
    {
      id: "quit",
      name: "Quit interface",
      description: "Close this terminal interface",
      shortcut: "Ctrl+Q",
      local: "quit",
    },
  ];
}
export function fuzzy<T extends { name: string; description: string }>(
  items: T[],
  query: string,
): T[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;
  return items
    .map((item) => {
      const label = item.name.toLowerCase();
      const hay = `${label} ${item.description.toLowerCase()}`;
      let at = 0,
        score = 0;
      for (const char of q) {
        const next = hay.indexOf(char, at);
        if (next < 0) return { item, score: -1 };
        score += next === at ? 4 : 1;
        at = next + 1;
      }
      if (label.includes(q)) score += 30;
      if (label.startsWith(q)) score += 50;
      return { item, score };
    })
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}
/** Return an app action for explicit slash commands. Unknown commands never hit the LLM. */
export function slash(text: string, state: Snapshot): Action | undefined {
  if (!text.startsWith("/")) return;
  const [name, ...rest] = text.slice(1).trim().split(/\s+/);
  const arg = rest.join(" ");
  if (
    [
      "chat",
      "tasks",
      "settings",
      "history",
      "keybinds",
      "appearance",
      "agents",
      "models",
      "hardware",
      "diagnostics",
    ].includes(name!)
  )
    return {
      action: "navigate",
      view: name === "chat" ? "conversation" : (name as "tasks"),
      ...(name === "agents" ? { agent: arg || state.active } : {}),
    };
  if (name === "text" || name === "voice")
    return { action: "mode", mode: name };
  if (name === "new") return { action: "reset" };
  if (name === "stop") return { action: "cancel" };
  if (name === "agent" && arg)
    return { action: "focus", agent: arg.replace(/^@/, "") };
  if (name === "layout" && ["conversation", "split", "artifact"].includes(arg))
    return { action: "layout", layout: arg as "split" };
  if (name === "pin" && state.selectedArtifact)
    return { action: "pin", id: state.selectedArtifact };
  if (name === "cancel" && arg)
    return { action: "task", operation: "cancel", id: arg };
  if (name === "retry" && arg)
    return { action: "task", operation: "retry", id: arg };
  if (name === "approve" && arg)
    return { action: "task", operation: "approve", id: arg };
  throw new Error(`Unknown command: /${name}`);
}

export const slashCommands = [
  "chat",
  "tasks",
  "settings",
  "history",
  "agents",
  "hardware",
  "keybinds",
  "appearance",
  "agent",
  "text",
  "voice",
  "layout",
  "pin",
  "new",
  "stop",
  "cancel",
  "retry",
  "approve",
  "help",
  "palette",
  "menu",
];
export type Completion = {
  value: string;
  label: string;
  detail: string;
  start: number;
  end: number;
};
/** Complete the token at the cursor, preserving the rest of the draft. */
export function completions(
  text: string,
  cursor: number,
  state?: Snapshot,
): Completion[] {
  const before = text.slice(0, cursor);
  const token = before.match(/(?:^|\s)(@[a-z0-9-]*)$/i);
  const command = before.match(/^\/[a-z-]*$/i);
  if (!token && !command) return [];
  const word = token?.[1] ?? command![0];
  // Do not replace a partial token while the cursor is in its middle.
  const suffix = text.slice(cursor).match(/^[a-z0-9-]*/i)?.[0] ?? "";
  const start = cursor - word.length;
  const end = cursor + suffix.length;
  const q = word.slice(1).toLowerCase();
  const options = token
    ? (state?.profiles ?? [])
        .filter((p) => p.enabled !== false)
        .map((p) => ({ value: `@${p.id}`, label: p.name, detail: p.model }))
    : slashCommands.map((id) => ({
        value: `/${id}`,
        label: `/${id}`,
        detail: "",
      }));
  return options
    .filter((o) => o.value.slice(1).toLowerCase().startsWith(q))
    .map((o) => ({ ...o, start, end }));
}
