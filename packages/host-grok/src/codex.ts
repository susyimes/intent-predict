// Codex CLI plumbing (verified against codex-cli 0.159 on the development machine).
//
// Turns: `codex exec --json [resume <id>] -`, the message on stdin. `codex exec` never asks for
// approval; what a turn may do is bounded by the sandbox the user configured, which the host keeps.
// Classification: `codex exec --ephemeral --sandbox read-only`, which writes no session file.
// History: the session's rollout file, ~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<id>.jsonl.
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { AgentEvent, Artifact, ToolCall, ToolKind, ToolResult } from '../../core/src/index.ts';
import type { AgentAdapter, AgentEnv, AgentRef } from './agent.ts';
import type { GrokLine, HistoryReplay } from './grok.ts';
import { firstLine, jsonLines, runProcess } from './proc.ts';
import { safeName } from './sessions.ts';
import { jsonlFrom, sizeOf } from './store.ts';

export const codexHome = (env: Pick<AgentEnv, 'home'>): string => process.env.CODEX_HOME ?? join(env.home, '.codex');

const refOf = (cwd: string, path: string): string => {
  const rel = isAbsolute(path) ? relative(cwd, path) : path;
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path).replaceAll('\\', '/');
};

const rollouts = new Map<string, string>();
const newestDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse().map((n) => join(dir, n));
  } catch {
    return [];
  }
};

/** The rollout file of session `id` under `<codex home>/sessions`, newest days first. */
export function codexRolloutFile(home: string, id: string): string | undefined {
  safeName(id, 'session id');
  const key = `${home}|${id}`;
  const cached = rollouts.get(key);
  if (cached && existsSync(cached)) return cached;
  const suffix = `-${id}.jsonl`;
  for (const year of newestDirs(join(home, 'sessions'))) {
    for (const month of newestDirs(year)) {
      for (const day of newestDirs(month)) {
        let names: string[];
        try {
          names = readdirSync(day);
        } catch {
          continue;
        }
        const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
        if (hit) {
          rollouts.set(key, join(day, hit));
          return join(day, hit);
        }
      }
    }
  }
  return undefined;
}

/** Tool names whose calls run commands, edit files or ask the user (others are left to the core). */
function codexKind(name: string): ToolKind | undefined {
  if (/^(exec|exec_command|shell|shell_command|local_shell|container\.exec|unified_exec)$/.test(name)) return 'execute';
  if (name === 'apply_patch') return 'edit';
  if (/^request_user_input/.test(name)) return 'ask_user';
  return undefined;
}

/** Text of a tool output: a string, a JSON string, or a list of content items. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((item) => (typeof item?.text === 'string' ? item.text : '')).filter(Boolean).join('\n');
  if (output && typeof output === 'object') return outputText(Object.values(output));
  return '';
}

/** The exit code a tool output reports, when it reports one. */
export function exitCodeOf(output: unknown): number | undefined {
  const text = outputText(output);
  if (text.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      const code = parsed?.metadata?.exit_code ?? parsed?.exit_code;
      if (typeof code === 'number') return code;
    } catch { /* fall through to the text patterns */ }
  }
  const match = /(?:Process exited with code|Exit code:?)\s*(-?\d+)/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Files an apply_patch input touches. */
function patchedFiles(patch: unknown, cwd: string, turnId: string): Artifact[] {
  if (typeof patch !== 'string') return [];
  const kinds: Record<string, string> = { Add: 'file_created', Update: 'file_changed', Delete: 'file_deleted' };
  return [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)]
    .map((m) => ({ type: 'artifact', turnId, kind: kinds[m[1]!]!, ref: refOf(cwd, m[2]!.trim()) }));
}

function commandOf(name: string, args: Record<string, any>, input: unknown): string | undefined {
  if (typeof args.cmd === 'string') return args.cmd;
  if (Array.isArray(args.command)) return args.command.map(String).join(' ');
  if (typeof args.command === 'string') return args.command;
  if (codexKind(name) === 'execute' && typeof input === 'string') return input.slice(0, 400);
  return undefined;
}

interface Group { userTexts: string[]; items: Array<Record<string, any>>; end: number; status?: 'completed' | 'interrupted' }

/**
 * Restore completed turns from a rollout file: the last `maxTurns`, or all after byte offset
 * `after`. A turn spans task_started .. task_complete (or turn_aborted); turns the user did not
 * start (no user message) are skipped but still move the replay point.
 */
