// The eager coding pack: same scenarios as builtin/coding, with lower floors and a less
// none-biased prompt, so borderline model selections can become suggestions.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Core, loadPackFile } from '../src/index.ts';
import type { AgentEvent, SampleRequest, UpdatedParams } from '../src/index.ts';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const turn: AgentEvent[] = [
  { type: 'turn.started', turnId: 't1', at: 1000 },
  { type: 'message.user', turnId: 't1', text: '继续处理这个任务' },
  { type: 'artifact', turnId: 't1', kind: 'file_changed', ref: 'src/auth.ts' },
  { type: 'message.agent', turnId: 't1', text: '已经改完了登录逻辑。', final: true },
  { type: 'turn.completed', turnId: 't1', status: 'completed', at: 2000 },
];

async function evaluate(packRel: string, minConfidence: number): Promise<{ out: UpdatedParams; prompt: string }> {
  let prompt = '';
  const core = new Core([loadPackFile(here(packRel))], {
    samplerModes: ['compact'],
    sample: async (request: SampleRequest) => {
      prompt = request.prompt;
      return { text: JSON.stringify({ intent: 'run_tests', confidence: 0.4, slots: {} }) };
    },
  }, { policy: { minConfidence }, options: { settleMs: 0, mode: 'catalog' }, debugTrace: true });
  const updated: UpdatedParams[] = [];
  core.on('updated', (p) => updated.push(p));
  core.observe('s', turn);
  await new Promise((r) => setTimeout(r, 10));
  return { out: updated[0]!, prompt };
}

test('the eager pack admits a 0.4-confidence selection that the default pack suppresses', async () => {
  const normal = await evaluate('../../pack-coding/pack.json', 0.6);
  assert.equal(normal.out.result.type === 'completed' && normal.out.result.prediction, null);
  assert.equal(normal.out.result.type === 'completed' && !normal.out.result.prediction && normal.out.result.suppressedReason, 'below_min_confidence');
  // the default prompt asks for honest probabilities (unsure guesses become runner-ups, not `none`); the gate decides
  assert.match(normal.prompt, /Honest probabilities/);
  assert.doesNotMatch(normal.prompt, /Prefer none|not confident/);

  const eager = await evaluate('../../pack-coding-eager/pack.json', 0.35);
  const picked = eager.out.result.type === 'completed' ? eager.out.result.prediction : null;
  assert.equal(picked && picked.mode !== 'open' ? picked.intent.id : undefined, 'run_tests');
  assert.equal(eager.out.trace?.threshold, 0.35);
  assert.match(eager.prompt, /Prefer the best fit/);
  assert.doesNotMatch(eager.prompt, /\*\*Prefer none\*\*|Honest probabilities/);
});
