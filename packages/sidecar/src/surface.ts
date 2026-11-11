// The bundled surface transport (SPEC 7.3, 8): plain HTTP on loopback.
//   GET  /         the suggestion page; GET /sessions the session picker (assets are inline)
//   GET  /events  Server-Sent Events: one JSON-RPC notification per message
//   POST /rpc     one JSON-RPC request or notification; the reply is the JSON-RPC response
// Every request needs the per-launch token and a loopback Host/Origin.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INVALID_PARAMS, RpcError, UNAUTHORIZED } from '../../core/src/index.ts';
import type { ActParams, Core, InvalidatedParams, UpdatedParams } from '../../core/src/index.ts';

const PAGE = readFileSync(new URL('./webui.html', import.meta.url));
const SESSIONS_PAGE = readFileSync(new URL('./sessions.html', import.meta.url));
const MAX_BODY = 64 * 1024;

export interface SurfaceServer { url: string; token: string; port: number; close(): Promise<void> }

/** A session's retained evaluations as an attaching surface may see them (SPEC 8). */
export function recentForSurface(core: Core, sessionId: string, inspector: boolean): UpdatedParams[] {
  const recent = core.recent(sessionId);
  if (!inspector) {
    return recent
      .filter((p) => p.result.type === 'completed' && p.result.prediction !== null)
      .map((p) => ({ sessionId: p.sessionId, sourceTurnId: p.sourceTurnId, result: p.result, at: p.at }));
  }
  return recent.map((p) => {
    const { signals: _signals, prompt: _prompt, ...trace } = p.trace ?? {};
    return { ...p, trace };
  });
}

/** Forwards a `binding/*` call to the host, which alone knows its sessions (SPEC 8). Absent: no picker. */
export type BindingCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

export async function startSurface(core: Core, options: { port?: number; binding?: BindingCall } = {}): Promise<SurfaceServer> {
  const token = randomBytes(24).toString('base64url');
  const streams = new Set<{ res: ServerResponse; inspector: boolean }>();
  let port = 0;

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const given = Buffer.from(header ?? url.searchParams.get('t') ?? '');
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  // DNS rebinding and cross-site requests: only our own loopback origin may talk to us.
  const local = (req: IncomingMessage): boolean => {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const origin = req.headers.origin;
    return hosts.includes(req.headers.host ?? '') && (origin === undefined || hosts.some((h) => origin === `http://${h}`));
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(text);
  };

  const push = (method: string, params: UpdatedParams | InvalidatedParams, inspectorOnly: boolean) => {
    for (const s of streams) {
      if (inspectorOnly && !s.inspector) continue;
      s.res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method, params })}\n\n`);
    }
  };
  core.on('updated', (p) => {
    // never forward unredacted diagnostics; plain surfaces only see delivered predictions (SPEC 8)
    const { signals: _signals, prompt: _prompt, ...trace } = p.trace ?? {};
    const delivered = p.result.type === 'completed' && p.result.prediction !== null;
    if (delivered) {
      for (const s of streams) {
        const params = s.inspector ? { ...p, trace } : { sessionId: p.sessionId, sourceTurnId: p.sourceTurnId, result: p.result };
        s.res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'prediction/updated', params })}\n\n`);
      }
    } else {
      push('prediction/updated', { ...p, trace }, true);
    }
  });
  core.on('invalidated', (p) => push('prediction/invalidated', p, false));
  const pushAll = (method: string, params: unknown) => {
    for (const s of streams) s.res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method, params })}\n\n`);
  };

  async function rpc(body: string): Promise<[number, unknown]> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(body);
    } catch {
      return [400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }];
    }
    const id = (msg.id ?? null) as string | number | null;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    try {
      let result: unknown;
      switch (msg.method) {
        case 'surface/attach': {
          const sessions = [...core.snapshot()];
          const out: Record<string, unknown> = { sessions, dispatchModes: core.dispatchModes, binding: options.binding !== undefined };
          if (options.binding) {
            try {
              const list = (await options.binding('binding/list', {})) as { current?: unknown; sessionId?: unknown };
              out.bound = list.current ?? null;
              if (typeof list.sessionId === 'string') {
                out.activeSessionId = list.sessionId;
                // a just-bound host session has no turn yet, so the core snapshot lacks it
                if (!sessions.some((s) => s.sessionId === list.sessionId)) sessions.push({ sessionId: list.sessionId });
              }
            } catch { /* the bound display is best effort */ }
          }
          out.sessions = sessions.map((s) => ({ ...s, recent: recentForSurface(core, s.sessionId, params.inspector === true) }));
          result = out;
          break;
        }
        case 'binding/list':
          if (!options.binding) throw new RpcError(-32601, 'this host does not support binding');
          result = await options.binding('binding/list', {});
          break;
        case 'binding/bind': {
          if (!options.binding) throw new RpcError(-32601, 'this host does not support binding');
          if (typeof params.kind !== 'string' || typeof params.id !== 'string' || typeof params.cwd !== 'string') {
            throw new RpcError(INVALID_PARAMS, 'binding/bind needs kind, id and cwd');
          }
          const bindParams: Record<string, unknown> = { kind: params.kind, id: params.id, cwd: params.cwd };
          if (params.profile !== undefined) {
            if (typeof params.profile !== 'string') throw new RpcError(INVALID_PARAMS, 'profile must be a string');
            bindParams.profile = params.profile;
          }
          result = await options.binding('binding/bind', bindParams);
          const bound = (result as { bound?: unknown; sessionId?: unknown }) ?? {};
          pushAll('binding/changed', { bound: bound.bound ?? null, sessionId: bound.sessionId });
          break;
        }
        case 'prediction/act':
          if (typeof params.predictionId !== 'string' || !['send', 'copy', 'dismiss'].includes(params.action as string)) {
            throw new RpcError(INVALID_PARAMS, 'prediction/act needs predictionId and action');
          }
          result = { status: await core.act(params as unknown as ActParams) };
          break;
        case 'prediction/cancel':
          if (typeof params.sessionId !== 'string') throw new RpcError(INVALID_PARAMS, 'sessionId is required');
          core.cancel(params.sessionId);
          result = {};
          break;
        default:
          throw new RpcError(-32601, `unknown method ${String(msg.method)}`);
      }
      return [200, { jsonrpc: '2.0', id, result }];
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32603;
      return [200, { jsonrpc: '2.0', id, error: { code, message: (e as Error).message } }];
    }
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!local(req)) return send(res, 403, { error: 'forbidden origin' });
    if (!authorized(req, url)) {
      return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: UNAUTHORIZED, message: 'missing or wrong token' } });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/sessions')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
        'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
      }).end(url.pathname === '/sessions' ? SESSIONS_PAGE : PAGE);
    } else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const stream = { res, inspector: url.searchParams.get('inspector') === '1' };
      streams.add(stream);
      const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(beat);
        streams.delete(stream);
      });
    } else if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', () => void rpc(Buffer.concat(chunks).toString('utf8')).then(([status, body]) => send(res, status, body)));
    } else {
      send(res, 404, { error: 'not found' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);          // loopback only
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`, token, port,
    close: () => new Promise((resolve) => {
      for (const s of streams) s.res.end();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
