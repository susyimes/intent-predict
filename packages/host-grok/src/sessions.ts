// Sniff out active AI sessions on this machine from each harness's local store, so the bundled
// surface can offer them for binding. Discovery reads metadata only (ids, cwds, titles,
// timestamps) and never conversation bodies. Only Grok registers its live sessions; elsewhere
// "active" means recent activity in the store. Grok, Hermes, Codex and Kimi sessions are bindable
// from this host when their ids are plain names (see isSafeName): their turns are driven
// headlessly by the adapters in grok.ts, hermes.ts, codex.ts and kimi.ts.
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

export type SessionKind = 'grok' | 'hermes' | 'codex' | 'kimi' | 'claude-code' | 'muse';

export interface DiscoveredSession {
  kind: SessionKind;
  id: string;
  cwd?: string;
  title?: string;
  /** Epoch ms of the latest known activity. */
  updatedAt?: number;
  /** True only when a live process is known to own the session (Grok's registry). */
  running: boolean;
  bindable: boolean;
  /** Host-defined instance/profile name when the kind has them (Hermes profiles). */
  profile?: string;
}

export interface DiscoverOptions {
  home?: string;
  /** Hermes home override (default: HERMES_HOME, else %LOCALAPPDATA%\hermes, else ~/.hermes). */
  hermesHome?: string;
  now?: number;
  /** How recent a session file must be to count as active where no registry exists. */
  windowMs?: number;
  limitPerKind?: number;
}

const DEFAULT_WINDOW_MS = 12 * 3_600_000;
const MAX_ENTRIES = 4000;
const UUIDS = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

function jsonFile(file: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}
function head(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0)).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const epoch = (value: unknown): number | undefined => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Session ids and profile names end up on command lines (`grok --resume <id>`, `hermes -p <profile>`)
 * and in store paths. A leading `-` would be parsed as a flag (`grok --resume --always-approve`
 * resumes the latest session and approves every tool), and separators or `..` would leave the
 * store, so only plain names are accepted.
 */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function isSafeName(value: unknown): value is string {
  return typeof value === 'string' && PLAIN_NAME.test(value) && !value.includes('..');
}
/** Returns `value` when it is a plain name, and throws otherwise. */
export function safeName(value: string, what: string): string {
  if (!isSafeName(value)) {
    throw new Error(`${what} must be a plain name (letters, digits, '.', '_' or '-', starting with a letter or digit): ${JSON.stringify(value)}`);
  }
  return value;
}

