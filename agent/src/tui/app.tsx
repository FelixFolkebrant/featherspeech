import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import type {
  SyntaxStyle,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "@opentui/core";
import type { Action, Artifact, Snapshot } from "../interface.js";
import type { Profile } from "../profiles.js";
import { settingsUpgradeMessage, type RoomClient } from "./client.js";
import {
  commands,
  completions,
  fuzzy,
  slash,
  type Command,
} from "./commands.js";
import {
  bindingDefaults,
  bindingLabels,
  matchesBinding,
  parseBinding,
  validateBindings,
  type BindingId,
} from "../keybindings.js";
import { defaultAppearance } from "../appearance.js";
import { editPromptFile } from "./prompt-file.js";
import {
  c,
  applyTheme,
  clean,
  clock,
  duration,
  money,
  makeSyntax,
} from "./theme.js";

const SyntaxContext = createContext<SyntaxStyle>(null!);
type Send = (action: Action) => void;
type Choice = { name: string; description: string; run: () => void };
type Dialog = {
  kind: "palette" | "choice" | "edit" | "help";
  title: string;
  items?: Choice[];
  value?: string;
  save?: (value: string) => void;
  multiline?: boolean;
};
const nav = [
  { id: "conversation", label: "Conversation" },
  { id: "tasks", label: "Tasks" },
  { id: "settings", label: "Settings" },
  { id: "history", label: "History" },
] as const;
const settingsViews = [
  "settings",
  "agents",
  "hardware",
  "keybinds",
  "appearance",
];
const selectStyle = () => ({
  backgroundColor: c.panel,
  textColor: c.muted,
  focusedBackgroundColor: c.panel,
  focusedTextColor: c.text,
  selectedBackgroundColor: c.raised,
  selectedTextColor: c.accent,
  descriptionColor: c.faint,
  selectedDescriptionColor: c.muted,
});
function Button({
  children,
  onPress,
  active = false,
  color,
}: {
  children: ReactNode;
  onPress: () => void;
  active?: boolean;
  color?: string;
}) {
  return (
    <box
      paddingX={1}
      backgroundColor={active ? c.raised : undefined}
      onMouseDown={(e) => {
        if (e.button === 0) {
          e.stopPropagation();
          onPress();
        }
      }}
    >
      <text fg={color ?? (active ? c.accent : c.muted)}>{children}</text>
    </box>
  );
}
function Heading({ title, detail }: { title: string; detail?: string }) {
  return (
    <box flexDirection="column" gap={1} paddingBottom={1} flexShrink={0}>
      <text fg={c.text}>
        <b>{title}</b>
      </text>
      {detail && <text fg={c.muted}>{detail}</text>}
    </box>
  );
}
function Muted({ children }: { children: ReactNode }) {
  return <text fg={c.muted}>{children}</text>;
}
function Rich({
  text,
  code,
  language,
}: {
  text: string;
  code?: boolean;
  language?: string;
}) {
  const syntax = useContext(SyntaxContext);
  return code ? (
    <code
      content={clean(text)}
      filetype={language ?? "text"}
      syntaxStyle={syntax}
      drawUnstyledText
    />
  ) : (
    <markdown content={clean(text)} syntaxStyle={syntax} />
  );
}

export function App({
  client,
  onQuit,
  onEditPrompt = editPromptFile,
}: {
  client: RoomClient;
  onQuit: () => void;
  onEditPrompt?: typeof editPromptFile;
}) {
  const renderer = useRenderer();
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const s = connection.snapshot;
  const appearance = s?.appearance ?? defaultAppearance;
  applyTheme(appearance);
  const syntax = useMemo(
    () => makeSyntax(renderer),
    [renderer, appearance.theme],
  );
  useEffect(() => {
    renderer.setBackgroundColor(c.bg);
  }, [renderer, appearance.theme, appearance.background]);
  const { width, height } = useTerminalDimensions();
  const [focus, setFocus] = useState<"composer" | "sidebar" | "content">(
    "composer",
  );
  const [sidebarIndex, setSidebarIndex] = useState(0);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [narrowMenuOpen, setNarrowMenuOpen] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const inSettings = settingsViews.includes(s?.view ?? "");
  const showSidebar = width >= 85 ? sidebarVisible : narrowMenuOpen;
  const toggleMenu = () =>
    width >= 85 ? setSidebarVisible((v) => !v) : setNarrowMenuOpen((v) => !v);
  const bindings = s?.keybindings ?? bindingDefaults;
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionDismissed, setCompletionDismissed] = useState(false);
  const suggestions = completionDismissed ? [] : completions(draft, cursor, s);
  const refreshDraft = () => {
    const area = editor.current;
    if (!area) return;
    setDraft(area.plainText);
    setCursor(area.cursorOffset);
    setCompletionIndex(0);
    setCompletionDismissed(false);
  };
  const acceptCompletion = (index = completionIndex) => {
    const option = suggestions[index];
    const area = editor.current;
    if (!option || !area) return;
    const tail = draft.slice(option.end);
    const space = tail.startsWith(" ") ? "" : " ";
    area.setText(draft.slice(0, option.start) + option.value + space + tail);
    area.cursorOffset = option.start + option.value.length + (space ? 1 : 0);
    refreshDraft();
  };
  useEffect(() => {
    if (!s) return;
    setFocus(
      s.view === "conversation"
        ? "composer"
        : s.view === "settings" && showSidebar
          ? "sidebar"
          : "content",
    );
    setSidebarIndex(0);
    if (s.view === "agents") setAgentsExpanded(true);
  }, [s?.view, showSidebar]);
  const sidebarScroll = useRef<ScrollBoxRenderable | null>(null);
  const [dialog, setDialog] = useState<Dialog>();
  useEffect(() => {
    const scroll = sidebarScroll.current;
    if (!scroll) return;
    const row = sidebarIndex * 2;
    if (row < scroll.scrollTop) scroll.scrollTo(row);
    else if (row >= scroll.scrollTop + scroll.height - 1)
      scroll.scrollTo(Math.max(0, row - scroll.height + 2));
  }, [sidebarIndex, height]);
  const [query, setQuery] = useState("");
  const queryRef = useRef("");
  const setSearch = (value: string) => {
    queryRef.current = value;
    setQuery(value);
  };
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [taskId, setTaskId] = useState<string>();
  const [sort, setSort] = useState<"usd" | "agent" | "model">("usd");
  const [, tick] = useState(0);
  const editor = useRef<TextareaRenderable | null>(null);
  const modalEditor = useRef<TextareaRenderable | null>(null);
  const send: Send = (action) => {
    setError(undefined);
    client.send(action);
  };
  const closeDialog = () => {
    setDialog(undefined);
    setSearch("");
    setIndex(0);
  };
  const open = (value: Dialog) => {
    setSearch(value.kind === "edit" ? (value.value ?? "") : "");
    setIndex(0);
    setDialog(value);
  };
  const edit = (
    title: string,
    value: string,
    save: (value: string) => void,
    multiline = false,
  ) => open({ kind: "edit", title, value, save, multiline });
  const choose = (title: string, items: Choice[]) =>
    open({ kind: "choice", title, items });
  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const newAgent = () =>
    edit("Name your new agent", "", (name) => {
      if (!s) return;
      const id = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 32);
      if (!/^[a-z][a-z0-9-]*$/.test(id))
        throw new Error("Use a name starting with a letter");
      if (s.profiles.some((p) => p.id === id))
        throw new Error("An agent with this name already exists");
      const p = {
        ...s.profiles.find((p) => p.id === "default")!,
        id,
        name: name.trim(),
        prompt: s.profiles
          .find((p) => p.id === "default")!
          .prompt.replace("You are Default:", `You are ${name.trim()}:`),
        enabled: true,
      };
      send({ action: "profile", profile: p });
      send({ action: "navigate", view: "agents", agent: id });
      setFocus("content");
    });
  const runCommand = (cmd: Command) => {
    closeDialog();
    if (cmd.action) {
      send(cmd.action);
      if (cmd.action.action === "navigate")
        setFocus(cmd.action.view === "conversation" ? "composer" : "content");
    }
    if (cmd.local === "quit") onQuit();
    if (cmd.local === "sidebar") toggleMenu();
    if (cmd.local === "new-agent") newAgent();
    if (cmd.local === "help") open({ kind: "help", title: "Help" });
  };
  const paletteChoices: Choice[] = commands(s).map((cmd) => ({
    name: `${cmd.name}${cmd.id === "tasks" ? `    ${bindings.tasks}` : cmd.id === "quit" ? `    ${bindings.quit}` : ""}`,
    description: cmd.description,
    run: () => runCommand(cmd),
  }));
  const choices = fuzzy(
    dialog?.kind === "palette" ? paletteChoices : (dialog?.items ?? []),
    query,
  );
  const activateChoice = () => {
    const current = fuzzy(
      dialog?.kind === "palette" ? paletteChoices : (dialog?.items ?? []),
      queryRef.current,
    );
    const item = current[Math.min(index, current.length - 1)];
    if (item) {
      closeDialog();
      item.run();
    }
  };
  const saveEdit = () => {
    try {
      const value = dialog?.multiline
        ? (modalEditor.current?.plainText ?? "")
        : queryRef.current;
      dialog?.save?.(value);
      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const submit = (steer = false) => {
    const text = editor.current?.plainText.trim();
    if (!text || !s) return;
    try {
      if (text === "/help") open({ kind: "help", title: "Help" });
      else if (text === "/menu") toggleMenu();
      else if (text === "/palette")
        open({ kind: "palette", title: "Command palette" });
      else {
        const action =
          slash(text, s) ??
          ({
            action: "message",
            text,
            ...(steer
              ? {
                  steer: true,
                  ...(s.view === "tasks" && selectedTask
                    ? { task: selectedTask.id }
                    : {}),
                }
              : {}),
          } as Action);
        if (client.send(action)) {
          if (action.action === "navigate")
            setFocus(action.view === "conversation" ? "composer" : "content");
        } else return;
      }
      editor.current?.setText("");
      setDraft("");
      setCursor(0);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const [editingFile, setEditingFile] = useState(false);
  const openPromptFile = async () => {
    const p = s?.profiles.find((p) => p.id === s.settingsAgent);
    if (!p || editingFile) return;
    if (connection.settingsSupported === false) {
      setError(settingsUpgradeMessage);
      return;
    }
    setEditingFile(true);
    try {
      const prompt = await onEditPrompt(p, renderer);
      send({ action: "prompt", agent: p.id, prompt, expected: p.prompt });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditingFile(false);
    }
  };
  const testSpeech = () => {
    if (s) send({ action: "test_speech", agent: s.settingsAgent });
  };
  const editTestSentence = () => {
    if (s)
      edit(
        "Test speech sentence · up to 500 characters",
        s.testSentence,
        (text) => {
          if (!text.trim() || text.trim().length > 500)
            throw new Error("Enter 1–500 characters");
          send({ action: "test_sentence", text });
        },
      );
  };
  const selectedTask =
    s?.tasks.find((t) => t.id === (s.selectedTask ?? taskId)) ??
    s?.tasks.at(-1);
  useKeyboard((key) => {
    if (editingFile) return;
    const is = (id: BindingId) => matchesBinding(key, bindings[id]);
    if (is("quit") || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      onQuit();
      return;
    }
    if (is("palette")) {
      key.preventDefault();
      open({ kind: "palette", title: "Command palette" });
      return;
    }
    if (is("back") || key.name === "escape") {
      key.preventDefault();
      if (dialog) closeDialog();
      else if (focus === "composer" && suggestions.length)
        setCompletionDismissed(true);
      else if (error || connection.error) {
        setError(undefined);
        client.dismissError();
      } else if (inSettings && s?.view !== "settings")
        send({ action: "navigate", view: "settings" });
      else if (s?.view !== "conversation")
        send({ action: "navigate", view: "conversation" });
      else setFocus("composer");
      return;
    }
    if (dialog) {
      if (dialog.kind === "palette" || dialog.kind === "choice") {
        if (key.name === "up" || key.name === "down") {
          key.preventDefault();
          setIndex((i) =>
            Math.max(
              0,
              Math.min(choices.length - 1, i + (key.name === "up" ? -1 : 1)),
            ),
          );
        }
        if (key.name === "return") {
          key.preventDefault();
          activateChoice();
        }
      }
      if (dialog.kind === "edit" && is("save")) {
        key.preventDefault();
        saveEdit();
      }
      return;
    }
    if (
      focus === "composer" &&
      suggestions.length &&
      ["up", "down", "tab", "return"].includes(key.name) &&
      !key.ctrl &&
      !key.meta &&
      !key.shift
    ) {
      key.preventDefault();
      if (key.name === "up" || key.name === "down")
        setCompletionIndex(
          (i) =>
            (i + (key.name === "up" ? -1 : 1) + suggestions.length) %
            suggestions.length,
        );
      else acceptCompletion();
      return;
    }
    if (s?.view === "agents") {
      if (is("promptFile")) {
        key.preventDefault();
        void openPromptFile();
        return;
      }
      if (is("tasks")) {
        key.preventDefault();
        testSpeech();
        return;
      }
      if (is("layout")) {
        key.preventDefault();
        editTestSentence();
        return;
      }
    }
    if (is("sidebar")) {
      key.preventDefault();
      toggleMenu();
      return;
    }
    if (is("tasks")) {
      key.preventDefault();
      send({ action: "navigate", view: "tasks" });
      setFocus("content");
      return;
    }
    if (is("layout") && s) {
      key.preventDefault();
      send({
        action: "layout",
        layout:
          s.layout === "conversation"
            ? "split"
            : s.layout === "split"
              ? "artifact"
              : "conversation",
      });
      return;
    }
    if (is("steer")) {
      key.preventDefault();
      if (
        s?.view === "tasks" &&
        selectedTask?.pendingInput?.kind === "question"
      )
        edit(`Answer task ${selectedTask.id}`, "", (text) =>
          send({
            action: "task",
            operation: "answer",
            id: selectedTask.id,
            text,
          }),
        );
      else if (s?.view === "conversation") submit(true);
      return;
    }
    if (is("focus") || (key.name === "tab" && key.shift)) {
      key.preventDefault();
      const areas: (typeof focus)[] = [
        ...(s?.view === "conversation" ? ["composer" as const] : []),
        ...(showSidebar ? ["sidebar" as const] : []),
        ...(s?.view === "settings" && showSidebar ? [] : ["content" as const]),
      ];
      setFocus(
        (f) =>
          areas[
            (Math.max(0, areas.indexOf(f)) +
              (key.shift ? -1 : 1) +
              areas.length) %
              areas.length
          ]!,
      );
      return;
    }
    if (is("stop")) {
      key.preventDefault();
      send({ action: "cancel" });
      return;
    }
    if (focus === "sidebar" && ["up", "down", "return"].includes(key.name)) {
      key.preventDefault();
      if (key.name === "return") {
        const option = sidebarOptions[sidebarIndex];
        if (option) navTo(option.value);
      } else
        setSidebarIndex((i) =>
          Math.max(
            0,
            Math.min(
              sidebarOptions.length - 1,
              i + (key.name === "up" ? -1 : 1),
            ),
          ),
        );
      return;
    }
    if (focus === "content" && s?.view === "models" && is("usageSort"))
      setSort((v) => (v === "usd" ? "agent" : v === "agent" ? "model" : "usd"));
    if (focus === "content" && s?.view === "tasks" && selectedTask) {
      const operation = is("taskCancel")
        ? "cancel"
        : is("taskRetry")
          ? "retry"
          : is("taskApprove")
            ? "approve"
            : is("taskDecline")
              ? "decline"
              : undefined;
      if (operation) {
        key.preventDefault();
        send({ action: "task", operation, id: selectedTask.id });
      }
      if (is("taskAnswer") && selectedTask.pendingInput?.kind === "question")
        edit(`Answer task ${selectedTask.id}`, "", (text) =>
          send({
            action: "task",
            operation: "answer",
            id: selectedTask.id,
            text,
          }),
        );
      if (is("taskDisplay") && selectedTask.result)
        send({
          action: "artifact",
          title: `Task ${selectedTask.id} · ${selectedTask.agent}`,
          content: selectedTask.result,
        });
    }
  });
  const chooseProfileField = (p: Profile, key: string) => {
    const update = (value: Partial<Profile>) =>
      send({ action: "profile", profile: { ...p, ...value } });
    const enumField = (
      title: string,
      values: string[],
      save: (value: string) => void,
      descriptions?: string[],
    ) =>
      choose(
        title,
        values.map((value, i) => ({
          name: value,
          description: descriptions?.[i] ?? "",
          run: () => save(value),
        })),
      );
    if (key === "test") return testSpeech();
    if (key === "sentence") return editTestSentence();
    if (key === "prompt-file") return void openPromptFile();
    if (key === "provider")
      return enumField("Voice provider", ["Pocket", "Kitten"], (v) =>
        update({
          voice: {
            ...p.voice,
            provider: v.toLowerCase() as "pocket" | "kitten",
          },
        }),
      );
    if (key === "enabled") return update({ enabled: p.enabled === false });
    if (key === "name")
      return edit("Agent name", p.name, (name) => update({ name }));
    if (key === "prompt")
      return edit(
        "Personality prompt",
        p.prompt,
        (prompt) => update({ prompt }),
        true,
      );
    if (key === "model")
      return choose(
        "Choose an OpenRouter model",
        (s?.models ?? []).map((m) => ({
          name: m.id,
          description: `${money(m.input)} input · ${money(m.output)} output / 1M tokens${m.reasoning ? " · reasoning" : ""}`,
          run: () => update({ model: m.id }),
        })),
      );
    if (key === "reasoning")
      return enumField("Reasoning effort", ["none", "high"], (v) =>
        update({ reasoning: v as Profile["reasoning"] }),
      );
    if (key === "verbosity")
      return enumField(
        "Response detail",
        ["concise", "balanced", "detailed"],
        (v) => update({ verbosity: v as Profile["verbosity"] }),
      );
    if (key === "temperature")
      return edit(
        "LLM temperature · 0–2",
        String(p.temperature ?? 0.7),
        (v) => {
          const temperature = Number(v);
          if (
            !v.trim() ||
            !Number.isFinite(temperature) ||
            temperature < 0 ||
            temperature > 2
          )
            throw new Error("Enter a number between 0 and 2");
          update({ temperature });
        },
      );
    if (key === "speed")
      return edit("Kitten speech speed · 0.5–2", String(p.voice.speed), (v) => {
        const speed = Number(v);
        if (!Number.isFinite(speed) || speed < 0.5 || speed > 2)
          throw new Error("Enter a number between 0.5 and 2");
        update({ voice: { ...p.voice, speed } });
      });
    if (key === "pocket" || key === "kitten")
      return enumField(
        `${key === "pocket" ? "Pocket" : "Kitten"} voice`,
        key === "pocket"
          ? [
              "default",
              "alba",
              "marius",
              "jean",
              "javert",
              "fantine",
              "cosette",
              "eponine",
              "azelma",
            ]
          : [
              "default",
              "Bella",
              "Jasper",
              "Luna",
              "Bruno",
              "Rosie",
              "Hugo",
              "Kiki",
              "Leo",
            ],
        (v) => update({ voice: { ...p.voice, [key]: v } }),
      );
    if (key === "tools") {
      const names = [
        "current_time",
        "tasks",
        "search_memory",
        "remember",
        "consult_agent",
        "interface",
        ...(p.id === "deep-think" ? ["web_search"] : []),
      ];
      const enabled = p.tools ?? names;
      return choose(
        "Tools",
        names.map((name) => ({
          name: `${enabled.includes(name) ? "[×]" : "[ ]"} ${name}`,
          description:
            name === "web_search"
              ? "Requires BRAVE_SEARCH_API_KEY"
              : "Capability for this agent",
          run: () =>
            update({
              tools: enabled.includes(name)
                ? enabled.filter((n) => n !== name)
                : [...enabled, name],
            }),
        })),
      );
    }
  };
  const settingsOptions = [
    { name: "‹ Back", value: "back" },
    { name: `Agents ${agentsExpanded ? "▾" : "▸"}`, value: "agents-fold" },
    ...(agentsExpanded
      ? [
          ...(s?.profiles ?? []).map((p) => ({
            name: `  ${p.name}${p.enabled === false ? " · off" : ""}`,
            value: `agent:${p.id}`,
          })),
          { name: "  + Add agent", value: "new-agent" },
        ]
      : []),
    { name: "Hardware", value: "hardware" },
    { name: "Keybinds", value: "keybinds" },
    { name: "UI", value: "appearance" },
  ];
  const sidebarOptions = inSettings
    ? settingsOptions
    : nav.map((n) => ({ name: n.label, value: n.id }));
  const navTo = (value: string) => {
    if (value === "agents-fold") {
      setAgentsExpanded((v) => !v);
      return;
    }
    if (value === "back") value = "conversation";
    if (value === "new-agent") return newAgent();
    if (width < 85) setNarrowMenuOpen(false);
    if (value.startsWith("agent:")) {
      send({ action: "navigate", view: "agents", agent: value.slice(6) });
      setFocus("content");
    } else {
      send({ action: "navigate", view: value as "conversation" });
      setFocus(
        value === "conversation"
          ? "composer"
          : value === "settings" && showSidebar
            ? "sidebar"
            : "content",
      );
    }
  };
  const currentMenu = inSettings ? "settings" : s?.view;
  const totalCost = s?.usage.reduce((n, u) => n + u.usd, 0) ?? 0;
  const modalWidth = Math.min(80, width - 6);
  const notice = error ?? connection.error;
  return (
    <SyntaxContext.Provider value={syntax}>
      <box
        width="100%"
        height="100%"
        flexDirection="column"
        backgroundColor={c.bg}
      >
        <box
          height={3}
          paddingX={2}
          alignItems="center"
          flexDirection="row"
          border={["bottom"]}
          borderColor={c.border}
          flexShrink={0}
        >
          <Button onPress={toggleMenu} active={showSidebar}>
            ☰
          </Button>
          <text fg={c.accent}>
            <b>VC</b>
          </text>
          <text fg={c.faint}> / </text>
          <text fg={c.text}>
            {inSettings
              ? `Settings${s?.view === "settings" ? "" : ` / ${s?.view === "agents" ? (s.profiles.find((p) => p.id === s.settingsAgent)?.name ?? "Agents") : s?.view === "hardware" ? "Hardware" : s?.view === "appearance" ? "UI" : "Keybinds"}`}`
              : s?.view === "models"
                ? "Usage"
                : (nav.find((n) => n.id === s?.view)?.label ?? "Conversation")}
          </text>
          <box flexGrow={1} />
          <text fg={connection.connected ? c.green : c.amber}>
            {connection.connected ? "●" : "○"}{" "}
            {width > 66
              ? connection.connected
                ? s?.engineConnected && s.mode === "voice"
                  ? "voice connected"
                  : s?.mock
                    ? "demo room"
                    : "text connected"
                : "reconnecting"
              : ""}
          </text>
          <text fg={c.faint}> │ </text>
          <Button
            onPress={() => open({ kind: "palette", title: "Command palette" })}
          >
            Commands
          </Button>
        </box>
        <box flexGrow={1} minHeight={0} flexDirection="row">
          {showSidebar && (
            <box
              width={25}
              backgroundColor={c.panel}
              border={["right"]}
              borderColor={c.border}
              flexDirection="column"
              padding={1}
              flexShrink={0}
            >
              <scrollbox
                ref={sidebarScroll}
                flexGrow={1}
                minHeight={0}
                scrollX={false}
                contentOptions={{ flexDirection: "column", gap: 1 }}
              >
                {sidebarOptions.map((option, i) => {
                  const current =
                    option.value ===
                    (inSettings
                      ? s?.view === "agents"
                        ? agentsExpanded
                          ? `agent:${s.settingsAgent}`
                          : "agents-fold"
                        : s?.view
                      : currentMenu);
                  const selected = focus === "sidebar" && sidebarIndex === i;
                  return (
                    <box
                      key={option.value}
                      height={1}
                      flexShrink={0}
                      paddingX={1}
                      backgroundColor={
                        selected || current ? c.raised : undefined
                      }
                      onMouseDown={(e) => {
                        if (e.button === 0) {
                          e.stopPropagation();
                          setSidebarIndex(i);
                          navTo(option.value);
                        }
                      }}
                    >
                      <text fg={current || selected ? c.accent : c.muted}>
                        {current ? "● " : selected ? "› " : "  "}
                        {clean(option.name)}
                      </text>
                    </box>
                  );
                })}
              </scrollbox>
              <box
                flexDirection="column"
                gap={1}
                border={["top"]}
                borderColor={c.border}
                paddingTop={1}
                flexShrink={0}
              >
                <Button
                  onPress={() => navTo("models")}
                  active={s?.view === "models"}
                >
                  {money(totalCost)} · usage
                </Button>
              </box>
            </box>
          )}
          <box
            flexGrow={1}
            minWidth={0}
            minHeight={0}
            flexDirection="column"
            paddingX={width >= 85 ? 2 : 1}
            paddingTop={1}
          >
            {!s ? (
              <box
                flexGrow={1}
                alignItems="center"
                justifyContent="center"
                flexDirection="column"
                gap={1}
              >
                <text fg={c.accent}>
                  <b>Welcome to your room.</b>
                </text>
                <Muted>Connecting to the local assistant…</Muted>
              </box>
            ) : (
              <>
                {inSettings && s.view !== "settings" && !showSidebar && (
                  <box height={2} flexShrink={0}>
                    <Button onPress={() => navTo("settings")}>‹ Back</Button>
                  </box>
                )}
                <box flexGrow={1} minHeight={0} minWidth={0}>
                  {s.view === "settings" && (
                    <box flexGrow={1} minHeight={0} flexDirection="column">
                      <Heading title="Settings" />
                      {!showSidebar && (
                        <select
                          flexGrow={1}
                          minHeight={0}
                          focused={focus === "content" && !dialog}
                          {...selectStyle()}
                          showDescription={false}
                          options={settingsOptions.map((o) => ({
                            ...o,
                            description: "",
                          }))}
                          onSelect={(_, o) => {
                            if (o) navTo(o.value);
                          }}
                        />
                      )}
                    </box>
                  )}
                  {s.view === "appearance" && (
                    <AppearanceSettings
                      state={s}
                      focused={focus === "content" && !dialog}
                      send={send}
                      choose={choose}
                    />
                  )}
                  {s.view === "keybinds" && (
                    <Keybinds
                      state={s}
                      focused={focus === "content" && !dialog}
                      send={send}
                      edit={edit}
                    />
                  )}
                  {s.view === "history" && (
                    <History
                      state={s}
                      focused={focus === "content" && !dialog}
                      send={send}
                    />
                  )}
                  {s.view === "conversation" && (
                    <Conversation
                      state={s}
                      width={width - (showSidebar ? 30 : 2)}
                      focused={focus === "content" && !dialog}
                      send={send}
                    />
                  )}
                  {s.view === "tasks" && (
                    <Tasks
                      state={s}
                      selected={selectedTask?.id}
                      onSelect={(id) => {
                        setTaskId(id);
                        send({ action: "navigate", view: "tasks", task: id });
                        send({ action: "task", operation: "acknowledge", id });
                      }}
                      focused={focus === "content" && !dialog}
                      send={send}
                      edit={edit}
                    />
                  )}
                  {s.view === "agents" && (
                    <AgentSettings
                      state={s}
                      focused={focus === "content" && !dialog}
                      onEdit={chooseProfileField}
                      sendProfile={send}
                      width={width - (showSidebar ? 29 : 2)}
                      onOpenPrompt={() => void openPromptFile()}
                      onTest={testSpeech}
                      onSentence={editTestSentence}
                    />
                  )}
                  {s.view === "models" && (
                    <Models
                      state={s}
                      sort={sort}
                      setSort={setSort}
                      focused={focus === "content" && !dialog}
                    />
                  )}
                  {s.view === "hardware" && (
                    <Hardware
                      state={s}
                      focused={focus === "content" && !dialog}
                      send={send}
                      choose={choose}
                      edit={edit}
                    />
                  )}
                  {s.view === "diagnostics" && (
                    <Diagnostics
                      state={s}
                      focused={focus === "content" && !dialog}
                    />
                  )}
                </box>
              </>
            )}
            {s?.view === "conversation" && (
              <>
                {focus === "composer" && !dialog && suggestions.length > 0 && (
                  <box
                    flexDirection="column"
                    flexShrink={0}
                    backgroundColor={c.overlay}
                    paddingX={1}
                    marginTop={1}
                  >
                    {suggestions
                      .slice(
                        Math.max(0, completionIndex - 4),
                        Math.max(0, completionIndex - 4) + 5,
                      )
                      .map((option) => {
                        const i = suggestions.indexOf(option);
                        return (
                          <Button
                            key={option.value}
                            active={i === completionIndex}
                            onPress={() => acceptCompletion(i)}
                          >
                            {option.value}
                            {option.label !== option.value
                              ? `  ${option.label}`
                              : ""}
                          </Button>
                        );
                      })}
                  </box>
                )}
                <box
                  height={4}
                  minHeight={3}
                  flexShrink={0}
                  flexDirection="row"
                  backgroundColor={c.input}
                  paddingX={1}
                  paddingY={1}
                  marginTop={1}
                  onMouseDown={() => {
                    if (!dialog) setFocus("composer");
                  }}
                >
                  <text fg={focus === "composer" && !dialog ? c.text : c.muted}>
                    ›{" "}
                  </text>
                  <textarea
                    ref={editor}
                    initialValue={draft}
                    flexGrow={1}
                    minHeight={1}
                    focused={focus === "composer" && !dialog}
                    placeholder="Message…"
                    textColor={c.text}
                    backgroundColor={c.panel}
                    focusedBackgroundColor={c.panel}
                    cursorColor={c.text}
                    keyBindings={[
                      { ...parseBinding(bindings.send), action: "submit" },
                      { ...parseBinding(bindings.newline), action: "newline" },
                    ]}
                    onContentChange={refreshDraft}
                    onCursorChange={refreshDraft}
                    onSubmit={() => submit()}
                  />
                </box>
              </>
            )}
          </box>
        </box>
        {notice && (
          <box
            height={1}
            paddingX={2}
            backgroundColor={c.raised}
            flexShrink={0}
          >
            <text fg={c.red}>{clean(notice).split("\n")[0]}</text>
          </box>
        )}
        {dialog && (
          <box
            position="absolute"
            top={Math.max(2, Math.floor(height * 0.15))}
            left={Math.max(1, Math.floor((width - modalWidth) / 2))}
            width={modalWidth}
            maxHeight={height - 5}
            backgroundColor={c.overlay}
            border
            borderStyle="rounded"
            borderColor={c.accent}
            flexDirection="column"
            padding={1}
          >
            <text fg={c.accent}>
              <b>{dialog.title}</b>
            </text>
            <box height={1} />
            {dialog.kind === "help" ? (
              <scrollbox
                height={Math.max(4, Math.min(height - 10, 30))}
                minHeight={0}
                focused
                scrollX={false}
                contentOptions={{ flexDirection: "column", gap: 1 }}
              >
                {Object.entries(bindingLabels)
                  .slice(0, 12)
                  .map(([id, label]) => (
                    <Muted key={id}>
                      {bindings[id as BindingId]} {label}
                    </Muted>
                  ))}
                <Button
                  onPress={() => {
                    closeDialog();
                    navTo("keybinds");
                  }}
                >
                  Keybinds…
                </Button>
                <Muted>
                  @ mentions and / commands: arrows to choose, Tab or Enter to
                  complete.
                </Muted>
                <Muted>Shift+Tab cycles focus backwards. Ctrl+C exits.</Muted>
                <text fg={c.faint}>
                  /agent id · /text · /voice · /new · /stop · /layout split
                </text>
              </scrollbox>
            ) : dialog.kind === "edit" ? (
              <>
                {dialog.multiline ? (
                  <textarea
                    ref={modalEditor}
                    initialValue={dialog.value}
                    height={Math.max(4, Math.min(12, height - 13))}
                    focused
                    textColor={c.text}
                    backgroundColor={c.raised}
                    cursorColor={c.accent}
                  />
                ) : (
                  <input
                    key={dialog.title}
                    value={query}
                    focused
                    onInput={setSearch}
                    onSubmit={saveEdit}
                    backgroundColor={c.raised}
                    textColor={c.text}
                    focusedTextColor={c.text}
                    focusedBackgroundColor={c.raised}
                  />
                )}
                <box height={1} />
                <box flexDirection="row" gap={1}>
                  <Button onPress={saveEdit}>Save</Button>
                  <Button onPress={closeDialog}>Cancel</Button>
                </box>
              </>
            ) : (
              <>
                <input
                  placeholder="Search commands…"
                  value={query}
                  focused
                  onInput={(value) => {
                    setSearch(value);
                    setIndex(0);
                  }}
                  backgroundColor={c.raised}
                  focusedBackgroundColor={c.raised}
                  textColor={c.text}
                  focusedTextColor={c.text}
                />
                <box height={1} />
                {choices.length ? (
                  <select
                    height={Math.max(
                      2,
                      Math.min(choices.length * 2, height - 14, 16),
                    )}
                    options={choices.map((o) => ({
                      name: o.name,
                      description: o.description,
                    }))}
                    selectedIndex={Math.max(
                      0,
                      Math.min(index, choices.length - 1),
                    )}
                    {...selectStyle()}
                    onChange={setIndex}
                    onSelect={(_, o) => {
                      if (o) {
                        const found = choices.find((i) => i.name === o.name);
                        closeDialog();
                        found?.run();
                      }
                    }}
                  />
                ) : (
                  <Muted>No matching commands.</Muted>
                )}
                <box height={1} />
              </>
            )}
          </box>
        )}
      </box>
    </SyntaxContext.Provider>
  );
}

function Keybinds({
  state: s,
  focused,
  send,
  edit,
}: {
  state: Snapshot;
  focused: boolean;
  send: Send;
  edit: (title: string, value: string, save: (value: string) => void) => void;
}) {
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Heading title="Keybinds" />
      <select
        flexGrow={1}
        minHeight={0}
        focused={focused}
        {...selectStyle()}
        showDescription={false}
        itemSpacing={1}
        options={[
          ...Object.entries(bindingLabels).map(([id, label]) => ({
            name: `${label}  ${s.keybindings[id as BindingId]}`,
            description: "",
            value: id,
          })),
          { name: "Reset to defaults", description: "", value: "reset" },
        ]}
        onSelect={(_, o) => {
          if (!o) return;
          if (o.value === "reset")
            return send({
              action: "keybindings",
              bindings: { ...bindingDefaults },
            });
          const id = o.value as BindingId;
          edit(bindingLabels[id], s.keybindings[id], (value) => {
            const bindings = validateBindings({
              ...s.keybindings,
              [id]: value.trim(),
            });
            send({ action: "keybindings", bindings });
          });
        }}
      />
    </box>
  );
}

function History({
  state: s,
  focused,
  send,
}: {
  state: Snapshot;
  focused: boolean;
  send: Send;
}) {
  const [reading, setReading] = useState(false);
  useKeyboard((key) => {
    if (focused && key.name === "left" && reading) {
      key.preventDefault();
      setReading(false);
    }
  });
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Heading title="History" />
      {!s.history.length ? (
        <Muted>No past conversations.</Muted>
      ) : (
        <>
          {reading && (
            <box height={2} flexShrink={0}>
              <Button onPress={() => setReading(false)}>‹ Back</Button>
            </box>
          )}
          {!reading ? (
            <select
              flexGrow={1}
              minHeight={0}
              focused={focused}
              {...selectStyle()}
              options={s.history.map((h) => ({
                name: clean(h.title).replace(/\n/g, " "),
                description: new Date(h.created).toLocaleString(),
                value: h.id,
              }))}
              onChange={(_, o) => {
                if (o)
                  send({
                    action: "navigate",
                    view: "history",
                    conversation: o.value,
                  });
              }}
              onSelect={(_, o) => {
                if (o) {
                  send({
                    action: "navigate",
                    view: "history",
                    conversation: o.value,
                  });
                  setReading(true);
                }
              }}
            />
          ) : (
            <Conversation
              state={{
                ...s,
                messages: s.historyMessages,
                live: undefined,
                artifacts: [],
                layout: "conversation",
              }}
              width={100}
              focused={focused}
              send={send}
            />
          )}
        </>
      )}
    </box>
  );
}

function Conversation({
  state: s,
  width,
  focused,
  send,
}: {
  state: Snapshot;
  width: number;
  focused: boolean;
  send: Send;
}) {
  const artifact = s.artifacts.find((a) => a.id === s.selectedArtifact);
  const split = !!artifact && s.layout === "split" && width >= 78;
  const showArtifact = !!artifact && (s.layout === "artifact" || split);
  const showChat = !artifact || s.layout !== "artifact";
  const waiting = !s.messages.length && !s.live;
  return (
    <box flexDirection="row" flexGrow={1} minWidth={0} minHeight={0} gap={2}>
      {showChat && (
        <box
          flexGrow={1}
          flexBasis={0}
          minWidth={0}
          minHeight={0}
          flexDirection="column"
        >
          {waiting ? (
            <box flexGrow={1} />
          ) : (
            <scrollbox
              flexGrow={1}
              minHeight={0}
              focused={focused}
              stickyScroll
              stickyStart="bottom"
              scrollX={false}
              contentOptions={{
                flexDirection: "column",
                gap: 1,
                paddingRight: 2,
              }}
            >
              {s.messages
                .filter((m) => m.text.trim())
                .map((m) => (
                  <Message
                    key={m.id}
                    name={
                      m.role === "user"
                        ? "You"
                        : (s.profiles.find((p) => p.id === m.agent)?.name ??
                          m.agent)
                    }
                    model={m.model}
                    text={m.text}
                    user={m.role === "user"}
                    time={clock(m.timestamp)}
                  />
                ))}
              {s.live?.user && (
                <Message
                  name="You"
                  text={s.live.user}
                  user
                  time={clock(s.live.started)}
                />
              )}
              {s.live && (
                <Message
                  name={
                    s.profiles.find((p) => p.id === s.live!.agent)?.name ??
                    s.live.agent
                  }
                  model={s.live.model}
                  text={
                    s.live.text ||
                    (s.live.tool ? `Using ${s.live.tool}…` : "Thinking…")
                  }
                  time={duration(s.live.started)}
                  streaming
                />
              )}
            </scrollbox>
          )}
        </box>
      )}
      {showArtifact && (
        <box
          width={split ? `${s.panelWidth}%` : "100%"}
          minWidth={0}
          minHeight={0}
          flexDirection="column"
          border={["left"]}
          borderColor={c.border}
          paddingLeft={2}
        >
          <box height={2} flexShrink={0} flexDirection="row">
            <box flexGrow={1} />
            {artifact && (
              <Button
                active={artifact.pinned}
                onPress={() => send({ action: "pin", id: artifact.id })}
              >
                {artifact.pinned ? "◆ pinned" : "◇ pin"}
              </Button>
            )}
          </box>
          {s.artifacts.length > 1 && (
            <box height={2} flexShrink={0} flexDirection="row">
              {s.artifacts.slice(-3).map((a) => (
                <Button
                  key={a.id}
                  active={a.id === artifact?.id}
                  onPress={() => send({ action: "select_artifact", id: a.id })}
                >
                  {a.title.slice(0, 16)}
                </Button>
              ))}
            </box>
          )}
          {artifact ? (
            <scrollbox
              flexGrow={1}
              minHeight={0}
              focused={focused && !showChat}
              scrollX={false}
              contentOptions={{
                flexDirection: "column",
                gap: 1,
                paddingRight: 1,
              }}
            >
              <text fg={c.text}>
                <b>{clean(artifact.title)}</b>
              </text>
              <Rich
                text={artifact.content}
                code={artifact.kind === "code"}
                language={artifact.language}
              />
            </scrollbox>
          ) : null}
        </box>
      )}
    </box>
  );
}
function Message({
  name,
  text,
  user,
  time,
  streaming,
  model,
}: {
  model?: string;
  name: string;
  text: string;
  user?: boolean;
  time: string;
  streaming?: boolean;
}) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      gap={1}
      paddingX={1}
      paddingY={1}
      backgroundColor={user ? c.input : c.panel}
    >
      <text fg={user ? c.muted : c.text}>
        <b>{clean(name)}</b>
        {model && <span fg={c.muted}> · {clean(model)}</span>}
        <span fg={c.faint}>
          {" "}
          {time}
          {streaming ? " · streaming" : ""}
        </span>
      </text>
      {user ? <text fg={c.text}>{clean(text)}</text> : <Rich text={text} />}
    </box>
  );
}

