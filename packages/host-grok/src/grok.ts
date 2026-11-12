// Grok CLI plumbing: run a headless turn, map its `streaming-json` lines (ACP session updates) to
// intent-predict events, and use a second headless call as the `compact` sampler.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent, SampleResult, ToolCall, ToolKind, ToolResult } from '../../core/src/index.ts';
import type { AgentAdapter, AgentEnv, AgentRef } from './agent.ts';
import { resolveCommand, runProcess } from './proc.ts';
import type { Bin } from './proc.ts';
import { isSafeName, safeName } from './sessions.ts';

export type GrokLine = Record<string, any>;

const KINDS: Record<string, ToolKind> = {
  read: 'read', edit: 'edit', delete: 'delete', move: 'edit', search: 'search', execute: 'execute', fetch: 'fetch',
};
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const firstLine = (text: string) => text.replace(ANSI, '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 160);
const contentText = (line: GrokLine): string =>
  (Array.isArray(line.content) ? line.content : []).map((c: GrokLine) => c?.content?.text ?? '').join('\n');

/** Turns the lines of one Grok turn into the events of one intent-predict turn. */
export class TurnMapper {
  sessionId: string | undefined;
  stopReason: string | undefined;
  private readonly turnId: string;
  private readonly cwd: string;
  private text = '';
  private ended = false;
  private readonly calls = new Map<string, { kind: ToolKind; path?: string }>();

  constructor(turnId: string, cwd: string) {
    this.turnId = turnId;
    this.cwd = cwd;
  }

  private flush(final: boolean): AgentEvent[] {
    const text = this.text.trim();
    this.text = '';
    return text ? [{ type: 'message.agent', turnId: this.turnId, text, final }] : [];
  }

  private ref(path: string): string {
    const rel = isAbsolute(path) ? relative(this.cwd, path) : path;
    return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).replaceAll('\\', '/');
  }

  push(line: GrokLine): AgentEvent[] {
    const turnId = this.turnId;
    switch (line.type) {
      case 'text':
        this.text += String(line.data ?? '');
        return [];
      case 'tool_call': {
        const raw: GrokLine = line.rawInput ?? {};
        const kind: ToolKind = line.toolName === 'ask_user_question' ? 'ask_user' : (KINDS[line.kind] ?? 'other');
        const path = raw.file_path ?? raw.target_file ?? raw.path;
        this.calls.set(line.toolCallId, { kind, path: typeof path === 'string' ? path : undefined });
        const call: ToolCall = { type: 'tool.call', turnId, callId: line.toolCallId, name: String(line.toolName ?? line.title ?? 'tool'), kind };
        if (kind === 'execute' && typeof raw.command === 'string') call.command = raw.command;
        // text before a tool call is commentary, not the turn's final message
        return [...this.flush(false), call];
      }
      case 'tool_call_update': {
        const call = this.calls.get(line.toolCallId);
        if (!call || (line.status !== 'completed' && line.status !== 'failed')) return [];
        const text = contentText(line);
        const refused = line.status === 'failed' && /cancel|permission|not run|denied/i.test(text);
        const result: ToolResult = {
          type: 'tool.result', turnId, callId: line.toolCallId,
          status: line.status === 'completed' ? 'ok' : refused ? 'denied' : 'error',
        };
        if (typeof line.rawOutput?.exit_code === 'number') result.exitCode = line.rawOutput.exit_code;
        const summary = firstLine(text);
        if (summary) result.summary = summary;
        const out: AgentEvent[] = [result];
        const path = call.path ?? line.locations?.[0]?.path;
        if (line.status === 'completed' && (call.kind === 'edit' || call.kind === 'delete') && typeof path === 'string') {
          out.push({ type: 'artifact', turnId, kind: call.kind === 'delete' ? 'file_deleted' : 'file_changed', ref: this.ref(path) });
        }
        return out;
      }
      case 'end': {
        this.ended = true;
        this.sessionId = line.sessionId;
        this.stopReason = line.stopReason;
        const status = line.stopReason === 'end_turn' ? 'completed' : line.stopReason === 'cancelled' ? 'interrupted' : 'failed';
        return [...this.flush(true), { type: 'turn.completed', turnId, status, at: Date.now() }];
      }
      default:
        return [];                                         // thought, usage, available_commands, ...
    }
  }

  /** Call when the process has exited: a turn that never said `end` failed. */
  finish(): AgentEvent[] {
    if (this.ended) return [];
    this.ended = true;
    return [...this.flush(true), { type: 'turn.completed', turnId: this.turnId, status: 'failed', at: Date.now() }];
  }
}

export interface RunOptions { cwd: string; signal?: AbortSignal; onLine?: (line: GrokLine) => void; bin?: Bin }

/** Completed turns restored from a session store at bind time, plus where the store then stood. */
export interface HistoryReplay {
  turns: AgentEvent[][];
  turnIds: string[];
  /** Grok: byte offset just after the last included turn. Hermes: greatest messages.id included. */
  fingerprint: number;
}

const TAIL_BYTES = 16 * 1024 * 1024;

