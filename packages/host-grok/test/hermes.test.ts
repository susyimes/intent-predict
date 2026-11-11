// Hermes single-query driving, classification calls and history replay (the real CLI was probed
// live; fixtures mirror what it printed and stored).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '../../core/src/index.ts';
import { HermesStreamMapper, hermesAdvanced, hermesChatArgs, hermesSampleArgs, readHermesHistory } from '../src/hermes.ts';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('turns run in single-query mode, never in auto-approving one-shot mode', () => {
  assert.deepEqual(hermesChatArgs('p.txt', { sessionId: 'h-1' }),
    ['chat', '--query-file', 'p.txt', '--oneshot', '--format', 'stream-json', '--resume', 'h-1']);
  assert.deepEqual(hermesChatArgs('p.txt', { sessionId: 'h-1', profile: 'coder' }),
    ['-p', 'coder', 'chat', '--query-file', 'p.txt', '--oneshot', '--format', 'stream-json', '--resume', 'h-1']);
  assert.deepEqual(hermesChatArgs('p.txt', {}), ['chat', '--query-file', 'p.txt', '--oneshot', '--format', 'stream-json']);
  for (const args of [hermesChatArgs('p.txt', { sessionId: 'h-1' }), hermesSampleArgs('p.txt')]) {
    assert.ok(!args.includes('-z') && !args.includes('--yolo'), 'nothing approves on the user\'s behalf');
  }
});

test('a classification call uses the default model, a side-effect-free toolset and a hidden source', () => {
  assert.deepEqual(hermesSampleArgs('p.txt'),
    ['chat', '--query-file', 'p.txt', '--oneshot', '--format', 'stream-json', '--source', 'tool', '--ignore-rules', '-t', 'clarify']);
  assert.deepEqual(hermesSampleArgs('p.txt', 'coder').slice(0, 3), ['-p', 'coder', 'chat']);
  assert.ok(!hermesSampleArgs('p.txt').includes('-m'), 'no model override: the host tool\'s default model');
});

test('a session id or profile that hermes would read as an option never reaches its command line', () => {
  assert.throws(() => hermesChatArgs('p.txt', { sessionId: '--yolo' }), /session id must be a plain name/);
  assert.throws(() => hermesChatArgs('p.txt', { sessionId: 'h-1', profile: '-x' }), /profile must be a plain name/);
  assert.throws(() => hermesChatArgs('p.txt', { sessionId: '../h-1' }), /session id must be a plain name/);
  assert.throws(() => hermesSampleArgs('p.txt', '--yolo'), /profile must be a plain name/);
});

test('a recorded single-query run maps to tool events with exit codes and one final message', () => {
  const mapper = new HermesStreamMapper('t1', 'C:\\proj');
  const events: AgentEvent[] = fixture('hermes-turn.jsonl').flatMap((line) => mapper.push(line));
  events.push(...mapper.finish());
  assert.deepEqual(events.map((e) => e.type), ['tool.call', 'tool.result', 'message.agent', 'turn.completed']);
  const call = events[0]!;
  assert.equal(call.type === 'tool.call' && call.command, 'ls -la');
  const result = events[1]!;
  assert.deepEqual(result.type === 'tool.result' && [result.status, result.exitCode, result.summary], ['ok', 0, 'total 4']);
  const message = events[2]!;
  assert.ok(message.type === 'message.agent' && message.final && message.text.startsWith('Tools are available.'), 'the result text is the final message');
  assert.equal(events[3]!.type === 'turn.completed' && events[3]!.status, 'completed');
  assert.equal(mapper.sessionId, 'local-0123456789abcdef');
});