function Tasks({
  state: s,
  selected,
  onSelect,
  focused,
  send,
  edit,
}: {
  state: Snapshot;
  selected?: string;
  onSelect: (id: string) => void;
  focused: boolean;
  send: Send;
  edit: (
    title: string,
    value: string,
    save: (v: string) => void,
    multiline?: boolean,
  ) => void;
}) {
  const tasks = [...s.tasks].reverse();
  const t = tasks.find((t) => t.id === selected) ?? tasks[0];
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Heading title="Tasks" />
      {!t ? (
        <box
          flexGrow={1}
          alignItems="center"
          justifyContent="center"
          flexDirection="column"
          gap={1}
        >
          <text fg={c.accent}>≡</text>
          <Muted>No tasks yet.</Muted>
        </box>
      ) : (
        <box flexGrow={1} minHeight={0} flexDirection="column" gap={1}>
          <select
            height={Math.min(7, Math.max(3, tasks.length * 2))}
            focused={focused}
            selectedIndex={Math.max(
              0,
              tasks.findIndex((t) => t.id === selected),
            )}
            options={tasks.map((t) => ({
              name: `#${t.id}  ${t.agent}  ·  ${t.status.replace("_", " ")}`,
              description: clean(t.prompt).replace(/\n/g, " ").slice(0, 120),
              value: t.id,
            }))}
            {...selectStyle()}
            onChange={(_, o) => {
              if (o) onSelect(o.value);
            }}
            onSelect={(_, o) => {
              if (o) onSelect(o.value);
            }}
          />
          <box flexDirection="row" height={2} flexShrink={0} gap={1}>
            {["queued", "running", "needs_input"].includes(t.status) && (
              <Button
                color={c.red}
                onPress={() =>
                  send({ action: "task", operation: "cancel", id: t.id })
                }
              >
                Cancel
              </Button>
            )}
            {["failed", "cancelled", "needs_input"].includes(t.status) &&
              !t.pendingInput && (
                <Button
                  onPress={() =>
                    send({ action: "task", operation: "retry", id: t.id })
                  }
                >
                  Retry
                </Button>
              )}
            {t.status === "needs_input" &&
              t.pendingInput?.kind !== "question" && (
                <>
                  <Button
                    color={c.green}
                    onPress={() =>
                      send({ action: "task", operation: "approve", id: t.id })
                    }
                  >
                    Approve
                  </Button>
                  <Button
                    onPress={() =>
                      send({ action: "task", operation: "decline", id: t.id })
                    }
                  >
                    Decline
                  </Button>
                </>
              )}
            {t.pendingInput?.kind === "question" && (
              <Button
                color={c.amber}
                onPress={() =>
                  edit(`Answer task ${t.id}`, "", (text) =>
                    send({
                      action: "task",
                      operation: "answer",
                      id: t.id,
                      text,
                    }),
                  )
                }
              >
                Answer
              </Button>
            )}
            {t.result && (
              <Button
                onPress={() =>
                  send({
                    action: "artifact",
                    title: `Task ${t.id} · ${t.agent}`,
                    content: t.result!,
                  })
                }
              >
                Display result
              </Button>
            )}
          </box>
          <scrollbox
            flexGrow={1}
            minHeight={0}
            scrollX={false}
            contentOptions={{ flexDirection: "column", gap: 1 }}
          >
            <text fg={c.faint}>
              #{t.id} · requested by {t.requester} · {clock(t.created)} ·{" "}
              {t.mode} · {t.access ?? "sandboxed"}
            </text>
            <text fg={c.text}>{clean(t.prompt)}</text>
            {t.question && <text fg={c.amber}>{clean(t.question)}</text>}
            {t.error && <text fg={c.red}>{clean(t.error)}</text>}
            {t.result && <Rich text={t.result} />}
            {!t.result && t.status === "running" && (
              <Muted>Running · {duration(t.created)}</Muted>
            )}
          </scrollbox>
        </box>
      )}
    </box>
  );
}

