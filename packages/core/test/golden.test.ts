// Conformance: every case of eval/golden.jsonl (SPEC 9.1) against the TypeScript core.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Core, RpcError, loadPackFile, resolve } from '../src/index.ts';
import type {
  DispatchRequest, HostBridge, InvalidatedParams, OutcomeRecord, Prediction, ScenarioPack, Signals, UpdatedParams,
} from '../src/index.ts';

const ROOT = new URL('../../../', import.meta.url);
const file = (rel: string) => fileURLToPath(new URL(rel, ROOT));
type Json = Record<string, any>;
const cases: Json[] = readFileSync(file('eval/golden.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const packs = new Map<string, ScenarioPack>();
const pack = (rel: string) => packs.get(rel) ?? packs.set(rel, loadPackFile(file(rel))).get(rel)!;

interface StepLog {
  updated: UpdatedParams[]; invalidated: InvalidatedParams[]; outcomes: OutcomeRecord[];
  samplerCancelled: boolean; dispatch?: DispatchRequest; hostReply?: { error?: number };
}
const freshLog = (): StepLog => ({ updated: [], invalidated: [], outcomes: [], samplerCancelled: false });

function subset(expected: unknown, actual: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual !== null && typeof actual === 'object'
      && Object.entries(expected).every(([k, v]) => k in (actual as Json) && subset(v, (actual as Json)[k]));
  }
  if (typeof expected === 'number' && typeof actual === 'number') return Math.abs(expected - actual) < 1e-6;
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch {
    return false;
  }
}

function checkPrediction(expected: Json, p: Prediction): string[] {
  const exp = { ...expected };
  const probes: Json = p.mode === 'open'
    ? { candidateTexts: p.candidates.map((c) => c.text) }
    : {
      intentId: p.intent.id,
      alternativeIds: p.alternatives.map((a) => a.intentId),
      choiceTexts: (p.choices ?? []).map((c) => c.text),
      choiceLabels: (p.choices ?? []).map((c) => c.label),
    };
  const errs: string[] = [];
  for (const [k, v] of Object.entries(probes)) {
    if (k in exp && !subset(exp[k], v)) errs.push(`prediction.${k}: expected ${JSON.stringify(exp[k])}, got ${JSON.stringify(v)}`);
    delete exp[k];
  }
  if ('contextIncludes' in exp && !(p.context?.excerpt ?? '').includes(exp.contextIncludes)) {
    errs.push(`context.excerpt lacks ${JSON.stringify(exp.contextIncludes)}: ${JSON.stringify(p.context)}`);
  }
  delete exp.contextIncludes;
  for (const [k, v] of Object.entries(exp)) {
    const got = (p as unknown as Json)[k];
    if (v === null ? got !== undefined : !subset(v, got)) {
      errs.push(`prediction.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
    }
  }
  return errs;
}

function checkStep(expect: Json, log: StepLog, addressed: Prediction | undefined, status?: string, error?: number): string[] {
  const errs: string[] = [];
  const last = log.updated.at(-1);
  const result = last?.result;
  const trace = last?.trace ?? {};
  const delivered = result?.type === 'completed' ? result.prediction : undefined;
  const reason = result?.type === 'completed' && !result.prediction ? result.suppressedReason : undefined;
  if (expect.noEvaluation && log.updated.length) errs.push(`expected no evaluation, got ${JSON.stringify(result)}`);
  if ('suppressedReason' in expect && reason !== expect.suppressedReason) {
    errs.push(`expected suppression ${expect.suppressedReason}, got ${reason ?? (delivered ? 'prediction ' + (delivered.mode === 'open' ? delivered.text : delivered.intent.id) : JSON.stringify(result) ?? 'no evaluation')}`);
  }
  if ('prediction' in expect) {
    if (!delivered) errs.push(`expected a prediction, got ${reason ?? 'no evaluation'}`);
    else errs.push(...checkPrediction(expect.prediction, delivered));
  }
  for (const [path, want] of Object.entries(expect.signals ?? {})) {
    const got = trace.signals ? resolve(trace.signals as Signals, path) : undefined;
    if (want === null ? got !== undefined : !subset(want, got)) errs.push(`signal ${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  if (expect.catalog) {
    const got = trace.catalog ?? [];
    if (expect.catalog.scenarioId && trace.scenarioId !== expect.catalog.scenarioId) {
      errs.push(`scenario: expected ${expect.catalog.scenarioId}, got ${trace.scenarioId}`);
    }
    for (const id of expect.catalog.includes ?? []) if (!got.includes(id)) errs.push(`catalog lacks ${id} (has ${got})`);
    for (const id of expect.catalog.excludes ?? []) if (got.includes(id)) errs.push(`catalog must not contain ${id}`);
  }
  if (expect.prompt) {
    const prompt = trace.prompt;
    if (prompt === undefined) errs.push('no prompt was rendered');
    else {
      for (const x of expect.prompt.includes ?? []) if (!prompt.includes(x)) errs.push(`prompt lacks ${JSON.stringify(x)}`);
      for (const x of expect.prompt.excludes ?? []) if (prompt.includes(x)) errs.push(`prompt must not contain ${JSON.stringify(x)}`);
      const bytes = Buffer.byteLength(prompt, 'utf8');
      if (expect.prompt.maxBytes !== undefined && bytes > expect.prompt.maxBytes) errs.push(`prompt is ${bytes} bytes`);
    }
  }
  const reasons = log.invalidated.map((i) => i.reason);
  if ('invalidated' in expect && !reasons.includes(expect.invalidated)) errs.push(`expected invalidated(${expect.invalidated}), got [${reasons}]`);
  if (expect.noInvalidation && reasons.length) errs.push(`expected no invalidation, got [${reasons}]`);
  if (expect.samplerCancelled && !log.samplerCancelled) errs.push('expected sampler/cancel');
  if ('status' in expect && status !== expect.status) errs.push(`act status: expected ${expect.status}, got ${status}`);
  if ('error' in expect && error !== expect.error) errs.push(`act error: expected ${expect.error}, got ${error}`);
  if ('dispatch' in expect) {
    if (expect.dispatch === null) {
      if (log.dispatch) errs.push(`expected no dispatch, got ${JSON.stringify(log.dispatch)}`);
    } else {
      const want = JSON.parse(JSON.stringify(expect.dispatch).replaceAll('$predictionId', addressed?.id ?? '?'));
      if (!subset(want, log.dispatch)) errs.push(`dispatch: expected ${JSON.stringify(want)}, got ${JSON.stringify(log.dispatch)}`);
    }
  }
  if ('outcome' in expect && !log.outcomes.some((o) => subset(expect.outcome, o))) {
    errs.push(`expected outcome ${JSON.stringify(expect.outcome)}, got ${JSON.stringify(log.outcomes)}`);
  }
  if (expect.noOutcome && log.outcomes.length) errs.push(`expected no outcome record, got ${JSON.stringify(log.outcomes)}`);
  return errs;
}

async function runCase(c: Json): Promise<string[]> {
  const config = c.config ?? {};
  const sampler = config.sampler ?? 'none';
  let log = freshLog();
  let lastDelivered: Prediction | undefined;
  let ids = 0;
  const host: HostBridge = {
    interactive: config.interactive ?? true,
    dispatchModes: config.dispatchModes ?? [],
    dispatch: (request) => {
      log.dispatch = request;
      return log.hostReply?.error ? Promise.reject(new RpcError(log.hostReply.error, 'refused')) : Promise.resolve();
    },
  };
  if (sampler !== 'none') {
    const replies: string[] = [...(sampler.replies ?? [])];
    host.samplerModes = [sampler.mode ?? 'compact'];
    host.sample = (_request, signal) => {
      signal.addEventListener('abort', () => { log.samplerCancelled = true; }, { once: true });
      if (sampler.pending || sampler.timeout) return new Promise(() => {});
      if ('error' in sampler) return Promise.reject(new RpcError(sampler.error, 'refused'));
      return Promise.resolve({ text: sampler.replyNull ? null : (replies.shift() ?? sampler.reply) });
    };
  }
  const core = new Core([pack(c.pack ?? 'INTENTS.md')], host, {
    policy: config.policy,
    options: { ...config.options, settleMs: 0, timeoutMs: sampler.timeout ? 5 : 60_000 },
    debugTrace: true,
    newId: () => `p-${++ids}`,
    telemetry: (record) => { if (record.record === 'outcome') log.outcomes.push(record); },
  });
  core.on('updated', (p) => {
    log.updated.push(p);
    if (p.result.type === 'completed' && p.result.prediction) lastDelivered = p.result.prediction;
  });
  core.on('invalidated', (p) => log.invalidated.push(p));
  const settle = async () => {
    for (let i = 0; i < 2000; i++) {
      await new Promise((r) => setTimeout(r, 0));
      if (!core.busy || (sampler.pending && core.sampling)) return;
    }
    throw new Error('the core did not settle');
  };
  const sid: string = c.sessionId ?? 's1';

  if (c.kind === 'pipeline') {
    const state = Object.entries(c.state ?? {}).map(([key, value]) => ({ type: 'state', key, value }));
    core.observe(sid, [...c.events.slice(0, -1), ...state]);
    await settle();
    log = freshLog();
    core.observe(sid, c.events.slice(-1));
    await settle();
    return checkStep(c.expect, log, lastDelivered);
  }

  const errs: string[] = [];
  for (const [n, step] of (c.steps as Json[]).entries()) {
    log = freshLog();
    let status: string | undefined;
    let error: number | undefined;
    const addressed = lastDelivered;
    if (step.observe) core.observe(sid, step.observe);
    else if (step.cancel) core.cancel(sid);
    else {
      const { hostReply, ...params } = step.act;
      log.hostReply = hostReply;
      try {
        status = await core.act({ ...params, predictionId: addressed?.id ?? 'none' });
      } catch (e) {
        if (!(e instanceof RpcError)) throw e;
        error = e.code;
      }
    }
    await settle();
    errs.push(...checkStep(step.expect ?? {}, log, addressed, status, error).map((e) => `step ${n + 1}: ${e}`));
  }
  return errs;
}

for (const c of cases) {
  test(`golden ${c.id}`, async () => {
    assert.deepEqual(await runCase(c), []);
  });
}
