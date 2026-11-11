import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { toLlmMessages, trimHistory } from "./history.js";
import type { Profile } from "./profiles.js";

export class PiFactory {
  readonly models = createModels();
  constructor(readonly maxTokens: number, readonly historyTurns: number, readonly maxUsd = 0.25) { this.models.setProvider(openrouterProvider()); }
  create(profile: Profile, tools: AgentTool[], messages: AgentMessage[], background = false): Agent {
    const model = this.models.getModel("openrouter", profile.model);
    if (!model) throw new Error(`Model ${profile.model} missing from Pi catalog; configure the agent model or update Pi`);
    let calls = 0, requests = 0, cost = 0;
    const agent = new Agent({
      initialState: { model, systemPrompt: profile.prompt + (profile.verbosity ? ` Response detail: ${profile.verbosity}.` : ""), tools: profile.tools ? tools.filter(t => profile.tools!.includes(t.name)) : tools, thinkingLevel: profile.reasoning === "none" ? "off" : "high" },
      streamFn: (m, context, options) => {
        if (++requests > 9 || cost >= this.maxUsd) throw new Error("Agent request/cost budget exceeded");
        return this.models.streamSimple({ ...m, baseUrl: process.env.VC_OPENROUTER_BASE_URL ?? m.baseUrl }, context, { ...options, maxTokens: this.maxTokens, ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }) });
      },
      getApiKey: () => process.env.OPENROUTER_API_KEY,
      transformContext: async values => trimHistory(values, this.historyTurns), convertToLlm: toLlmMessages,
      onPayload: payload => { const p = payload as Record<string, unknown>; p.reasoning = { effort: profile.reasoning }; if (profile.reasoning === "none") p.provider = { sort: "latency" }; return p; },
      beforeToolCall: async (_call, signal) => { signal?.throwIfAborted(); return ++calls > 8 || cost >= this.maxUsd ? { block: true, terminate: true, reason: "Tool/cost budget exceeded" } : undefined; },
      maxRetryDelayMs: 1000, toolExecution: "sequential",
    });
    // Never carry another agent's system prompt/tool declarations across a switch.
    agent.state.messages = [...agent.state.messages, ...messages.filter(m => m.role !== "system")];
    agent.subscribe(event => { if (event.type === "message_end" && event.message.role === "assistant") cost += event.message.usage.cost.total; });
    return agent;
  }
}