test('a failed command, a write and a failed run map as such', () => {
  const mapper = new HermesStreamMapper('t2', 'C:\\proj');
  const events = [
    { type: 'text', text: 'Running the tests.' },
    { type: 'tool_use', name: 'terminal', tool_call_id: 'c1', input: { command: 'pytest -q' } },
    { type: 'tool_result', name: 'terminal', tool_call_id: 'c1', output: JSON.stringify({ output: '2 failed', exit_code: 1, error: null }), is_error: false },
    { type: 'tool_use', name: 'write_file', tool_call_id: 'c2', input: { path: 'C:\\proj\\src\\a.ts', content: 'x' } },
    { type: 'tool_result', name: 'write_file', tool_call_id: 'c2', output: '{"ok": true}', is_error: false },
    { type: 'result', session_id: 'local-1', exit_code: 1, text: '', error: 'provider error' },
  ].flatMap((line) => mapper.push(line));
  assert.deepEqual(events.map((e) => e.type),
    ['message.agent', 'tool.call', 'tool.result', 'tool.call', 'tool.result', 'artifact', 'turn.completed']);
  assert.equal(events[0]!.type === 'message.agent' && events[0]!.final, false, 'text before a tool call is commentary');
  assert.deepEqual(events[2]!.type === 'tool.result' && [events[2]!.status, events[2]!.exitCode], ['error', 1]);
  assert.equal(events[5]!.type === 'artifact' && events[5]!.ref, 'src/a.ts');
  assert.equal(events[6]!.type === 'turn.completed' && events[6]!.status, 'failed');
  assert.deepEqual(mapper.finish(), [], 'a run ends once');

  const silent = new HermesStreamMapper('t3', 'C:\\proj');
  assert.deepEqual(silent.finish().map((e) => e.type === 'turn.completed' && e.status), ['failed'], 'a run without a result failed');
});

test('history replay restores the last completed turns and detects later advancement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-hermes-hist-'));
  const dbFile = join(dir, 'state.db');
  const S = 'sess-1';
  type Row = [string, string, string | null, string | null, number, string | null];
  const seed = (rows: Row[]) => {
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, finish_reason TEXT)');
    const ins = db.prepare('INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, timestamp, finish_reason) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const [role, content, callId, calls, ts, finish] of rows) ins.run(S, role, content, callId, calls, ts, finish);
    db.close();
  };
  try {
    seed([
      ['user', '一', null, null, 100, null], ['assistant', '答一', null, null, 101, 'stop'],
      ['user', '改一下 a.ts', null, null, 200, null],
      ['assistant', '', null, JSON.stringify([{ id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'D:\\proj\\a.ts' }) } }]), 201, 'tool_calls'],
      ['tool', 'written', 'c1', null, 202, null],
      ['assistant', '改好了。', null, null, 203, 'stop'],
      ['user', '三', null, null, 300, null], ['assistant', '答三，要继续吗？', null, null, 301, 'stop'],
    ]);
    let n = 0;
    const replay = readHermesHistory(dbFile, S, 'D:\\proj', 3, () => `t${++n}`)!;
    assert.equal(replay.turns.length, 3);
    assert.deepEqual(replay.turnIds, ['t1', 't2', 't3']);

    const edit = replay.turns[1]!;
    assert.deepEqual(edit.filter((e) => e.type === 'tool.call').map((e) => e.type === 'tool.call' && e.name), ['write_file']);
    assert.deepEqual(edit.filter((e) => e.type === 'artifact').map((e) => e.type === 'artifact' && e.ref), ['a.ts']);
    const final = replay.turns[2]!.at(-2)!;
    assert.equal(final.type === 'message.agent' && final.text, '答三，要继续吗？');
    assert.equal(final.type === 'message.agent' && final.final, true);

    assert.equal(hermesAdvanced(dbFile, S, replay.fingerprint), false, 'nothing arrived after the replay point yet');
    seed([['user', '没答完的问题', null, null, 400, null]]);
    assert.equal(hermesAdvanced(dbFile, S, replay.fingerprint), true, 'a newer user message advanced the session');
    assert.equal(readHermesHistory(dbFile, S, 'D:\\proj', 3, () => 'x', replay.fingerprint), undefined, 'an incomplete external turn is not synced yet');

    seed([['assistant', '现在答完了，要继续吗？', null, null, 401, 'stop']]);
    const incremental = readHermesHistory(dbFile, S, 'D:\\proj', 3, () => `t${++n}`, replay.fingerprint)!;
    assert.equal(incremental.turns.length, 1, 'only the newly completed external turn is restored');
    assert.deepEqual(incremental.turnIds, ['t4']);
    const syncedFinal = incremental.turns[0]!.at(-2)!;
    assert.equal(syncedFinal.type === 'message.agent' && syncedFinal.text, '现在答完了，要继续吗？');
    assert.equal(hermesAdvanced(dbFile, S, incremental.fingerprint), false, 'the sync point catches up after incremental replay');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
