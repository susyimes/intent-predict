// session/turn (SPEC 8): a retained turn as a surface may show it — redacted, cut, in event order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Core } from '../src/core.ts';

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';

test('a turn digest keeps event order, merges tool results into their calls, and redacts and cuts text', () => {
  const core = new Core([], {}, { options: { settleMs: 0 } });
  core.observe('s', [
    { type: 'turn.started', turnId: 't1', at: 1000 },
    { type: 'message.user', turnId: 't1', text: `deploy with ${SECRET}` },
    { type: 'tool.call', turnId: 't1', callId: 'c1', name: 'terminal', kind: 'execute', command: `curl -H "Authorization: Bearer ${SECRET}" x` },
    { type: 'tool.result', turnId: 't1', callId: 'c1', status: 'error', exitCode: 7, summary: 'connection refused', output: 'raw output stays in the core' },
    { type: 'artifact', turnId: 't1', kind: 'file_changed', ref: 'src/a.ts' },
    { type: 'message.agent', turnId: 't1', text: 'checking', final: false },
    { type: 'message.agent', turnId: 't1', text: 'x'.repeat(5000), final: true },
    { type: 'turn.completed', turnId: 't1', status: 'completed', at: 2000 },
    { type: 'turn.started', turnId: 't2', at: 3000 },
    { type: 'message.user', turnId: 't2', text: 'next' },
  ]);
  const d = core.turn('s', 't1')!;
  assert.deepEqual([d.status, d.startedAt, d.completedAt], ['completed', 1000, 2000]);
  assert.deepEqual(d.items.map((i) => i.kind), ['user', 'tool', 'artifact', 'agent', 'agent']);
  const [user, tool, , commentary, final] = d.items;
  assert.ok(user!.kind === 'user' && !user.text.includes(SECRET) && user.text.includes('[REDACTED'), JSON.stringify(user));
  assert.ok(tool!.kind === 'tool' && tool.toolKind === 'execute' && tool.status === 'error' && tool.exitCode === 7 && tool.summary === 'connection refused');
  assert.ok(tool!.kind === 'tool' && !tool.command!.includes(SECRET));
  assert.ok(!JSON.stringify(d).includes('raw output'), 'tool output never leaves the core');
  assert.ok(commentary!.kind === 'agent' && !commentary.final);
  assert.ok(final!.kind === 'agent' && final.final && [...final.text].length === 4001 && final.text.endsWith('…'), 'agent text cut to 4000');

  const running = core.turn('s', 't2')!;
  assert.equal(running.status, undefined, 'a turn still under way has no status');
  assert.equal(core.turn('s', 't9'), undefined);
  assert.equal(core.turn('nobody', 't1'), undefined);
  core.close();
});
