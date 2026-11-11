// Starting agent CLIs without a shell. On Windows npm installs a CLI as a `.cmd` shim, which Node
// cannot spawn without a shell, and a shell would re-parse every argument (the text a user sends
// included). Such a shim is resolved to the script it wraps and run with this Node instead.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

/** An executable plus leading arguments, e.g. `node <script>`. */
export interface Command { command: string; prefix: string[] }
/** A CLI to run: a name looked up on PATH, a path, or an explicit command. */
export type Bin = string | Command;

const resolved = new Map<string, Command>();

export function resolveCommand(bin: Bin): Command {
  if (typeof bin !== 'string') return bin;
  let command = resolved.get(bin);
  if (!command) {
    command = { command: bin, prefix: [] };
    if (process.platform === 'win32') {
      const found = findOnPath(bin);
      if (found && /\.(cmd|bat)$/i.test(found)) command = fromShim(found);
      else if (found) command = { command: found, prefix: [] };
    }
    resolved.set(bin, command);
  }
  return command;
}

function findOnPath(bin: string): string | undefined {
  const exts = extname(bin) ? [''] : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = isAbsolute(bin) || /[\\/]/.test(bin) ? [''] : (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? join(dir, bin + ext) : bin + ext;
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** npm's shim ends with `"%_prog%" "%dp0%\node_modules\<pkg>\<entry>.js" %*`. */
export function fromShim(shim: string): Command {
  const match = /"%dp0%\\([^"%]+?\.(?:js|mjs|cjs))"/i.exec(readFileSync(shim, 'utf8'));
  if (!match) throw new Error(`cannot run ${shim} without a shell: it does not name a script`);
  const script = join(dirname(shim), match[1]!);
  if (!existsSync(script)) throw new Error(`${shim} names a missing script: ${script}`);
  return { command: process.execPath, prefix: [script] };
}

export interface ProcessOptions {
  cwd: string;
  /** Written to stdin, which is then closed. */
  input?: string;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

/** Run a CLI to completion; arguments reach it verbatim. Rejects only when it cannot be started. */
export function runProcess(bin: Bin, args: string[], opts: ProcessOptions): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    let command: Command;
    try {
      command = resolveCommand(bin);
    } catch (e) {
      reject(e);
      return;
    }
    const child = spawn(command.command, [...command.prefix, ...args], {
      cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, signal: opts.signal,
    });
    let stdout = '';
    let stderr = '';
    createInterface({ input: child.stdout }).on('line', (line) => {
      stdout += line + '\n';
      opts.onLine?.(line);
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.stdin.on('error', () => { /* the CLI may exit without reading its input */ });
    child.stdin.end(opts.input ?? '');
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** Each stdout line that parses as a JSON object. */
export function jsonLines(stdout: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  for (const line of stdout.split('\n')) {
    if (!line.trimStart().startsWith('{')) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') out.push(value);
    } catch { /* not a JSON line */ }
  }
  return out;
}

/** First non-empty line of a text, trimmed and capped (tool summaries). */
export function firstLine(text: unknown, max = 160): string | undefined {
  if (typeof text !== 'string') return undefined;
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, max);
}
