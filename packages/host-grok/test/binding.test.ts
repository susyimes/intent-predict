// The bundled surface's session picker, end to end: surface RPC -> sidecar -> host binding.
// Every agent CLI points nowhere unless a test gives it a stand-in: no real agent ever runs here.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLAUDE_SAMPLE_ARGS, claudeTurnArgs } from '../src/claude.ts';
import { CODEX_SAMPLE_ARGS } from '../src/codex.ts';
import { GrokHost } from '../src/host.ts';
import type { GrokHostOptions } from '../src/host.ts';

const NO_BIN = 'intent-predict-no-such-bin';
const FAKE_ACP = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function started(extra: Partial<GrokHostOptions> = {}) {
  const host = new GrokHost({ cwd: process.cwd(), bin: NO_BIN, hermesBin: NO_BIN, codexBin: NO_BIN, kimiBin: NO_BIN, claudeBin: NO_BIN, ...extra });
  await host.start();
  const base = new URL(host.surfaceUrl!);
  const token = base.searchParams.get('t')!;
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(new URL('/rpc', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return res.json() as Promise<any>;
  };
  return { host, base, token, rpc };
}

test('the picker page is served and attach advertises binding', async () => {
  const { host, base, token, rpc } = await started();
  try {
    const attached = await rpc('surface/attach', {});
    assert.equal(attached.result.binding, true);

    const page = await fetch(new URL('/sessions?t=' + encodeURIComponent(token), base));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /选择会话/);
    assert.match(html, /建议由该会话自己的 Agent 挑/, 'the picker says who picks the suggestions for a bound session');

    const list = await rpc('binding/list', {});
    assert.equal(list.result.current, null);
    assert.ok(Array.isArray(list.result.sessions));
    for (const s of list.result.sessions) {
      assert.equal(typeof s.kind, 'string');
      assert.equal(typeof s.id, 'string');
      assert.equal(typeof s.bindable, 'boolean');
    }
  } finally {
    await host.stop();
  }
});

test('the eager preset selects the eager pack and lower gate settings', async () => {
  const { host } = await started({ eagerness: 'eager' });
  try {
    assert.deepEqual(host.loadedPacks, [{ id: 'builtin/coding-eager', version: '0.5.0', scenarioCount: 7 }]);
    assert.deepEqual(host.gateSettings, {
      eagerness: 'eager', minConfidence: 0.35, sideEffectMinConfidence: 0.65,
      altMinConfidence: 0.05, cooldownTurnsAfterDismiss: 0,
    });
  } finally {
    await host.stop();
  }

  const custom = await started({
    eagerness: 'eager', minConfidence: 0.5, sideEffectMinConfidence: 0.7,
    altMinConfidence: 0.1, cooldownTurnsAfterDismiss: 1,
  });
  try {
    assert.deepEqual(custom.host.gateSettings, {
      eagerness: 'eager', minConfidence: 0.5, sideEffectMinConfidence: 0.7,
      altMinConfidence: 0.1, cooldownTurnsAfterDismiss: 1,
    });
  } finally {
    await custom.host.stop();
  }
});

test('binding hot-switches the host to a Grok session and refuses other kinds', async () => {
  const { host, rpc } = await started();
  try {
    const before = host.sessionId;
    const refused = await rpc('binding/bind', { kind: 'muse', id: 'm-1', cwd: process.cwd() });
    assert.equal(refused.error.code, -32602);
    assert.equal(host.grokSessionId, undefined);

    const badCwd = await rpc('binding/bind', { kind: 'grok', id: 'g-1', cwd: join(process.cwd(), 'no-such-dir-xyz') });
    assert.equal(badCwd.error.code, -32602);

    const bound = await rpc('binding/bind', { kind: 'grok', id: 'g-1', cwd: process.cwd() });
    assert.equal(bound.result.bound.id, 'g-1');
    assert.equal(host.grokSessionId, 'g-1');
    assert.notEqual(host.sessionId, before, 'a fresh core session starts at bind: no history is carried');
    assert.equal(host.lastCompletedTurn, undefined);

    const list = await rpc('binding/list', {});
    assert.equal(list.result.current.id, 'g-1');
  } finally {
    await host.stop();
  }
});

