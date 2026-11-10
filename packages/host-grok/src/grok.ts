// Grok CLI plumbing: run a headless turn, map its `streaming-json` lines (ACP session updates) to
// intent-predict events, and use a second headless call as the `compact` sampler.
import { spawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentEvent, SampleResult, ToolCall, ToolKind, ToolResult } from '../../core/src/index.ts';

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

export interface RunOptions { cwd: string; signal?: AbortSignal; onLine?: (line: GrokLine) => void; bin?: string }

/** Run `grok` and hand every JSON line of its stdout to `onLine`. Resolves with the whole stdout. */
export function runGrok(args: string[], opts: RunOptions): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.bin ?? 'grok', args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal: opts.signal });
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
  promptFile: string, opts: { cwd: string; model?: string; signal?: AbortSignal; bin?: string },
): Promise<SampleResult & { sessionId?: string }> {
  const args = [
    '--prompt-file', promptFile, '--output-format', 'json', '--max-turns', '1', '--no-subagents', '--no-plan',
    '--disable-web-search', '--reasoning-effort', 'low', '--disallowed-tools', ALL_TOOLS,
    '--system-prompt-override', SAMPLER_SYSTEM,
  ];
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
export function deleteGrokSession(sessionId: string, bin = 'grok'): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['sessions', 'delete', sessionId], { stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}
