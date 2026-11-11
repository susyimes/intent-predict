// Grok CLI as an intent-predict host: it reports each turn's events to a sidecar, lends Grok's model
// as the `compact` sampler, and accepts user-approved sends as the next prompt of the same session.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVALID_PARAMS, RpcError, SAMPLER_ABORTED, SESSION_BUSY, TURN_MISMATCH } from '../../core/src/index.ts';
import type { AgentEvent } from '../../core/src/index.ts';
import { RpcPeer } from '../../sidecar/src/rpc.ts';
import { TurnMapper, deleteGrokSession, grokAdvanced, grokFingerprint, readGrokHistory, runGrok, sampleWithGrok } from './grok.ts';
import { hermesAdvanced, hermesFingerprint, hermesTurnArgs, hermesTurnEvents, readHermesHistory, runHermes } from './hermes.ts';
import { discoverSessions, hermesHomePath, isSafeName, safeName } from './sessions.ts';
import type { GrokLine } from './grok.ts';

const SIDECAR = fileURLToPath(new URL('../../sidecar/src/main.ts', import.meta.url));

export interface GateSettings {
  eagerness: 'conservative' | 'eager';
  minConfidence?: number;
  sideEffectMinConfidence?: number;
  altMinConfidence?: number;
  cooldownTurnsAfterDismiss?: number;
}

export interface GrokHostOptions {
  cwd: string;
  /** Extra arguments for every agent turn, e.g. permission rules: ['--allow', 'search_replace']. */
  grokArgs?: string[];
  model?: string;
  /** Bind to an existing Grok session: every turn runs with `--resume <id>` from the first one on. */
  resume?: string;
  /** Telemetry JSONL written by the sidecar. */
  logPath?: string;
  /** The sampler is a process spawn: allow far more than the core's 4 s default. */
  timeoutMs?: number;
  packs?: string[];
  surfacePort?: number;
  bin?: string;
  hermesBin?: string;
  /** Prediction gate preset: conservative (default) or eager (lower floors and prompt). */
  eagerness?: GateSettings['eagerness'];
  minConfidence?: number;
  sideEffectMinConfidence?: number;
  altMinConfidence?: number;
  cooldownTurnsAfterDismiss?: number;
  /** Completed turns restored from the bound session's store initially (default 3; 0 disables history sync). */
  replayTurns?: number;
  hermesHome?: string;
  onLine?: (line: GrokLine) => void;
  onInfo?: (message: string) => void;
}

export interface BoundRef { kind: 'grok' | 'hermes'; id: string; cwd: string; profile?: string }

export class GrokHost {
  sessionId = `grok-${Date.now().toString(36)}`;
  surfaceUrl: string | undefined;
  loadedPacks: Array<{ id: string; version: string; scenarioCount: number }> = [];
  readonly gateSettings: GateSettings;
  grokSessionId: string | undefined;
  hermesSessionId: string | undefined;
  lastCompletedTurn: string | undefined;
  busy = false;
  private readonly opts: GrokHostOptions;
  private scratchDir: string | undefined;
  private sidecar: ChildProcess | undefined;
  private peer: RpcPeer | undefined;
  private sampling: AbortController | undefined;
  private readonly dispatched = new Set<string>();
  private readonly cleanups: Promise<void>[] = [];
  private turnSeq = 0;
  private fileSeq = 0;
  private bindSeq = 0;
  private cwdNow: string;
  private kindNow: 'grok' | 'hermes' = 'grok';
  private hermesProfile: string | undefined;
  private synced?: {
    kind: 'grok' | 'hermes'; id: string; cwd: string; profile?: string;
    fingerprint: number; grokFile?: string; hermesDbFile?: string;
  };
  private drivingTurns = 0;

