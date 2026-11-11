// Hermes Agent plumbing (verified against Hermes v0.22 on the development machine).
//
// Turns run in single-query mode: `hermes [-p profile] chat --query-file F --oneshot --format
// stream-json [--resume id]`. Not `hermes -z`: one-shot mode auto-approves dangerous commands,
// whereas single-query mode follows `approvals.single_query_mode`, which denies them by default.
// The JSONL stream carries tool calls with their exit codes and a final `result` with the session id.
import { isAbsolute, join, relative } from 'node:path';
import type { AgentEvent, ToolCall, ToolResult } from '../../core/src/index.ts';
import type { AgentAdapter, AgentEnv, AgentRef } from './agent.ts';
import type { GrokLine, HistoryReplay } from './grok.ts';
import { firstLine, jsonLines, runProcess } from './proc.ts';
import { hermesHomePath, isSafeName, loadSqlite, safeName } from './sessions.ts';

/** Arguments for a driven turn. Throws when the session id or profile could be read as an option. */
export function hermesChatArgs(promptFile: string, opts: { sessionId?: string; profile?: string }): string[] {
  const args: string[] = [];
  if (opts.profile) args.push('-p', safeName(opts.profile, 'profile'));
  args.push('chat', '--query-file', promptFile, '--oneshot', '--format', 'stream-json');
  if (opts.sessionId) args.push('--resume', safeName(opts.sessionId, 'session id'));
  return args;
}

/**
 * Arguments for a classification call: the profile's default model, only the side-effect-free
 * `clarify` toolset (an unknown toolset name is rejected), no rules or memory injection, and
 * source `tool`, which keeps the session out of the user's session lists until it is deleted.
 */
export function hermesSampleArgs(promptFile: string, profile?: string): string[] {
  const args: string[] = [];
  if (profile) args.push('-p', safeName(profile, 'profile'));
  args.push('chat', '--query-file', promptFile, '--oneshot', '--format', 'stream-json',
    '--source', 'tool', '--ignore-rules', '-t', 'clarify');
  return args;
}

const WRITE_TOOLS = /write|edit|patch|create|append|insert|replace/i;
const DELETE_TOOLS = /delete|remove|unlink/i;

/** Maps one Hermes single-query run (stream-json lines) to the events of one turn. */
export class HermesStreamMapper {
  sessionId: string | undefined;
  private readonly turnId: string;
  private readonly cwd: string;
  private text = '';
  private ended = false;
  private readonly calls = new Map<string, { name: string; path?: string }>();
  private seq = 0;

  constructor(turnId: string, cwd: string) {
    this.turnId = turnId;
    this.cwd = cwd;
  }

  private flush(final: boolean): AgentEvent[] {
    const text = this.text.trim();
    this.text = '';
    return text ? [{ type: 'message.agent', turnId: this.turnId, text, final }] : [];
  }

  push(line: Record<string, any>): AgentEvent[] {
    const turnId = this.turnId;
    switch (line.type) {
      case 'text':
        this.text += String(line.text ?? '');
        return [];
      case 'tool_use': {
        const callId = String(line.tool_call_id ?? `h${++this.seq}`);
        const name = String(line.name ?? 'tool');
        const input: Record<string, any> = line.input && typeof line.input === 'object' ? line.input : {};
        const path = [input.path, input.file_path, input.file, input.target_file].find((v) => typeof v === 'string');
        this.calls.set(callId, { name, path });
        const call: ToolCall = { type: 'tool.call', turnId, callId, name };
        if (typeof input.command === 'string') call.command = input.command;
        return [...this.flush(false), call];                // text before a tool call is commentary
      }
      case 'tool_result': {
        const callId = String(line.tool_call_id ?? [...this.calls.keys()].at(-1) ?? `h${++this.seq}`);
        let output: unknown = line.output;
        let exitCode: number | undefined;
        if (typeof output === 'string' && output.trimStart().startsWith('{')) {
          try {
            const parsed = JSON.parse(output);
            if (typeof parsed?.exit_code === 'number') exitCode = parsed.exit_code;
            output = parsed?.output ?? parsed?.error ?? output;
          } catch { /* not JSON */ }
        }
        const failed = line.is_error === true || (exitCode !== undefined && exitCode !== 0);
        const result: ToolResult = { type: 'tool.result', turnId, callId, status: failed ? 'error' : 'ok' };
        if (exitCode !== undefined) result.exitCode = exitCode;
        const summary = firstLine(output);
        if (summary) result.summary = summary;
        const out: AgentEvent[] = [result];
        const info = this.calls.get(callId);
        if (!failed && info?.path && (WRITE_TOOLS.test(info.name) || DELETE_TOOLS.test(info.name))) {
          out.push({ type: 'artifact', turnId, kind: DELETE_TOOLS.test(info.name) ? 'file_deleted' : 'file_changed', ref: refOf(this.cwd, info.path) });
        }
        return out;
      }
      case 'result': {
        this.ended = true;
        if (typeof line.session_id === 'string' && line.session_id) this.sessionId = line.session_id;
        // the result's text is the whole reply; deltas may have been cut by a replay gap
        if (typeof line.text === 'string' && line.text.trim()) this.text = line.text;
        const status = line.exit_code === 0 ? 'completed' : line.exit_code === 130 ? 'interrupted' : 'failed';
        return [...this.flush(true), { type: 'turn.completed', turnId, status, at: Date.now() }];
      }
      default:
        return [];
    }
  }

