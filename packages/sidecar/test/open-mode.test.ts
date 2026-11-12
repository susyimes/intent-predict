// Open mode (SPEC 4.9) end to end through the sidecar: with the default options the host's own agent writes
// the candidates, the surface sends the one the user picked, and the host receives it pinned to the turn.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;
const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const until = async (what: string, cond: () => unknown, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('open mode by default: the agent writes the candidates, the user sends the one they picked', async () => {
  const child = spawn(process.execPath, [MAIN, 'serve', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map<number, (m: Json) => void>();
  const reverse: Json[] = [];
  let seq = 0;
  const write = (m: Json) => {
    if (!child.stdin.writableEnded) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    const m: Json = JSON.parse(line);
    if (!m.method) return void pending.get(m.id)?.(m);
    reverse.push(m);
    if (m.method === 'sampler/sample') {
      const candidates = [
        { text: '顺便把 README 也更新一下', confidence: 0.2 },
        { text: '跑一下测试看看', confidence: 0.5 },
        { text: '推到远端吧', confidence: 0.18, sideEffect: true },
      ];
      write({ id: m.id, result: { text: '```json\n' + JSON.stringify({ candidates }) + '\n```' } });
    } else if (m.method === 'dispatch/message') {
      write({ id: m.id, result: {} });
    }
  });
  const call = (method: string, params: Json) => new Promise<Json>((resolve) => {
    pending.set(++seq, resolve);
    write({ id: seq, method, params });
  });
  try {
    const init = (await call('initialize', {
      protocolVersion: '0.5', client: { name: 'test-host', version: '0' },
      capabilities: { samplerModes: ['compact'], dispatchModes: ['message'] }, options: { settleMs: 0 },
    })).result;
    const url = new URL(init.surfaceUrl);
    const token = url.searchParams.get('t')!;
    const rpc = async (method: string, params: Json) => (await (await fetch(url.origin + '/rpc', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })).json()) as Json;

    write({
      method: 'session/observe', params: {
        sessionId: 's1', events: [
          { type: 'turn.started', turnId: 't1', at: 1000 }, { type: 'message.user', turnId: 't1', text: '把登录的 bug 修一下' },
          { type: 'artifact', turnId: 't1', kind: 'file_changed', ref: 'src/auth.ts' },
          { type: 'message.agent', turnId: 't1', text: '改好了，问题出在会话过期时间的计算上。', final: true },
          { type: 'turn.completed', turnId: 't1', status: 'completed', at: 2000 },
        ],
      },
    });
    let p: Json | undefined;
    await until('the open prediction', async () => {
      const attached = (await rpc('surface/attach', { inspector: true })).result;
      p = attached.sessions.find((s: Json) => s.sessionId === 's1')?.live;
      return p;
    });
    const sample = reverse.find((m) => m.method === 'sampler/sample')!;
    assert.match(sample.params.prompt, /Predict the message THE USER will send next/);
    assert.match(sample.params.prompt, /User: 把登录的 bug 修一下/);
    assert.ok(!/Catalog/.test(sample.params.prompt), 'no catalog in open mode');
    assert.equal(sample.params.maxOutputTokens, 800);

    assert.equal(p!.mode, 'open');
    assert.deepEqual(p!.candidates.map((c: Json) => [c.text, c.confirmBeforeSend]),
      [['跑一下测试看看', false], ['顺便把 README 也更新一下', false], ['推到远端吧', true]], 'likeliest first; the risky one flagged');
    assert.equal(p!.text, '跑一下测试看看');
    assert.match(p!.context.excerpt, /会话过期时间/);

    assert.equal((await rpc('prediction/act', { predictionId: p!.id, action: 'send', text: '推到远端吧', candidate: 2 })).result.status, 'confirmation_required');
    const sent = await rpc('prediction/act', { predictionId: p!.id, action: 'send', text: '顺便把 README 也更新一下', candidate: 1 });
    assert.equal(sent.result.status, 'dispatched');
    const dispatch = reverse.filter((m) => m.method === 'dispatch/message');
    assert.equal(dispatch.length, 1);
    assert.deepEqual(dispatch[0]!.params, { sessionId: 's1', text: '顺便把 README 也更新一下', expectedTurnId: 't1', predictionId: p!.id });
    assert.equal((await rpc('prediction/act', { predictionId: p!.id, action: 'send', text: '跑一下测试看看' })).result.status, 'stale', 'sent once');
  } finally {
    child.stdin.end();
    await new Promise((r) => child.once('exit', r));
  }
});
