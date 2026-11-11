// Grok history replay: a session's updates.jsonl (ACP updates) -> the last completed turns as events.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { grokAdvanced, readGrokHistory } from '../src/grok.ts';

const upd = (update: Record<string, unknown>) => JSON.stringify({ timestamp: 1, method: 'session/update', params: { update } });
const tool = (name: string, kind: string) => ({ 'x.ai/tool': { name, kind, version: 1, namespace: 'grok_build' } });

test('restores the last completed turns from updates.jsonl and drops the in-progress tail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-grok-hist-'));
  const file = join(dir, 'updates.jsonl');
  try {
    writeFileSync(file, [
      upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'fix add' } }),
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '改中' } }),
      upd({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'edit', title: 'Edit', rawInput: { file_path: 'C:\\proj\\math.js' }, _meta: tool('search_replace', 'edit') }),
      upd({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', content: [{ content: { text: 'done' } }], locations: [{ path: 'C:\\proj\\math.js' }] }),
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '改好了' } }),
      upd({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
      upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '再看看' } }),
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '看了一半' } }),
      upd({ sessionUpdate: 'turn_completed', stop_reason: 'cancelled' }),
      upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '还在跑的问题' } }),
    ].join('\n') + '\n', 'utf8');

    let n = 0;
    const replay = readGrokHistory(file, 'sess', 'C:\\proj', 3, () => `t${++n}`)!;
    assert.equal(replay.turns.length, 2);
    assert.deepEqual(replay.turnIds, ['t1', 't2']);

    const first = replay.turns[0]!;
    assert.equal(first[0]!.type, 'turn.started');
    assert.equal(first[1]!.type === 'message.user' && (first[1] as any).text, 'fix add');
    assert.deepEqual(first.filter((e) => e.type === 'tool.call').map((e) => e.type === 'tool.call' && e.name), ['search_replace']);
    assert.deepEqual(first.filter((e) => e.type === 'artifact').map((e) => e.type === 'artifact' && e.ref), ['math.js']);
    const done1 = first.at(-1)!;
    assert.equal(done1.type === 'turn.completed' && done1.status, 'completed');

    const done2 = replay.turns[1]!.at(-1)!;
    assert.equal(done2.type === 'turn.completed' && done2.status, 'interrupted', 'a cancelled turn stays interrupted');

    assert.equal(grokAdvanced(file, replay.fingerprint), true, 'the in-progress user turn after the replay point already advanced the session');
    assert.equal(readGrokHistory(file, 'sess', 'C:\\proj', 3, () => 'x', replay.fingerprint), undefined, 'an incomplete external turn is not synced yet');

    appendFileSync(file, [
      upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '现在跑完了' } }),
      upd({ sessionUpdate: 'turn_completed', stop_reason: 'end_turn' }),
    ].join('\n') + '\n');
    const incremental = readGrokHistory(file, 'sess', 'C:\\proj', 3, () => `t${++n}`, replay.fingerprint)!;
    assert.equal(incremental.turns.length, 1, 'only the newly completed external turn is restored');
    assert.deepEqual(incremental.turnIds, ['t3']);
    assert.equal(incremental.turns[0]![1]!.type === 'message.user' && (incremental.turns[0]![1] as any).text, '还在跑的问题');
    assert.equal(grokAdvanced(file, incremental.fingerprint), false, 'the sync point catches up after incremental replay');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