  /** Call when the process has exited: a run that never reported a result failed. */
  finish(): AgentEvent[] {
    if (this.ended) return [];
    this.ended = true;
    return [...this.flush(true), { type: 'turn.completed', turnId: this.turnId, status: 'failed', at: Date.now() }];
  }
}

/** The state.db files that may hold a session: the profile's own store first. */
function hermesDbs(env: AgentEnv, profile?: string): string[] {
  const root = hermesHomePath(env.home, env.hermesHome);
  return profile ? [join(root, 'profiles', safeName(profile, 'profile'), 'state.db'), join(root, 'state.db')] : [join(root, 'state.db')];
}

/** Hermes Agent: single-query turns (dangerous commands denied by default), history from state.db. */
export const hermesAdapter: AgentAdapter = {
  kind: 'hermes',
  async runTurn(text, ctx) {
    const mapper = new HermesStreamMapper(ctx.turnId, ctx.cwd);
    try {
      const args = hermesChatArgs(ctx.env.promptFile(text), { sessionId: ctx.id, profile: ctx.profile });
      const { code, stderr } = await runProcess(ctx.env.bins.hermes ?? 'hermes', args, {
        cwd: ctx.cwd,
        onLine: (raw) => {
          const [line] = jsonLines(raw);
          if (!line) return;
          if (line.type === 'text') ctx.onLine?.({ type: 'text', data: line.text } as GrokLine);
          if (line.type === 'tool_use') ctx.onLine?.({ type: 'tool_call', toolName: line.name, rawInput: line.input } as GrokLine);
          ctx.emit(mapper.push(line));
        },
      });
      if (code !== 0) ctx.info(`hermes exited with ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n')[0] : ''}`);
    } catch (e) {
      ctx.info(`could not run hermes: ${(e as Error).message}`);
    } finally {
      ctx.emit(mapper.finish());
    }
    return { sessionId: isSafeName(mapper.sessionId) ? mapper.sessionId : undefined };
  },
  async sample(prompt, ctx) {
    const bin = ctx.env.bins.hermes ?? 'hermes';
    const profile = ctx.ref?.profile;
    const { code, stdout, stderr } = await runProcess(bin, hermesSampleArgs(ctx.env.promptFile(prompt), profile), {
      cwd: ctx.env.scratch(), signal: ctx.signal,
    });
    const lines = jsonLines(stdout);
    const result = lines.find((l) => l.type === 'result');
    const sessionId = result?.session_id;
    const cleanup = isSafeName(sessionId)
      ? runProcess(bin, [...(profile ? ['-p', safeName(profile, 'profile')] : []), 'sessions', 'delete', '--yes', sessionId], { cwd: ctx.env.scratch() })
        .then(() => {}, () => {})
      : undefined;
    if (!result || result.exit_code !== 0) {
      void cleanup;
      throw new Error(`hermes classification call failed (${code}): ${String(result?.error ?? stderr.trim().split('\n').at(-1) ?? '')}`);
    }
    const tokens = result.tokens ?? {};
    return {
      // a call that used a tool is void (SPEC 6)
      text: lines.some((l) => l.type === 'tool_use') ? null : String(result.text ?? ''),
      usage: { inputTokens: tokens.input, cachedInputTokens: tokens.cache_read, outputTokens: tokens.output },
      cleanup,
    };
  },
  readHistory(ref, env, maxTurns, makeTurnId, after) {
    for (const db of hermesDbs(env, ref.profile)) {
      const replay = readHermesHistory(db, ref.id, ref.cwd, maxTurns, makeTurnId, after);
      if (replay) return replay;
    }
    return undefined;
  },
  fingerprint(ref, env) {
    for (const db of hermesDbs(env, ref.profile)) {
      const fingerprint = hermesFingerprint(db, ref.id);
      if (fingerprint > 0) return fingerprint;
    }
    return 0;
  },
  advanced: (ref: AgentRef, env, fingerprint) => hermesDbs(env, ref.profile).some((db) => hermesAdvanced(db, ref.id, fingerprint)),
};

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