function readSegment(file: string, start: number): { buffer: Buffer; size: number } | undefined {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return undefined;
  }
  if (start < 0 || start > size) return undefined;
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    if (buffer.length) readSync(fd, buffer, 0, buffer.length, start);
    return { buffer, size };
  } finally {
    closeSync(fd);
  }
}

/** The session's current replay point: updates.jsonl size in bytes, or 0 when unreadable. */
export function grokFingerprint(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** True when a new user turn started in updates.jsonl past the replay point. */
export function grokAdvanced(file: string, fingerprint: number): boolean {
  const segment = readSegment(file, fingerprint);
  if (!segment || segment.buffer.length === 0) return false;
  for (const line of segment.buffer.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      if ((JSON.parse(line)?.params?.update as Record<string, any> | undefined)?.sessionUpdate === 'user_message_chunk') return true;
    } catch { /* ignore partial or non-update lines */ }
  }
  return false;
}

/**
 * Restore the last `maxTurns` completed turns from a Grok session's updates.jsonl (ACP session
 * updates, the same stream the TUI persisted). A trailing turn with no `turn_completed` is dropped.
 */
export function readGrokHistory(
  file: string, sessionId: string, cwd: string, maxTurns: number, makeTurnId: () => string, afterOffset = 0,
): HistoryReplay | undefined {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return undefined;
  }
  if (afterOffset < 0 || afterOffset > size) return undefined;
  const requestedStart = afterOffset > 0 ? afterOffset : Math.max(0, size - TAIL_BYTES);
  const segment = readSegment(file, requestedStart);
  if (!segment) return undefined;
  const { buffer } = segment;
  let pos = 0;
  let offset = requestedStart;
  if (afterOffset === 0 && requestedStart > 0) {
    const nl = buffer.indexOf(10);
    if (nl < 0) return undefined;
    pos = nl + 1;
    offset = requestedStart + pos;
  }
  type Upd = Record<string, any>;
  const groups: Array<{ updates: Upd[]; end: number }> = [];
  let group: Upd[] | undefined;
  while (pos < buffer.length) {
    const nl = buffer.indexOf(10, pos);
    const lineEnd = nl >= 0 ? nl : buffer.length;
    const nextOffset = nl >= 0 ? offset + (lineEnd - pos) + 1 : size;
    const line = buffer.subarray(pos, lineEnd).toString('utf8').trim();
    if (line) {
      let u: Upd | undefined;
      try {
        u = (JSON.parse(line)?.params?.update ?? {}) as Upd;
      } catch { /* ignore partial or non-update lines */ }
      if (u) {
        if (u.sessionUpdate === 'user_message_chunk' && !group) group = [];
        if (group) {
          group.push(u);
          if (u.sessionUpdate === 'turn_completed') {
            groups.push({ updates: group, end: nextOffset });
            group = undefined;
          }
        }
      }
    }
    if (nl < 0) break;
    pos = nl + 1;
    offset = nextOffset;
  }
  const picked = afterOffset > 0 ? groups : groups.slice(-maxTurns);
  if (!picked.length) return undefined;
  const turns: AgentEvent[][] = [];
  const turnIds: string[] = [];
  for (const pickedGroup of picked) {
    const g = pickedGroup.updates;
    const turnId = makeTurnId();
    turnIds.push(turnId);
    const userText = g.filter((u) => u.sessionUpdate === 'user_message_chunk').map((u) => String(u.content?.text ?? '')).join('');
    const mapper = new TurnMapper(turnId, cwd);
    const events: AgentEvent[] = [{ type: 'turn.started', turnId, at: Date.now() }];
    if (userText) events.push({ type: 'message.user', turnId, text: userText });
    const seenCalls = new Set<string>();
    for (const u of g) {
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          events.push(...mapper.push({ type: 'text', data: String(u.content?.text ?? '') }));
          break;
        case 'tool_call': {
          const id = String(u.toolCallId ?? '');
          if (seenCalls.has(id)) break;
          seenCalls.add(id);
          const meta = (u._meta?.['x.ai/tool'] ?? {}) as Upd;
          events.push(...mapper.push({
            type: 'tool_call', toolCallId: id, toolName: meta.name ?? u.title,
            kind: meta.kind ?? u.kind, rawInput: u.rawInput ?? {}, title: u.title,
          }));
          break;
        }
        case 'tool_call_update':
          events.push(...mapper.push({
            type: 'tool_call_update', toolCallId: u.toolCallId, status: u.status,
            rawOutput: u.rawOutput, content: u.content, locations: u.locations,
          }));
          break;
        case 'turn_completed':
          events.push(...mapper.push({ type: 'end', sessionId, stopReason: u.stop_reason }));
          break;
        default:
          break;
      }
    }
    events.push(...mapper.finish());
    turns.push(events);
  }
  return { turns, turnIds, fingerprint: picked[picked.length - 1]!.end };
}

