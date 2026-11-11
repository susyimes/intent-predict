// Hermes one-shot driving and history replay (the real CLI was probed live; fixtures mirror it).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { hermesAdvanced, hermesTurnArgs, hermesTurnEvents, readHermesHistory } from '../src/hermes.ts';

test('a bound turn resumes the session in one-shot mode', () => {
  assert.deepEqual(hermesTurnArgs('继续', { sessionId: 'h-1' }), ['-z', '继续', '--resume', 'h-1']);
  assert.deepEqual(hermesTurnArgs('继续', { sessionId: 'h-1', profile: 'coder' }),
    ['-p', 'coder', '-z', '继续', '--resume', 'h-1']);
  assert.deepEqual(hermesTurnArgs('你好', {}), ['-z', '你好']);
});

test('one-shot output maps to a final agent message and a completed turn', () => {
  const events = hermesTurnEvents('t1', { code: 0, stdout: '做完了。\n要不要跑一下测试？\n' });
  assert.deepEqual(events.map((e) => e.type), ['message.agent', 'turn.completed']);
  const msg = events[0]!;
  assert.equal(msg.type === 'message.agent' && msg.text, '做完了。\n要不要跑一下测试？');
  assert.equal(msg.type === 'message.agent' && msg.final, true);
  const done = events[1]!;
  assert.equal(done.type === 'turn.completed' && done.status, 'completed');
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

test('a failed one-shot completes the turn as failed, with any partial text kept', () => {
  const events = hermesTurnEvents('t2', { code: 1, stdout: '半截输出' });
  assert.deepEqual(events.map((e) => e.type), ['message.agent', 'turn.completed']);
  const done = events[1]!;
  assert.equal(done.type === 'turn.completed' && done.status, 'failed');

  const empty = hermesTurnEvents('t3', { code: 0, stdout: '  \n' });
  assert.deepEqual(empty.map((e) => e.type), ['turn.completed']);
});
