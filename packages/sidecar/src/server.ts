// The sidecar: a core behind JSON-RPC over stdio, plus the bundled surface (SPEC 8).
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Core, INVALID_PARAMS, RpcError, loadPackFile, packErrors } from '../../core/src/index.ts';
import type {
  ActParams, CoreConfig, DispatchMode, HostBridge, SampleResult, SamplerMode, ScenarioPack,
} from '../../core/src/index.ts';
import { RpcPeer } from './rpc.ts';
import { startSurface } from './surface.ts';
import type { SurfaceServer } from './surface.ts';

export const PROTOCOL_VERSION = '0.5';
const BUILTIN: Record<string, string> = {
  'builtin/coding': fileURLToPath(new URL('../../pack-coding/pack.json', import.meta.url)),
};
const OPTION_KEYS = [
  'enabled', 'blockedModes', 'settleMs', 'timeoutMs', 'samplerMode', 'modelBudget', 'maxPerSession',
  'cooldownTurnsAfterDismiss', 'altMinConfidence', 'redact',
] as const;

export interface SidecarOptions {
  input: Readable; output: Writable;
  /** Append telemetry records (spec/feedback.schema.json) to this JSONL file. */
  logPath?: string;
  surfacePort?: number;
  log?: (message: string) => void;
}

export interface Sidecar { closed: Promise<void>; close(): Promise<void> }

export function startSidecar(opts: SidecarOptions): Sidecar {
  const log = opts.log ?? (() => {});
  let core: Core | undefined;
  let surface: SurfaceServer | undefined;

  const initialized = (): Core => {
    if (!core) throw new RpcError(-32600, 'initialize first');
    return core;
  };

  function loadPacks(specs: unknown): ScenarioPack[] {
    const list = Array.isArray(specs) && specs.length ? specs : ['builtin/coding'];
    return list.map((spec) => {
      if (typeof spec === 'string') {
        // a path is the explicit opt-in SPEC 3.2 asks for; nothing is discovered on its own
        return loadPackFile(BUILTIN[spec] ?? (isAbsolute(spec) ? spec : resolvePath(process.cwd(), spec)));
      }
      const errors = packErrors(spec);
      if (errors.length) throw new RpcError(INVALID_PARAMS, `invalid inline pack: ${errors.slice(0, 3).join('; ')}`);
      return spec as ScenarioPack;
    });
  }

  async function initialize(params: Record<string, unknown>) {
    if (core) throw new RpcError(-32600, 'already initialized');
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      throw new RpcError(INVALID_PARAMS, `unsupported protocolVersion; this sidecar speaks ${PROTOCOL_VERSION}`);
    }
    const caps = (params.capabilities ?? {}) as Record<string, unknown>;
    const options = (params.options ?? {}) as Record<string, unknown>;
    let packs: ScenarioPack[];
    try {
      packs = loadPacks(params.packs);
    } catch (e) {
      throw e instanceof RpcError ? e : new RpcError(INVALID_PARAMS, (e as Error).message);
    }

    const host: HostBridge = {
      interactive: caps.interactive !== false,
      samplerModes: (Array.isArray(caps.samplerModes) ? caps.samplerModes : []) as SamplerMode[],
      dispatchModes: (Array.isArray(caps.dispatchModes) ? caps.dispatchModes : []) as DispatchMode[],
      sample(request, signal) {
        const { id, result } = peer.call('sampler/sample', request);
        signal.addEventListener('abort', () => peer.notify('sampler/cancel', { sampleRequestId: id, sessionId: request.sessionId }), { once: true });
        return result as Promise<SampleResult>;
      },
      async dispatch({ method, ...rest }) {
        await peer.request(method, rest);
      },
    };
    const config: CoreConfig = {
      policy: params.policy as CoreConfig['policy'],
      options: Object.fromEntries(OPTION_KEYS.filter((k) => k in options).map((k) => [k, options[k]])),
    };
    if (opts.logPath) {
      const path = opts.logPath;
      mkdirSync(dirname(path), { recursive: true });
      config.telemetry = (record) => appendFileSync(path, JSON.stringify(record) + '\n');
    }
    core = new Core(packs, host, config);

    if (caps.surface === true) {
      // the host renders suggestions itself: it gets what a plain surface gets, on its own connection
      core.on('updated', (p) => {
        if (p.result.type === 'completed' && p.result.prediction) {
          peer.notify('prediction/updated', { sessionId: p.sessionId, sourceTurnId: p.sourceTurnId, result: p.result });
        }
      });
      core.on('invalidated', (p) => peer.notify('prediction/invalidated', p));
    }
    const result: Record<string, unknown> = {
      protocolVersion: PROTOCOL_VERSION,
      server: { name: 'intent-predict-sidecar', version: '0.5.0' },
      loadedPacks: packs.map((p) => ({ id: p.id, version: p.version, scenarioCount: p.scenarios.length })),
    };
    if (options.serveSurface !== false) {
      surface = await startSurface(core, { port: opts.surfacePort });
      result.surfaceUrl = surface.url;
      log(`surface: ${surface.url}`);
    }
    return result;
  }

  const peer = new RpcPeer(opts.input, opts.output, {
    async request(method, params) {
      switch (method) {
        case 'initialize': return initialize(params);
        case 'surface/attach': return { sessions: initialized().snapshot(), dispatchModes: initialized().dispatchModes };
        case 'prediction/act': return { status: await initialized().act(params as unknown as ActParams) };
        default: throw new RpcError(-32601, `unknown method ${method}`);
      }
    },
    notify(method, params) {
      if (method === 'session/observe') {
        if (typeof params.sessionId === 'string' && Array.isArray(params.events)) initialized().observe(params.sessionId, params.events);
      } else if (method === 'prediction/cancel') {
        if (typeof params.sessionId === 'string') initialized().cancel(params.sessionId);
      }
    },
  }, 's-', log);

  const close = async () => {
    core?.close();                                         // open outcomes are written as expired
    await surface?.close();
  };
  return { closed: peer.closed.then(close), close };
}
