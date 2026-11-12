// An intent-predict host for agent CLIs. It drives one session of Grok, Hermes, Codex, Kimi or
// Claude Code headlessly, reports each turn's events to a sidecar, lends that session's own agent as
// the `compact` sampler (its default model), and accepts user-approved sends as the session's next
// prompt. The per-agent details live in the adapters (agent.ts).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVALID_PARAMS, RpcError, SAMPLER_ABORTED, SESSION_BUSY, TURN_MISMATCH } from '../../core/src/index.ts';
import type { AgentEvent } from '../../core/src/index.ts';
import { RpcPeer } from '../../sidecar/src/rpc.ts';
import { AGENT_KINDS, isAgentKind } from './agent.ts';
import type { AgentAdapter, AgentEnv, AgentKind, AgentRef } from './agent.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { grokAdapter } from './grok.ts';
import type { GrokLine } from './grok.ts';
import { hermesAdapter } from './hermes.ts';
import { kimiAdapter } from './kimi.ts';
import type { Bin } from './proc.ts';
import { discoverSessions, isSafeName, safeName } from './sessions.ts';

const SIDECAR = fileURLToPath(new URL('../../sidecar/src/main.ts', import.meta.url));

export const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  grok: grokAdapter, hermes: hermesAdapter, codex: codexAdapter, kimi: kimiAdapter, claude: claudeAdapter,
};

export interface GateSettings {
  eagerness: 'conservative' | 'eager';
  minConfidence?: number;
  sideEffectMinConfidence?: number;
  altMinConfidence?: number;
  cooldownTurnsAfterDismiss?: number;
}

export interface GrokHostOptions {
  cwd: string;
  /** The agent that runs turns until a session is bound (default grok). */
  agent?: AgentKind;
  /** Grok only: extra arguments for every turn, e.g. permission rules: ['--allow', 'search_replace']. */
  grokArgs?: string[];
  /** Grok only: model override. */
  model?: string;
  /** Bind to an existing session of `agent` from the start: every turn continues it. */
  resume?: string;
  /** Telemetry JSONL written by the sidecar. */
  logPath?: string;
  /** The sampler is a process spawn: allow far more than the core's 4 s default. */
  timeoutMs?: number;
  packs?: string[];
  surfacePort?: number;
  /** The agent CLIs (default: grok, hermes, codex, kimi, claude on PATH). */
  bin?: Bin;
  hermesBin?: Bin;
  codexBin?: Bin;
  kimiBin?: Bin;
  claudeBin?: Bin;
  /**
   * open (default): the session's own agent writes the user's likely next messages (SPEC 4.9). catalog: the
   * closed-catalog pipeline, an explicit restriction; the preset and thresholds below apply to it only.
   */
  mode?: 'open' | 'catalog';
  /** Open mode: candidates below this confidence are not shown (core default 0.15). */
  minCandidateConfidence?: number;
  /** Classification calls run at the agent's own reasoning effort unless the user explicitly asks for `low`. */
  samplerEffort?: 'default' | 'low';
  /**
   * Catalog mode's gate preset. eager (the default while Phase 1 collects feedback): lower floors and a prompt
   * that leans away from `none`. conservative: the SPEC defaults (minConfidence 0.60).
   */
  eagerness?: GateSettings['eagerness'];
  minConfidence?: number;
  sideEffectMinConfidence?: number;
  altMinConfidence?: number;
  cooldownTurnsAfterDismiss?: number;
  /** Completed turns restored from the bound session's store initially (default 3; 0 disables history sync). */
  replayTurns?: number;
  /**
   * How often the bound session's store is checked for turns taken in the agent's own interface, so they are
   * evaluated without a page refresh (default 2000 ms; 0 checks only when a surface loads or refreshes).
   */
  syncIntervalMs?: number;
  hermesHome?: string;
  onLine?: (line: GrokLine) => void;
  onInfo?: (message: string) => void;
}

export type BoundRef = AgentRef;

