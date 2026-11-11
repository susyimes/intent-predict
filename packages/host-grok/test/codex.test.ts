// Codex CLI: rollout replay, exec-stream mapping, and driving / classification against a stand-in.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '../../core/src/index.ts';
import type { AgentEnv } from '../src/agent.ts';
import {
  CODEX_SAMPLE_ARGS, CodexExecMapper, codexAdapter, codexAdvanced, codexRolloutFile, codexTurnArgs, exitCodeOf, readCodexHistory,
} from '../src/codex.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const item = (payload: object) => ({ timestamp: '2026-11-11T10:00:00Z', type: 'response_item', payload });
const event = (payload: object) => ({ timestamp: '2026-11-11T10:00:00Z', type: 'event_msg', payload });

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ip-codex-'));
  const log = join(dir, 'codex.log');
  writeFileSync(log, '');
  const env: AgentEnv = {
    home: dir, bins: { codex: { command: process.execPath, prefix: [FAKE, log] } }, grokArgs: [],
    scratch: () => dir, promptFile: () => { throw new Error('codex reads its prompt from stdin'); },
  };
  const calls = (): Array<{ args: string[]; input: string; cwd: string }> => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, env, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const ROLLOUT = [
  { timestamp: '2026-11-11T10:00:00Z', type: 'session_meta', payload: { id: '01a1ca3a-0000-7000-8000-000000000001', cwd: 'D:\\proj', model_provider: 'openai' } },
  event({ type: 'task_started', turn_id: 'u1' }),
  item({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '## Memory ...' }] }),
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>D:\\proj</cwd>\n</environment_context>' }] }),
  { timestamp: '2026-11-11T10:00:00Z', type: 'turn_context', payload: { model: 'gpt-6-astra', cwd: 'D:\\proj' } },
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the login bug' }] }),
  item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Running the tests first.' }] }),
  item({ type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pytest -q' }), call_id: 'c1' }),
  item({ type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Command: pytest -q\nProcess exited with code 1\nOutput:\n1 failed' }] }),
  item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: D:\\proj\\src\\login.py\n@@\n-a\n+b\n*** Add File: tests/test_login.py\n+x\n*** End Patch' }),
  item({ type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'input_text', text: 'Success. Updated the following files' }] }),
  item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed. Shall I run the tests again?' }] }),
  event({ type: 'task_complete', turn_id: 'u1', last_agent_message: 'Fixed. Shall I run the tests again?' }),
  event({ type: 'task_started', turn_id: 'auto' }),                       // a turn the user did not start
  item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Background check done.' }] }),
  event({ type: 'task_complete', turn_id: 'auto' }),
];

test('rollout replay: user turns only, injected context skipped, exit codes and patched files read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-codex-hist-'));
  const file = join(dir, 'rollout.jsonl');
  try {
    writeFileSync(file, jsonl(ROLLOUT));
    let n = 0;
    const replay = readCodexHistory(file, 'D:\\proj', 3, () => `t${++n}`)!;
    assert.deepEqual(replay.turnIds, ['t1']);
    const events = replay.turns[0]!;
    assert.deepEqual(events.map((e) => e.type), ['turn.started', 'message.user', 'message.agent', 'tool.call', 'tool.result',
      'tool.call', 'tool.result', 'artifact', 'artifact', 'message.agent', 'turn.completed']);
    assert.equal(events[1]!.type === 'message.user' && events[1]!.text, 'fix the login bug');
    assert.deepEqual(events[3]!.type === 'tool.call' && [events[3]!.kind, events[3]!.command], ['execute', 'pytest -q']);
    assert.deepEqual(events[4]!.type === 'tool.result' && [events[4]!.status, events[4]!.exitCode], ['error', 1]);
    assert.equal(events[5]!.type === 'tool.call' && events[5]!.kind, 'edit');
    assert.deepEqual(events.filter((e) => e.type === 'artifact').map((e) => e.type === 'artifact' && [e.kind, e.ref]),
      [['file_changed', 'src/login.py'], ['file_created', 'tests/test_login.py']]);
    assert.deepEqual(events[9]!.type === 'message.agent' && [events[9]!.text, events[9]!.final], ['Fixed. Shall I run the tests again?', true]);
    assert.equal(replay.fingerprint, readFileSync(file).length, 'the replay point passes the skipped background turn');

    assert.equal(codexAdvanced(file, replay.fingerprint), false);
    appendFileSync(file, jsonl([event({ type: 'task_started', turn_id: 'u2' }), item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] })]));
    assert.equal(codexAdvanced(file, replay.fingerprint), true, 'a new turn started in Codex itself');
    assert.equal(readCodexHistory(file, 'D:\\proj', 3, () => 'x', replay.fingerprint), undefined, 'a running turn is not replayed yet');
    appendFileSync(file, jsonl([event({ type: 'turn_aborted', turn_id: 'u2' })]));
    const later = readCodexHistory(file, 'D:\\proj', 3, () => `t${++n}`, replay.fingerprint)!;
    const last = later.turns[0]!.at(-1)!;
    assert.equal(last.type === 'turn.completed' && last.status, 'interrupted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit codes are read from the output shapes Codex records', () => {
  assert.equal(exitCodeOf('{"output":"x","metadata":{"exit_code":2}}'), 2);
  assert.equal(exitCodeOf([{ type: 'input_text', text: 'Process exited with code 0' }]), 0);
  assert.equal(exitCodeOf('Exit code: 127'), 127);
  assert.equal(exitCodeOf('no code here'), undefined);
});