/** Run `grok` and hand every JSON line of its stdout to `onLine`. Resolves with the whole stdout. */
export function runGrok(args: string[], opts: RunOptions): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const command = resolveCommand(opts.bin ?? 'grok');
    const child = spawn(command.command, [...command.prefix, ...args], {
      cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: opts.signal,
    });
    let stdout = '';
    let stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      stdout += line + '\n';
      if (!opts.onLine || !line.startsWith('{')) return;
      try {
        opts.onLine(JSON.parse(line));
      } catch { /* not a JSON line */ }
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const ALL_TOOLS = [
  'run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'grep', 'kill_command_or_subagent', 'todo_write',
  'get_command_or_subagent_output', 'monitor', 'search_tool', 'use_tool', 'workflow', 'enter_plan_mode', 'exit_plan_mode',
  'ask_user_question', 'send_feedback', 'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'write',
].join(',');
const SAMPLER_SYSTEM =
  'You are a strict classifier. Follow the instructions in the user message and reply with a single JSON object only. Never call tools.';

/**
 * The `compact` sampler (SPEC 6): one tool-less call on Grok's own model connection.
 * Grok has no ephemeral mode, so the call leaves a session behind; its id is returned for deletion.
 */
export async function sampleWithGrok(
  promptFile: string, opts: { cwd: string; model?: string; signal?: AbortSignal; bin?: Bin; lowEffort?: boolean },
): Promise<SampleResult & { sessionId?: string }> {
  const args = [
    '--prompt-file', promptFile, '--output-format', 'json', '--max-turns', '1', '--no-subagents', '--no-plan',
    '--disable-web-search', '--disallowed-tools', ALL_TOOLS,
    '--system-prompt-override', SAMPLER_SYSTEM,
  ];
  if (opts.lowEffort) args.push('--reasoning-effort', 'low');      // only when the user chose it
  if (opts.model) args.push('--model', opts.model);
  const { code, stdout, stderr } = await runGrok(args, opts);
  let out: GrokLine;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`grok sampler exited with ${code}: ${stderr.trim().slice(0, 300) || 'no JSON on stdout'}`);
  }
  const usage = out.usage ?? {};
  return {
    // a sample that tried to call a tool, or was cut short, is void
    text: out.stopReason === 'end_turn' && typeof out.text === 'string' ? out.text : null,
    usage: { inputTokens: usage.input_tokens, cachedInputTokens: usage.cache_read_input_tokens, outputTokens: usage.output_tokens },
    sessionId: out.sessionId,
  };
}

/** Best effort: remove a session Grok persisted for a sampler call. */
export function deleteGrokSession(sessionId: string, bin: Bin = 'grok'): Promise<void> {
  return runProcess(bin, ['sessions', 'delete', safeName(sessionId, 'session id')], { cwd: process.cwd() }).then(() => {}, () => {});
}

const grokHistoryFile = (ref: AgentRef, env: AgentEnv) =>
  join(env.home, '.grok', 'sessions', encodeURIComponent(ref.cwd), safeName(ref.id, 'session id'), 'updates.jsonl');

/** Grok CLI: turns via `--resume` in streaming-json mode; unapproved tools are denied headlessly. */
export const grokAdapter: AgentAdapter = {
  kind: 'grok',
  async runTurn(text, ctx) {
    const mapper = new TurnMapper(ctx.turnId, ctx.cwd);
    try {
      const args = ['--prompt-file', ctx.env.promptFile(text), '--output-format', 'streaming-json', '--no-subagents'];
      // never let a session id reach grok as an option: the turn fails instead
      if (ctx.id) args.push('--resume', safeName(ctx.id, 'session id'));
      if (ctx.env.grokModel) args.push('--model', ctx.env.grokModel);
      args.push(...ctx.env.grokArgs);
      const { code, stderr } = await runGrok(args, {
        cwd: ctx.cwd, bin: ctx.env.bins.grok,
        onLine: (line) => {
          ctx.onLine?.(line);
          ctx.emit(mapper.push(line));
        },
      });
      if (code !== 0 || stderr.trim()) ctx.info(`grok exited with ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n')[0] : ''}`);
    } catch (e) {
      ctx.info(`could not run grok: ${(e as Error).message}`);
    } finally {
      ctx.emit(mapper.finish());
    }
    return { sessionId: isSafeName(mapper.sessionId) ? mapper.sessionId : undefined };
  },
  async sample(prompt, ctx) {
    const bin = ctx.env.bins.grok ?? 'grok';
    const { sessionId, ...result } = await sampleWithGrok(ctx.env.promptFile(prompt), {
      cwd: ctx.env.scratch(), model: ctx.env.grokModel, signal: ctx.signal, bin, lowEffort: ctx.env.samplerEffort === 'low',
    });
    // Grok has no ephemeral mode: remove the session the call stored
    return isSafeName(sessionId) ? { ...result, cleanup: deleteGrokSession(sessionId, bin) } : result;
  },
  readHistory: (ref, env, maxTurns, makeTurnId, after) =>
    readGrokHistory(grokHistoryFile(ref, env), ref.id, ref.cwd, maxTurns, makeTurnId, after),
  fingerprint: (ref, env) => grokFingerprint(grokHistoryFile(ref, env)),
  advanced: (ref, env, fingerprint) => grokAdvanced(grokHistoryFile(ref, env), fingerprint),
};
