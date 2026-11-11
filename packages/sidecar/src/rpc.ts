// A JSON-RPC 2.0 peer over newline-delimited JSON (SPEC 8). Used by the sidecar and by hosts.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { RpcError } from '../../core/src/index.ts';

export interface RpcHandlers {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): void;
}

interface Pending { resolve(value: unknown): void; reject(error: Error): void }

export class RpcPeer {
  private readonly pending = new Map<string | number, Pending>();
  private readonly output: Writable;
  private readonly handlers: RpcHandlers;
  private readonly idPrefix: string;
  private readonly onError: (message: string) => void;
  private seq = 0;
  /** Resolves when the input stream ends. */
  readonly closed: Promise<void>;

  constructor(input: Readable, output: Writable, handlers: RpcHandlers, idPrefix: string, onError: (m: string) => void = () => {}) {
    this.output = output;
    this.handlers = handlers;
    this.idPrefix = idPrefix;
    this.onError = onError;
    // the other side may be gone (EPIPE): report it instead of crashing the process
    output.on('error', (e) => this.onError(`write failed: ${e.message}`));
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (line.trim()) this.receive(line);
    });
    this.closed = new Promise((done) => lines.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('connection closed'));
      this.pending.clear();
      done();
    }));
  }

  private write(message: Record<string, unknown>): void {
    // e.g. the reply to a request that was still running when this side closed the connection
    if (this.output.writableEnded || this.output.destroyed) return;
    this.output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  /** Send a request; the id is returned at once so the caller can refer to it (e.g. sampler/cancel). */
  call(method: string, params: unknown): { id: string; result: Promise<unknown> } {
    const id = `${this.idPrefix}${++this.seq}`;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return { id, result };
  }
  request(method: string, params: unknown): Promise<unknown> {
    return this.call(method, params).result;
  }
  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private receive(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
      if (msg === null || typeof msg !== 'object' || msg.jsonrpc !== '2.0') throw new Error('not a JSON-RPC 2.0 message');
    } catch (e) {
      this.onError(`dropped a malformed line: ${(e as Error).message}`);
      return this.write({ id: null, error: { code: -32700, message: 'parse error' } });
    }
    const id = msg.id as string | number | undefined | null;
    if (typeof msg.method === 'string') {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      if (id === undefined || id === null) {
        try {
          this.handlers.notify(msg.method, params);
        } catch (e) {
          this.onError(`notification ${msg.method} failed: ${(e as Error).message}`);
        }
        return;
      }
      this.handlers.request(msg.method, params).then(
        (result) => this.write({ id, result: result ?? {} }),
        (e) => {
          const code = e instanceof RpcError ? e.code : -32603;
          this.write({ id, error: { code, message: (e as Error).message || 'internal error' } });
        },
      );
      return;
    }
    const waiter = id === undefined || id === null ? undefined : this.pending.get(id);
    if (!waiter) return;                                   // late or unknown reply: discard (SPEC 4.1)
    this.pending.delete(id!);
    if (msg.error && typeof msg.error === 'object') {
      const err = msg.error as { code?: number; message?: string };
      waiter.reject(new RpcError(typeof err.code === 'number' ? err.code : -32603, err.message ?? 'error'));
    } else {
      waiter.resolve(msg.result);
    }
  }
}
