import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

interface PlaybackNote {
  role: "playback_note";
  text: string;
  timestamp: number;
}
interface RoomNote { role: "room_note"; text: string; timestamp: number }
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages { playback_note: PlaybackNote; room_note: RoomNote }
}

export function trimHistory(messages: AgentMessage[], maxTurns: number): AgentMessage[] {
  const users = messages.flatMap((m, i) => m.role === "user" ? [i] : []);
  const start = users.length > maxTurns ? users[users.length - maxTurns]! : 0;
  if (!start) return messages;
  // Notes belong to their real user turn; never count them as additional turns.
  return [...messages.slice(0, start).filter(m => m.role === "system"), ...messages.slice(start)];
}

export function toLlmMessages(messages: AgentMessage[]): Message[] {
  return messages.map(m => m.role === "playback_note" || m.role === "room_note"
    ? { role: "user", content: m.text, timestamp: m.timestamp }
    : m);
}

export function retainInterruptedReply(messages: AgentMessage[], baseline: number, playbackElapsedMs?: number | null): AgentMessage[] {
  const tail = messages.slice(baseline);
  const completedTools = new Set(tail.flatMap(m => m.role === "toolResult" ? [m.toolCallId] : []));
  const retained = tail.flatMap<AgentMessage>(m => {
    if (m.role !== "assistant" || m.stopReason !== "aborted") return [m];
    // Pi omits aborted messages when preparing provider requests. Keep partial prose
    // as context, but never replay unfinished/unexecuted tool-call arguments.
    const content = m.content.filter(c => c.type === "text" || (c.type === "toolCall" && completedTools.has(c.id)));
    return content.length ? [{ ...m, content, stopReason: "stop", errorMessage: undefined }] : [];
  });
  const timing = playbackElapsedMs === null
    ? "Playback had not been observed to start."
    : playbackElapsedMs === undefined
      ? "Playback progress is unknown."
      : `Playback stopped approximately ${(playbackElapsedMs / 1000).toFixed(1)} seconds after it began (elapsed time, not word alignment).`;
  return [...messages.slice(0, baseline), ...retained, {
    role: "playback_note", timestamp: Date.now(),
    text: `[Playback interruption: ${timing} The preceding assistant text is retained for context, but the user may not have heard all of it. Generation may also have stopped mid-sentence. Do not assume the whole answer was heard.]`,
  }];
}
