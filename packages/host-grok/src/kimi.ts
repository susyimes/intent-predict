// Kimi Code plumbing (verified against kimi-code 2.5 on the development machine).
//
// Turns run over ACP (`kimi acp`): `session/resume`, then `session/prompt`. Not `kimi -p`: prompt
// mode forces the "auto" permission mode, which runs everything without asking. Over ACP the
// session keeps its own permission mode, and every permission request that reaches the host is
// refused. A classification call is a throwaway ACP session that is deleted afterwards.
// History: <kimi home>/sessions/<workspace>/<session>/agents/main/wire.jsonl, found through the
// session index (session_index.jsonl), whose entries outlive deleted sessions.
import { isAbsolute, join, relative } from 'node:path';
import type { AgentEvent, ToolCall, ToolResult } from '../../core/src/index.ts';
import { AcpClient } from './acp.ts';
import type { AcpUpdate } from './acp.ts';
import type { AgentAdapter, AgentEnv, AgentRef } from './agent.ts';
import { TurnMapper } from './grok.ts';
import type { GrokLine, HistoryReplay } from './grok.ts';
import { firstLine } from './proc.ts';
import { isSafeName, kimiIndex, kimiRoot, safeName } from './sessions.ts';
import { jsonlFrom, sizeOf } from './store.ts';

const refOf = (cwd: string, path: string): string => {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).replaceAll('\\', '/');
};

/** The wire log of session `id`, when the index names an existing session directory. */
export function kimiWireFile(root: string, id: string): string | undefined {
  const entry = kimiIndex(root).get(safeName(id, 'session id'));
  return entry ? join(entry.dir, 'agents', 'main', 'wire.jsonl') : undefined;
}

const textOfInput = (input: unknown): string => {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
};
const isUserPrompt = (o: Record<string, any>): boolean => o.type === 'turn.prompt' && o.origin?.kind === 'user';
const WRITE_TOOLS = /^(Edit|Write|MultiEdit|StrReplace|Patch)/;

interface Group { user: string; items: Array<Record<string, any>>; end: number; ended: boolean; reason?: string }

/**
 * Restore completed turns from a wire log: the last `maxTurns`, or all after byte offset `after`.
 * A turn starts at a prompt the user typed; prompts from background tasks continue it. It is
 * complete once its last prompt has ended.
 */
export function readKimiHistory(file: string, cwd: string, maxTurns: number, makeTurnId: () => string, after = 0): HistoryReplay | undefined {
  const read = jsonlFrom(file, after);
  if (!read) return undefined;
  const groups: Group[] = [];
  let current: Group | undefined;
  for (const { value: o, end } of read.entries) {
    if (isUserPrompt(o)) {
      if (current) groups.push(current);
      current = { user: textOfInput(o.input).trim(), items: [], end, ended: false };
      continue;
    }
    if (!current) continue;
    if (o.type === 'turn.prompt') current.ended = false;
    else if (o.type === 'turn.ended') {
      current.ended = true;
      current.reason = o.reason;
      current.end = end;
    } else if (o.type === 'context.append_loop_event') {
      const e: Record<string, any> = o.event ?? {};
      if (e.type === 'content.part' && e.part?.type === 'text' && typeof e.part.text === 'string') current.items.push({ kind: 'text', text: e.part.text });
      else if (e.type === 'tool.call') current.items.push({ kind: 'call', id: String(e.toolCallId ?? ''), name: String(e.name ?? 'tool'), args: e.args ?? {} });
      else if (e.type === 'tool.result') current.items.push({ kind: 'result', id: String(e.toolCallId ?? ''), result: e.result ?? {} });
    }
  }
  if (current) groups.push(current);
  const complete = groups.filter((g) => g.ended);
  // a trailing group still running is left for later; complete groups before it are final
  const picked = (after > 0 ? complete : complete.slice(-maxTurns)).filter((g) => g.user);
  const fingerprint = complete.length ? complete[complete.length - 1]!.end : after;
  if (!picked.length) return after > 0 && fingerprint > after ? { turns: [], turnIds: [], fingerprint } : undefined;
  const turns: AgentEvent[][] = [];
  const turnIds: string[] = [];
  for (const g of picked) {
    const turnId = makeTurnId();
    turnIds.push(turnId);
    const events: AgentEvent[] = [
      { type: 'turn.started', turnId, at: Date.now() },
      { type: 'message.user', turnId, text: g.user },
    ];
    const calls = new Map<string, { name: string; args: Record<string, any> }>();
    let text = '';
    const flush = (final: boolean) => {
      if (text.trim()) events.push({ type: 'message.agent', turnId, text: text.trim(), final });
      text = '';
    };
    for (const item of g.items) {
      if (item.kind === 'text') {
        text += item.text;
      } else if (item.kind === 'call') {
        flush(false);
        calls.set(item.id, { name: item.name, args: item.args });
        const call: ToolCall = { type: 'tool.call', turnId, callId: item.id, name: item.name };
        if (typeof item.args.command === 'string') call.command = item.args.command;
        events.push(call);
      } else {
        const failed = item.result.isError === true;
        const result: ToolResult = { type: 'tool.result', turnId, callId: item.id, status: failed ? 'error' : 'ok' };
        const summary = firstLine(item.result.output);
        if (summary) result.summary = summary;
        events.push(result);
        const call = calls.get(item.id);
        if (!failed && call && WRITE_TOOLS.test(call.name) && typeof call.args.path === 'string') {
          events.push({ type: 'artifact', turnId, kind: 'file_changed', ref: refOf(cwd, call.args.path) });
        }
      }
    }
    flush(true);
    const status = g.reason === 'completed' ? 'completed' : g.reason === 'cancelled' ? 'interrupted' : 'failed';
    events.push({ type: 'turn.completed', turnId, status, at: Date.now() });
    turns.push(events);
  }
  return { turns, turnIds, fingerprint };
}

