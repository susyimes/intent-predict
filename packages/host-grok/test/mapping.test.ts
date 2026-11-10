// Recorded Grok CLI `streaming-json` turns -> intent-predict events -> signals and scenario.
// No network and no Grok needed: the fixtures were captured from grok 1.0.77 and trimmed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Core, extractSignals, loadPackFile } from '../../core/src/index.ts';
import type { AgentEvent, UpdatedParams } from '../../core/src/index.ts';
import { TurnMapper } from '../src/grok.ts';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const pack = loadPackFile(here('../../pack-coding/pack.json'));

function replay(fixture: string, userText: string): AgentEvent[] {
  const mapper = new TurnMapper('t1', 'C:\\proj');
  const events: AgentEvent[] = [{ type: 'turn.started', turnId: 't1', at: 1 }, { type: 'message.user', turnId: 't1', text: userText }];
  for (const line of readFileSync(here(`./fixtures/${fixture}`), 'utf8').split('\n').filter(Boolean)) {
    events.push(...mapper.push(JSON.parse(line)));
  }
  events.push(...mapper.finish());
  return events;
}
async function evaluate(events: AgentEvent[]): Promise<UpdatedParams> {
  const core = new Core([pack], {}, { options: { settleMs: 0 }, debugTrace: true });
  const out: UpdatedParams[] = [];
  core.on('updated', (p) => out.push(p));
  core.observe('s', events);
  await new Promise((r) => setTimeout(r, 5));
  return out[0]!;
}
const signals = (events: AgentEvent[]) => extractSignals({ events, completedCount: 1, state: {} }, 't1');

test('an edit turn maps to after_edit', async () => {
  const events = replay('edit-turn.jsonl', 'fix add in math.js');
  assert.deepEqual(events.filter((e) => e.type === 'tool.call').map((e) => [e.name, e.kind]),
    [['grep', 'search'], ['read_file', 'read'], ['search_replace', 'edit']]);
  assert.deepEqual(events.filter((e) => e.type === 'artifact').map((e) => e.ref), ['math.js'], 'paths are made relative to the workspace');
  assert.equal(events.at(-1)!.type, 'turn.completed');
  const sig = signals(events);
  assert.equal(sig.lastTurn.filesChanged, 1);
  assert.equal(sig.lastTurn.checkRuns, 0);
  const result = await evaluate(events);
  assert.equal(result.trace!.scenarioId, 'coding.after_edit');
  assert.deepEqual(result.result, { type: 'completed', prediction: null, suppressedReason: 'no_sampler' });
});

test('a failing `node --test` run maps to checks_failed', async () => {
  const events = replay('failing-test-turn.jsonl', 'run node --test');
  const call = events.find((e) => e.type === 'tool.call')!;
  assert.equal(call.type === 'tool.call' && call.command, 'node --test');
  const result = events.find((e) => e.type === 'tool.result')!;
  assert.deepEqual(result.type === 'tool.result' && [result.status, result.exitCode, result.summary], ['ok', 1, '✖ add (0.8137ms)']);
  const agent = events.filter((e) => e.type === 'message.agent');
  assert.deepEqual(agent.map((m) => m.final), [false, true], 'text before a tool call is not the final message');
  const sig = signals(events);
  assert.equal(sig.lastTurn.lastExecFailed, true);
  assert.equal(sig.lastTurn.lastCheckFailed, true, 'Grok reports the run as completed; the exit code carries the failure');
  assert.equal((await evaluate(events)).trace!.scenarioId, 'coding.checks_failed');
});

test('an edit Grok refused for lack of permission ends the turn as interrupted', async () => {
  const events = replay('denied-edit-turn.jsonl', 'fix add in math.js');
  const results = events.filter((e) => e.type === 'tool.result');
  assert.equal(results.at(-1)!.status, 'denied');
  assert.equal(events.some((e) => e.type === 'artifact'), false);
  assert.partialDeepStrictEqual(events.at(-1), { type: 'turn.completed', status: 'interrupted' });
  const result = await evaluate(events);
  assert.deepEqual(result.result, { type: 'completed', prediction: null, suppressedReason: 'interrupted_turn' });
});

test('a turn whose process dies without `end` is reported as failed', () => {
  const mapper = new TurnMapper('t1', 'C:\\proj');
  mapper.push({ type: 'text', data: 'working on it' });
  assert.deepEqual(mapper.finish().map((e) => [e.type, 'status' in e ? e.status : 'final' in e ? e.final : undefined]),
    [['message.agent', true], ['turn.completed', 'failed']]);
  assert.deepEqual(mapper.finish(), []);
});
