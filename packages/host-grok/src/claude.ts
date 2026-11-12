// Claude Code plumbing (verified against Claude Code 2.1.322 on the development machine).
//
// Turns: `claude -p --output-format stream-json --verbose --permission-prompts none [--resume <id>]`,
// the message on stdin. The session's own permission mode and rules decide what runs without asking;
// whatever would ask is denied, since nobody can answer a prompt in a headless turn. Claude refuses
// to resume a session that another process has open, and the host says so before trying.
// Classification: `claude -p --no-session-persistence --tools "" --safe-mode --strict-mcp-config`: the
// default model with no tools, hooks, MCP servers or CLAUDE.md, and no transcript left behind.
// History: <claude home>/projects/<project>/<id>.jsonl, where <claude home> is CLAUDE_CONFIG_DIR or ~/.claude.
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { AgentEvent, ToolCall, ToolResult } from '../../core/src/index.ts';
import type { AgentAdapter } from './agent.ts';
import type { GrokLine, HistoryReplay } from './grok.ts';
import { firstLine, jsonLines, runProcess } from './proc.ts';
import { claudeHome, claudeLiveSessions, claudeProjectDir, safeName } from './sessions.ts';
import { jsonlFrom, sizeOf } from './store.ts';

const refOf = (cwd: string, path: string): string => {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).replaceAll('\\', '/');
};

const transcripts = new Map<string, string>();

/** The transcript of session `id`: in the project folder of `cwd` when it is there, else wherever it is. */
export function claudeTranscript(root: string, id: string, cwd?: string): string | undefined {
  const name = `${safeName(id, 'session id')}.jsonl`;
  const projects = join(root, 'projects');
  if (cwd) {
    const direct = join(projects, claudeProjectDir(cwd), name);
    if (existsSync(direct)) return direct;
  }
  const key = `${root}|${id}`;
  const cached = transcripts.get(key);
  if (cached && existsSync(cached)) return cached;
  let dirs: string[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const file = join(projects, dir, name);
    if (existsSync(file)) {
      transcripts.set(key, file);
      return file;
    }
  }
  return undefined;
}

type Block = Record<string, any>;
const blocks = (content: unknown): Block[] =>
  (Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [])
    .filter((b): b is Block => !!b && typeof b === 'object');
const textOf = (content: unknown): string =>
  blocks(content).map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');