function AgentSettings({
  state: s,
  focused,
  onEdit,
  width,
  onOpenPrompt,
  onTest,
  onSentence,
  sendProfile,
}: {
  state: Snapshot;
  focused: boolean;
  onEdit: (profile: Profile, key: string) => void;
  sendProfile: Send;
  width: number;
  onOpenPrompt: () => void;
  onTest: () => void;
  onSentence: () => void;
}) {
  const p = s.profiles.find((p) => p.id === s.settingsAgent) ?? s.profiles[0]!;
  const { height } = useTerminalDimensions();
  const wide = width >= 88;
  const showPrompt = wide || (width >= 48 && height >= 36);
  const provider = p.voice.provider ?? s.ttsProvider ?? "pocket";
  const providerLabel =
    p.voice.provider || s.ttsProvider
      ? provider === "pocket"
        ? "Pocket"
        : "Kitten"
      : "Pocket (service default)";
  const field = (
    key: string,
    label: string,
    value: string,
  ): [string, string, string] => [key, label, value];
  const fields: [string, string, string][] = [
    [
      "enabled",
      "Enabled",
      p.enabled === false ? "[ ] Disabled" : "[×] Enabled",
    ],
    ["name", "Name", p.name],
    [
      "prompt",
      "Personality prompt",
      "Edit here · " + s.keybindings.promptFile + " opens TXT",
    ],
    ["model", "Model", p.model],
    ["reasoning", "Reasoning", p.reasoning === "none" ? "Basic" : "High"],
    ["verbosity", "Response detail", p.verbosity ?? "Profile default"],
    ["temperature", "Temperature", String(p.temperature ?? "Provider default")],
    ["provider", "Voice provider", providerLabel],
    field(
      provider,
      provider === "pocket" ? "Pocket voice" : "Kitten voice",
      p.voice[provider],
    ),
    ...(provider === "kitten"
      ? [
          field(
            "speed",
            "Speech speed",
            `${p.voice.speed.toFixed(2)}×  ${"─".repeat(Math.round((p.voice.speed - 0.5) * 10))}●${"─".repeat(15 - Math.round((p.voice.speed - 0.5) * 10))}`,
          ),
        ]
      : []),
    [
      "test",
      "Test speech",
      s.engineConnected
        ? "Play current voice settings"
        : "Requires running audio service",
    ],
    ["sentence", "Test sentence", s.testSentence],
    [
      "tools",
      "Tools →",
      p.tools ? `${p.tools.length} enabled` : "Profile defaults",
    ],
  ];
  const [selected, setSelected] = useState(0);
  useKeyboard((key) => {
    if (!focused) return;
    const field = fields[selected]?.[0];
    if (
      key.name === "delete" &&
      ["provider", "pocket", "kitten", "speed"].includes(field ?? "")
    ) {
      key.preventDefault();
      const voice = { ...p.voice };
      if (field === "provider") delete voice.provider;
      if (field === "pocket" || field === "kitten") voice[field] = "default";
      if (field === "speed") voice.speed = 1;
      sendProfile({ action: "profile", profile: { ...p, voice } });
      return;
    }
    if (field === "speed" && ["left", "right"].includes(key.name)) {
      key.preventDefault();
      const speed = Math.min(
        2,
        Math.max(
          0.5,
          Math.round(
            (p.voice.speed + (key.name === "left" ? -0.05 : 0.05)) * 100,
          ) / 100,
        ),
      );
      sendProfile({
        action: "profile",
        profile: { ...p, voice: { ...p.voice, speed } },
      });
    }
  });
  return (
    <box flexGrow={1} minHeight={0} minWidth={0} flexDirection="column">
      <Heading title={p.name} />
      <box
        flexGrow={1}
        minHeight={0}
        minWidth={0}
        backgroundColor={c.panel}
        padding={1}
        flexDirection={wide ? "row" : "column"}
        gap={wide ? 3 : 1}
      >
        <box
          width={wide ? Math.max(24, Math.floor((width - 5) / 3)) : "100%"}
          flexGrow={wide ? 0 : 1}
          minHeight={0}
          flexShrink={wide ? 0 : 1}
          flexBasis={wide ? undefined : 0}
          flexDirection="column"
        >
          <text fg={c.faint}>@{p.id}</text>
          <text fg={c.text}>
            <b>{clean(p.name)}</b>
          </text>
          <select
            flexGrow={1}
            minHeight={0}
            marginTop={1}
            focused={focused}
            {...selectStyle()}
            options={fields.map(([value, name, description]) => ({
              value,
              name,
              description: clean(description),
            }))}
            showDescription
            itemSpacing={1}
            onChange={(index) => setSelected(index)}
            onSelect={(_, o) => {
              if (o) onEdit(p, o.value);
            }}
          />
        </box>
        {showPrompt && (
          <box
            width={
              wide ? Math.max(30, Math.floor(((width - 5) * 2) / 3)) : "100%"
            }
            flexGrow={0}
            flexShrink={1}
            height={
              wide
                ? Math.min(18, Math.max(9, Math.floor((height - 8) * 0.58)))
                : 8
            }
            minWidth={0}
            minHeight={0}
            flexDirection="column"
          >
            <text fg={c.faint}>Prompt</text>
            <scrollbox
              flexGrow={1}
              minHeight={0}
              scrollX={false}
              backgroundColor={c.panel}
              padding={1}
            >
              <text fg={c.muted} wrapMode="word">
                {clean(p.prompt)}
              </text>
            </scrollbox>
          </box>
        )}
      </box>
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text fg={c.faint}>Del reset </text>
        <Button onPress={onTest}>{s.keybindings.tasks} test speech</Button>
        <Button onPress={onSentence}>{s.keybindings.layout} sentence</Button>
        {width >= 70 && (
          <Button onPress={onOpenPrompt}>
            {s.keybindings.promptFile} prompt TXT
          </Button>
        )}
      </box>
      {!!s.speechTest && <text fg={c.muted}>{clean(s.speechTest)}</text>}
    </box>
  );
}