test('attach and the event stream reflect a binding change at once', async () => {
  const { host, base, token, rpc } = await started();
  const ac = new AbortController();
  try {
    const events = await fetch(new URL('/events?t=' + encodeURIComponent(token), base), { signal: ac.signal });
    const changed = (async () => {
      const reader = events.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!buf.includes('binding/changed')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      return buf;
    })();

    await rpc('binding/bind', { kind: 'hermes', id: 'h-live', cwd: process.cwd() });
    const seen = await Promise.race([
      changed,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('no binding/changed within 5s')), 5000).unref()),
    ]);
    assert.match(seen, /h-live/);

    // A freshly loaded suggestion page attaches after the bind: it must learn the binding
    // and the host's new core session even though no turn has run under it yet.
    const attached = await rpc('surface/attach', {});
    assert.equal(attached.result.bound.id, 'h-live');
    assert.equal(attached.result.bound.kind, 'hermes');
    assert.equal(attached.result.activeSessionId, host.sessionId);
    assert.ok(attached.result.sessions.some((s: any) => s.sessionId === host.sessionId));
  } finally {
    ac.abort();
    await host.stop();
  }
});

function seedHermesHome(): string {
  const hermesHome = mkdtempSync(join(tmpdir(), 'ip-bind-replay-'));
  const nowSec = Math.floor(Date.now() / 1000);
  mkdirSync(hermesHome, { recursive: true });
  const db = new DatabaseSync(join(hermesHome, 'state.db'));
  db.exec('CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, cwd TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, archived INTEGER, hidden INTEGER, profile_name TEXT)');
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, finish_reason TEXT)');
  db.prepare('INSERT INTO sessions (id, source, title, cwd, started_at, last_activity_at, archived, hidden, profile_name) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)')
    .run('h-replay', 'cli', 'replay me', process.cwd(), nowSec - 600, nowSec - 60, 'default');
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, ?, ?, ?, ?)');
  ins.run('h-replay', 'user', '第一问', nowSec - 600, null);
  ins.run('h-replay', 'assistant', '第一答', nowSec - 590, 'stop');
  ins.run('h-replay', 'user', '第二问', nowSec - 120, null);
  ins.run('h-replay', 'assistant', '第二答，要我跑一下测试吗？', nowSec - 60, 'stop');
  db.close();
  return hermesHome;
}

function appendHermesTurn(hermesHome: string): void {
  const nowSec = Math.floor(Date.now() / 1000);
  const db = new DatabaseSync(join(hermesHome, 'state.db'));
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, timestamp, finish_reason) VALUES (?, ?, ?, ?, ?)');
  ins.run('h-replay', 'user', '第三问', nowSec, null);
  ins.run('h-replay', 'assistant', '第三答，要继续吗？', nowSec, 'stop');
  db.close();
}