/** Grok: the live registry at ~/.grok/active_sessions.json, enriched from each summary.json. */
function grokSessions(home: string): DiscoveredSession[] {
  let registry: unknown;
  try {
    registry = JSON.parse(readFileSync(join(home, '.grok', 'active_sessions.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(registry)) return [];
  const out: DiscoveredSession[] = [];
  for (const entry of registry as Array<Record<string, any>>) {
    const id = entry?.session_id;
    const cwd = entry?.cwd;
    if (typeof id !== 'string' || typeof cwd !== 'string' || typeof entry?.pid !== 'number' || !alive(entry.pid)) continue;
    const plain = isSafeName(id);
    const summary = plain ? jsonFile(join(home, '.grok', 'sessions', encodeURIComponent(cwd), id, 'summary.json')) : undefined;
    const title = summary?.generated_title ?? summary?.session_summary;
    const session: DiscoveredSession = {
      kind: 'grok', id, cwd, running: true, bindable: plain,
      updatedAt: epoch(summary?.last_active_at ?? summary?.updated_at) ?? epoch(entry.opened_at),
    };
    if (typeof title === 'string' && title) session.title = title;
    out.push(session);
  }
  return out;
}

/** Files under `root` (bounded walk) whose mtime is inside the window, newest first. */
function recentFiles(root: string, depth: number, keep: (name: string) => boolean, cutoff: number, limit: number): string[] {
  const found: Array<{ file: string; mtime: number }> = [];
  let seen = 0;
  const walk = (dir: string, left: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (left > 0) walk(path, left - 1);
      } else if (entry.isFile() && keep(entry.name)) {
        try {
          const mtime = statSync(path).mtimeMs;
          if (mtime >= cutoff) found.push({ file: path, mtime });
        } catch { /* vanished mid-scan */ }
      }
    }
  };
  walk(root, depth);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((f) => f.file);
}

const mtimeOf = (file: string): number | undefined => {
  try {
    return Math.round(statSync(file).mtimeMs);
  } catch {
    return undefined;
  }
};

/** Claude Code: ~/.claude/projects/<bucket>/<session>.jsonl; cwd rides on early entries. */
function claudeSessions(home: string, cutoff: number, limit: number): DiscoveredSession[] {
  const files = recentFiles(join(home, '.claude', 'projects'), 1, (n) => n.endsWith('.jsonl'), cutoff, limit);
  return files.map((file) => {
    let cwd: string | undefined;
    try {
      for (const line of head(file, 65_536).split('\n').slice(0, 40)) {
        if (!line.trim()) continue;
        const value = JSON.parse(line)?.cwd;
        if (typeof value === 'string' && value) { cwd = value; break; }
      }
    } catch { /* metadata is best effort */ }
    const session: DiscoveredSession = {
      kind: 'claude-code', id: basename(file, '.jsonl'), running: false, bindable: false, updatedAt: mtimeOf(file),
    };
    if (cwd) session.cwd = cwd;
    return session;
  });
}

/** Codex: ~/.codex/sessions/<y>/<m>/<d>/rollout-<stamp>-<uuid>.jsonl; the meta line can be huge. */
function codexSessions(home: string, cutoff: number, limit: number): DiscoveredSession[] {
  const files = recentFiles(join(home, '.codex', 'sessions'), 3, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), cutoff, limit);
  const out: DiscoveredSession[] = [];
  for (const file of files) {
    const id = basename(file).match(UUIDS)?.at(-1);
    if (!id) continue;
    let cwd: string | undefined;
    try {
      const match = /"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(head(file, 262_144));
      if (match) cwd = JSON.parse(`"${match[1]}"`) as string;
    } catch { /* metadata is best effort */ }
    const session: DiscoveredSession = { kind: 'codex', id, running: false, bindable: isSafeName(id), updatedAt: mtimeOf(file) };
    if (cwd) session.cwd = cwd;
    out.push(session);
  }
  return out;
}

/** Kimi Code's home: KIMI_CODE_HOME, else ~/.kimi-code. */
export function kimiRoot(home: string): string {
  return process.env.KIMI_CODE_HOME ?? join(home, '.kimi-code');
}

/**
 * Kimi's session index (session_index.jsonl: {sessionId, sessionDir, workDir} per line, last entry
 * wins). The index is append-only and outlives deleted sessions, so entries whose directory is
 * gone are left out.
 */
export function kimiIndex(root: string): Map<string, { dir: string; workDir?: string }> {
  const index = new Map<string, { dir: string; workDir?: string }>();
  let text: string;
  try {
    text = readFileSync(join(root, 'session_index.jsonl'), 'utf8');
  } catch {
    return index;
  }
  for (const line of text.split('\n')) {
    try {
      const o = JSON.parse(line);
      if (typeof o?.sessionId !== 'string' || typeof o?.sessionDir !== 'string') continue;
      const entry: { dir: string; workDir?: string } = { dir: isAbsolute(o.sessionDir) ? o.sessionDir : join(root, o.sessionDir) };
      if (typeof o.workDir === 'string') entry.workDir = o.workDir;
      index.set(o.sessionId, entry);
    } catch { /* a partial line */ }
  }
  for (const [id, entry] of index) if (!existsSync(entry.dir)) index.delete(id);
  return index;
}

/** Kimi Code: sessions whose main wire log changed inside the window; title and cwd from state.json. */
function kimiSessions(home: string, cutoff: number, limit: number): DiscoveredSession[] {
  const recent: Array<{ id: string; dir: string; workDir?: string; mtime: number }> = [];
  for (const [id, entry] of kimiIndex(kimiRoot(home))) {
    const mtime = mtimeOf(join(entry.dir, 'agents', 'main', 'wire.jsonl'));
    if (mtime !== undefined && mtime >= cutoff) recent.push({ id, dir: entry.dir, workDir: entry.workDir, mtime });
  }
  const out: DiscoveredSession[] = [];
  for (const r of recent.sort((a, b) => b.mtime - a.mtime)) {
    if (out.length >= limit) break;
    const state = jsonFile(join(r.dir, 'state.json'));
    if (state?.archived === true) continue;
    const session: DiscoveredSession = { kind: 'kimi', id: r.id, running: false, bindable: isSafeName(r.id), updatedAt: r.mtime };
    const cwd = typeof state?.cwd === 'string' && state.cwd ? state.cwd : r.workDir;
    if (cwd) session.cwd = cwd;
    if (typeof state?.title === 'string' && state.title) session.title = state.title;
    out.push(session);
  }
  return out;
}

/** Muse: ~/.local/share/muse/sessions/<y>/<m>/<d>/<id>/session.jsonl. */
function museSessions(home: string, cutoff: number, limit: number): DiscoveredSession[] {
  const files = recentFiles(join(home, '.local', 'share', 'muse', 'sessions'), 4, (n) => n === 'session.jsonl', cutoff, limit);
  return files.map((file) => ({
    kind: 'muse' as const, id: basename(dirname(file)), running: false, bindable: false, updatedAt: mtimeOf(file),
  }));
}

// Hermes keeps sessions in a SQLite store (state.db). node:sqlite needs a recent Node; without
// it Hermes discovery simply yields nothing instead of breaking the rest.
let DatabaseSync: typeof import('node:sqlite').DatabaseSync | undefined;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
} catch {
  DatabaseSync = undefined;
}

