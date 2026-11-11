import { realpath } from "node:fs/promises";
import { checkCodexPermission, codexPrompt, fullAccess, type CodexOptions } from "./codex.js";
import { CodexRpc, type RpcMessage } from "./codex-rpc.js";
import { NeedsInput, type TaskInteraction, type TaskRunner } from "./tasks.js";

/** The coding job stays alive while approvals/questions are answered through the room. */
export function codexAppServerRunner(options: CodexOptions): TaskRunner {
  return async (task, signal, progress, interaction) => {
    checkCodexPermission(task, options);
    const project = await realpath(options.project); signal.throwIfAborted();
    const full = fullAccess(task);
    const sandbox = full ? "danger-full-access" : task.mode === "modify" ? "workspace-write" : "read-only";
    const approvalPolicy = full ? "never" : "on-request";
    const sandboxPolicy = full ? { type: "dangerFullAccess" } : task.mode === "modify"
      ? { type: "workspaceWrite", writableRoots: [project], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
      : { type: "readOnly", networkAccess: false };
    const rpc = new CodexRpc(options.executable, project);
    let threadId = "", turnId = "", answer = "", usage: unknown, settled = false;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void finished.catch(() => {});
    const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    const requests = new Map<string | number, AbortController>();
    let requestChain = Promise.resolve();
    rpc.on("failure", fail);
    rpc.on("notification", (m: RpcMessage) => {
      const p = m.params;
      if (m.method === "serverRequest/resolved") { const request = requests.get(p?.requestId); request?.abort(new Error("Codex cleared this request")); return; }
      if (p?.threadId !== threadId || (turnId && p?.turnId && p.turnId !== turnId)) return;
      if (m.method === "turn/started" && p.turn?.id) turnId = p.turn.id;
      if (m.method === "item/completed" && p.item?.type === "agentMessage") answer = String(p.item.text ?? "").slice(-24000);
      if (m.method === "thread/tokenUsage/updated") usage = p.tokenUsage;
      if (m.method === "item/started" || m.method === "item/completed") progress(String(p.item?.type ?? "item"));
      if (m.method === "turn/completed") {
        if (p.turn?.id !== turnId && turnId) return;
        if (p.turn?.status !== "completed") fail(new Error(`Codex turn ${p.turn?.status ?? "failed"}: ${String(p.turn?.error?.message ?? "no result").slice(0, 600)}`));
        else if (!answer.trim()) fail(new Error("Codex completed without a final answer"));
        else if (!settled) { settled = true; resolve(); }
      }
    });
    rpc.on("request", (m: RpcMessage) => {
      if (m.params?.threadId !== threadId || (turnId && m.params?.turnId && m.params.turnId !== turnId)) {
        rpc.send({ id: m.id, error: { code: -32602, message: "Request does not belong to this task" } }); return;
      }
      const controller = new AbortController(); requests.set(m.id!, controller);
      requestChain = requestChain.then(async () => {
        if (controller.signal.aborted || signal.aborted || settled) return;
        try {
          const value = await respond(m, interaction, AbortSignal.any([signal, controller.signal]));
          if (!controller.signal.aborted && !signal.aborted && !settled) rpc.send({ id: m.id, result: value });
        } catch (error) { if (!controller.signal.aborted && !signal.aborted && !settled) fail(error); }
        finally { requests.delete(m.id!); }
      }).catch(fail);
    });
    const abort = () => {
      if (threadId && turnId) void rpc.request("turn/interrupt", { threadId, turnId }, 1000).catch(() => {}).finally(() => rpc.terminate());
      else rpc.terminate();
      fail(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await rpc.request("initialize", { clientInfo: { name: "vc_voice_room", title: "VC Voice Room", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      signal.throwIfAborted(); rpc.send({ method: "initialized", params: {} });
      const thread = await rpc.request(task.threadId ? "thread/resume" : "thread/start", {
        ...(task.threadId ? { threadId: task.threadId, excludeTurns: true } : {}),
        cwd: project, sandbox, approvalPolicy, approvalsReviewer: "user", ...(options.model ? { model: options.model } : {}),
      });
      threadId = thread?.thread?.id;
      if (typeof threadId !== "string" || !threadId) throw new Error("Codex App Server returned no thread ID");
      interaction?.checkpoint(threadId); signal.throwIfAborted();
      const started = await rpc.request("turn/start", { threadId, cwd: project, approvalPolicy, approvalsReviewer: "user", sandboxPolicy,
        input: [{ type: "text", text: codexPrompt(task, project), text_elements: [] }], ...(options.model ? { model: options.model } : {}) });
      turnId = started?.turn?.id ?? turnId;
      if (!turnId) throw new Error("Codex App Server returned no turn ID");
      signal.throwIfAborted(); await finished;
      return { text: answer, threadId, usage };
    } finally {
      signal.removeEventListener("abort", abort);
      for (const request of requests.values()) request.abort();
      await rpc.close();
    }
  };
}

async function respond(m: RpcMessage, interaction: TaskInteraction | undefined, signal: AbortSignal): Promise<object> {
  const p = m.params;
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(m.method!)) {
    if (!interaction) throw new NeedsInput("Codex needs approval, but this client does not support voice approvals");
    const question = m.method === "item/commandExecution/requestApproval"
      ? `Codex wants ${p.networkApprovalContext ? `network access to ${p.networkApprovalContext.host}` : `to run ${String(p.command ?? "a command").slice(0, 600)}`}. ${p.reason ?? ""}`
      : m.method === "item/fileChange/requestApproval" ? `Codex wants to change files${p.grantRoot ? ` in ${p.grantRoot}` : ""}. ${p.reason ?? ""}`
      : `Codex requests additional filesystem or network permissions. ${p.reason ?? ""}`;
    const reply = interaction.fullAccess() ? { decision: "accept" as const } : await interaction.request({ kind: "approval", question: question.slice(0, 1600) + " Say approve the request, or decline it." }, signal);
    const accepted = "decision" in reply && reply.decision === "accept";
    if (m.method === "item/permissions/requestApproval") return { permissions: accepted ? p.permissions ?? {} : {}, scope: "turn" };
    return { decision: accepted ? "accept" : "decline" };
  }
  if (m.method === "item/tool/requestUserInput" || m.method === "tool/requestUserInput") {
    if (!interaction || !Array.isArray(p.questions)) throw new NeedsInput("Codex needs an answer, but this client cannot route the question");
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of p.questions.slice(0, 3)) {
      const options = Array.isArray(question.options) ? question.options.map((o: any) => o.label).join(", ") : "";
      const reply = await interaction.request({ kind: "question", question: `${String(question.question).slice(0, 1000)}${options ? ` Options: ${options}.` : ""}` }, signal);
      if (!("text" in reply)) throw new Error("Codex's question needs a spoken answer");
      answers[String(question.id)] = { answers: [reply.text] };
    }
    return { answers };
  }
  // Unsupported integrations must never hang waiting for a terminal prompt.
  if (m.method === "mcpServer/elicitation/request") return { action: "decline", content: null };
  throw new Error(`Unsupported Codex App Server request: ${m.method}`);
}
