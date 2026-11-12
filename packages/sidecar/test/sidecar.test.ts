// The sidecar as a host and a surface see it: JSON-RPC over stdio on one side, HTTP + SSE on the other.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const until = async (what: string, cond: () => unknown, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const turn = (t: string, at: number, text = '已经改完了登录逻辑。') => [
  { type: 'turn.started', turnId: t, at }, { type: 'message.user', turnId: t, text: '继续处理这个任务' },
  { type: 'artifact', turnId: t, kind: 'file_changed', ref: 'src/auth.ts' },
  { type: 'message.agent', turnId: t, text, final: true }, { type: 'turn.completed', turnId: t, status: 'completed', at: at + 1 },
];

test('sidecar: stdio host protocol, loopback surface, turn-pinned dispatch, sampler cancel', async () => {
  const child = spawn(process.execPath, [MAIN, 'serve', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (m: Json) => void>();
  const reverse: Json[] = [];          // requests and notifications the sidecar sent to the host
  let seq = 0;
  let holdSamples = false;
  let dispatchError: number | undefined;
  const write = (m: Json) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m: Json = JSON.parse(line);
    if (!m.method) return void pending.get(m.id)?.(m);
    reverse.push(m);
    if (m.method === 'sampler/sample' && !holdSamples) {
      write({ id: m.id, result: { text: JSON.stringify({ intent: 'run_tests', confidence: 0.9, slots: {} }), usage: { inputTokens: 700 } } });
    } else if (m.method === 'dispatch/message') {
      write(dispatchError ? { id: m.id, error: { code: dispatchError, message: 'refused' } } : { id: m.id, result: {} });
    }
  });
  const call = (method: string, params: Json) => new Promise<Json>((resolve) => {
    pending.set(++seq, resolve);
    write({ id: seq, method, params });
  });

  try {
    assert.equal((await call('session/observe', { sessionId: 's1', events: [] })).error?.code, -32601, 'observe is a notification, not a request');
    const bad = await call('initialize', { protocolVersion: '0.1', client: { name: 't', version: '0' }, capabilities: {} });
    assert.equal(bad.error?.code, -32602);
    const init = (await call('initialize', {
      protocolVersion: '0.5', client: { name: 'test-host', version: '0' },
      capabilities: { samplerModes: ['compact'], dispatchModes: ['message'] }, options: { settleMs: 0 },
    })).result;
    assert.deepEqual(init.loadedPacks, [{ id: 'builtin/coding', version: '0.5.0', scenarioCount: 7 }]);
    const url = new URL(init.surfaceUrl);
    const token = url.searchParams.get('t')!;
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok(token.length >= 16);

    // -- surface security (SPEC 7.3) --
    assert.equal((await fetch(url.origin + '/')).status, 401, 'no token');
    assert.equal((await fetch(url.origin + '/?t=' + 'x'.repeat(token.length))).status, 401, 'wrong token');
    const page = await fetch(init.surfaceUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(!/(src|href)\s*=\s*["']https?:/i.test(html), 'the page must not load anything from the network');
    const rebound = await new Promise<number>((resolve) => httpRequest(
      { host: '127.0.0.1', port: url.port, path: '/?t=' + token, headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode!)).end());
    assert.equal(rebound, 403, 'foreign Host header');
    assert.equal((await fetch(init.surfaceUrl, { headers: { origin: 'https://evil.example' } })).status, 403, 'foreign Origin');

    const rpc = async (method: string, params: Json) => (await (await fetch(url.origin + '/rpc', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json()) as Json;
    const notifications: Json[] = [];
    const sse = await fetch(`${url.origin}/events?inspector=1&t=${token}`);
    void (async () => {
      let buf = '';
      for await (const chunk of sse.body!.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
          const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          if (data) notifications.push(JSON.parse(data.slice(6)));
        }
      }
    })().catch(() => {});

    // -- a turn ends: the core borrows the host's model and delivers a suggestion --
    write({ method: 'session/observe', params: { sessionId: 's1', events: [...turn('t1', 1000), { type: 'env.future_event', at: 5 }] } });
    await until('a delivered prediction', () => notifications.some((n) => n.params.result?.prediction));
    const sample = reverse.find((m) => m.method === 'sampler/sample')!;
    assert.match(sample.id, /^s-/);
    assert.equal(sample.params.mode, 'compact');
    assert.equal(sample.params.expectedTurnId, 't1');
    assert.ok(sample.params.prompt.includes('`run_tests`') && sample.params.prompt.includes('User: 继续处理这个任务'));
    const updated = notifications.find((n) => n.params.result?.prediction)!;
    const p = updated.params.result.prediction;
    assert.equal(p.intent.id, 'run_tests');
    assert.equal(p.usage.inputTokens, 700);
    assert.equal(updated.params.trace.scenarioId, 'coding.after_edit');
    assert.ok(!('prompt' in updated.params.trace) && !('signals' in updated.params.trace), 'no unredacted diagnostics on the wire');
    assert.deepEqual((await rpc('surface/attach', {})).result.dispatchModes, ['message']);

    // -- a surface can look back at the turn it answers --
    const looked = (await rpc('session/turn', { sessionId: 's1', turnId: 't1' })).result;
    assert.equal(looked.status, 'completed');
    assert.deepEqual(looked.items.map((i: Json) => i.kind), ['user', 'artifact', 'agent']);
    assert.equal(looked.items[0].text, '继续处理这个任务');
    assert.equal((await rpc('session/turn', { sessionId: 's1', turnId: 't9' })).error.code, -32602, 'a turn that is not retained');
    assert.equal((await rpc('session/turn', { sessionId: 's1' })).error.code, -32602);

    // -- send: refused while the host is busy, then dispatched, pinned to the turn, exactly once --
    dispatchError = -32001;
    assert.equal((await rpc('prediction/act', { predictionId: p.id, action: 'send', text: p.text })).result.status, 'busy');
    dispatchError = undefined;
    assert.equal((await rpc('prediction/act', { predictionId: p.id, action: 'send', text: p.text })).result.status, 'dispatched');
    const dispatch = reverse.filter((m) => m.method === 'dispatch/message').at(-1)!;
    assert.deepEqual(dispatch.params, { sessionId: 's1', text: p.text, expectedTurnId: 't1', predictionId: p.id });
    await until('invalidated(resolved)', () => notifications.some((n) => n.method === 'prediction/invalidated' && n.params.reason === 'resolved'));
    assert.equal((await rpc('prediction/act', { predictionId: p.id, action: 'send', text: p.text })).result.status, 'stale');
    assert.equal((await rpc('prediction/act', { action: 'send' })).error.code, -32602);
    assert.equal((await rpc('nope', {})).error.code, -32601);

    // -- the next turn starts while a sample is in flight: the host is told to stop --
    holdSamples = true;
    write({ method: 'session/observe', params: { sessionId: 's1', events: turn('t2', 2000) } });
    await until('second sample', () => reverse.filter((m) => m.method === 'sampler/sample').length === 2);
    const held = reverse.filter((m) => m.method === 'sampler/sample')[1]!;
    write({ method: 'session/observe', params: { sessionId: 's1', events: [{ type: 'turn.started', turnId: 't3', at: 3000 }] } });
    await until('sampler/cancel', () => reverse.some((m) => m.method === 'sampler/cancel'));
    assert.deepEqual(reverse.find((m) => m.method === 'sampler/cancel')!.params, { sampleRequestId: held.id, sessionId: 's1' });
    await until('aborted', () => notifications.some((n) => n.params.result?.suppressedReason === 'aborted'));
    write({ id: held.id, result: { text: '{"intent":"run_tests","confidence":1,"slots":{}}' } });   // late reply: must be discarded
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notifications.filter((n) => n.params.result?.prediction).length, 1);
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
  }
});
