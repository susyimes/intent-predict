// Optional test of the bundled web page in a real headless browser (not part of `npm test`):
//
//   node packages/sidecar/test/webui-smoke.ts [path-to-chrome-or-edge]
//
// A sidecar with a scripted host delivers one pass-through suggestion with an alternative. The page is
// driven over the DevTools protocol: read what it shows, pick the alternative, click Send, and check
// that the host received exactly that as a turn-pinned dispatch. No dependencies: Node's WebSocket.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;
const browserPath = [
  process.argv[2], process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!browserPath) {
  console.log('no Chrome or Edge found; pass its path as the first argument');
  process.exit(2);
}
const until = async <T>(what: string, probe: () => T | Promise<T>, ms = 15_000): Promise<NonNullable<T>> => {
  let last: unknown;
  for (const end = Date.now() + ms; Date.now() < end;) {
    try {
      const value = await probe();
      if (value) return value as NonNullable<T>;
    } catch (e) {
      last = e;                                            // e.g. the page has no body yet: try again
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ''}`);
};

// ---- a sidecar with a scripted host --------------------------------------------------------------
const sidecar = spawn(process.execPath, [fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'serve', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
const write = (m: object) => sidecar.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const dispatches: Json[] = [];
let surfaceUrl = '';
createInterface({ input: sidecar.stdout }).on('line', (line) => {
  const m: Json = JSON.parse(line);
  if (m.id === 1) surfaceUrl = m.result.surfaceUrl;
  if (m.method === 'sampler/sample') {
    // t1: a confident suggestion with an alternative; t2: neither option is likely enough alone, together they are
    const reply = m.params.expectedTurnId === 't1'
      ? { intent: 'confirm', confidence: 0.9, slots: {}, runnerUps: [{ intent: 'ask_tradeoffs', confidence: 0.2 }] }
      : { intent: 'confirm', confidence: 0.4, slots: {}, runnerUps: [{ intent: 'ask_tradeoffs', confidence: 0.25 }] };
    write({ id: m.id, result: { text: JSON.stringify(reply) } });
  }
  if (m.method === 'dispatch/message') {
    dispatches.push(m.params);
    write({ id: m.id, result: {} });
  }
});
write({
  id: 1, method: 'initialize',
  params: { protocolVersion: '0.5', client: { name: 'smoke', version: '0' }, capabilities: { samplerModes: ['compact'], dispatchModes: ['message'] }, options: { settleMs: 0 } },
});
const observeTurn = (turnId = 't1', agent = `<img src=x onerror="document.title='pwned'"> 我打算把重试次数从 3 次改成 5 次，可以吗？`) => write({
  method: 'session/observe',
  params: {
    sessionId: 'demo',
    events: [
      { type: 'turn.started', turnId, at: 1 }, { type: 'message.user', turnId, text: '继续处理这个任务' },
      { type: 'message.agent', turnId, text: agent, final: true },
      { type: 'turn.completed', turnId, status: 'completed', at: 2 },
    ],
  },
});

// ---- a headless browser driven over the DevTools protocol ----------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'intent-predict-browser-'));
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
browser.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

let code = 0;
try {
  await until('the surface address', () => surfaceUrl);
  const endpoint = (await until('the DevTools endpoint', () => /DevTools listening on (ws:\/\/\S+)/.exec(stderr)))[1]!;
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('could not connect to the browser')));
  });
  const waiting = new Map<number, (m: Json) => void>();
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m: Json = JSON.parse(String(e.data));
    waiting.get(m.id)?.(m);
  });
  const cdp = (method: string, params: Json = {}, sessionId?: string) => new Promise<Json>((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await cdp('Target.createTarget', { url: surfaceUrl });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  const page = async (expression: string) => {
    const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (exceptionDetails) throw new Error(`page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  };
  const clickButton = (label: string) => page(`[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)}).click()`);

  await until('the page to connect', () => page(`document.body.innerText.includes('已连接')`));
  observeTurn();                                           // the page is attached: it sees the evaluation live
  await until('the suggestion card', () => page(`!!document.querySelector('.card textarea')`)).catch(async (e) => {
    throw new Error(`${e.message}; the page shows: ${JSON.stringify(await page('document.body.innerText'))}`);
  });
  const text = await page(`document.body.innerText`);
  for (const expected of ['confirm', 'coding.awaiting_reply', '置信度 0.90', 'Agent 刚才说（节选）', '改成 5 次，可以吗？', '发给 Agent', '复制', '没用，关掉', '给出 confirm', '已连接']) {
    assert.ok(text.includes(expected), `the page does not show ${JSON.stringify(expected)}`);
  }
  assert.equal(await page(`document.querySelector('.card textarea').value`), '可以，按这个方案继续');
  assert.ok(text.includes('<img src=x onerror'), 'agent text is shown as text');
  assert.equal(await page(`document.querySelectorAll('.card img').length + (document.title === 'pwned' ? 1 : 0)`), 0, 'agent text must never become markup');
  console.log('  ✔ the card shows the suggestion, the agent text it answers, and the inspector row; agent text is inert');

  // look back at the turn: what was said and done in it, and why it got this suggestion
  assert.ok((await page(`document.getElementById('lastTurn').textContent`)).includes('最近一轮 t1'), 'the header says which turn was evaluated last');
  await page(`[...document.querySelectorAll('tr.turn')].find((r) => r.cells[1].textContent === 't1').click()`);
  await until('the turn details', () => page(`!!document.querySelector('tr.detail') && document.querySelector('tr.detail').innerText.includes('Agent（最终回复）')`));
  const detail = await page(`document.querySelector('tr.detail').innerText`);
  for (const expected of ['判断过程', '模型选了', 'confirm，把握 0.90，门槛 0.60', '这一轮发生了什么', '继续处理这个任务', '改成 5 次，可以吗？', '这一轮正常结束']) {
    assert.ok(detail.includes(expected), `the turn details do not show ${JSON.stringify(expected)}: ${JSON.stringify(detail)}`);
  }
  assert.equal(await page(`document.querySelectorAll('tr.detail img').length + (document.title === 'pwned' ? 1 : 0)`), 0, 'turn text is inert too');
  console.log('  ✔ clicking a turn shows what happened in it and why it got its suggestion');

  await clickButton('先说说这样做的利弊');
  assert.equal(await page(`document.querySelector('.card textarea').value`), '先说说这样做的利弊');
  await clickButton('发给 Agent');
  await until('the dispatch', () => dispatches.length);
  assert.deepEqual({ ...dispatches[0], predictionId: '<id>' }, { sessionId: 'demo', text: '先说说这样做的利弊', expectedTurnId: 't1', predictionId: '<id>' });
  await until('the page to report the send', () => page(`document.body.innerText.includes('已过期')`));
  assert.equal(await page(`[...document.querySelectorAll('button')].some((b) => b.textContent === '发给 Agent')`), false, 'a resolved card offers no send button');
  assert.equal(dispatches.length, 1);
  console.log('  ✔ picking the alternative and clicking Send dispatched exactly that text, pinned to t1, once');

  // an option set: the options are equals, none is preselected, and nothing can go out before a pick
  observeTurn('t2', '重试次数有两种改法：直接改成 5 次，或者按网络状况动态调整。先按第一种改吗？');
  await until('the option set', () => page(`document.body.innerText.includes('合计把握 0.65')`)).catch(async (e) => {
    throw new Error(`${e.message}; the page shows: ${JSON.stringify(await page('document.body.innerText'))}`);
  });
  const options = await page(`[...document.querySelectorAll('.card .choices label')].map((l) => l.textContent)`);
  assert.equal(options.length, 2);
  assert.ok(options[0].startsWith('可以，按这个方案继续') && options[1].startsWith('先说说这样做的利弊'), JSON.stringify(options));
  assert.equal(await page(`[...document.querySelectorAll('.card .choices input')].some((r) => r.checked)`), false, 'no option is preselected');
  assert.equal(await page(`document.querySelector('.card textarea').value`), '');
  const disabled = (label: string) => page(`[...document.querySelectorAll('button')].find((b) => b.textContent === ${JSON.stringify(label)}).disabled`);
  assert.equal(await disabled('发给 Agent'), true, 'nothing to send before a pick');
  assert.equal(await disabled('复制'), true, 'nothing to copy before a pick');
  await page(`[...document.querySelectorAll('.card .choices label')].find((l) => l.textContent.startsWith('先说说这样做的利弊')).querySelector('input').click()`);
  assert.equal(await page(`document.querySelector('.card textarea').value`), '先说说这样做的利弊');
  await clickButton('发给 Agent');
  await until('the second dispatch', () => dispatches.length === 2);
  assert.deepEqual({ ...dispatches[1], predictionId: '<id>' }, { sessionId: 'demo', text: '先说说这样做的利弊', expectedTurnId: 't2', predictionId: '<id>' });
  console.log('  ✔ an option set shows its options as equals with none preselected; the picked one was dispatched, pinned to t2');
  ws.close();
  console.log(`webui smoke passed in ${browserPath}`);
} catch (e) {
  code = 1;
  console.error('webui smoke FAILED:', (e as Error).message);
} finally {
  sidecar.stdin.end();
  browser.kill();
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* the browser may still hold a file for a moment */ }
}
process.exit(code);
