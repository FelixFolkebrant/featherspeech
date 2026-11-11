export const bindingDefaults = {
  send: "Enter",
  newline: "Shift+Enter",
  steer: "Ctrl+Enter",
  palette: "Ctrl+P",
  tasks: "Ctrl+T",
  layout: "Ctrl+L",
  sidebar: "Ctrl+B",
  stop: "Ctrl+X",
  focus: "Tab",
  back: "Esc",
  quit: "Ctrl+Q",
  save: "Ctrl+S",
  promptFile: "Ctrl+O",
  taskCancel: "c",
  taskRetry: "r",
  taskApprove: "a",
  taskDecline: "d",
  taskAnswer: "e",
  taskDisplay: "p",
  usageSort: "s",
} as const;
export type BindingId = keyof typeof bindingDefaults;
export type Keybindings = Record<BindingId, string>;
export const bindingLabels: Record<BindingId, string> = {
  send: "Send message",
  newline: "Insert newline",
  steer: "Steer response / answer task",
  palette: "Command palette",
  tasks: "Open tasks",
  layout: "Cycle layout",
  sidebar: "Toggle menu",
  stop: "Stop response",
  focus: "Cycle focus",
  back: "Back / close",
  quit: "Quit",
  save: "Save editor",
  promptFile: "Open agent prompt TXT file",
  taskCancel: "Cancel task",
  taskRetry: "Retry task",
  taskApprove: "Approve task",
  taskDecline: "Decline task",
  taskAnswer: "Answer task",
  taskDisplay: "Display task result",
  usageSort: "Sort usage",
};
export function parseBinding(value: string) {
  const parts = value.toLowerCase().trim().split("+");
  const raw = parts.pop() ?? "";
  const name =
    (
      { enter: "return", esc: "escape", space: "space" } as Record<
        string,
        string
      >
    )[raw] ?? raw;
  if (
    !/^(?:[a-z0-9]|return|escape|tab|space|up|down|left|right|f(?:[1-9]|1[0-2]))$/.test(
      name,
    ) ||
    parts.some((p) => !["ctrl", "shift", "alt"].includes(p)) ||
    new Set(parts).size !== parts.length
  )
    throw new Error("Use a key such as Ctrl+B, Shift+Enter or F2");
  return {
    name,
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    meta: parts.includes("alt"),
  };
}
export function matchesBinding(
  key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean },
  value: string,
) {
  const b = parseBinding(value);
  return (
    key.name === b.name &&
    !!key.ctrl === b.ctrl &&
    !!key.shift === b.shift &&
    !!key.meta === b.meta
  );
}
export function validateBindings(value: Record<string, string>): Keybindings {
  const result = { ...bindingDefaults, ...value };
  const seen = new Set<string>();
  for (const id of Object.keys(result)) {
    if (!Object.hasOwn(bindingDefaults, id)) throw new Error("Unknown keybind");
    const key = JSON.stringify(parseBinding(result[id as BindingId]));
    if (seen.has(key)) throw new Error("That key is already assigned");
    // These keys are needed to operate lists, completion and the keybind editor.
    const parsed = parseBinding(result[id as BindingId]);
    if (parsed.name === "c" && parsed.ctrl && !parsed.shift && !parsed.meta)
      throw new Error("Ctrl+C is reserved for quitting");
    if (parsed.name === "tab" && parsed.shift && !parsed.ctrl && !parsed.meta)
      throw new Error("Shift+Tab is reserved for reverse focus");
    if (
      [
        "steer",
        "palette",
        "tasks",
        "layout",
        "sidebar",
        "stop",
        "focus",
        "back",
        "quit",
        "save",
        "promptFile",
      ].includes(id) &&
      !parsed.ctrl &&
      !parsed.meta &&
      !/^f\d+$/.test(parsed.name) &&
      !["tab", "escape"].includes(parsed.name)
    )
      throw new Error("Global shortcuts need Ctrl, Alt or a function key");
    if (
      ["up", "down", "left", "right"].includes(parsed.name) &&
      !parsed.ctrl &&
      !parsed.meta
    )
      throw new Error("Arrow keys are reserved for navigation");
    if (
      ["return", "escape", "tab"].includes(parsed.name) &&
      !parsed.ctrl &&
      !parsed.meta &&
      !parsed.shift &&
      (
        { return: "send", escape: "back", tab: "focus" } as Record<
          string,
          string
        >
      )[parsed.name] !== id
    )
      throw new Error(
        "Enter, Esc and Tab are reserved for selection, closing and completion",
      );
    seen.add(key);
  }
  return result;
}