  constructor(opts: GrokHostOptions) {
    const eagerness = opts.eagerness ?? 'conservative';
    if (eagerness !== 'conservative' && eagerness !== 'eager') {
      throw new Error('eagerness must be conservative or eager');
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
    this.grokSessionId = opts.resume === undefined ? undefined : safeName(opts.resume, 'resume');
    this.cwdNow = opts.cwd;
  }
  private info(message: string) { this.opts.onInfo?.(message); }
  /** Prompt files and the sampler's working directory; created on first use, removed by stop(). */
  private get scratch(): string {
    return (this.scratchDir ??= mkdtempSync(join(tmpdir(), 'intent-predict-')));
  }

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
      capabilities: { interactive: true, samplerModes: ['compact'], dispatchModes: ['message'], binding: true },
      packs: this.opts.packs ?? [this.gateSettings.eagerness === 'eager' ? 'builtin/coding-eager' : 'builtin/coding'],
      policy: {
        minConfidence: this.gateSettings.minConfidence,
        sideEffectMinConfidence: this.gateSettings.sideEffectMinConfidence,
      },
      options: {
        timeoutMs: this.opts.timeoutMs ?? 60_000,
        altMinConfidence: this.gateSettings.altMinConfidence,
        cooldownTurnsAfterDismiss: this.gateSettings.cooldownTurnsAfterDismiss,
      },
    })) as { surfaceUrl?: string; loadedPacks?: GrokHost['loadedPacks'] };
    this.surfaceUrl = init.surfaceUrl;
    this.loadedPacks = init.loadedPacks ?? [];
  }

  private observe(events: AgentEvent[]): void {
    if (events.length) this.peer!.notify('session/observe', { sessionId: this.sessionId, events });
  }
  private promptFile(text: string): string {
    const file = join(this.scratch, `prompt-${++this.fileSeq}.txt`);
    writeFileSync(file, text, 'utf8');
    return file;
  }

  private bound(): BoundRef | null {
    if (this.kindNow === 'hermes') {
      if (!this.hermesSessionId) return null;
      const ref: BoundRef = { kind: 'hermes', id: this.hermesSessionId, cwd: this.cwdNow };
      if (this.hermesProfile) ref.profile = this.hermesProfile;
      return ref;
    }
    return this.grokSessionId ? { kind: 'grok', id: this.grokSessionId, cwd: this.cwdNow } : null;
  }

  /** Hot-switch the driven session (SPEC 8) and restore its recent completed turns. */
  private bind(params: Record<string, unknown>): { bound: BoundRef; sessionId: string; replayedTurns: number } {
    const { kind, id, cwd, profile } = params;
    if (kind !== 'grok' && kind !== 'hermes') throw new RpcError(INVALID_PARAMS, 'this host can only bind grok or hermes sessions');
    // ids and profiles reach `grok --resume` / `hermes -p` and store paths: plain names only
    const plain = "a plain name (letters, digits, '.', '_' or '-', starting with a letter or digit)";
    if (!isSafeName(id)) throw new RpcError(INVALID_PARAMS, `the session id must be ${plain}`);
    if (profile !== undefined && !isSafeName(profile)) throw new RpcError(INVALID_PARAMS, `the profile must be ${plain}`);
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw new RpcError(INVALID_PARAMS, 'binding/bind needs an absolute cwd');
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch { /* falls through to the error below */ }
    if (!isDir) throw new RpcError(INVALID_PARAMS, `cwd is not a directory: ${cwd}`);
    if (this.busy) throw new RpcError(SESSION_BUSY, 'a turn is running');
    this.sampling?.abort();
    this.peer?.notify('prediction/cancel', { sessionId: this.sessionId });
    this.sessionId = `${kind}-${Date.now().toString(36)}-${++this.bindSeq}`;
    this.kindNow = kind;
    if (kind === 'grok') {
      this.grokSessionId = id;
    } else {
      this.hermesSessionId = id;
      this.hermesProfile = profile;
    }
    this.cwdNow = cwd;
    this.lastCompletedTurn = undefined;
    this.synced = { kind, id, cwd, profile: kind === 'hermes' ? profile : undefined, fingerprint: 0 };
    const replayedTurns = this.syncBoundHistory();
    this.info(`bound to ${kind} session ${id} (cwd: ${cwd})`);
    if (kind === 'hermes') {
      this.info("evaluation uses Grok's model: excerpts of this Hermes session's recent turns (redacted) are sent to Grok");
    }
    return { bound: this.bound()!, sessionId: this.sessionId, replayedTurns };
  }

  private grokHistoryFile(cwd: string, id: string): string {
    return join(homedir(), '.grok', 'sessions', encodeURIComponent(cwd), safeName(id, 'session id'), 'updates.jsonl');
  }

  private hermesDbCandidates(profile?: string): string[] {
    const root = hermesHomePath(homedir(), this.opts.hermesHome);
    return profile
      ? [join(root, 'profiles', safeName(profile, 'profile'), 'state.db'), join(root, 'state.db')]
      : [join(root, 'state.db')];
  }

  private ensureSynced(): typeof this.synced {
    const current = this.bound();
    if (!current) {
      this.synced = undefined;
      return undefined;
    }
    if (!this.synced || this.synced.kind !== current.kind || this.synced.id !== current.id
      || this.synced.cwd !== current.cwd || this.synced.profile !== current.profile) {
      this.synced = { ...current, fingerprint: 0 };
    }
    return this.synced;
  }

  /**
   * Restore completed turns not yet observed from the bound session's store. At bind this is the
   * recent-history replay; on later refreshes it increments from the last replay point.
   */
  private syncBoundHistory(): number {
    if (this.busy || this.drivingTurns > 0) return 0;
    const initialMax = this.opts.replayTurns ?? 3;
    if (initialMax <= 0) return 0;
    const sync = this.ensureSynced();
    if (!sync) return 0;
    const makeTurnId = () => `t${++this.turnSeq}`;
    const max = sync.fingerprint > 0 ? Number.MAX_SAFE_INTEGER : initialMax;
    try {
      if (sync.kind === 'grok') {
        const file = sync.grokFile ?? this.grokHistoryFile(sync.cwd, sync.id);
        const replay = readGrokHistory(file, sync.id, sync.cwd, max, makeTurnId, sync.fingerprint);
        if (!replay) return 0;
        sync.grokFile = file;
        sync.fingerprint = replay.fingerprint;
        this.lastCompletedTurn = replay.turnIds[replay.turnIds.length - 1];
        this.observe(replay.turns.flat());
        this.info(`synchronized ${replay.turns.length} turn(s) from bound session`);
        return replay.turns.length;
      }
      const candidates = sync.hermesDbFile ? [sync.hermesDbFile] : this.hermesDbCandidates(sync.profile);
      for (const dbFile of candidates) {
        const replay = readHermesHistory(dbFile, sync.id, sync.cwd, max, makeTurnId, sync.fingerprint);
        if (!replay) continue;
        sync.hermesDbFile = dbFile;
        sync.fingerprint = replay.fingerprint;
        this.lastCompletedTurn = replay.turnIds[replay.turnIds.length - 1];
        this.observe(replay.turns.flat());
        this.info(`synchronized ${replay.turns.length} turn(s) from bound session`);
        return replay.turns.length;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private boundAdvanced(): boolean {
    const sync = this.synced;
    if (!sync) return false;
    if (sync.kind === 'grok') {
      return grokAdvanced(sync.grokFile ?? this.grokHistoryFile(sync.cwd, sync.id), sync.fingerprint);
    }
    return sync.hermesDbFile ? hermesAdvanced(sync.hermesDbFile, sync.id, sync.fingerprint) : false;
  }

  /** After a host-driven turn, move the replay point past that turn so it is not replayed later. */
  private catchUpSynced(): void {
    const current = this.bound();
    if (!current) return;
    try {
      if (current.kind === 'grok') {
        const file = this.grokHistoryFile(current.cwd, current.id);
        this.synced = { ...current, fingerprint: grokFingerprint(file), grokFile: file };
        return;
      }
      for (const dbFile of this.hermesDbCandidates(current.profile)) {
        const fingerprint = hermesFingerprint(dbFile, current.id);
        if (fingerprint > 0) {
          this.synced = { ...current, fingerprint, hermesDbFile: dbFile };
          return;
        }
      }
      if (!this.synced || this.synced.kind !== current.kind || this.synced.id !== current.id) {
        this.synced = { ...current, fingerprint: 0 };
      }
    } catch { /* the next refresh can still synchronize from the previous point */ }
  }

  /** Requests the sidecar makes of the host (SPEC 5.3, 6, 8). */
  private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
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
      // The compact sampler always rides Grok's model connection, whichever kind is bound:
      // the classification prompt is self-contained and Grok's sampler leaves nothing behind.
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

    if (this.boundAdvanced()) {
      this.syncBoundHistory();
      throw new RpcError(TURN_MISMATCH, 'the bound session has advanced since the replay point');
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

  private runTurn(text: string, fromSurface: boolean): Promise<void> {
    this.drivingTurns++;
    const run = this.kindNow === 'hermes' ? this.runHermesTurn(text, fromSurface) : this.runGrokTurn(text, fromSurface);
    return run.finally(() => { this.drivingTurns--; });
  }

  private async runHermesTurn(text: string, fromSurface: boolean): Promise<void> {
    const turnId = `t${++this.turnSeq}`;
    this.info(`${fromSurface ? 'sent from the surface' : 'user'} › ${text}`);
    this.observe([{ type: 'turn.started', turnId, at: Date.now() }, { type: 'message.user', turnId, text }]);
    const forward = (events: AgentEvent[]) => {
      if (events.some((e) => e.type === 'turn.completed')) {
        this.lastCompletedTurn = turnId;
        this.busy = false;
      }
      this.observe(events);
    };
    try {
      const args = hermesTurnArgs(text, { sessionId: this.hermesSessionId, profile: this.hermesProfile });
      const { code, stdout, stderr } = await runHermes(args, { cwd: this.cwdNow, bin: this.opts.hermesBin });
      if (stdout.trim()) this.opts.onLine?.({ type: 'text', data: stdout });
      if (code !== 0 || stderr.trim()) this.info(`hermes exited with ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n')[0] : ''}`);
      forward(hermesTurnEvents(turnId, { code, stdout }));
    } catch (e) {
      this.info(`could not run hermes: ${(e as Error).message}`);
      forward(hermesTurnEvents(turnId, { code: 1, stdout: '' }));
    }
    this.catchUpSynced();
  }

  private runGrokTurn(text: string, fromSurface: boolean): Promise<void> {
    const run = (async () => {
      const turnId = `t${++this.turnSeq}`;
      this.info(`${fromSurface ? 'sent from the surface' : 'user'} › ${text}`);
      this.observe([{ type: 'turn.started', turnId, at: Date.now() }, { type: 'message.user', turnId, text }]);
      const mapper = new TurnMapper(turnId, this.cwdNow);
      const forward = (events: AgentEvent[]) => {
        if (events.some((e) => e.type === 'turn.completed')) {
          // be ready for the sampler and for a dispatch before the sidecar hears that the turn ended
          this.lastCompletedTurn = turnId;
          this.busy = false;
        }
        this.observe(events);
      };
      try {
        const args = ['--prompt-file', this.promptFile(text), '--output-format', 'streaming-json', '--no-subagents'];
        // never let a session id reach grok as an option: the turn fails instead
        if (this.grokSessionId) args.push('--resume', safeName(this.grokSessionId, 'session id'));
        if (this.opts.model) args.push('--model', this.opts.model);
        args.push(...(this.opts.grokArgs ?? []));
        const { code, stderr } = await runGrok(args, {
          cwd: this.cwdNow, bin: this.opts.bin,
          onLine: (line) => {
            this.opts.onLine?.(line);
            forward(mapper.push(line));
          },
        });
        if (isSafeName(mapper.sessionId)) this.grokSessionId = mapper.sessionId;
        if (code !== 0 || stderr.trim()) this.info(`grok exited with ${code}${stderr.trim() ? ': ' + stderr.trim().split('\n')[0] : ''}`);
      } catch (e) {
        this.info(`could not run grok: ${(e as Error).message}`);
      } finally {
        forward(mapper.finish());
      }
      this.catchUpSynced();
    })();
    return run;
  }

  async stop(): Promise<void> {
    this.sampling?.abort();
    await this.idle();
    await Promise.all(this.cleanups);
    this.sidecar?.stdin?.end();
    await new Promise<void>((resolve) => (this.sidecar && this.sidecar.exitCode === null ? this.sidecar.once('exit', () => resolve()) : resolve()));
    if (this.scratchDir) rmSync(this.scratchDir, { recursive: true, force: true });
  }
}
