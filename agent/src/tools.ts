import type { AgentTool } from "@earendil-works/pi-agent-core";

/** Register additional capabilities here. All tools must honor the abort signal. */
export const tools: AgentTool[] = [{
  name: "current_time", label: "Current time", description: "Get the current date and time in a timezone.",
  parameters: { type: "object", properties: { timezone: { type: "string", description: "IANA timezone, e.g. Europe/London" } }, required: [], additionalProperties: false },
  execute: async (_id, params: unknown, signal) => {
    signal?.throwIfAborted();
    const timezone = (params as { timezone?: string }).timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const text = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "full", timeStyle: "long" }).format(new Date());
    return { content: [{ type: "text", text }], details: { timezone } };
  },
}];
