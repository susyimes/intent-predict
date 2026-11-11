// A stand-in for `kimi acp` in tests: speaks just enough ACP, asks for one permission during a
// turn, and logs every request it receives (as JSON lines) to the file named by its first argument.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const logFile = process.argv[2];
const log = (entry) => appendFileSync(logFile, JSON.stringify(entry) + '\n');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
let seq = 1000;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => {
  const id = ++seq;
  waiting.set(id, resolve);
  send({ id, method, params });
});

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = params.prompt?.map((p) => p.text).join('') ?? '';
  if (text.includes('INTENT PREDICTION')) {
    if (text.includes('USE_TOOL')) update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 's1', title: 'Read', kind: 'read', status: 'pending' });
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'classifying' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"intent":"run_tests",' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '"confidence":0.9,"slots":{}}' } });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  const cwd = process.cwd();
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } });
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', kind: 'execute', status: 'pending', content: [] });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', rawInput: { command: 'npm test' } });
  const decision = await ask('session/request_permission', {
    sessionId,
    toolCall: { toolCallId: 'c1', title: 'Bash', kind: 'execute' },
    options: [
      { optionId: 'yes-always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'yes', kind: 'allow_once', name: 'Allow' },
      { optionId: 'no-always', kind: 'reject_always', name: 'Always reject' },
      { optionId: 'no', kind: 'reject_once', name: 'Reject' },
    ],
  });
  log({ permission: decision });
  const allowed = decision?.outcome?.outcome === 'selected' && String(decision.outcome.optionId).startsWith('yes');
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: allowed ? 'completed' : 'failed', rawOutput: { output: allowed ? 'ran' : 'denied' } });
  const file = join(cwd, 'src', 'a.ts');
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Write', kind: 'edit', status: 'pending' });
  update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'completed', rawInput: { path: file, content: 'x' }, locations: [{ path: file }] });
  update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
  send({ id, result: { stopReason: 'end_turn' } });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result ?? { error: msg.error });
    waiting.delete(msg.id);
    return;
  }
  log({ method: msg.method, params: msg.params });
  if (msg.id === undefined) return;                       // notifications: session/cancel
  switch (msg.method) {
    case 'initialize':
      return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    case 'session/new':
      return send({ id: msg.id, result: { sessionId: 'session_fake-new', configOptions: [], modes: { currentModeId: 'default' } } });
    case 'session/resume':
      if (msg.params.sessionId === 'session_missing') return send({ id: msg.id, error: { code: -32602, message: 'Unknown sessionId' } });
      return send({ id: msg.id, result: { configOptions: [], modes: { currentModeId: 'default' } } });
    case 'session/prompt':
      return void prompt(msg.id, msg.params);
    case 'session/delete':
      return send({ id: msg.id, result: {} });
    default:
      return send({ id: msg.id, error: { code: -32601, message: 'unknown method' } });
  }
});