export function readCodexHistory(file: string, cwd: string, maxTurns: number, makeTurnId: () => string, after = 0): HistoryReplay | undefined {
  const read = jsonlFrom(file, after);
  if (!read) return undefined;
  const groups: Group[] = [];
  let current: Group | undefined;
  for (const { value: o, end } of read.entries) {
    const p: Record<string, any> = o.payload ?? {};
    if (o.type === 'event_msg' && p.type === 'task_started') {
      current = { userTexts: [], items: [], end };
      continue;
    }
    if (!current) continue;
    if (o.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
      current.status = p.type === 'task_complete' ? 'completed' : 'interrupted';
      current.end = end;
      groups.push(current);
      current = undefined;
      continue;
    }
    if (o.type !== 'response_item') continue;
    if (p.type === 'message' && p.role === 'user') {
      // injected context (environment, instructions) is wrapped in tags; the user's own text is not
      for (const c of Array.isArray(p.content) ? p.content : []) {
        if (typeof c?.text === 'string' && c.text.trim() && !c.text.trimStart().startsWith('<')) current.userTexts.push(c.text.trim());
      }
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = (Array.isArray(p.content) ? p.content : []).map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('').trim();
      if (text) current.items.push({ kind: 'text', text });
    } else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(p.type)) {
      let args: Record<string, any> = {};
      if (typeof p.arguments === 'string') {
        try {
          const parsed = JSON.parse(p.arguments);
          if (parsed && typeof parsed === 'object') args = parsed;
        } catch { /* free-form arguments */ }
      }
      if (p.type === 'local_shell_call' && p.action?.command) args = { command: p.action.command };
      current.items.push({ kind: 'call', id: String(p.call_id ?? p.id ?? ''), name: String(p.name ?? (p.type === 'local_shell_call' ? 'local_shell' : 'tool')), args, input: p.input });
    } else if (['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(p.type)) {
      current.items.push({ kind: 'result', id: String(p.call_id ?? ''), output: p.output });
    }
  }
  const complete = groups.filter((g) => g.userTexts.length > 0);
  const picked = after > 0 ? complete : complete.slice(-maxTurns);
  const fingerprint = groups.length ? groups[groups.length - 1]!.end : after;
  if (!picked.length) return after > 0 && fingerprint > after ? { turns: [], turnIds: [], fingerprint } : undefined;
  const turns: AgentEvent[][] = [];
  const turnIds: string[] = [];
  for (const g of picked) {
    const turnId = makeTurnId();
    turnIds.push(turnId);
    const events: AgentEvent[] = [
      { type: 'turn.started', turnId, at: Date.now() },
      { type: 'message.user', turnId, text: g.userTexts.join('\n') },
    ];
    const calls = new Map<string, { name: string; input: unknown }>();
    let pendingText: string | undefined;
    const flush = (final: boolean) => {
      if (pendingText) events.push({ type: 'message.agent', turnId, text: pendingText, final });
      pendingText = undefined;
    };
    for (const item of g.items) {
      if (item.kind === 'text') {
        flush(false);
        pendingText = item.text;
      } else if (item.kind === 'call') {
        flush(false);
        calls.set(item.id, { name: item.name, input: item.input });
        const call: ToolCall = { type: 'tool.call', turnId, callId: item.id, name: item.name };
        const kind = codexKind(item.name);
        if (kind) call.kind = kind;
        const command = commandOf(item.name, item.args, item.input);
        if (command) call.command = command;
        events.push(call);
      } else {
        const exitCode = exitCodeOf(item.output);
        const result: ToolResult = { type: 'tool.result', turnId, callId: item.id, status: exitCode !== undefined && exitCode !== 0 ? 'error' : 'ok' };
        if (exitCode !== undefined) result.exitCode = exitCode;
        const summary = firstLine(outputText(item.output));
        if (summary) result.summary = summary;
        events.push(result);
        const call = calls.get(item.id);
        if (call?.name === 'apply_patch' && result.status === 'ok') events.push(...patchedFiles(call.input, cwd, turnId));
      }
    }
    flush(true);
    events.push({ type: 'turn.completed', turnId, status: g.status ?? 'completed', at: Date.now() });
    turns.push(events);
  }
  return { turns, turnIds, fingerprint };
}

/** True when a turn started in the rollout after byte offset `fingerprint`. */
export function codexAdvanced(file: string, fingerprint: number): boolean {
  const read = jsonlFrom(file, fingerprint);
  return !!read && read.entries.some(({ value: o }) => o.type === 'event_msg' && o.payload?.type === 'task_started');
}