export class GrokHost {
  sessionId: string;
  surfaceUrl: string | undefined;
  loadedPacks: Array<{ id: string; version: string; scenarioCount: number }> = [];
  readonly gateSettings: GateSettings;
  lastCompletedTurn: string | undefined;
  busy = false;
  private readonly opts: GrokHostOptions;
  private readonly env: AgentEnv;
  private readonly ids: Partial<Record<AgentKind, string>> = {};
  private kindNow: AgentKind;
  private profile: string | undefined;                     // Hermes profile of the bound session
  private cwdNow: string;
  private scratchDir: string | undefined;
  private sidecar: ChildProcess | undefined;
  private peer: RpcPeer | undefined;
  private sampling: AbortController | undefined;
  private readonly dispatched = new Set<string>();
  private readonly cleanups: Promise<void>[] = [];
  private turnSeq = 0;
  private fileSeq = 0;
  private bindSeq = 0;
  private synced?: AgentRef & { fingerprint: number };
  private drivingTurns = 0;
  private stopping = false;
  private readonly inflight = new Set<Promise<unknown>>();
  private syncTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: GrokHostOptions) {
    const eagerness = opts.eagerness ?? 'eager';
    if (eagerness !== 'conservative' && eagerness !== 'eager') {
      throw new Error('eagerness must be conservative or eager');
    }
    if (opts.agent !== undefined && !isAgentKind(opts.agent)) throw new Error(`agent must be one of ${AGENT_KINDS.join(', ')}`);
    if (opts.mode !== undefined && opts.mode !== 'open' && opts.mode !== 'catalog') throw new Error('mode must be open or catalog');
    if (opts.samplerEffort !== undefined && opts.samplerEffort !== 'default' && opts.samplerEffort !== 'low') {
      throw new Error('samplerEffort must be default or low');
    }
    if (opts.minCandidateConfidence !== undefined
      && (!Number.isFinite(opts.minCandidateConfidence) || opts.minCandidateConfidence < 0 || opts.minCandidateConfidence > 1)) {
      throw new Error('minCandidateConfidence must be a number in [0, 1]');
    }
    const confidence = (name: string, value: number | undefined) => {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
        throw new Error(`${name} must be a number in [0, 1]`);
      }
      return value;
    };
    if (opts.cooldownTurnsAfterDismiss !== undefined
      && (!Number.isInteger(opts.cooldownTurnsAfterDismiss) || opts.cooldownTurnsAfterDismiss < 0)) {
      throw new Error('cooldownTurnsAfterDismiss must be a non-negative integer');
    }
    const eager = eagerness === 'eager';
    this.gateSettings = {
      eagerness,
      minConfidence: confidence('minConfidence', opts.minConfidence ?? (eager ? 0.35 : undefined)),
      sideEffectMinConfidence: confidence('sideEffectMinConfidence', opts.sideEffectMinConfidence ?? (eager ? 0.65 : undefined)),
      altMinConfidence: confidence('altMinConfidence', opts.altMinConfidence ?? (eager ? 0.05 : undefined)),
      cooldownTurnsAfterDismiss: opts.cooldownTurnsAfterDismiss ?? (eager ? 0 : undefined),
    };
    this.opts = opts;
    this.kindNow = opts.agent ?? 'grok';
    this.sessionId = `${this.kindNow}-${Date.now().toString(36)}`;
    if (opts.resume !== undefined) this.ids[this.kindNow] = safeName(opts.resume, 'resume');
    this.cwdNow = opts.cwd;
    this.env = {
      home: homedir(),
      hermesHome: opts.hermesHome,
      bins: { grok: opts.bin, hermes: opts.hermesBin, codex: opts.codexBin, kimi: opts.kimiBin, claude: opts.claudeBin },
      grokModel: opts.model,
      samplerEffort: opts.samplerEffort ?? 'default',
      grokArgs: opts.grokArgs ?? [],
      scratch: () => this.scratch,
      promptFile: (text) => this.promptFile(text),
    };
  }

  /** The agent that runs the next turn. */
  get agent(): AgentKind { return this.kindNow; }
  get grokSessionId(): string | undefined { return this.ids.grok; }
  set grokSessionId(id: string | undefined) { this.ids.grok = id; }
  get hermesSessionId(): string | undefined { return this.ids.hermes; }
  set hermesSessionId(id: string | undefined) { this.ids.hermes = id; }
  /** The agent's own id of the session the host drives, once there is one. */
  get agentSessionId(): string | undefined { return this.ids[this.kindNow]; }

  private info(message: string) { this.opts.onInfo?.(message); }
  /** Prompt files and the sampler's working directory; created on first use, removed by stop(). */
  private get scratch(): string {
    return (this.scratchDir ??= mkdtempSync(join(tmpdir(), 'intent-predict-')));
  }
  private promptFile(text: string): string {
    const file = join(this.scratch, `prompt-${++this.fileSeq}.txt`);
    writeFileSync(file, text, 'utf8');
    return file;
  }

  async start(): Promise<void> {
    const args = [SIDECAR, 'serve', '--stdio'];
    if (this.opts.logPath) args.push('--log', this.opts.logPath);
    if (this.opts.surfacePort !== undefined) args.push('--port', String(this.opts.surfacePort));
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    this.sidecar = child;
    this.peer = new RpcPeer(child.stdout!, child.stdin!, {
      request: (method, params) => {
        const handled = this.onRequest(method, params);
        this.inflight.add(handled);
        handled.then(() => this.inflight.delete(handled), () => this.inflight.delete(handled));
        return handled;
      },
      notify: (method) => {
        if (method === 'sampler/cancel') this.sampling?.abort();
      },
    }, 'h-', (m) => this.info(m));
    const init = (await this.peer.request('initialize', {
      protocolVersion: '0.5',
      client: { name: 'agent-cli-host', version: '0.5.0' },
      capabilities: { interactive: true, samplerModes: ['compact'], dispatchModes: ['message'], binding: true },
      packs: this.opts.packs ?? [this.gateSettings.eagerness === 'eager' ? 'builtin/coding-eager' : 'builtin/coding'],
      policy: {
        minConfidence: this.gateSettings.minConfidence,
        sideEffectMinConfidence: this.gateSettings.sideEffectMinConfidence,
      },
      options: {
        mode: this.opts.mode ?? 'open',
        minCandidateConfidence: this.opts.minCandidateConfidence,
        timeoutMs: this.opts.timeoutMs ?? 120_000,
        altMinConfidence: this.gateSettings.altMinConfidence,
        cooldownTurnsAfterDismiss: this.gateSettings.cooldownTurnsAfterDismiss,
      },
    })) as { surfaceUrl?: string; loadedPacks?: GrokHost['loadedPacks'] };
    this.surfaceUrl = init.surfaceUrl;
    this.loadedPacks = init.loadedPacks ?? [];
    const every = this.opts.syncIntervalMs ?? 2000;
    if (every > 0) {
      // turns the user takes in the agent's own interface reach the surface without a refresh (SPEC 8)
      this.syncTimer = setInterval(() => {
        if (!this.stopping) this.syncBoundHistory();
      }, every);
      this.syncTimer.unref();
    }
  }

  private observe(events: AgentEvent[]): void {
    if (events.length) this.peer!.notify('session/observe', { sessionId: this.sessionId, events });
  }

  private bound(): BoundRef | null {
    const id = this.ids[this.kindNow];
    if (!id) return null;
    const ref: BoundRef = { kind: this.kindNow, id, cwd: this.cwdNow };
    if (this.kindNow === 'hermes' && this.profile) ref.profile = this.profile;
    return ref;
  }

  /** Hot-switch the driven session (SPEC 8) and restore its recent completed turns. */
  private bind(params: Record<string, unknown>): { bound: BoundRef; sessionId: string; replayedTurns: number } {
    const { kind, id, cwd, profile } = params;
    if (!isAgentKind(kind)) throw new RpcError(INVALID_PARAMS, `this host can bind ${AGENT_KINDS.join(', ')} sessions`);
    // ids and profiles reach the agents' command lines and store paths: plain names only
    const plain = "a plain name (letters, digits, '.', '_' or '-', starting with a letter or digit)";
    if (!isSafeName(id)) throw new RpcError(INVALID_PARAMS, `the session id must be ${plain}`);
    if (profile !== undefined && !isSafeName(profile)) throw new RpcError(INVALID_PARAMS, `the profile must be ${plain}`);
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new RpcError(INVALID_PARAMS, 'binding/bind needs an absolute cwd');
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch { /* falls through to the error below */ }
    if (!isDir) throw new RpcError(INVALID_PARAMS, `cwd is not a directory: ${cwd}`);
    // also while a finished turn's process is still winding down: its session would be adopted late
    if (this.busy || this.drivingTurns > 0) throw new RpcError(SESSION_BUSY, 'a turn is running');
    this.sampling?.abort();
    this.peer?.notify('prediction/cancel', { sessionId: this.sessionId });
    this.sessionId = `${kind}-${Date.now().toString(36)}-${++this.bindSeq}`;
    this.kindNow = kind;
    this.ids[kind] = id;
    this.profile = kind === 'hermes' ? (profile as string | undefined) : undefined;
    this.cwdNow = cwd;
    this.lastCompletedTurn = undefined;
    this.synced = { ...this.bound()!, fingerprint: 0 };
    const replayedTurns = this.syncBoundHistory();
    this.info(`bound to ${kind} session ${id} (cwd: ${cwd}); suggestions are picked with ${kind}'s default model`);
    return { bound: this.bound()!, sessionId: this.sessionId, replayedTurns };
  }

  /**
   * Restore completed turns of the bound session not yet observed. At bind this is the recent-
   * history replay; on later refreshes it continues from the last replay point.
   */
  private syncBoundHistory(): number {
    if (this.busy || this.drivingTurns > 0) return 0;
    const initialMax = this.opts.replayTurns ?? 3;
    if (initialMax <= 0) return 0;
    const ref = this.bound();
    if (!ref) {
      this.synced = undefined;
      return 0;
    }
    const s = this.synced;
    const sync = s && s.kind === ref.kind && s.id === ref.id && s.cwd === ref.cwd && s.profile === ref.profile
      ? s
      : (this.synced = { ...ref, fingerprint: 0 });
    try {
      const max = sync.fingerprint > 0 ? Number.MAX_SAFE_INTEGER : initialMax;
      const replay = ADAPTERS[ref.kind].readHistory(ref, this.env, max, () => `t${++this.turnSeq}`, sync.fingerprint);
      if (!replay) return 0;
      sync.fingerprint = replay.fingerprint;
      if (!replay.turns.length) return 0;                  // the store moved on without a user turn
      this.lastCompletedTurn = replay.turnIds.at(-1);
      this.observe(replay.turns.flat());
      this.info(`synchronized ${replay.turns.length} turn(s) from the bound session`);
      return replay.turns.length;
    } catch {
      return 0;
    }
  }

  private boundAdvanced(): boolean {
    const ref = this.bound();
    if (!ref || !this.synced) return false;
    try {
      return ADAPTERS[ref.kind].advanced(ref, this.env, this.synced.fingerprint);
    } catch {
      return false;
    }
  }

  /** After a host-driven turn, move the replay point past that turn so it is not replayed later. */
  private catchUpSynced(): void {
    const ref = this.bound();
    if (!ref) return;
    try {
      this.synced = { ...ref, fingerprint: ADAPTERS[ref.kind].fingerprint(ref, this.env) };
    } catch { /* the next refresh can still synchronize from the previous point */ }
  }

  /** Requests the sidecar makes of the host (SPEC 5.3, 6, 8). */
  private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.stopping) throw new RpcError(method === 'sampler/sample' ? SAMPLER_ABORTED : SESSION_BUSY, 'the host is stopping');
    if (method === 'binding/list') {
      // Surfaces call this on load and refresh; first catch up with external turns of the bound session.
      this.syncBoundHistory();
      return { current: this.bound(), sessions: discoverSessions({ hermesHome: this.opts.hermesHome }), sessionId: this.sessionId };
    }
    if (method === 'binding/bind') return this.bind(params);
    if (method !== 'sampler/sample' && method !== 'dispatch/message') throw new RpcError(-32601, `unsupported: ${method}`);
    if (this.busy) throw new RpcError(SESSION_BUSY, 'a turn is running');
    if (params.expectedTurnId !== this.lastCompletedTurn) throw new RpcError(TURN_MISMATCH, 'not the latest completed turn');

    if (method === 'sampler/sample') {
      // the session's own agent picks the suggestion: its content stays with that agent's provider
      if (params.mode !== 'compact') throw new RpcError(-32602, 'this host offers the compact sampler only');
      const controller = (this.sampling = new AbortController());
      try {
        const { cleanup, ...result } = await ADAPTERS[this.kindNow].sample(String(params.prompt), {
          env: this.env, ref: this.bound() ?? undefined, signal: controller.signal,
        });
        if (cleanup) this.cleanups.push(cleanup);
        return result;
      } catch (e) {
        if (controller.signal.aborted) throw new RpcError(SAMPLER_ABORTED, 'cancelled');
        throw e;
      } finally {
        if (this.sampling === controller) this.sampling = undefined;
      }
    }

    if (this.boundAdvanced()) {
      this.syncBoundHistory();
      throw new RpcError(TURN_MISMATCH, 'the bound session has advanced since the replay point');
    }
    const ref = this.bound();
    const elsewhere = ref ? ADAPTERS[ref.kind].busyElsewhere?.(ref, this.env) : undefined;
    if (elsewhere) {
      this.info(`not sent: ${elsewhere}`);
      throw new RpcError(SESSION_BUSY, elsewhere);
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
    this.syncBoundHistory();
    this.busy = true;
    return this.runTurn(text, false);
  }
  /** Resolves when no turn is running (a dispatched send starts one on its own). */
  async idle(): Promise<void> {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
  }

  private async runTurn(text: string, fromSurface: boolean): Promise<void> {
    this.drivingTurns++;
    const kind = this.kindNow;
    const turnId = `t${++this.turnSeq}`;
    let completed = false;
    try {
      this.info(`${fromSurface ? 'sent from the surface' : 'user'} › ${text}`);
      this.observe([{ type: 'turn.started', turnId, at: Date.now() }, { type: 'message.user', turnId, text }]);
      const emit = (events: AgentEvent[]) => {
        if (events.some((e) => e.type === 'turn.completed')) {
          if (completed) events = events.filter((e) => e.type !== 'turn.completed');
          completed = true;
          // be ready for the sampler and for a dispatch before the sidecar hears that the turn ended
          this.lastCompletedTurn = turnId;
          this.busy = false;
        }
        this.observe(events);
      };
      const { sessionId } = await ADAPTERS[kind].runTurn(text, {
        env: this.env, turnId, cwd: this.cwdNow, id: this.ids[kind], profile: kind === 'hermes' ? this.profile : undefined,
        emit, onLine: this.opts.onLine, info: (m) => this.info(m),
      });
      if (!completed) emit([{ type: 'turn.completed', turnId, status: 'failed', at: Date.now() }]);
      if (isSafeName(sessionId) && this.kindNow === kind) this.ids[kind] = sessionId;
      this.catchUpSynced();
    } catch (e) {
      this.info(`the ${kind} turn failed: ${(e as Error).message}`);
      if (!completed) {
        this.lastCompletedTurn = turnId;
        this.busy = false;
        this.observe([{ type: 'turn.completed', turnId, status: 'failed', at: Date.now() }]);
      }
    } finally {
      this.drivingTurns--;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;                                  // refuse new requests from here on
    clearInterval(this.syncTimer);
    this.sampling?.abort();
    await this.idle();
    await Promise.allSettled([...this.inflight]);          // e.g. a sample that was running: its reply goes out first
    await Promise.all(this.cleanups);
    this.sidecar?.stdin?.end();
    await new Promise<void>((resolve) => (this.sidecar && this.sidecar.exitCode === null ? this.sidecar.once('exit', () => resolve()) : resolve()));
    if (this.scratchDir) rmSync(this.scratchDir, { recursive: true, force: true });
  }
}