/** The node:sqlite constructor when this Node provides it (shared with the Hermes history reader). */
export function loadSqlite(): typeof import('node:sqlite').DatabaseSync | undefined {
  return DatabaseSync;
}

/** Where Hermes keeps its home on this machine. */
export function hermesHomePath(home: string, override?: string): string {
  return override ?? process.env.HERMES_HOME ??
    (process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes') : join(home, '.hermes'));
}

function hermesDbSessions(dbFile: string, profile: string | undefined, cutoffSec: number, limit: number): DiscoveredSession[] {
  if (!DatabaseSync) return [];
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const cols = new Set((db.prepare('PRAGMA table_info(sessions)').all() as Array<Record<string, any>>).map((r) => String(r.name)));
    if (!cols.has('id') || !cols.has('started_at')) return [];
    const hasMessages = Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='messages'").get() as Record<string, any>)?.n ?? 0) > 0;
    const base = cols.has('last_activity_at') ? 'COALESCE(last_activity_at, started_at, 0)' : 'started_at';
    const activity = hasMessages
      ? `MAX(${base}, COALESCE((SELECT MAX(timestamp) FROM messages WHERE session_id = sessions.id), 0))`
      : base;
    const pick = (name: string) => (cols.has(name) ? name : `NULL AS ${name}`);
    const filters =
      (cols.has('archived') ? ' AND COALESCE(archived, 0) = 0' : '') +
      (cols.has('hidden') ? ' AND COALESCE(hidden, 0) = 0' : '');
    const rows = db.prepare(
      `SELECT * FROM (SELECT id, ${pick('title')}, ${pick('cwd')}, ${pick('profile_name')}, ${activity} AS activity ` +
      `FROM sessions WHERE 1 = 1${filters}) WHERE activity >= ? ORDER BY activity DESC LIMIT ?`,
    ).all(cutoffSec, limit) as Array<Record<string, any>>;
    return rows.map((r) => {
      const session: DiscoveredSession = {
        kind: 'hermes', id: String(r.id), running: false, bindable: true,
        updatedAt: Number(r.activity) > 0 ? Math.round(Number(r.activity) * 1000) : undefined,
      };
      if (typeof r.cwd === 'string' && r.cwd) session.cwd = r.cwd;
      if (typeof r.title === 'string' && r.title) session.title = r.title;
      const named = profile ?? (typeof r.profile_name === 'string' && r.profile_name && r.profile_name !== 'default' ? r.profile_name : undefined);
      if (named) session.profile = named;
      session.bindable = isSafeName(session.id) && (!named || isSafeName(named));
      return session;
    });
  } finally {
    db.close();
  }
}

/** Hermes: <hermes home>/state.db plus one store per named profile. Metadata columns only. */
function hermesSessions(home: string, hermesHome: string | undefined, cutoffMs: number, limit: number): DiscoveredSession[] {
  const root = hermesHomePath(home, hermesHome);
  const cutoffSec = cutoffMs / 1000;
  const out = hermesDbSessions(join(root, 'state.db'), undefined, cutoffSec, limit);
  try {
    for (const entry of readdirSync(join(root, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) out.push(...hermesDbSessions(join(root, 'profiles', entry.name, 'state.db'), entry.name, cutoffSec, limit));
    }
  } catch { /* no profiles */ }
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

/** Every active AI session this machine knows about: running first, then most recently active. */
export function discoverSessions(opts: DiscoverOptions = {}): DiscoveredSession[] {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.windowMs ?? DEFAULT_WINDOW_MS);
  const limit = opts.limitPerKind ?? 10;
  const each = (scan: () => DiscoveredSession[]): DiscoveredSession[] => {
    try {
      return scan();
    } catch {
      return [];
    }
  };
  const all = [
    ...each(() => grokSessions(home)),
    ...each(() => hermesSessions(home, opts.hermesHome, cutoff, limit)),
    ...each(() => claudeSessions(home, cutoff, limit)),
    ...each(() => codexSessions(home, cutoff, limit)),
    ...each(() => kimiSessions(home, cutoff, limit)),
    ...each(() => museSessions(home, cutoff, limit)),
  ];
  return all.sort((a, b) =>
    Number(b.running) - Number(a.running) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.kind.localeCompare(b.kind));
}