/** True when the user started a turn in the wire log after byte offset `fingerprint`. */
export function kimiAdvanced(file: string, fingerprint: number): boolean {
  const read = jsonlFrom(file, fingerprint);
  return !!read && read.entries.some(({ value }) => isUserPrompt(value));
}

/**
 * ACP session updates in Grok's line format (what TurnMapper reads). A tool call is held back
 * until it finishes: its command and path only arrive in later updates.
 */
export class AcpLineMapper {
  private readonly calls = new Map<string, GrokLine>();

  push(u: AcpUpdate): GrokLine[] {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        return u.content?.type === 'text' && typeof u.content.text === 'string' ? [{ type: 'text', data: u.content.text }] : [];
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        let call = this.calls.get(id);
        if (!call) {
          call = { type: 'tool_call', toolCallId: id, toolName: u.title ?? 'tool', kind: u.kind, rawInput: {} };
          this.calls.set(id, call);
        }
        if (u.title) call.toolName = u.title;
        if (u.kind) call.kind = u.kind;
        if (u.rawInput && typeof u.rawInput === 'object') call.rawInput = { ...call.rawInput, ...u.rawInput };
        if (u.status !== 'completed' && u.status !== 'failed') return [];
        this.calls.delete(id);
        return [call, { type: 'tool_call_update', toolCallId: id, status: u.status, content: u.content ?? [], rawOutput: u.rawOutput, locations: u.locations ?? [] }];
      }
      default:
        return [];                                         // thoughts, plans, usage, titles
    }
  }

  /** Calls that never finished, so the turn still shows them. */
  flush(): GrokLine[] {
    const pending = [...this.calls.values()];
    this.calls.clear();
    return pending;
  }
}

const wire = (ref: AgentRef, env: AgentEnv) => kimiWireFile(kimiRoot(env.home), ref.id);
const PROMPT_TIMEOUT_MS = 30 * 60_000;

/** Kimi Code. */
export const kimiAdapter: AgentAdapter = {
  kind: 'kimi',
  async runTurn(text, ctx) {
    const mapper = new TurnMapper(ctx.turnId, ctx.cwd);
    const lines = new AcpLineMapper();
    let sessionId = ctx.id;
    let client: AcpClient | undefined;
    try {
      if (sessionId) safeName(sessionId, 'session id');
      client = new AcpClient(ctx.env.bins.kimi ?? 'kimi', ['acp'], ctx.cwd);
      client.onPermission = (request) => ctx.info(`refused a permission request: ${String(request.toolCall?.title ?? 'a tool call')}`);
      await client.initialize();
      if (sessionId) await client.request('session/resume', { sessionId, cwd: ctx.cwd, mcpServers: [] });
      else sessionId = (await client.request('session/new', { cwd: ctx.cwd, mcpServers: [] }))?.sessionId;
      if (!isSafeName(sessionId)) throw new Error('kimi returned no usable session id');
      client.onUpdate(sessionId, (update) => {
        for (const line of lines.push(update)) {
          ctx.onLine?.(line);
          ctx.emit(mapper.push(line));
        }
      });
      const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, PROMPT_TIMEOUT_MS);
      for (const line of lines.flush()) ctx.emit(mapper.push(line));
      ctx.emit(mapper.push({ type: 'end', sessionId, stopReason: result?.stopReason ?? 'end_turn' }));
    } catch (e) {
      ctx.info(`could not run kimi: ${(e as Error).message}`);
    } finally {
      ctx.emit(mapper.finish());
      await client?.close();
    }
    return { sessionId: isSafeName(sessionId) ? sessionId : undefined };
  },
  async sample(prompt, ctx) {
    const dir = ctx.env.scratch();
    const client = new AcpClient(ctx.env.bins.kimi ?? 'kimi', ['acp'], dir);
    let sessionId: string | undefined;
    const abort = () => {
      if (sessionId) client.notify('session/cancel', { sessionId });
      client.kill();
    };
    ctx.signal.addEventListener('abort', abort, { once: true });
    const cleanup = async () => {
      ctx.signal.removeEventListener('abort', abort);
      if (sessionId) await client.request('session/delete', { sessionId }, 30_000).catch(() => {});
      await client.close();
    };
    try {
      await client.initialize();
      sessionId = (await client.request('session/new', { cwd: dir, mcpServers: [] }))?.sessionId;
      if (!isSafeName(sessionId)) throw new Error('kimi returned no usable session id');
      let reply = '';
      let usedTool = false;
      client.onUpdate(sessionId, (update) => {
        if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') reply += update.content.text;
        if (update.sessionUpdate === 'tool_call') usedTool = true;
      });
      const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
      // a call that used a tool, or did not end normally, is void (SPEC 6)
      return { text: usedTool || result?.stopReason !== 'end_turn' ? null : reply, cleanup: cleanup() };
    } catch (e) {
      await cleanup();
      throw e;
    }
  },
  readHistory(ref, env, maxTurns, makeTurnId, after) {
    const file = wire(ref, env);
    return file ? readKimiHistory(file, ref.cwd, maxTurns, makeTurnId, after) : undefined;
  },
  fingerprint(ref, env) {
    const file = wire(ref, env);
    return file ? sizeOf(file) : 0;
  },
  advanced(ref, env, fingerprint) {
    const file = wire(ref, env);
    return !!file && kimiAdvanced(file, fingerprint);
  },
};
