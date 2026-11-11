// Sniffing active AI sessions across harnesses from their local stores (fixtures; no real home read).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { discoverSessions } from '../src/sessions.ts';

const iso = (ms: number) => new Date(ms).toISOString();

test('discovers running Grok sessions and recently active Claude/Codex/Muse sessions', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-sessions-'));
  const now = Date.now();
  const put = (rel: string, content: string, mtime = now) => {
    const file = join(home, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    utimesSync(file, new Date(mtime), new Date(mtime));
  };
  try {
    put('.grok/active_sessions.json', JSON.stringify([
      { session_id: 'g-alive', pid: process.pid, cwd: 'D:\\work', opened_at: iso(now - 60_000) },
      { session_id: 'g-dead', pid: 999999, cwd: 'D:\\work', opened_at: iso(now - 60_000) },
    ]));
    put(`.grok/sessions/${encodeURIComponent('D:\\work')}/g-alive/summary.json`,
      JSON.stringify({ generated_title: '活着的会话', last_active_at: iso(now - 30_000) }));
    put('.claude/projects/bucket/c-recent.jsonl',
      '{"type":"mode","sessionId":"c-recent"}\n{"type":"user","cwd":"D:\\\\claude-proj","sessionId":"c-recent"}\n');
    put('.claude/projects/bucket/c-old.jsonl', '{"type":"mode","sessionId":"c-old"}\n', now - 13 * 3_600_000);
    put('.codex/sessions/2026/11/11/rollout-2026-11-11T01-00-00-12345678-1234-1234-1234-1234567890ab.jsonl',
      '{"type":"session_meta","payload":{"cwd":"D:\\\\codex-proj"}}\n');
    put('.local/share/muse/sessions/2026/11/11/m-live/session.jsonl', '{}\n');

    const found = discoverSessions({ home, now, hermesHome: join(home, 'no-hermes') });
    const byId = new Map(found.map((s) => [s.id, s]));

    const grok = byId.get('g-alive');
    assert.equal(grok?.kind, 'grok');
    assert.equal(grok?.running, true);
    assert.equal(grok?.bindable, true);
    assert.equal(grok?.cwd, 'D:\\work');
    assert.equal(grok?.title, '活着的会话');
    assert.equal(byId.has('g-dead'), false, 'a registered session whose process is gone is not active');

    assert.equal(byId.get('c-recent')?.cwd, 'D:\\claude-proj');
    assert.equal(byId.get('c-recent')?.bindable, false);
    assert.equal(byId.has('c-old'), false, 'sessions idle past the window are not active');

    const codex = byId.get('12345678-1234-1234-1234-1234567890ab');
    assert.equal(codex?.kind, 'codex');
    assert.equal(codex?.cwd, 'D:\\codex-proj');

    assert.equal(byId.get('m-live')?.kind, 'muse');
    assert.equal(found[0]?.id, 'g-alive', 'running sessions come first');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('missing stores yield an empty list, not an error', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-sessions-empty-'));
  try {
    assert.deepEqual(discoverSessions({ home, now: Date.now(), hermesHome: join(home, 'no-hermes') }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

type HermesRow = [string, string | null, string | null, number, number | null, number];
function makeHermesDb(file: string, rows: HermesRow[], messages: Array<[string, number]>): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE sessions (id TEXT, source TEXT, title TEXT, cwd TEXT, started_at REAL, ended_at REAL, last_activity_at REAL, archived INTEGER, hidden INTEGER, profile_name TEXT)');
  db.exec('CREATE TABLE messages (id INTEGER, session_id TEXT, timestamp REAL)');
  const ins = db.prepare('INSERT INTO sessions (id, source, title, cwd, started_at, ended_at, last_activity_at, archived, hidden, profile_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [id, title, cwd, started, last, archived] of rows) {
    ins.run(id, 'cli', title, cwd, started, null, last, archived, 0, 'default');
  }
  const msg = db.prepare('INSERT INTO messages (session_id, timestamp) VALUES (?, ?)');
  for (const [sid, ts] of messages) msg.run(sid, ts);
  db.close();
}

test('discovers Hermes sessions from its SQLite store, including named profiles', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-hermes-'));
  const hermesHome = join(home, 'hermes');
  const now = Date.now();
  const s = Math.floor(now / 1000);
  try {
    makeHermesDb(join(hermesHome, 'state.db'), [
      ['h-recent', 'Hermes 会话', 'D:\\hermes-proj', s - 7200, s - 3600, 0],
      ['h-old', 'old', 'D:\\x', s - 13 * 3600, s - 13 * 3600, 0],
      ['h-arch', 'archived', 'D:\\x', s - 60, s - 60, 1],
      ['h-nocwd', null, null, s - 120, null, 0],
    ], [['h-recent', s - 60]]);
    makeHermesDb(join(hermesHome, 'profiles', 'coder', 'state.db'), [
      ['hp-1', 'profile session', 'D:\\prof', s - 300, null, 0],
    ], []);

    const found = discoverSessions({ home, now, hermesHome });
    const byId = new Map(found.map((x) => [x.id, x]));

    const recent = byId.get('h-recent');
    assert.equal(recent?.kind, 'hermes');
    assert.equal(recent?.bindable, true);
    assert.equal(recent?.running, false, 'no live-process proof for a specific Hermes session');
    assert.equal(recent?.cwd, 'D:\\hermes-proj');
    assert.equal(recent?.title, 'Hermes 会话');
    assert.equal(recent?.updatedAt, (s - 60) * 1000, 'activity follows the latest message, not just last_activity_at');
    assert.equal(recent?.profile, undefined);

    assert.equal(byId.has('h-old'), false);
    assert.equal(byId.has('h-arch'), false, 'archived sessions are not offered');
    assert.equal(byId.get('h-nocwd')?.cwd, undefined);
    assert.equal(byId.get('hp-1')?.profile, 'coder');
    assert.equal(byId.get('hp-1')?.bindable, true);
    assert.deepEqual(found.map((x) => x.id), ['h-recent', 'h-nocwd', 'hp-1']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('discovers Kimi sessions from its index, skipping deleted, archived and idle ones; Codex is bindable', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-kimi-disc-'));
  const saved = process.env.KIMI_CODE_HOME;
  delete process.env.KIMI_CODE_HOME;
  const now = Date.now();
  try {
    const root = join(home, '.kimi-code');
    const session = (id: string, state: object, mtime = now) => {
      const dir = join(root, 'sessions', 'wd_1', id);
      mkdirSync(join(dir, 'agents', 'main'), { recursive: true });
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ id, ...state }));
      const wire = join(dir, 'agents', 'main', 'wire.jsonl');
      writeFileSync(wire, '{"type":"metadata"}\n');
      utimesSync(wire, new Date(mtime), new Date(mtime));
      return dir;
    };
    const live = session('session_live', { cwd: 'D:\\kimi-proj', title: 'Kimi 会话', archived: false });
    const archived = session('session_archived', { cwd: 'D:\\x', archived: true });
    const idle = session('session_idle', { cwd: 'D:\\x' }, now - 13 * 3_600_000);
    const unsafe = session('-unsafe', { cwd: 'D:\\x' });
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'session_index.jsonl'), [
      { sessionId: 'session_live', sessionDir: live, workDir: 'D:\\kimi-proj' },
      { sessionId: 'session_gone', sessionDir: join(root, 'sessions', 'wd_1', 'session_gone'), workDir: 'D:\\x' },
      { sessionId: 'session_archived', sessionDir: archived },
      { sessionId: 'session_idle', sessionDir: idle },
      { sessionId: '-unsafe', sessionDir: unsafe },
    ].map((o) => JSON.stringify(o)).join('\n') + '\n');
    const codexDay = join(home, '.codex', 'sessions', '2026', '11', '11');
    mkdirSync(codexDay, { recursive: true });
    writeFileSync(join(codexDay, 'rollout-2026-11-11T01-00-00-12345678-1234-1234-1234-1234567890ab.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"D:\\\\codex-proj"}}\n');

    const byId = new Map(discoverSessions({ home, now, hermesHome: join(home, 'no-hermes') }).map((x) => [x.id, x]));
    assert.deepEqual(byId.get('session_live'), {
      kind: 'kimi', id: 'session_live', running: false, bindable: true, updatedAt: byId.get('session_live')?.updatedAt,
      cwd: 'D:\\kimi-proj', title: 'Kimi 会话',
    });
    for (const id of ['session_gone', 'session_archived', 'session_idle']) assert.equal(byId.has(id), false, id);
    assert.equal(byId.get('-unsafe')?.bindable, false);
    assert.equal(byId.get('12345678-1234-1234-1234-1234567890ab')?.bindable, true, 'Codex sessions can now be bound');
  } finally {
    if (saved !== undefined) process.env.KIMI_CODE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sessions whose id or profile could act as an option are listed but not bindable', () => {
  const home = mkdtempSync(join(tmpdir(), 'ip-sessions-unsafe-'));
  const hermesHome = join(home, 'hermes');
  const now = Date.now();
  const s = Math.floor(now / 1000);
  try {
    const registry = join(home, '.grok', 'active_sessions.json');
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, JSON.stringify([
      { session_id: '--always-approve', pid: process.pid, cwd: 'D:\\work', opened_at: iso(now) },
      { session_id: 'g-plain', pid: process.pid, cwd: 'D:\\work', opened_at: iso(now) },
    ]));
    makeHermesDb(join(hermesHome, 'state.db'), [['--yolo', null, 'D:\\x', s - 60, s - 60, 0]], []);
    makeHermesDb(join(hermesHome, 'profiles', '-bad', 'state.db'), [['hp-2', null, 'D:\\y', s - 60, s - 60, 0]], []);

    const byId = new Map(discoverSessions({ home, now, hermesHome }).map((x) => [x.id, x]));
    assert.equal(byId.get('--always-approve')?.bindable, false);
    assert.equal(byId.get('g-plain')?.bindable, true);
    assert.equal(byId.get('--yolo')?.bindable, false);
    assert.equal(byId.get('hp-2')?.profile, '-bad');
    assert.equal(byId.get('hp-2')?.bindable, false, 'a profile that could act as an option makes its sessions unbindable');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
