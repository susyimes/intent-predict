// Hermes Agent plumbing: one headless turn per process. `hermes -z` prints only the final
// response text, so a Hermes turn yields no tool-call events — signals come from the final
// message alone. Verified live against Hermes on this machine: `-z ... --resume <id>`
// continues the same session id, and a named profile is selected with a leading `-p`.
import { spawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import type { AgentEvent, ToolCall, ToolResult } from '../../core/src/index.ts';
import type { HistoryReplay } from './grok.ts';
import { loadSqlite } from './sessions.ts';

export function hermesTurnArgs(text: string, opts: { sessionId?: string; profile?: string }): string[] {
  const args: string[] = [];
  if (opts.profile) args.push('-p', opts.profile);
  args.push('-z', text);
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  return args;
}

export interface HermesRunOptions { cwd: string; bin?: string; signal?: AbortSignal }

/** Run `hermes` and collect its whole stdout (one-shot mode emits no incremental output). */
export function runHermes(
  args: string[], opts: HermesRunOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin ?? 'hermes', args, {
      cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: opts.signal,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

type Row = Record<string, any>;

function openDb(dbFile: string) {
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) return undefined;
  try {
    return new DatabaseSync(dbFile, { readOnly: true });
  } catch {
    return undefined;
  }
}

const textOf = (content: unknown): string => {
  if (typeof content !== 'string') return '';
  if (content.trim().startsWith('[')) {
    try {
      const blocks = JSON.parse(content) as Array<Record<string, any>>;
      const text = blocks.map((b) => (typeof b.text === 'string' ? b.text : '')).join('');
      if (text) return text;
    } catch { /* plain text that happens to start with [ */ }
  }
  return content;
};
const refOf = (cwd: string, path: string): string => {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).replaceAll('\\', '/');
};
const WRITE_LIKE = /write|edit|patch|create|append|insert|replace/i;
const DELETE_LIKE = /delete|remove|unlink/i;

/**
 * Restore the last `maxTurns` completed turns from a Hermes state.db. A trailing turn whose last
 * row is not an assistant text (unanswered, or mid-tools) is dropped. Tool kinds are left for the
 * core to infer from names; file artifacts are inferred from write-like calls with a path argument.
 */
export function readHermesHistory(
  dbFile: string, sessionId: string, cwd: string, maxTurns: number, makeTurnId: () => string, afterId = 0,
): HistoryReplay | undefined {
  const db = openDb(dbFile);
  if (!db) return undefined;
  try {
    const rows = db.prepare(
      'SELECT id, role, content, tool_call_id, tool_calls, timestamp FROM messages WHERE session_id = ? AND id > ? ORDER BY id',
    ).all(sessionId, afterId) as Row[];
    const groups: Row[][] = [];
    for (const r of rows) {
      if (r.role === 'user') groups.push([r]);
      else if (groups.length && (r.role === 'assistant' || r.role === 'tool')) groups[groups.length - 1]!.push(r);
    }
    const complete = groups.filter((g, i) => {
      const texts = g.filter((r) => r.role === 'assistant' && textOf(r.content).trim());
      return texts.length > 0 && (i < groups.length - 1 || g[g.length - 1] === texts[texts.length - 1]);
    });
    const picked = afterId > 0 ? complete : complete.slice(-maxTurns);
    if (!picked.length) return undefined;
    const turns: AgentEvent[][] = [];
    const turnIds: string[] = [];
    for (const g of picked) {
      const turnId = makeTurnId();
      turnIds.push(turnId);
      const at = (r: Row) => Math.round(Number(r.timestamp ?? 0) * 1000) || Date.now();
      const events: AgentEvent[] = [
        { type: 'turn.started', turnId, at: at(g[0]!) },
        { type: 'message.user', turnId, text: textOf(g[0]!.content) },
      ];
      const callArgs = new Map<string, { name: string; path?: string }>();
      const lastText = g.filter((r) => r.role === 'assistant' && textOf(r.content).trim()).at(-1);
      for (const r of g.slice(1)) {
        if (r.role === 'assistant' && r.tool_calls) {
          let calls: Row[] = [];
          try {
            const v = JSON.parse(String(r.tool_calls));
            calls = Array.isArray(v) ? v : [v];
          } catch { /* unparsable tool_calls carry no events */ }
          calls.forEach((c, i) => {
            const fn: Row = c?.function ?? c ?? {};
            const name = String(fn.name ?? c?.name ?? 'tool');
            let args: Row = {};
            try {
              args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.args ?? {});
            } catch { /* no usable arguments */ }
            const callId = String(c?.id ?? `h${r.id}-${i}`);
            const path = [args.path, args.file_path, args.file, args.target_file, args.filename]
              .find((v) => typeof v === 'string') as string | undefined;
            callArgs.set(callId, { name, path });
            const call: ToolCall = { type: 'tool.call', turnId, callId, name, kind: 'other' };
            if (typeof args.command === 'string') call.command = args.command;
            events.push(call);
          });
        }
        if (r.role === 'tool') {
          const callId = String(r.tool_call_id ?? '');
          const result: ToolResult = { type: 'tool.result', turnId, callId, status: 'ok' };
          const summary = textOf(r.content).split('\n').map((s) => s.trim()).find(Boolean)?.slice(0, 160);
          if (summary) result.summary = summary;
          events.push(result);
          const info = callArgs.get(callId);
          if (info?.path && (WRITE_LIKE.test(info.name) || DELETE_LIKE.test(info.name))) {
            events.push({ type: 'artifact', turnId, kind: DELETE_LIKE.test(info.name) ? 'file_deleted' : 'file_changed', ref: refOf(cwd, info.path) });
          }
        }
        if (r.role === 'assistant') {
          const text = textOf(r.content).trim();
          if (text) events.push({ type: 'message.agent', turnId, text, final: r === lastText });
        }
      }
      events.push({ type: 'turn.completed', turnId, status: 'completed', at: at(g[g.length - 1]!) });
      turns.push(events);
    }
    return { turns, turnIds, fingerprint: Number(picked[picked.length - 1]!.at(-1)!.id ?? 0) };
  } catch {
    return undefined;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** The session's current replay point: greatest messages.id, or 0 when unreadable or empty. */
export function hermesFingerprint(dbFile: string, sessionId: string): number {
  const db = openDb(dbFile);
  if (!db) return 0;
  try {
    const row = db.prepare('SELECT MAX(id) AS m FROM messages WHERE session_id = ?').get(sessionId) as Row;
    return Number(row?.m ?? 0);
  } catch {
    return 0;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** True when a new user turn started in the Hermes session past the replay point. */
export function hermesAdvanced(dbFile: string, sessionId: string, fingerprint: number): boolean {
  const db = openDb(dbFile);
  if (!db) return false;
  try {
    const row = db.prepare(
      "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id = ? AND id > ? AND role = 'user') AS advanced",
    ).get(sessionId, fingerprint) as Row;
    return Number(row?.advanced ?? 0) > 0;
  } catch {
    return false;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** One finished one-shot run becomes the turn's final agent message (if any) plus its completion. */
export function hermesTurnEvents(turnId: string, run: { code: number | null; stdout: string }): AgentEvent[] {
  const text = run.stdout.trim();
  const events: AgentEvent[] = [];
  if (text) events.push({ type: 'message.agent', turnId, text, final: true });
  events.push({ type: 'turn.completed', turnId, status: run.code === 0 ? 'completed' : 'failed', at: Date.now() });
  return events;
}