function AppearanceSettings({
  state: s,
  focused,
  send,
  choose,
}: {
  state: Snapshot;
  focused: boolean;
  send: Send;
  choose: (title: string, items: Choice[]) => void;
}) {
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Heading
        title="UI"
        detail="Colors and background apply immediately and save to this room."
      />
      <select
        focused={focused}
        flexGrow={1}
        minHeight={0}
        {...selectStyle()}
        itemSpacing={1}
        options={[
          {
            name: "Theme colors",
            description: s.appearance.theme,
            value: "theme",
          },
          {
            name: "Background",
            description:
              s.appearance.background === "transparent"
                ? "Terminal default · preserves opacity and blur"
                : "Solid theme color",
            value: "background",
          },
        ]}
        onSelect={(_, o) => {
          if (o?.value === "theme")
            choose(
              "Theme colors",
              (["neutral", "blue", "forest", "plum"] as const).map((theme) => ({
                name: theme[0]!.toUpperCase() + theme.slice(1),
                description:
                  theme === "blue" ? "Classic blue background design" : "",
                run: () =>
                  send({
                    action: "appearance",
                    appearance: { ...s.appearance, theme },
                  }),
              })),
            );
          if (o?.value === "background")
            choose(
              "Background",
              (["transparent", "solid"] as const).map((background) => ({
                name:
                  background === "transparent"
                    ? "Transparent / terminal default"
                    : "Solid theme color",
                description: "",
                run: () =>
                  send({
                    action: "appearance",
                    appearance: { ...s.appearance, background },
                  }),
              })),
            );
        }}
      />
    </box>
  );
}

