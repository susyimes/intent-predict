// Grok CLI as an intent-predict host: it reports each turn's events to a sidecar, lends Grok's model
// as the `compact` sampler, and accepts user-approved sends as the next prompt of the same session.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RpcError, SAMPLER_ABORTED, SESSION_BUSY, TURN_MISMATCH } from '../../core/src/index.ts';
import type { AgentEvent } from '../../core/src/index.ts';
import { RpcPeer } from '../../sidecar/src/rpc.ts';
import { TurnMapper, deleteGrokSession, runGrok, sampleWithGrok } from './grok.ts';
import type { GrokLine } from './grok.ts';

const SIDECAR = fileURLToPath(new URL('../../sidecar/src/main.ts', import.meta.url));

export interface GrokHostOptions {
  cwd: string;
  /** Extra arguments for every agent turn, e.g. permission rules: ['--allow', 'search_replace']. */
  grokArgs?: string[];
  model?: string;
  /** Telemetry JSONL written by the sidecar. */
  logPath?: string;
  /** The sampler is a process spawn: allow far more than the core's 4 s default. */
  timeoutMs?: number;
  packs?: string[];
  surfacePort?: number;
  bin?: string;
  onLine?: (line: GrokLine) => void;
  onInfo?: (message: string) => void;
}

export class GrokHost {
  readonly sessionId = `grok-${Date.now().toString(36)}`;
  surfaceUrl: string | undefined;
  grokSessionId: string | undefined;
  lastCompletedTurn: string | undefined;
  busy = false;
  private readonly opts: GrokHostOptions;
  private readonly scratch = mkdtempSync(join(tmpdir(), 'intent-predict-'));
  private sidecar: ChildProcess | undefined;
  private peer: RpcPeer | undefined;
  private sampling: AbortController | undefined;
  private readonly dispatched = new Set<string>();
  private readonly cleanups: Promise<void>[] = [];
  private turnSeq = 0;
  private fileSeq = 0;

  constructor(opts: GrokHostOptions) {
    this.opts = opts;
  }
  private info(message: string) { this.opts.onInfo?.(message); }

  async start(): Promise<void> {
    const args = [SIDECAR, 'serve', '--stdio'];
    if (this.opts.logPath) args.push('--log', this.opts.logPath);
    if (this.opts.surfacePort !== undefined) args.push('--port', String(this.opts.surfacePort));
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.sidecar = child;
    this.peer = new RpcPeer(child.stdout!, child.stdin!, {
      request: (method, params) => this.onRequest(method, params),
      notify: (method) => {
        if (method === 'sampler/cancel') this.sampling?.abort();
      },
    }, 'h-', (m) => this.info(m));
    const init = (await this.peer.request('initialize', {
      protocolVersion: '0.5',
      client: { name: 'grok-cli-host', version: '0.5.0' },
      capabilities: { interactive: true, samplerModes: ['compact'], dispatchModes: ['message'] },
      packs: this.opts.packs ?? ['builtin/coding'],
      options: { timeoutMs: this.opts.timeoutMs ?? 60_000 },
    })) as { surfaceUrl?: string };
    this.surfaceUrl = init.surfaceUrl;
  }

  private observe(events: AgentEvent[]): void {
    if (events.length) this.peer!.notify('session/observe', { sessionId: this.sessionId, events });
  }
  private promptFile(text: string): string {
    const file = join(this.scratch, `prompt-${++this.fileSeq}.txt`);
    writeFileSync(file, text, 'utf8');
    return file;
  }

  /** Requests the sidecar makes of the host (SPEC 5.3, 6). */
  private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method !== 'sampler/sample' && method !== 'dispatch/message') throw new RpcError(-32601, `unsupported: ${method}`);
    if (this.busy) throw new RpcError(SESSION_BUSY, 'a turn is running');
    if (params.expectedTurnId !== this.lastCompletedTurn) throw new RpcError(TURN_MISMATCH, 'not the latest completed turn');

    if (method === 'sampler/sample') {
      if (params.mode !== 'compact') throw new RpcError(-32602, 'this host offers the compact sampler only');
      const controller = (this.sampling = new AbortController());
      try {
        const { sessionId, ...result } = await sampleWithGrok(this.promptFile(String(params.prompt)), {
          cwd: this.scratch, model: this.opts.model, signal: controller.signal, bin: this.opts.bin,
        });
        // the sample must leave nothing behind (SPEC 6 rule 2); Grok persists it, so remove it
        if (sessionId) this.cleanups.push(deleteGrokSession(sessionId, this.opts.bin));
        return result;
      } catch (e) {
        if (controller.signal.aborted) throw new RpcError(SAMPLER_ABORTED, 'cancelled');
        throw e;
      } finally {
        if (this.sampling === controller) this.sampling = undefined;
      }
    }

    // dispatch/message: exactly like a message the user typed; never queued, never twice
    const id = String(params.predictionId);
    if (!this.dispatched.has(id)) {
      this.dispatched.add(id);
      const text = String(params.text);
      this.busy = true;                                    // refuse anything else from this instant
      setImmediate(() => void this.runTurn(text, true));   // reply first, then start the turn
    }
    return {};
  }

  /** Run one agent turn for a message the user typed in this host. Resolves when the turn has ended. */
  send(text: string): Promise<void> {
    if (this.busy) return Promise.reject(new Error('a turn is running'));
    this.busy = true;
    return this.runTurn(text, false);
  }
  /** Resolves when no turn is running (a dispatched send starts one on its own). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  private runTurn(text: string, fromSurface: boolean): Promise<void> {
    const run = (async () => {
      const turnId = `t${++this.turnSeq}`;
      this.info(`${fromSurface ? 'sent from the surface' : 'user'} › ${text}`);
      this.observe([{ type: 'turn.started', turnId, at: Date.now() }, { type: 'message.user', turnId, text }]);
      const mapper = new TurnMapper(turnId, this.opts.cwd);
      const forward = (events: AgentEvent[]) => {
        if (events.some((e) => e.type === 'turn.completed')) {
          // be ready for the sampler and for a dispatch before the sidecar hears that the turn ended
          this.lastCompletedTurn = turnId;
          this.busy = false;
        }
        this.observe(events);
      };
      const args = ['--prompt-file', this.promptFile(text), '--output-format', 'streaming-json', '--no-subagents'];
      if (this.grokSessionId) args.push('--resume', this.grokSessionId);
      if (this.opts.model) args.push('--model', this.opts.model);
      args.push(...(this.opts.grokArgs ?? []));
      try {
        const { code, stderr } = await runGrok(args, {
          cwd: this.opts.cwd, bin: this.opts.bin,
          onLine: (line) => {
            this.opts.onLine?.(line);
            forward(mapper.push(line));
          },
        });
        if (mapper.sessionId) this.grokSessionId = mapper.sessionId;
        if (code !== 0 || stderr.trim()) this.info(`grok exited with ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n')[0] : ''}`);
      } catch (e) {
        this.info(`could not run grok: ${(e as Error).message}`);
      } finally {
        forward(mapper.finish());
      }
    })();
    return run;
  }

  async stop(): Promise<void> {
    this.sampling?.abort();
    await this.idle();
    await Promise.all(this.cleanups);
    this.sidecar?.stdin?.end();
    await new Promise<void>((resolve) => (this.sidecar && this.sidecar.exitCode === null ? this.sidecar.once('exit', () => resolve()) : resolve()));
    rmSync(this.scratch, { recursive: true, force: true });
  }
}
