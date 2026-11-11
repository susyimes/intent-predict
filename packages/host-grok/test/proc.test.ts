// Starting agent CLIs without a shell: npm shims resolve to their scripts; arguments stay verbatim.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fromShim, resolveCommand, runProcess } from '../src/proc.ts';

/** An npm-style Windows shim and the script it wraps. */
function shim(dir: string, name: string) {
  const script = join(dir, 'node_modules', '@fake', name, 'bin', `${name}.js`);
  mkdirSync(join(script, '..'), { recursive: true });
  writeFileSync(script, `
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n'));
`);
  const cmd = join(dir, `${name}.cmd`);
  writeFileSync(cmd, [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@fake\\${name}\\bin\\${name}.js" %*`,
  ].join('\r\n'));
  return { script, cmd };
}

test('an npm .cmd shim runs its script with this node, never through a shell', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-proc-'));
  try {
    const { script, cmd } = shim(dir, 'fakeagent');
    assert.deepEqual(fromShim(cmd), { command: process.execPath, prefix: [script] });
    writeFileSync(join(dir, 'odd.cmd'), '@echo off\r\necho hi\r\n');
    assert.throws(() => fromShim(join(dir, 'odd.cmd')), /does not name a script/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('arguments and stdin reach the CLI verbatim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-proc-'));
  try {
    const { script } = shim(dir, 'echoagent');
    const args = ['--flag', 'a "quoted" $HOME `tick` & echo pwned | x', '%PATH%', '中文'];
    const { code, stdout } = await runProcess({ command: process.execPath, prefix: [script] }, args, { cwd: dir, input: 'message 正文\nline 2' });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { argv: args, input: 'message 正文\nline 2' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('on Windows a CLI found on PATH as an npm shim resolves to its script', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-proc-'));
  const saved = process.env.PATH;
  try {
    const name = `ipshim${Date.now().toString(36)}`;
    const { script } = shim(dir, name);
    process.env.PATH = dir + delimiter + (saved ?? '');
    assert.deepEqual(resolveCommand(name), { command: process.execPath, prefix: [script] });
    const { stdout } = await runProcess(name, ['x y'], { cwd: dir });
    assert.deepEqual(JSON.parse(stdout).argv, ['x y']);
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