function Models({
  state: s,
  sort,
  setSort,
  focused,
}: {
  state: Snapshot;
  sort: "usd" | "agent" | "model";
  setSort: (v: "usd" | "agent" | "model") => void;
  focused: boolean;
}) {
  const rows = [...s.usage].sort((a, b) =>
    sort === "usd" ? b.usd - a.usd : a[sort].localeCompare(b[sort]),
  );
  const max = Math.max(...rows.map((r) => r.usd), 0.000001);
  const total = rows.reduce((n, r) => n + r.usd, 0);
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      focused={focused}
      scrollX={false}
      contentOptions={{ flexDirection: "column", gap: 1, paddingRight: 1 }}
    >
      <Heading title="Usage" />
      <box flexDirection="row" height={3} flexShrink={0} gap={3}>
        <text fg={c.accent}>
          <b>{money(total)}</b>
          <span fg={c.muted}> recorded</span>
        </text>
        <text fg={c.text}>
          {rows.reduce((n, r) => n + r.input + r.output, 0).toLocaleString()}
          <span fg={c.muted}> tokens</span>
        </text>
      </box>
      <box flexDirection="row">
        <Muted>Sort </Muted>
        {(["usd", "agent", "model"] as const).map((v) => (
          <Button key={v} active={v === sort} onPress={() => setSort(v)}>
            {v === "usd" ? "Cost" : v === "agent" ? "Agent" : "Model"}
          </Button>
        ))}
      </box>
      {rows.length ? (
        rows.map((r) => (
          <box
            key={`${r.agent}:${r.model}`}
            flexShrink={0}
            flexDirection="column"
          >
            <text fg={c.text}>
              {r.agent} <span fg={c.faint}>{r.model}</span>
            </text>
            <text fg={c.accent}>
              {"━".repeat(Math.max(1, Math.round((r.usd / max) * 20)))}
              <span fg={c.muted}>
                {" "}
                {r.costUnknown ? "cost unavailable" : money(r.usd)} ·{" "}
                {r.input.toLocaleString()} in / {r.output.toLocaleString()} out
                {r.estimated ? " · estimate" : ""}
              </span>
            </text>
          </box>
        ))
      ) : (
        <Muted>No recorded model usage yet.</Muted>
      )}
    </scrollbox>
  );
}

