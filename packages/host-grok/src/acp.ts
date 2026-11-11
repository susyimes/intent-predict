// A minimal Agent Client Protocol client over stdio (newline-delimited JSON-RPC 2.0), enough to
// resume or create a session, prompt it, and answer what the agent asks of the client.
// The client advertises no file system or terminal capability, and it never approves on the
// user's behalf: every permission request is rejected for this call only.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCommand } from './proc.ts';
import type { Bin } from './proc.ts';

export interface AcpUpdate { sessionUpdate: string; [key: string]: any }
export interface PermissionOption { optionId: string; kind: string; name?: string }
export interface PermissionRequest { sessionId: string; toolCall?: Record<string, any>; options: PermissionOption[] }

interface Pending { resolve(value: any): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }

export class AcpError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** The option a client picks to refuse: never an "always" option, which would change the agent's settings. */
export function rejectOnce(options: PermissionOption[]): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  const reject = options.find((o) => o.kind === 'reject_once');
  return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
}

export class AcpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, (update: AcpUpdate) => void>();
  private seq = 0;
  private stderr = '';
  private exited = false;
  /** Called for each permission request before it is rejected (for logging). */
  onPermission: (request: PermissionRequest) => void = () => {};

  constructor(bin: Bin, args: string[], cwd: string) {
    const command = resolveCommand(bin);
    this.child = spawn(command.command, [...command.prefix, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr!.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-4000); });
    this.child.stdin!.on('error', () => {});
    this.child.once('error', (e) => {
      this.exited = true;                                  // a CLI that cannot start never emits 'exit'
      this.fail(new AcpError(`could not start the agent: ${e.message}`));
    });
    this.child.once('exit', (code) => {
      this.exited = true;
      this.fail(new AcpError(`the agent exited (${code})${this.stderr.trim() ? ': ' + this.stderr.trim().split('\n').at(-1) : ''}`));
    });
    createInterface({ input: this.child.stdout! }).on('line', (line) => this.receive(line));
  }

  private fail(error: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }

  private write(message: Record<string, unknown>): void {
    if (!this.exited) this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  private receive(line: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;                                              // agents may log to stdout; not protocol
    }
    if (typeof msg.method === 'string') {
      const params = msg.params ?? {};
      if (msg.method === 'session/update') {
        if (params.update) this.listeners.get(params.sessionId)?.(params.update);
        return;
      }
      if (msg.id === undefined || msg.id === null) return;  // other notifications
      if (msg.method === 'session/request_permission') {
        try {
          this.onPermission(params);
        } catch { /* logging only */ }
        this.write({ id: msg.id, result: { outcome: rejectOnce(Array.isArray(params.options) ? params.options : []) } });
        return;
      }
      this.write({ id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } });
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.error) waiter.reject(new AcpError(String(msg.error.message ?? 'error'), msg.error.code));
    else waiter.resolve(msg.result ?? null);
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    if (this.exited) return Promise.reject(new AcpError('the agent is not running'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new AcpError(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  initialize(): Promise<any> {
    return this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'intent-predict', version: '0.5.0' },
    }, 60_000);
  }

  onUpdate(sessionId: string, listener: (update: AcpUpdate) => void): void {
    this.listeners.set(sessionId, listener);
  }

  async close(): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.stdin!.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    await done;
    clearTimeout(timer);
  }

  kill(): void {
    if (!this.exited) this.child.kill();
  }
}
