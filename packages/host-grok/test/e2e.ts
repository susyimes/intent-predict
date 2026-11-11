// End-to-end run against the real Grok CLI (needs `grok` on PATH and a logged-in account; costs a few cents).
//
//   node packages/host-grok/test/e2e.ts
//
// A throwaway project is created; Grok may only edit files and run `node --test` there. The script plays
// the user and the surface: it talks to Grok through the host, reads predictions from the surface's HTTP
// endpoint, and sends one of them back. It checks the plumbing (events, signals, sampler, dispatch,
// telemetry), not how good the model's predictions are.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrokHost } from '../src/host.ts';
import { deleteGrokSession } from '../src/grok.ts';

type Json = Record<string, any>;
const project = mkdtempSync(join(tmpdir(), 'intent-predict-e2e-'));
writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
writeFileSync(join(project, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
writeFileSync(join(project, 'math.test.js'),
  'import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "./math.js";\n' +
  'test("add", () => { assert.equal(add(2, 3), 5); });\n');
const logPath = join(project, 'telemetry.jsonl');

const say = (s: string) => process.stdout.write(s + '\n');
const host = new GrokHost({
  cwd: project, logPath,
  // the narrowest permissions the scenario needs: edit files, run exactly one command
  grokArgs: ['--allow', 'search_replace', '--allow', 'write', '--allow', 'run_terminal_command(node --test)', '--disable-web-search'],
  onInfo: (m) => say(`    · ${m}`),
});

const notifications: Json[] = [];
const waitFor = async (what: string, find: () => Json | undefined, ms = 180_000): Promise<Json> => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const hit = find();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const evaluationOf = (turnId: string) =>
  waitFor(`the evaluation of ${turnId}`, () => notifications.find((n) => n.method === 'prediction/updated' && n.params.sourceTurnId === turnId));
const describe = (n: Json) => {
  const r = n.params.result;
  const t = n.params.trace ?? {};
  const p = r.prediction;
  const what = !p
    ? `no suggestion: ${r.suppressedReason}${t.confidence !== undefined && t.confidence !== null ? ` (model said ${t.selected} at ${t.confidence}, needs ${t.threshold})` : ''}`
    : p.optionSet
      ? `offers an option set (together ≥ ${t.threshold}): ${[{ text: p.text, intentId: p.intent.id, confidence: p.intent.confidence }, ...p.alternatives]
        .map((o: Json) => `"${o.text}" (${o.intentId} ${o.confidence})`).join(' | ')}`
      : `suggests "${p.text}" (${p.intent.id}, ${p.source}${p.intent.confidence === null ? '' : ' ' + p.intent.confidence})`;
  return `${n.params.sourceTurnId}  scenario=${t.scenarioId ?? '—'}  ${what}`;
};
const PLUMBING_FAILURES = ['sampler_error', 'timeout', 'invalid_model_output', 'unknown_intent', 'no_sampler', 'prompt_too_large'];
const checks: string[] = [];
const ok = (what: string) => {
  checks.push(what);
  say(`  ✔ ${what}`);
};
/** When the model was unsure and an option set came out, check what SPEC 4.6 promises about it. */
const checkOptionSet = (n: Json) => {
  const p = n.params.result.prediction;
  if (!p?.optionSet) return;
  const options = [{ intentId: p.intent.id, confidence: p.intent.confidence, risk: p.risk }, ...p.alternatives];
  const total = options.reduce((sum: number, o: Json) => sum + o.confidence, 0);
  assert.ok(options.length >= 2 && options.length <= 3, `an option set has 2-3 options, got ${options.length}`);
  assert.equal(new Set(options.map((o: Json) => o.intentId)).size, options.length, 'options are distinct intents');
  assert.ok(options.every((o: Json) => o.risk !== 'side_effect'), 'no side-effect intent in a set');
  assert.ok(p.intent.confidence < n.params.trace.threshold && total >= n.params.trace.threshold - 1e-9, 'alone below, together at or above the threshold');
  assert.equal(p.confirmBeforeSend, false);
  ok(`${n.params.sourceTurnId}: an option set of ${options.length}, ${p.intent.confidence} alone, ${total.toFixed(2)} together (threshold ${n.params.trace.threshold})`);
};

let failed = false;
try {
  await host.start();
  const url = new URL(host.surfaceUrl!);
  const token = url.searchParams.get('t')!;
  const rpc = async (method: string, params: Json) => (await (await fetch(url.origin + '/rpc', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })).json()) as Json;
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
  say(`project: ${project}\nsurface: ${host.surfaceUrl}\n`);

  // ---- turn 1: an edit without a test run -> model path ---------------------------------------
  say('turn 1: ask Grok to fix a bug without running anything');
  await host.send('Fix the bug in math.js: add(a, b) must return a + b. Do not run the tests or any other command.');
  assert.match(readFileSync(join(project, 'math.js'), 'utf8'), /a \+ b/, 'Grok did not fix the file');
  const e1 = await evaluationOf('t1');
  say('    ' + describe(e1));
  checkOptionSet(e1);
  const s1 = JSON.parse(e1.params.trace.signalsJson);
  assert.equal(e1.params.trace.scenarioId, 'coding.after_edit');
  assert.ok(s1['lastTurn.filesChanged'] >= 1 && s1['lastTurn.checkRuns'] === 0, JSON.stringify(s1));
  ok('Grok events became signals: a changed file, no check run, scenario coding.after_edit');
  assert.equal(e1.params.trace.samplerMode, 'compact');
  assert.ok(!PLUMBING_FAILURES.includes(e1.params.result.suppressedReason), `sampler path broke: ${e1.params.result.suppressedReason}`);
  ok(`Grok served the compact sampler and its reply parsed (${e1.params.result.prediction ? 'delivered' : e1.params.result.suppressedReason})`);

  // ---- turn 2: send the suggestion if there is one, else type it ourselves ----------------------
  const p1 = e1.params.result.prediction;
  if (p1) {
    say(`turn 2: send the suggestion from the surface: "${p1.text}"`);
    const sent = await rpc('prediction/act', { predictionId: p1.id, action: 'send', text: p1.text, confirmed: p1.confirmBeforeSend || undefined });
    assert.equal(sent.result?.status, 'dispatched', JSON.stringify(sent));
    ok('a send from the surface was dispatched to Grok as the next user message');
    await waitFor('the dispatched turn to start', () => (host.busy || host.lastCompletedTurn === 't2' ? {} : undefined));
    await host.idle();
  } else {
    say('turn 2: no suggestion to send, so the user types "run the tests" themselves');
    await host.send('Run the tests with exactly this command: node --test');
  }
  const e2 = await evaluationOf('t2');
  say('    ' + describe(e2));
  checkOptionSet(e2);
  const s2 = JSON.parse(e2.params.trace.signalsJson);
  assert.ok(!PLUMBING_FAILURES.includes(e2.params.result.suppressedReason), `sampler path broke: ${e2.params.result.suppressedReason}`);
  if (s2['lastTurn.checkRuns'] >= 1) {
    assert.equal(s2['lastTurn.lastCheckFailed'], false, JSON.stringify(s2));
    ok('`node --test` was recognised as a check run that passed');
  } else {
    say('    (Grok did not run the tests this turn; nothing to check about check runs)');
  }

  // ---- turn 3: numbered options -> deterministic rule, then send a choice -----------------------
  say('turn 3: make Grok end with numbered options');
  await host.send('Do not use any tool. Reply with exactly these three lines and nothing else:\n' +
    'Which one should I do next?\n1. Add a subtract function to math.js\n2. Add one more test for add');
  const e3 = await evaluationOf('t3');
  say('    ' + describe(e3));
  checkOptionSet(e3);
  const p3 = e3.params.result.prediction;
  assert.ok(p3, `expected the options rule to fire, got ${e3.params.result.suppressedReason}`);
  assert.equal(p3.intent.id, 'choose_option');
  assert.equal(p3.source, 'rule');
  assert.equal(p3.choices.length, 2);
  assert.ok(p3.passThrough && p3.context.excerpt.includes('subtract'), 'a pass-through card must carry what it answers');
  ok('numbered options became a rule-sourced choice card, with no model call, carrying the agent text it answers');

  const wrong = await rpc('prediction/act', { predictionId: p1?.id ?? 'p-unknown', action: 'send', text: 'x' });
  assert.equal(wrong.result?.status, 'stale');
  ok('an old prediction can no longer be sent (stale)');
  const sent3 = await rpc('prediction/act', { predictionId: p3.id, action: 'send', text: p3.choices[0].text, choice: 0 });
  assert.equal(sent3.result?.status, 'dispatched', JSON.stringify(sent3));
  await waitFor('the dispatched turn to start', () => (host.busy || host.lastCompletedTurn === 't4' ? {} : undefined));
  const again = await rpc('prediction/act', { predictionId: p3.id, action: 'send', text: p3.choices[0].text, choice: 0 });
  assert.equal(again.result?.status, 'stale');
  ok('the chosen option was dispatched once; a second click is refused');
  await host.idle();
  const e4 = await evaluationOf('t4');
  say('    ' + describe(e4));
  checkOptionSet(e4);

  // ---- telemetry --------------------------------------------------------------------------------
  await host.stop();
  const records: Json[] = readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const evaluations = records.filter((r) => r.record === 'evaluation');
  const outcomes = records.filter((r) => r.record === 'outcome');
  assert.deepEqual(evaluations.map((r) => r.sourceTurnId), ['t1', 't2', 't3', 't4'], 'one evaluation per completed turn');
  assert.ok(outcomes.some((o) => o.outcome === 'sent' && o.selected?.kind === 'choice'));
  assert.ok(!JSON.stringify(records).includes('subtract'), 'telemetry must not contain message text');
  ok(`telemetry: ${evaluations.length} evaluation records, outcomes ${outcomes.map((o) => o.outcome).join(', ')}, no message text`);
  const latencies = evaluations.filter((r) => r.samplerMode).map((r) => r.usage?.latencyMs).filter((x) => typeof x === 'number');
  say(`\nsampler calls: ${evaluations.filter((r) => r.samplerMode).length}` +
    (latencies.length ? `, latency of delivered ones ${latencies.map((x) => (x / 1000).toFixed(1) + ' s').join(', ')}` : ''));
  say(`e2e passed: ${checks.length} checks`);
} catch (e) {
  failed = true;
  say(`\ne2e FAILED: ${(e as Error).message}`);
  await host.stop().catch(() => {});
} finally {
  if (host.grokSessionId) await deleteGrokSession(host.grokSessionId);
  rmSync(project, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