/** Maps one `codex exec --json` run to the events of one turn. */
export class CodexExecMapper {
  sessionId: string | undefined;
  private readonly turnId: string;
  private readonly cwd: string;
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
    const turnId = this.turnId;
    if (line.type === 'thread.started' && typeof line.thread_id === 'string') this.sessionId = line.thread_id;
    if (line.type === 'turn.completed') return this.end('completed');
    if (line.type === 'turn.failed') return this.end('failed');
    if (line.type !== 'item.completed' || !line.item) return [];
    const item = line.item;
    const callId = String(item.id ?? `c${Date.now()}`);
    switch (item.type) {
      case 'agent_message': {
        const out = this.flush(false);
        if (typeof item.text === 'string' && item.text.trim()) this.pendingText = item.text.trim();
        return out;
      }
      case 'command_execution': {
        const call: ToolCall = { type: 'tool.call', turnId, callId, name: 'exec_command', kind: 'execute' };
        if (typeof item.command === 'string') call.command = item.command;
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const result: ToolResult = {
          type: 'tool.result', turnId, callId,
          status: item.status === 'failed' || (exitCode !== undefined && exitCode !== 0) ? 'error' : 'ok',
        };
        if (exitCode !== undefined) result.exitCode = exitCode;
        const summary = firstLine(item.aggregated_output);
        if (summary) result.summary = summary;
        return [...this.flush(false), call, result];
      }
      case 'file_change': {
        const ok = item.status !== 'failed';
        const kinds: Record<string, string> = { add: 'file_created', delete: 'file_deleted', update: 'file_changed' };
        const artifacts: Artifact[] = ok
          ? (Array.isArray(item.changes) ? item.changes : []).filter((c: any) => typeof c?.path === 'string')
            .map((c: any) => ({ type: 'artifact', turnId, kind: kinds[c.kind] ?? 'file_changed', ref: refOf(this.cwd, c.path) }))
          : [];
        return [...this.flush(false),
          { type: 'tool.call', turnId, callId, name: 'apply_patch', kind: 'edit' },
          { type: 'tool.result', turnId, callId, status: ok ? 'ok' : 'error' }, ...artifacts];
      }
      case 'mcp_tool_call':
      case 'web_search': {
        const name = item.type === 'web_search' ? 'web_search' : String(item.tool ?? 'mcp_tool');
        return [...this.flush(false),
          { type: 'tool.call', turnId, callId, name },
          { type: 'tool.result', turnId, callId, status: item.status === 'failed' ? 'error' : 'ok' }];
      }
      default:
        return [];                                         // reasoning, plans
    }
  }

  /** Call when the process has exited: a run that never completed its turn failed. */
  finish(): AgentEvent[] {
    return this.end('failed');
  }
}

/** Arguments of a driven turn (the message itself goes to stdin). */
export function codexTurnArgs(sessionId?: string): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--color', 'never'];
  if (sessionId) args.push('resume', safeName(sessionId, 'session id'));
  return [...args, '-'];
}

/** Arguments of a classification call: no session file, read-only sandbox, the default model. */
export const CODEX_SAMPLE_ARGS = ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '-'];

const rollout = (ref: AgentRef, env: AgentEnv) => codexRolloutFile(codexHome(env), ref.id);

/** Codex CLI. */
export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  async runTurn(text, ctx) {
    const mapper = new CodexExecMapper(ctx.turnId, ctx.cwd);
    try {
      const { code, stderr } = await runProcess(ctx.env.bins.codex ?? 'codex', codexTurnArgs(ctx.id), {
        cwd: ctx.cwd, input: text,
        onLine: (raw) => {
          const [line] = jsonLines(raw);
          if (!line) return;
          const item = line.item ?? {};
          if (line.type === 'item.completed' && item.type === 'agent_message') ctx.onLine?.({ type: 'text', data: String(item.text ?? '') } as GrokLine);
          if (line.type === 'item.completed' && item.type === 'command_execution') {
            ctx.onLine?.({ type: 'tool_call', toolName: 'exec_command', rawInput: { command: item.command } } as GrokLine);
          }
          ctx.emit(mapper.push(line));
        },
      });
      if (code !== 0) ctx.info(`codex exited with ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n').at(-1) : ''}`);
    } catch (e) {
      ctx.info(`could not run codex: ${(e as Error).message}`);
    } finally {
      ctx.emit(mapper.finish());
    }
    return { sessionId: mapper.sessionId };
  },
  async sample(prompt, ctx) {
    const { code, stdout, stderr } = await runProcess(ctx.env.bins.codex ?? 'codex', CODEX_SAMPLE_ARGS, {
      cwd: ctx.env.scratch(), input: prompt, signal: ctx.signal,
    });
    const lines = jsonLines(stdout);
    const done = lines.find((l) => l.type === 'turn.completed');
    if (!done) {
      const failure = lines.find((l) => l.type === 'turn.failed' || l.type === 'error');
      throw new Error(`codex classification call failed (${code}): ${String(failure?.error?.message ?? failure?.message ?? stderr.trim().split('\n').at(-1) ?? '')}`);
    }
    const items = lines.filter((l) => l.type === 'item.completed').map((l) => l.item ?? {});
    const replies = items.filter((i) => i.type === 'agent_message' && typeof i.text === 'string');
    const usedTool = items.some((i) => ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(i.type));
    const usage = done.usage ?? {};
    return {
      // a call that used a tool is void (SPEC 6)
      text: usedTool || !replies.length ? null : String(replies.at(-1)!.text),
      usage: { inputTokens: usage.input_tokens, cachedInputTokens: usage.cached_input_tokens, outputTokens: usage.output_tokens },
    };
  },
  readHistory(ref, env, maxTurns, makeTurnId, after) {
    const file = rollout(ref, env);
    return file ? readCodexHistory(file, ref.cwd, maxTurns, makeTurnId, after) : undefined;
  },
  fingerprint(ref, env) {
    const file = rollout(ref, env);
    return file ? sizeOf(file) : 0;
  },
  advanced(ref, env, fingerprint) {
    const file = rollout(ref, env);
    return !!file && codexAdvanced(file, fingerprint);
  },
};
