// Kimi Code: wire-log replay, and ACP driving and classification against a stand-in agent.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '../../core/src/index.ts';
import type { AgentEnv } from '../src/agent.ts';
import { AcpLineMapper, kimiAdapter, kimiAdvanced, readKimiHistory } from '../src/kimi.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const loop = (event: object) => ({ type: 'context.append_loop_event', agentId: 'main', event });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ip-kimi-'));
  const log = join(dir, 'acp.log');
  writeFileSync(log, '');
  let n = 0;
  const env: AgentEnv = {
    home: dir, bins: { kimi: { command: process.execPath, prefix: [FAKE, log] } }, grokArgs: [],
    scratch: () => dir,
    promptFile: (text) => {
      const file = join(dir, `p${++n}.txt`);
      writeFileSync(file, text);
      return file;
    },
  };
  const requests = (): Array<Record<string, any>> => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, env, requests, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the wire log replays user turns; prompts from background tasks continue them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-kimi-wire-'));
  const file = join(dir, 'wire.jsonl');
  try {
    writeFileSync(file, jsonl([
      { type: 'metadata', protocol_version: 1 },
      { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: '修一下登录' }], origin: { kind: 'user' } },
      loop({ type: 'step.begin', turnId: 'k1', step: 1 }),
      loop({ type: 'content.part', turnId: 'k1', step: 1, part: { type: 'think', text: 'hmm' } }),
      loop({ type: 'content.part', turnId: 'k1', step: 1, part: { type: 'text', text: 'Let me run the tests.' } }),
      loop({ type: 'tool.call', turnId: 'k1', step: 1, toolCallId: 'b1', name: 'Bash', args: { command: 'npm test' } }),
      loop({ type: 'tool.result', toolCallId: 'b1', result: { output: '1 failing', isError: true } }),
      loop({ type: 'tool.call', turnId: 'k1', step: 2, toolCallId: 'e1', name: 'Edit', args: { path: 'D:\\proj\\src\\login.ts', old_string: 'a', new_string: 'b' } }),
      loop({ type: 'tool.result', toolCallId: 'e1', result: { output: 'edited' } }),
      { type: 'turn.ended', agentId: 'main', turnId: 'k1', reason: 'completed' },
      { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: '<task-notification>' }], origin: { kind: 'task' } },
      loop({ type: 'content.part', turnId: 'k2', step: 1, part: { type: 'text', text: '改好了，要跑一下测试吗？' } }),
      { type: 'turn.ended', agentId: 'main', turnId: 'k2', reason: 'completed' },
    ]));
    let n = 0;
    const replay = readKimiHistory(file, 'D:\\proj', 3, () => `t${++n}`)!;
    assert.equal(replay.turns.length, 1, 'the task prompt is part of the user turn, not a turn of its own');
    const events = replay.turns[0]!;
    assert.deepEqual(events.map((e) => e.type), ['turn.started', 'message.user', 'message.agent', 'tool.call', 'tool.result',
      'tool.call', 'tool.result', 'artifact', 'message.agent', 'turn.completed']);
    assert.equal(events[1]!.type === 'message.user' && events[1]!.text, '修一下登录');
    assert.deepEqual(events[2]!.type === 'message.agent' && [events[2]!.text, events[2]!.final], ['Let me run the tests.', false]);
    assert.equal(events[3]!.type === 'tool.call' && events[3]!.command, 'npm test');
    assert.equal(events[4]!.type === 'tool.result' && events[4]!.status, 'error');
    assert.equal(events[7]!.type === 'artifact' && events[7]!.ref, 'src/login.ts');
    assert.deepEqual(events[8]!.type === 'message.agent' && [events[8]!.text, events[8]!.final], ['改好了，要跑一下测试吗？', true]);

    assert.equal(kimiAdvanced(file, replay.fingerprint), false);
    appendFileSync(file, jsonl([{ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: '再看看' }], origin: { kind: 'user' } }]));
    assert.equal(kimiAdvanced(file, replay.fingerprint), true, 'the user started a turn in Kimi itself');
    assert.equal(readKimiHistory(file, 'D:\\proj', 3, () => 'x', replay.fingerprint), undefined, 'a running turn is not replayed yet');
    appendFileSync(file, jsonl([
      loop({ type: 'content.part', turnId: 'k3', step: 1, part: { type: 'text', text: '看过了。' } }),
      { type: 'turn.ended', agentId: 'main', turnId: 'k3', reason: 'cancelled' },
    ]));
    const later = readKimiHistory(file, 'D:\\proj', 3, () => `t${++n}`, replay.fingerprint)!;
    assert.deepEqual(later.turnIds, ['t2']);
    const last = later.turns[0]!.at(-1)!;
    assert.equal(last.type === 'turn.completed' && last.status, 'interrupted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ACP tool calls are held back until they finish, with their late arguments merged', () => {
  const mapper = new AcpLineMapper();
  assert.deepEqual(mapper.push({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Bash', kind: 'execute', status: 'pending' }), []);
  assert.deepEqual(mapper.push({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'in_progress', rawInput: { command: 'ls' } }), []);
  const done = mapper.push({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { output: 'a' } });
  assert.deepEqual(done.map((l) => l.type), ['tool_call', 'tool_call_update']);
  assert.deepEqual(done[0]!.rawInput, { command: 'ls' });
  assert.deepEqual(mapper.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } }), [], 'thoughts are not messages');
});