const INTERRUPTED = /^\[Request interrupted by user/;
/** How Claude Code words a refusal: no approval surface, its auto-mode classifier, or the user saying no. */
const REFUSED = /Permission for this (?:tool use|action) was denied|doesn't want to proceed with this tool use|tool use was rejected/i;
const EXIT_CODE = /^Exit code (-?\d+)/;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The text of a prompt that starts a turn: one the user typed, or one sent with `claude -p` or the
 * SDK. Tool results, notifications from background tasks, automatic continuations, command output
 * and compaction summaries belong to the turn they arrive in.
 */
export function claudePromptText(o: Record<string, any>): string | undefined {
  if (o.type !== 'user' || o.isSidechain || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return undefined;
  const content = o.message?.content;
  if (blocks(content).some((b) => b.type === 'tool_result')) return undefined;
  const text = textOf(content).trim();
  if (!text || INTERRUPTED.test(text)) return undefined;
  if (o.turnOrigin !== undefined) return o.turnOrigin === 'human' || o.turnOrigin === 'sdk' ? text : undefined;
  // older transcripts record no origin: injected text (commands, notifications, hook output) is wrapped in a tag
  return /^<[A-Za-z][\w-]*[\s>]/.test(text) ? undefined : text;
}

interface Call { name: string; input: Record<string, any> }

function toolCall(turnId: string, callId: string, call: Call): ToolCall {
  // the core knows Claude Code's tool names (Bash, Edit, Write, Read, Grep, WebFetch, AskUserQuestion, ...)
  const event: ToolCall = { type: 'tool.call', turnId, callId, name: call.name };
  if (SHELL_TOOLS.has(call.name) && typeof call.input.command === 'string') event.command = call.input.command;
  return event;
}

function toolResult(
  turnId: string, cwd: string, callId: string, call: Call | undefined, isError: boolean, content: unknown, detail: unknown, refused = false,
): AgentEvent[] {
  const text = textOf(content);
  const result: ToolResult = { type: 'tool.result', turnId, callId, status: !isError ? 'ok' : refused || REFUSED.test(text) ? 'denied' : 'error' };
  const code = isError ? EXIT_CODE.exec(text) : null;
  if (code) result.exitCode = Number(code[1]);
  const summary = firstLine(code ? text.slice(code[0].length) : text);
  if (summary) result.summary = summary;
  const out: AgentEvent[] = [result];
  const path = call?.input.file_path ?? call?.input.notebook_path;
  if (!isError && call && WRITE_TOOLS.has(call.name) && typeof path === 'string') {
    const created = call.name === 'Write' && (detail as Block | undefined)?.type === 'create';
    out.push({ type: 'artifact', turnId, kind: created ? 'file_created' : 'file_changed', ref: refOf(cwd, path) });
  }
  return out;
}

type Item =
  | { kind: 'text'; text: string }
  | { kind: 'call'; id: string; call: Call }
  | { kind: 'result'; id: string; isError: boolean; content: unknown; detail: unknown };

interface Group { user: string; items: Item[]; end: number; done: boolean; ending?: 'reply' | 'error' | 'interrupt' }

const statusOf = (g: Group): 'completed' | 'interrupted' | 'failed' =>
  g.ending === 'interrupt' ? 'interrupted' : g.ending === 'error' ? 'failed' : g.done ? 'completed' : 'interrupted';

/**
 * Restore completed turns from a Claude Code transcript: the last `maxTurns`, or all after byte
 * offset `after`. A turn starts at a prompt (claudePromptText). It is complete once the model ended
 * its reply with no tool call outstanding, an API error ended it, or the user interrupted it; the
 * next prompt closes it too. Only a live Claude Code process can move a turn on, so when no process
 * has the session open (`open` false) an unfinished last turn counts as interrupted. Subagent lines
 * and Claude Code's own bookkeeping lines are skipped.
 */
export function readClaudeHistory(
  file: string, cwd: string, maxTurns: number, makeTurnId: () => string, after = 0, open = true,
): HistoryReplay | undefined {
  const read = jsonlFrom(file, after);
  if (!read) return undefined;
  const groups: Group[] = [];
  let current: Group | undefined;
  for (const { value: o, end } of read.entries) {
    if (o.isSidechain) continue;
    const prompt = claudePromptText(o);
    if (prompt !== undefined) {
      if (current) groups.push(current);
      current = { user: prompt, items: [], end, done: false };
      continue;
    }
    if (!current) continue;
    current.end = end;
    if (o.type === 'assistant') {
      if (o.isApiErrorMessage) {                           // e.g. a usage limit: the turn ends without a reply
        current.ending = 'error';
        current.done = true;
        continue;
      }
      for (const b of blocks(o.message?.content)) {
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) current.items.push({ kind: 'text', text: b.text.trim() });
        else if (b.type === 'tool_use') {
          current.items.push({ kind: 'call', id: String(b.id ?? ''), call: { name: String(b.name ?? 'tool'), input: b.input && typeof b.input === 'object' ? b.input : {} } });
        }
      }
      const stop = o.message?.stop_reason;
      current.done = typeof stop === 'string' && stop !== 'tool_use';
      if (current.done) current.ending = 'reply';
    } else if (o.type === 'user') {
      const content = o.message?.content;
      if (blocks(content).some((b) => b.type === 'tool_result')) {
        for (const b of blocks(content)) {
          if (b.type === 'tool_result') current.items.push({ kind: 'result', id: String(b.tool_use_id ?? ''), isError: b.is_error === true, content: b.content, detail: o.toolUseResult });
        }
        current.done = false;
      } else if (INTERRUPTED.test(textOf(content).trim())) {
        current.ending = 'interrupt';
        current.done = true;
      } else if (o.turnOrigin !== undefined || textOf(content).trimStart().startsWith('<task-notification')) {
        current.done = false;                              // a background task reported back: the model works on
      }
    } else if (o.type === 'system' && o.subtype === 'turn_duration') {
      current.done = true;                                 // the interactive UI's end-of-turn record
    }
  }
  if (current && (current.done || !open)) groups.push(current);   // abandoned: e.g. the process was killed mid-turn
  const picked = after > 0 ? groups : groups.slice(-maxTurns);
  if (!picked.length) return undefined;
  const turns: AgentEvent[][] = [];
  const turnIds: string[] = [];
  for (const g of picked) {
    const turnId = makeTurnId();
    turnIds.push(turnId);
    const events: AgentEvent[] = [{ type: 'turn.started', turnId, at: Date.now() }, { type: 'message.user', turnId, text: g.user }];
    const calls = new Map<string, Call>();
    let pending: string | undefined;
    const flush = (final: boolean) => {
      if (pending) events.push({ type: 'message.agent', turnId, text: pending, final });
      pending = undefined;
    };
    for (const item of g.items) {
      if (item.kind === 'text') {
        flush(false);
        pending = item.text;
      } else if (item.kind === 'call') {
        flush(false);
        calls.set(item.id, item.call);
        events.push(toolCall(turnId, item.id, item.call));
      } else if (calls.has(item.id)) {
        events.push(...toolResult(turnId, cwd, item.id, calls.get(item.id), item.isError, item.content, item.detail));
      }
    }
    flush(true);
    events.push({ type: 'turn.completed', turnId, status: statusOf(g), at: Date.now() });
    turns.push(events);
  }
  return { turns, turnIds, fingerprint: groups.at(-1)!.end };
}

/** True when a prompt arrived in the transcript after byte offset `fingerprint`. */
export function claudeAdvanced(file: string, fingerprint: number): boolean {
  const read = jsonlFrom(file, fingerprint);
  return !!read && read.entries.some(({ value }) => !value.isSidechain && claudePromptText(value) !== undefined);
}

/** Maps one `claude -p --output-format stream-json` run to the events of one turn. */
export class ClaudeStreamMapper {
  sessionId: string | undefined;
  permissionMode: string | undefined;
  /** Tools Claude refused to run because they needed an approval nobody could give. */
  readonly refusedTools: string[] = [];
  private readonly turnId: string;
  private readonly cwd: string;
  private readonly calls = new Map<string, Call>();
  private readonly refused = new Set<string>();
  private pendingText: string | undefined;
  private ended = false;

  constructor(turnId: string, cwd: string) {
    this.turnId = turnId;
    this.cwd = cwd;
  }

  private flush(final: boolean): AgentEvent[] {
    const text = this.pendingText;
    this.pendingText = undefined;
    return text ? [{ type: 'message.agent', turnId: this.turnId, text, final }] : [];
  }

  private end(status: 'completed' | 'failed'): AgentEvent[] {
    if (this.ended) return [];
    this.ended = true;
    return [...this.flush(true), { type: 'turn.completed', turnId: this.turnId, status, at: Date.now() }];
  }

  push(line: Record<string, any>): AgentEvent[] {
    if (typeof line.session_id === 'string' && line.session_id) this.sessionId ??= line.session_id;
    if (line.parent_tool_use_id) return [];               // a subagent's own messages
    const turnId = this.turnId;
    switch (line.type) {
      case 'system':
        if (line.subtype === 'init') {
          if (typeof line.session_id === 'string') this.sessionId = line.session_id;
          if (typeof line.permissionMode === 'string') this.permissionMode = line.permissionMode;
        } else if (line.subtype === 'permission_denied' && typeof line.tool_use_id === 'string') {
          this.refused.add(line.tool_use_id);
          this.refusedTools.push(String(line.tool_name ?? 'tool'));
        }
        return [];
      case 'assistant': {
        if (line.error !== undefined || line.message?.model === '<synthetic>') return [];   // an API error, not a reply
        const out: AgentEvent[] = [];
        for (const b of blocks(line.message?.content)) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            out.push(...this.flush(false));
            this.pendingText = b.text.trim();
          } else if (b.type === 'tool_use') {
            out.push(...this.flush(false));
            const callId = String(b.id ?? `c${Date.now()}`);
            const call: Call = { name: String(b.name ?? 'tool'), input: b.input && typeof b.input === 'object' ? b.input : {} };
            this.calls.set(callId, call);
            out.push(toolCall(turnId, callId, call));
          }
        }
        return out;
      }
      case 'user': {
        const out: AgentEvent[] = [];
        for (const b of blocks(line.message?.content)) {
          if (b.type !== 'tool_result') continue;
          const callId = String(b.tool_use_id ?? '');
          if (!this.calls.has(callId)) continue;
          out.push(...toolResult(turnId, this.cwd, callId, this.calls.get(callId), b.is_error === true, b.content, line.tool_use_result, this.refused.has(callId)));
        }
        return out;
      }
      case 'result':
        if (typeof line.session_id === 'string' && line.session_id) this.sessionId = line.session_id;
        return this.end(line.subtype === 'success' && line.is_error !== true ? 'completed' : 'failed');
      default:
        return [];                                         // hook events, rate-limit notices, ...
    }
  }

  /** Call when the process has exited: a run that never reported its result failed. */
  finish(): AgentEvent[] {
    return this.end('failed');
  }
}