function Hardware({
  state: s,
  focused,
  send,
  choose,
  edit,
}: {
  state: Snapshot;
  focused: boolean;
  send: Send;
  choose: (title: string, items: Choice[]) => void;
  edit: (
    title: string,
    value: string,
    save: (v: string) => void,
    multiline?: boolean,
  ) => void;
}) {
  const h = s.hardware;
  const gain = (kind: "source" | "sink", value: number) =>
    edit(
      kind === "source" ? "Microphone gain · 0–100%" : "Output volume · 0–100%",
      String(value),
      (raw) => {
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 100 || !raw.trim())
          throw new Error("Enter an integer between 0 and 100");
        send({ action: "hardware", kind, operation: "volume", value });
      },
    );
  const device = (kind: "source" | "sink") =>
    choose(
      kind === "source" ? "Input device" : "Output device",
      (kind === "source" ? h.sources : h.sinks).map((d) => ({
        name: d.description || d.name,
        description: d.name,
        run: () =>
          send({
            action: "hardware",
            kind,
            operation: "device",
            value: d.name,
          }),
      })),
    );
  const options = [
    {
      name: `Microphone  ${h.muted ? "MUTED" : "open"}`,
      description: "",
      value: () =>
        send({
          action: "hardware",
          kind: "source",
          operation: "mute",
          value: !h.muted,
        }),
    },
    {
      name: `Input gain  ${h.input}%  ${"━".repeat(Math.round(Math.min(h.input, 100) / 5))}`,
      description: "",
      value: () => gain("source", h.input),
    },
    {
      name: `Output volume  ${h.output}%  ${"━".repeat(Math.round(Math.min(h.output, 100) / 5))}`,
      description: "",
      value: () => gain("sink", h.output),
    },
    {
      name: `Input device  ${h.sources.find((d) => d.name === h.source)?.description || h.source}`,
      description: "",
      value: () => device("source"),
    },
    {
      name: `Output device  ${h.sinks.find((d) => d.name === h.sink)?.description || h.sink}`,
      description: "",
      value: () => device("sink"),
    },
    {
      name: "Refresh audio devices",
      description: "",
      value: () => send({ action: "refresh" }),
    },
  ];
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Heading title="Hardware" />
      {!h.available ? (
        <box flexDirection="column" gap={1}>
          <text fg={c.amber}>{h.error ?? "Reading audio devices…"}</text>
          <Button onPress={() => send({ action: "refresh" })}>↻ Refresh</Button>
        </box>
      ) : (
        <select
          flexGrow={1}
          minHeight={0}
          focused={focused}
          {...selectStyle()}
          options={options}
          showDescription={false}
          itemSpacing={1}
          onSelect={(_, o) => {
            if (o) o.value();
          }}
        />
      )}
    </box>
  );
}
function Diagnostics({
  state: s,
  focused,
}: {
  state: Snapshot;
  focused: boolean;
}) {
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Heading
        title="Diagnostics"
        detail={`Session ${s.conversation.slice(0, 8)} · ${s.engineConnected ? "audio engine attached" : "audio offline"} · Codex ${s.codexAccess}`}
      />
      <scrollbox
        flexGrow={1}
        minHeight={0}
        focused={focused}
        stickyScroll
        stickyStart="bottom"
        scrollX={false}
        contentOptions={{ flexDirection: "column", gap: 1 }}
      >
        {s.logs.map((l, i) => (
          <box key={`${l.ts}:${i}`} flexDirection="column" flexShrink={0}>
            <text fg={l.event.includes("error") ? c.red : c.accent}>
              <span fg={c.faint}>{clock(l.ts)} </span>
              {l.event}
            </text>
            <text fg={c.muted}>{clean(JSON.stringify(l.data))}</text>
          </box>
        ))}
        {!s.logs.length && (
          <Muted>Events appear here as you interact with the room.</Muted>
        )}
      </scrollbox>
      <text fg={c.faint}>
        Current backend events · audio pipeline timings remain in logs/*.jsonl
      </text>
    </box>
  );
}