test('a Kimi turn resumes the session over ACP and refuses its permission request', async () => {
  const w = workspace();
  try {
    const events: AgentEvent[] = [];
    const infos: string[] = [];
    const out = await kimiAdapter.runTurn('run the tests', {
      env: w.env, turnId: 't1', cwd: w.dir, id: 'session_abc-1', emit: (e) => events.push(...e), info: (m) => infos.push(m),
    });
    assert.equal(out.sessionId, 'session_abc-1');
    const reqs = w.requests();
    assert.deepEqual(reqs.filter((r) => r.method).map((r) => r.method), ['initialize', 'session/resume', 'session/prompt']);
    assert.deepEqual(reqs.find((r) => r.permission)?.permission, { outcome: { outcome: 'selected', optionId: 'no' } },
      'rejected for this call only: never allowed, never an "always" option');
    assert.ok(infos.some((m) => m.includes('refused a permission request: Bash')), infos.join(' | '));
    assert.deepEqual(events.map((e) => e.type),
      ['message.agent', 'tool.call', 'tool.result', 'tool.call', 'tool.result', 'artifact', 'message.agent', 'turn.completed']);
    const call = events[1]!;
    assert.deepEqual(call.type === 'tool.call' && [call.kind, call.command], ['execute', 'npm test']);
    assert.equal(events[2]!.type === 'tool.result' && events[2]!.status, 'error');
    assert.equal(events[5]!.type === 'artifact' && events[5]!.ref, 'src/a.ts');
    assert.deepEqual(events[6]!.type === 'message.agent' && [events[6]!.text, events[6]!.final], ['Done.', true]);
    assert.equal(events[7]!.type === 'turn.completed' && events[7]!.status, 'completed');
  } finally {
    w.done();
  }
});

test('without a session id Kimi starts one; an unknown session fails the turn', async () => {
  const w = workspace();
  try {
    const fresh = await kimiAdapter.runTurn('hi', { env: w.env, turnId: 't1', cwd: w.dir, emit: () => {}, info: () => {} });
    assert.equal(fresh.sessionId, 'session_fake-new');
    const events: AgentEvent[] = [];
    const infos: string[] = [];
    await kimiAdapter.runTurn('hi', { env: w.env, turnId: 't2', cwd: w.dir, id: 'session_missing', emit: (e) => events.push(...e), info: (m) => infos.push(m) });
    assert.deepEqual(events.map((e) => e.type === 'turn.completed' && e.status), ['failed']);
    assert.ok(infos.some((m) => m.includes('could not run kimi')), infos.join(' | '));
  } finally {
    w.done();
  }
});

test('a Kimi CLI that cannot start fails the turn at once', async () => {
  const w = workspace();
  try {
    const events: AgentEvent[] = [];
    const infos: string[] = [];
    const started = Date.now();
    await kimiAdapter.runTurn('hi', {
      env: { ...w.env, bins: { kimi: 'intent-predict-no-such-bin' } }, turnId: 't1', cwd: w.dir, emit: (e) => events.push(...e), info: (m) => infos.push(m),
    });
    assert.ok(Date.now() - started < 5000, 'no wait for a request timeout');
    assert.deepEqual(events.map((e) => e.type === 'turn.completed' && e.status), ['failed']);
    assert.ok(infos.some((m) => m.includes('could not run kimi')), infos.join(' | '));
  } finally {
    w.done();
  }
});

test('a Kimi classification call is a throwaway session on the default model, deleted afterwards', async () => {
  const w = workspace();
  try {
    const sample = await kimiAdapter.sample('[INTENT PREDICTION] pick one', { env: w.env, signal: new AbortController().signal });
    assert.equal(sample.text, '{"candidates":[{"text":"跑一下测试","confidence":0.6}]}');
    await sample.cleanup;
    const methods = w.requests().map((r) => r.method);
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt', 'session/delete']);
    assert.ok(!methods.includes('session/set_model'), 'the host tool\'s default model');

    const withTool = await kimiAdapter.sample('[INTENT PREDICTION] USE_TOOL', { env: w.env, signal: new AbortController().signal });
    assert.equal(withTool.text, null, 'a call that used a tool is void');
    await withTool.cleanup;
  } finally {
    w.done();
  }
});