test('binding replays the recent completed turns so evaluation starts at once', async () => {
  const hermesHome = seedHermesHome();
  try {

    // bin points nowhere: the sampler fails fast instead of reaching a real model.
    const { host, rpc } = await started({ hermesHome, bin: 'intent-predict-no-such-bin' });
    try {
      const bound = await rpc('binding/bind', { kind: 'hermes', id: 'h-replay', cwd: process.cwd() });
      assert.equal(bound.result.replayedTurns, 2);
      assert.equal(typeof host.lastCompletedTurn, 'string', 'the last replayed turn is pinned for sampler and dispatch');
      const list = await rpc('binding/list', {});
      assert.equal(list.result.current.id, 'h-replay');
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('a surface attaching after an evaluation still receives its record', async () => {
  const hermesHome = seedHermesHome();
  try {
    const { host, rpc } = await started({ hermesHome, bin: 'intent-predict-no-such-bin' });
    try {
      await rpc('binding/bind', { kind: 'hermes', id: 'h-replay', cwd: process.cwd() });
      // No surface was attached while the replay evaluated; a fresh inspector attach must carry it.
      let recent: any[] = [];
      for (const end = Date.now() + 10_000; Date.now() < end;) {
        const attached = await rpc('surface/attach', { inspector: true });
        recent = attached.result.sessions.find((s: any) => s.sessionId === host.sessionId)?.recent ?? [];
        if (recent.some((e: any) => e.result.suppressedReason === 'sampler_error')) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(recent.some((e: any) => e.result.suppressedReason === 'sampler_error'), 'the suppressed evaluation is retained');
      assert.ok(recent.every((e: any) => typeof e.at === 'number'));
      const plain = await rpc('surface/attach', {});
      const plainRecent = plain.result.sessions.find((s: any) => s.sessionId === host.sessionId)?.recent ?? [];
      assert.ok(plainRecent.every((e: any) => e.result.prediction), 'plain attaches only carry delivered evaluations');
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('refreshing a surface syncs external turns added since bind', async () => {
  const hermesHome = seedHermesHome();
  try {
    const { host, rpc } = await started({ hermesHome, bin: 'intent-predict-no-such-bin' });
    try {
      await rpc('binding/bind', { kind: 'hermes', id: 'h-replay', cwd: process.cwd() });
      assert.equal(host.lastCompletedTurn, 't2');

      appendHermesTurn(hermesHome);
      let recent: any[] = [];
      for (const end = Date.now() + 10_000; Date.now() < end;) {
        const attached = await rpc('surface/attach', { inspector: true });
        recent = attached.result.sessions.find((s: any) => s.sessionId === host.sessionId)?.recent ?? [];
        if (recent.some((e: any) => e.sourceTurnId === 't3' && e.result.suppressedReason === 'sampler_error')) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(host.lastCompletedTurn, 't3', 'the refresh-triggered sync pins the external turn');
      assert.ok(recent.some((e: any) => e.sourceTurnId === 't3'), 'the external turn was evaluated after refresh');

      await rpc('surface/attach', { inspector: true });
      await new Promise((r) => setTimeout(r, 350));
      const again = await rpc('surface/attach', { inspector: true });
      const againRecent = again.result.sessions.find((s: any) => s.sessionId === host.sessionId)?.recent ?? [];
      assert.equal(againRecent.some((e: any) => e.sourceTurnId === 't4'), false, 'a second refresh does not replay the same external turn again');
    } finally {
      await host.stop();
    }
  } finally {
    rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('binding refuses ids, profiles and cwds that could act as options or leave the stores', async () => {
  const { host, rpc } = await started();
  try {
    for (const id of ['--always-approve', '-p', '..', '../x', 'a/b', 'a\\b', 'a b', '']) {
      const refused = await rpc('binding/bind', { kind: 'grok', id, cwd: process.cwd() });
      assert.equal(refused.error?.code, -32602, `id ${JSON.stringify(id)} must be refused`);
    }
    for (const profile of ['--yolo', '../other', 'a/b']) {
      const refused = await rpc('binding/bind', { kind: 'hermes', id: 'h-1', cwd: process.cwd(), profile });
      assert.equal(refused.error?.code, -32602, `profile ${JSON.stringify(profile)} must be refused`);
    }
    const relative = await rpc('binding/bind', { kind: 'grok', id: 'g-1', cwd: '.' });
    assert.equal(relative.error?.code, -32602, 'a relative cwd is refused');
    assert.equal(host.grokSessionId, undefined);
    assert.equal(host.hermesSessionId, undefined);

    const uuid = '01a1c874-dfaa-7bd3-a8b4-f53e74961c74';
    const bound = await rpc('binding/bind', { kind: 'grok', id: uuid, cwd: process.cwd() });
    assert.equal(bound.result.bound.id, uuid, 'a real Grok session id still binds');
  } finally {
    await host.stop();
  }
});

test('a turn never hands grok a flag-like session id', async () => {
  const infos: string[] = [];
  // bin points nowhere: had the id been passed on, the turn would instead fail spawning grok.
  const { host } = await started({ bin: 'intent-predict-no-such-bin', onInfo: (m) => infos.push(m) });
  try {
    host.grokSessionId = '--always-approve';
    await host.send('继续');
    assert.ok(infos.some((m) => /could not run grok: session id must be a plain name/.test(m)), infos.join(' | '));
    assert.ok(!infos.some((m) => /ENOENT/.test(m)), 'grok is not even spawned');
    assert.equal(host.busy, false, 'the refused turn still ends');
  } finally {
    await host.stop();
  }
});

/** The first finished evaluation of the host's current core session, as an inspector sees it. */
async function firstEvaluation(rpc: (m: string, p?: Record<string, unknown>) => Promise<any>, host: GrokHost): Promise<any> {
  for (const end = Date.now() + 20_000; Date.now() < end;) {
    const attached = await rpc('surface/attach', { inspector: true });
    const recent: any[] = attached.result.sessions.find((s: any) => s.sessionId === host.sessionId)?.recent ?? [];
    const done = recent.find((e) => e.result.prediction || e.result.suppressedReason);
    if (done) return done;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('no evaluation within 20 s');
}

test('a bound Codex session is replayed from its rollout and evaluated by Codex itself', async () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-codex-home-'));
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const log = join(home, 'codex.log');
  writeFileSync(log, '');
  try {
    const id = '01a1ca3a-0000-7000-8000-00000000abcd';
    const day = join(home, 'sessions', '2026', '11', '11');
    mkdirSync(day, { recursive: true });
    const row = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-11-11T10:00:00Z', type, payload });
    writeFileSync(join(day, `rollout-2026-11-11T18-00-00-${id}.jsonl`), [
      row('session_meta', { id, cwd: process.cwd() }),
      row('event_msg', { type: 'task_started', turn_id: 'u1' }),
      row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the login' }] }),
      row('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Update File: src/login.py\n*** End Patch' }),
      row('response_item', { type: 'custom_tool_call_output', call_id: 'p1', output: 'Success.' }),
      row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Changed the login check.' }] }),
      row('event_msg', { type: 'task_complete', turn_id: 'u1' }),
    ].join('\n') + '\n');
    const { host, rpc } = await started({ codexBin: { command: process.execPath, prefix: [FAKE_CODEX, log] } });
    try {
      const bound = await rpc('binding/bind', { kind: 'codex', id, cwd: process.cwd() });
      assert.equal(bound.result.bound.kind, 'codex');
      assert.equal(bound.result.replayedTurns, 1);
      const evaluation = await firstEvaluation(rpc, host);
      assert.equal(evaluation.result.prediction?.intent.id, 'run_tests', JSON.stringify(evaluation.result));
      const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.deepEqual(calls.map((c) => c.args), [CODEX_SAMPLE_ARGS], 'Codex itself picked the suggestion, in an ephemeral call');
    } finally {
      await host.stop();
    }
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test('a bound Kimi session is replayed from its wire log and evaluated by Kimi itself', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ip-kimi-home-'));
  const saved = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  const log = join(root, 'acp.log');
  writeFileSync(log, '');
  try {
    const dir = join(root, 'sessions', 'wd_1', 'session_k1');
    mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
    writeFileSync(join(root, 'session_index.jsonl'), JSON.stringify({ sessionId: 'session_k1', sessionDir: dir, workDir: process.cwd() }) + '\n');
    const loop = (event: object) => ({ type: 'context.append_loop_event', agentId: 'main', event });
    writeFileSync(join(dir, 'agents', 'main', 'wire.jsonl'), [
      { type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'fix the login' }], origin: { kind: 'user' } },
      loop({ type: 'tool.call', toolCallId: 'e1', name: 'Edit', args: { path: join(process.cwd(), 'src', 'login.ts') } }),
      loop({ type: 'tool.result', toolCallId: 'e1', result: { output: 'ok' } }),
      loop({ type: 'content.part', part: { type: 'text', text: 'Changed the login check.' } }),
      { type: 'turn.ended', agentId: 'main', reason: 'completed' },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const { host, rpc } = await started({ kimiBin: { command: process.execPath, prefix: [FAKE_ACP, log] } });
    try {
      const bound = await rpc('binding/bind', { kind: 'kimi', id: 'session_k1', cwd: process.cwd() });
      assert.equal(bound.result.replayedTurns, 1);
      const evaluation = await firstEvaluation(rpc, host);
      assert.equal(evaluation.result.prediction?.intent.id, 'run_tests', JSON.stringify(evaluation.result));
    } finally {
      await host.stop();                                   // waits for the throwaway session's deletion
    }
    const methods = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).method).filter(Boolean);
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt', 'session/delete'],
      'Kimi itself picked the suggestion, in a session it then deleted');
  } finally {
    if (saved === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

/** A Claude Code home (CLAUDE_CONFIG_DIR) holding one completed session in this cwd's project, and a log for the stand-in. */
function seedClaudeHome() {
  const root = mkdtempSync(join(tmpdir(), 'ip-claude-home-'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const log = join(root, 'claude.log');
  writeFileSync(log, '');
  const id = '68608922-0000-4000-8000-00000000abcd';
  const project = join(root, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(project, { recursive: true });
  const line = (o: object) => JSON.stringify({ sessionId: id, cwd: process.cwd(), isSidechain: false, ...o });
  writeFileSync(join(project, `${id}.jsonl`), [
    line({ type: 'user', message: { role: 'user', content: 'fix the login' }, turnOrigin: 'human', promptSource: 'typed' }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: join(process.cwd(), 'src', 'login.ts') } }], stop_reason: 'tool_use' } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'The file has been updated successfully.', is_error: false }] } }),
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Changed the login check.' }], stop_reason: 'end_turn' } }),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 1000 }),
  ].join('\n') + '\n');
  return {
    root, id, log,
    bin: { command: process.execPath, prefix: [FAKE_CLAUDE, log] },
    calls: (): Array<{ args: string[]; input: string; cwd: string }> => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    done: () => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a bound Claude Code session is replayed and evaluated by Claude itself; a send waits until no other process has it open', async () => {
  const { root, id, bin, calls, done } = seedClaudeHome();
  try {
    const infos: string[] = [];
    const { host, rpc } = await started({ claudeBin: bin, onInfo: (m) => infos.push(m) });
    try {
      const bound = await rpc('binding/bind', { kind: 'claude', id, cwd: process.cwd() });
      assert.equal(bound.result.bound.kind, 'claude');
      assert.equal(bound.result.replayedTurns, 1);
      const evaluation = await firstEvaluation(rpc, host);
      const p = evaluation.result.prediction;
      assert.equal(p?.intent.id, 'run_tests', JSON.stringify(evaluation.result));
      assert.deepEqual(calls().map((c) => c.args), [CLAUDE_SAMPLE_ARGS], 'Claude itself picked the suggestion, in a call that kept no session');

      // the session is open in a Claude Code window (this test process stands in for it)
      const registry = join(root, 'sessions', `${process.pid}.json`);
      mkdirSync(join(root, 'sessions'), { recursive: true });
      writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: id, cwd: process.cwd(), kind: 'interactive', status: 'idle' }));
      const send = () => rpc('prediction/act', { predictionId: p.id, action: 'send', text: p.text, confirmed: p.confirmBeforeSend || undefined });
      assert.equal((await send()).result.status, 'busy');
      assert.ok(infos.some((m) => /not sent: this Claude session is open in another Claude Code process/.test(m)), infos.join(' | '));
      assert.equal(calls().length, 1, 'claude is not even started for the refused send');

      rmSync(registry);
      assert.equal((await send()).result.status, 'dispatched');
      for (const end = Date.now() + 10_000; Date.now() < end && calls().length < 2;) await new Promise((r) => setTimeout(r, 50));
      const turn = calls()[1]!;
      assert.deepEqual(turn.args, claudeTurnArgs(id), 'the send continues the bound session');
      assert.equal(turn.input, p.text);
      assert.equal(turn.cwd, process.cwd());
      await host.idle();
    } finally {
      await host.stop();
    }
  } finally {
    done();
  }
});

test('stopping the host while a classification call runs aborts the call and closes cleanly', async () => {
  const claude = seedClaudeHome();
  process.env.FAKE_CLAUDE_DELAY_MS = '4000';
  try {
    const { host, rpc } = await started({ claudeBin: claude.bin });
    await rpc('binding/bind', { kind: 'claude', id: claude.id, cwd: process.cwd() });
    for (const end = Date.now() + 10_000; Date.now() < end && !claude.calls().length;) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(claude.calls().map((c) => c.args), [CLAUDE_SAMPLE_ARGS], 'the classification call is running');
    const t = Date.now();
    await host.stop();                                     // its reply must not be written to a closed pipe
    assert.ok(Date.now() - t < 3000, 'the running call was aborted, not waited out');
  } finally {
    delete process.env.FAKE_CLAUDE_DELAY_MS;
    claude.done();
  }
});

test('binding can hot-switch to a Hermes session, profile included, and back', async () => {
  const { host, rpc } = await started();
  try {
    const bound = await rpc('binding/bind', { kind: 'hermes', id: 'h-1', cwd: process.cwd(), profile: 'coder' });
    assert.deepEqual(bound.result.bound, { kind: 'hermes', id: 'h-1', cwd: process.cwd(), profile: 'coder' });
    assert.equal(host.hermesSessionId, 'h-1');
    assert.equal(host.lastCompletedTurn, undefined);

    const list = await rpc('binding/list', {});
    assert.equal(list.result.current.kind, 'hermes');

    const back = await rpc('binding/bind', { kind: 'grok', id: 'g-9', cwd: process.cwd() });
    assert.equal(back.result.bound.kind, 'grok');
    assert.equal(host.grokSessionId, 'g-9');
  } finally {
    await host.stop();
  }
});
