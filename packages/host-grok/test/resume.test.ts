// Binding to an existing Grok session: the host must seed its Grok session id from `resume`
// so the first turn it runs already continues that conversation (`grok --resume <id>`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GrokHost } from '../src/host.ts';

const RESUME_ID = '01a1c874-dfaa-7bd3-a8b4-f53e74961c74';

test('resume seeds the Grok session id before any turn', async () => {
  const host = new GrokHost({ cwd: process.cwd(), resume: RESUME_ID });
  try {
    await host.start();
    assert.equal(host.grokSessionId, RESUME_ID);
    assert.ok(host.surfaceUrl, 'the bundled surface still starts');
  } finally {
    await host.stop();
  }
});

test('without resume the host starts unbound', async () => {
  const host = new GrokHost({ cwd: process.cwd() });
  try {
    await host.start();
    assert.equal(host.grokSessionId, undefined);
  } finally {
    await host.stop();
  }
});
