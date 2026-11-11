#!/usr/bin/env node
// Deterministic protocol fixture. Never calls a model or executes a command.
const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
let turn, scenario, denied = false, policy;
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const notification = (method, params) => send({ method, params });
const audit = m => fs.appendFileSync('rpc-audit.jsonl', JSON.stringify(m) + '\n');
const resolved = id => notification('serverRequest/resolved', { threadId: 'fixture-thread', requestId: id });
function finish(text, write = false) {
  if (write) fs.writeFileSync('answer.txt', '42\n');
  notification('item/completed', { threadId: 'fixture-thread', turnId: turn, item: { type: 'agentMessage', id: 'answer', text } });
  notification('thread/tokenUsage/updated', { threadId: 'fixture-thread', turnId: turn, tokenUsage: { last: { inputTokens: 10, outputTokens: 8 } } });
  notification('turn/completed', { threadId: 'fixture-thread', turn: { id: turn, status: 'completed' } });
}
function approval() {
  send({ id: 'approval-1', method: scenario.includes('PERMISSIONS') ? 'item/permissions/requestApproval' : 'item/commandExecution/requestApproval', params: { threadId: 'fixture-thread', turnId: turn, command: 'echo approved', reason: 'Test the voice approval bridge', permissions: { network: { enabled: true } } } });
}
input.on('line', line => {
  const m = JSON.parse(line); audit(m);
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fixture' } });
  else if (m.method === 'thread/start' || m.method === 'thread/resume') {
    policy = m.params.approvalPolicy;
    send({ id: m.id, result: { thread: { id: 'fixture-thread' } } });
  } else if (m.method === 'turn/start') {
    turn = 'fixture-turn'; scenario = m.params.input[0].text;
    send({ id: m.id, result: { turn: { id: turn, status: 'inProgress' } } });
    notification('turn/started', { threadId: 'fixture-thread', turn: { id: turn } });
    if (scenario.includes('FOREVER')) return;
    if (scenario.includes('RPC_FAIL')) { notification('turn/completed', { threadId: 'fixture-thread', turn: { id: turn, status: 'failed', error: { message: 'fixture failure' } } }); return; }
    if (policy === 'never') { finish('Created answer.txt with full access.', true); return; }
    approval();
    if (scenario.includes('CLEAR_REQUEST')) setTimeout(() => { resolved('approval-1'); finish('The approval request expired.'); }, 30);
  } else if (m.method === 'turn/interrupt') {
    send({ id: m.id, result: {} });
    notification('turn/completed', { threadId: 'fixture-thread', turn: { id: turn, status: 'interrupted' } });
  } else if (m.id === 'approval-1' && m.result) {
    resolved(m.id); denied = m.result.decision === 'decline' || (m.result.permissions && !m.result.permissions.network);
    if (denied) { finish('The user declined; no files changed.'); return; }
    if (scenario.includes('INPUT_FLOW')) send({ id: 'question-1', method: 'item/tool/requestUserInput', params: { threadId: 'fixture-thread', turnId: turn, questions: [{ id: 'database', question: 'Which database should I use?', options: [{ label: 'SQLite' }, { label: 'PostgreSQL' }] }] } });
    else finish('Created answer.txt after voice approval.', true);
  } else if (m.id === 'question-1' && m.result) {
    resolved(m.id); finish('User chose ' + m.result.answers.database.answers[0], true);
  }
});
input.on('close', () => process.exit(0));