/** Arguments of a driven turn (the message itself goes to stdin). Nothing here approves anything. */
export function claudeTurnArgs(sessionId?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
  if (sessionId) args.push('--resume', safeName(sessionId, 'session id'));
  return args;
}

const SAMPLER_SYSTEM =
  'You are a strict classifier. Follow the instructions in the user message and reply with a single JSON object only. Never call tools.';

/** Arguments of a classification call: default model and effort, no tools, hooks, MCP or CLAUDE.md, no transcript. */
export const CLAUDE_SAMPLE_ARGS = [
  '-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--safe-mode', '--strict-mcp-config',
  '--permission-prompts', 'none', '--system-prompt', SAMPLER_SYSTEM,
];
/** The same, with low reasoning effort when the user chose it (cheaper and faster, explicitly). */
export const claudeSampleArgs = (effort: 'default' | 'low' = 'default'): string[] =>
  (effort === 'low' ? [...CLAUDE_SAMPLE_ARGS.slice(0, -2), '--effort', 'low', ...CLAUDE_SAMPLE_ARGS.slice(-2)] : CLAUDE_SAMPLE_ARGS);

/** Claude Code. */
export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  async runTurn(text, ctx) {
    const mapper = new ClaudeStreamMapper(ctx.turnId, ctx.cwd);
    try {
      const { code, stderr } = await runProcess(ctx.env.bins.claude ?? 'claude', claudeTurnArgs(ctx.id), {
        cwd: ctx.cwd, input: text,
        onLine: (raw) => {
          const [line] = jsonLines(raw);
          if (!line) return;
          if (line.type === 'assistant' && !line.parent_tool_use_id) {
            for (const b of blocks(line.message?.content)) {
              if (b.type === 'text') ctx.onLine?.({ type: 'text', data: String(b.text ?? '') } as GrokLine);
              if (b.type === 'tool_use') ctx.onLine?.({ type: 'tool_call', toolName: b.name, rawInput: { command: b.input?.command } } as GrokLine);
            }
          }
          if (line.type === 'system' && line.subtype === 'init' && typeof line.permissionMode === 'string' && line.permissionMode !== 'default') {
            ctx.info(`Claude runs this session in its own "${line.permissionMode}" permission mode`);
          }
          ctx.emit(mapper.push(line));
        },
      });
      if (mapper.refusedTools.length) {
        ctx.info(`Claude was refused what needed approval (${[...new Set(mapper.refusedTools)].join(', ')}): nobody can approve a headless turn`);
      }
      if (code !== 0) ctx.info(`claude exited with ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n')[0] : ''}`);
    } catch (e) {
      ctx.info(`could not run claude: ${(e as Error).message}`);
    } finally {
      ctx.emit(mapper.finish());
    }
    return { sessionId: mapper.sessionId };
  },
  async sample(prompt, ctx) {
    const { code, stdout, stderr } = await runProcess(ctx.env.bins.claude ?? 'claude', claudeSampleArgs(ctx.env.samplerEffort), {
      cwd: ctx.env.scratch(), input: prompt, signal: ctx.signal,
    });
    const out = jsonLines(stdout).find((l) => l.type === 'result');
    if (!out) throw new Error(`claude classification call failed (${code}): ${stderr.trim().split('\n').at(-1) || 'no result on stdout'}`);
    const usage = out.usage ?? {};
    const answered = out.subtype === 'success' && out.is_error !== true && out.stop_reason === 'end_turn'
      && (out.num_turns ?? 1) <= 1 && !(out.permission_denials ?? []).length;
    return {
      // a call that was cut short or reached for a tool is void (SPEC 6)
      text: answered && typeof out.result === 'string' ? out.result : null,
      usage: {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        cachedInputTokens: usage.cache_read_input_tokens,
        outputTokens: usage.output_tokens,
      },
    };
  },
  readHistory(ref, env, maxTurns, makeTurnId, after) {
    const root = claudeHome(env.home);
    const file = claudeTranscript(root, ref.id, ref.cwd);
    return file ? readClaudeHistory(file, ref.cwd, maxTurns, makeTurnId, after, claudeLiveSessions(root).has(ref.id)) : undefined;
  },
  fingerprint(ref, env) {
    const file = claudeTranscript(claudeHome(env.home), ref.id, ref.cwd);
    return file ? sizeOf(file) : 0;
  },
  advanced(ref, env, fingerprint) {
    const file = claudeTranscript(claudeHome(env.home), ref.id, ref.cwd);
    return !!file && claudeAdvanced(file, fingerprint);
  },
  busyElsewhere(ref, env) {
    const open = claudeLiveSessions(claudeHome(env.home)).get(ref.id);
    return open
      ? `this Claude session is open in another Claude Code process (pid ${open.pid}), and Claude lets only one process continue a session: `
        + 'leave it there first, or copy the suggestion into it'
      : undefined;
  },
};
