// --headless (LAUNCHER.md): started in the background with no terminal input, the host stays up and serves the
// pages; without it, a closed stdin ends the interactive host at once.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

test('--headless keeps running with stdin closed and serves the pages', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ip-headless-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const child = spawn(process.execPath, [MAIN, '--headless', '--cwd', home], { stdio: ['ignore', 'pipe', 'pipe'], env });
  t.after(() => void child.kill());
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));

  // a pipe can deliver a line in pieces: wait for the notice printed after both addresses, not for a token prefix
  const URL_RE = /http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+/;
  for (const end = Date.now() + 15_000; !/--headless/.test(out) && child.exitCode === null && Date.now() < end;) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const page = new URL(out.match(URL_RE)?.[0] ?? assert.fail(`no page address in:\n${out}`));
  assert.match(out, /\/sessions\?t=/, 'the session picker address is printed too');
  assert.doesNotMatch(out, /\u001b\[/, 'no terminal colours when the output goes to a file or pipe');

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(child.exitCode, null, 'still running after stdin was closed');
  const token = page.searchParams.get('t')!;
  const res = await fetch(page.origin + '/rpc', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'binding/list', params: {} }),
  });
  assert.equal(res.status, 200, `the page answers with its token; host output:\n${out}`);
  const { result } = (await res.json()) as { result: { sessions: unknown[]; current: unknown } };
  assert.ok(Array.isArray(result.sessions), 'the picker answers');
});

test('without --headless, a closed stdin ends the host', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ip-headless-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const cli = spawnSync(process.execPath, [MAIN, '--cwd', home], {
    input: '', env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /输入消息后回车发送/);
});