test('a session\'s rollout file is found by id under dated folders; unsafe ids are refused', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-codex-home-'));
  try {
    const id = '01a1ca3a-5509-7d82-a266-d26264fc160a';
    const day = join(home, 'sessions', '2026', '11', '11');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-11-11T18-49-47-${id}.jsonl`), '');
    assert.equal(codexRolloutFile(home, id), join(day, `rollout-2026-11-11T18-49-47-${id}.jsonl`));
    assert.equal(codexRolloutFile(home, '01a1ca3a-0000-0000-0000-000000000000'), undefined);
    assert.throws(() => codexRolloutFile(home, '../x'), /plain name/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('turn and classification arguments: message on stdin, nothing that bypasses approvals, default model', () => {
  assert.deepEqual(codexTurnArgs('01a1ca3a-0000-7000-8000-000000000001'),
    ['exec', '--json', '--skip-git-repo-check', '--color', 'never', 'resume', '01a1ca3a-0000-7000-8000-000000000001', '-']);
  assert.deepEqual(codexTurnArgs(), ['exec', '--json', '--skip-git-repo-check', '--color', 'never', '-']);
  assert.throws(() => codexTurnArgs('--dangerously-bypass-approvals-and-sandbox'), /plain name/);
  for (const args of [codexTurnArgs('a1'), CODEX_SAMPLE_ARGS]) {
    assert.ok(!args.some((a) => /dangerously|full-auto|approve-for-me/.test(a)));
  }
  assert.ok(CODEX_SAMPLE_ARGS.includes('--ephemeral') && CODEX_SAMPLE_ARGS.includes('read-only'));
  assert.ok(!CODEX_SAMPLE_ARGS.includes('-m'), 'no model override');
});

test('a recorded codex exec run (codex-cli 0.159) maps to one final message', () => {
  const mapper = new CodexExecMapper('t1', 'D:\\proj');
  const events = [
    { type: 'thread.started', thread_id: '01a1ca3a-5509-7d82-a266-d26264fc160a' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'first' } },
    { type: 'turn.completed', usage: { input_tokens: 24595, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } },
  ].flatMap((line) => mapper.push(line));
  assert.deepEqual(events.map((e) => e.type), ['message.agent', 'turn.completed']);
  assert.deepEqual(events[0]!.type === 'message.agent' && [events[0]!.text, events[0]!.final], ['first', true]);
  assert.equal(mapper.sessionId, '01a1ca3a-5509-7d82-a266-d26264fc160a');
  assert.deepEqual(mapper.finish(), []);
});

test('a driven Codex turn resumes the session with the message on stdin', async () => {
  const w = workspace();
  try {
    const events: AgentEvent[] = [];
    const out = await codexAdapter.runTurn('fix it', {
      env: w.env, turnId: 't1', cwd: w.dir, id: '01a1ca3a-0000-7000-8000-000000000001', emit: (e) => events.push(...e), info: () => {},
    });
    assert.equal(out.sessionId, '01a1ca3a-0000-7000-8000-000000000001');
    const [call] = w.calls();
    assert.deepEqual(call!.args, codexTurnArgs('01a1ca3a-0000-7000-8000-000000000001'));
    assert.equal(call!.input, 'fix it');
    assert.deepEqual(events.map((e) => e.type),
      ['message.agent', 'tool.call', 'tool.result', 'tool.call', 'tool.result', 'artifact', 'message.agent', 'turn.completed']);
    assert.deepEqual(events[2]!.type === 'tool.result' && [events[2]!.status, events[2]!.exitCode, events[2]!.summary], ['error', 1, '1 failing']);
    assert.equal(events[5]!.type === 'artifact' && events[5]!.ref, 'src/a.ts');
    assert.deepEqual(events[6]!.type === 'message.agent' && [events[6]!.text, events[6]!.final], ['Fixed; please rerun.', true]);
  } finally {
    w.done();
  }
});

test('a Codex classification call is ephemeral and read-only; a call that used a tool is void', async () => {
  const w = workspace();
  try {
    const sample = await codexAdapter.sample('[INTENT PREDICTION] pick one', { env: w.env, signal: new AbortController().signal });
    assert.equal(sample.text, '{"intent":"run_tests","confidence":0.9,"slots":{}}');
    assert.deepEqual(sample.usage, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 });
    const [call] = w.calls();
    assert.deepEqual(call!.args, CODEX_SAMPLE_ARGS);
    assert.equal(call!.input, '[INTENT PREDICTION] pick one');
    const withTool = await codexAdapter.sample('[INTENT PREDICTION] USE_TOOL', { env: w.env, signal: new AbortController().signal });
    assert.equal(withTool.text, null);
  } finally {
    w.done();
  }
});
