#!/usr/bin/env node
// Grok CLI with intent-predict: a line-based chat with Grok in headless mode; suggestions for your
// next message appear on the surface page whose address is printed at start.
//
//   node packages/host-grok/src/main.ts [--cwd DIR] [--model ID] [--log FILE] [--timeout MS] [-- <grok args>]
//
// Everything after `--` goes to every `grok` turn, e.g. `-- --allow search_replace` to let it edit.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { GrokHost } from './host.ts';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split >= 0 ? argv.slice(0, split) : argv;
const grokArgs = split >= 0 ? argv.slice(split + 1) : [];
const flag = (name: string) => {
  const i = own.indexOf(name);
  return i >= 0 ? own[i + 1] : undefined;
};
if (own.includes('--help')) {
  process.stdout.write('usage: main.ts [--cwd DIR] [--model ID] [--log FILE] [--timeout MS] [-- <grok args>]\n');
  process.exit(0);
}

const cwd = resolve(flag('--cwd') ?? process.cwd());
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
let midLine = false;
const say = (s: string) => {
  process.stdout.write((midLine ? '\n' : '') + s + '\n');
  midLine = false;
};

const host = new GrokHost({
  cwd, grokArgs, model: flag('--model'), logPath: flag('--log'),
  timeoutMs: flag('--timeout') ? Number(flag('--timeout')) : undefined,
  onInfo: (m) => say(dim(`· ${m}`)),
  onLine: (line) => {
    if (line.type === 'text') {
      process.stdout.write(String(line.data));
      midLine = true;
    } else if (line.type === 'tool_call') {
      say(dim(`· ${line.toolName}${line.rawInput?.command ? ': ' + line.rawInput.command : ''}`));
    }
  },
});

await host.start();
say(`intent-predict × Grok CLI   cwd: ${cwd}`);
say(`打开这个页面看「下一步建议」：${host.surfaceUrl}`);
say(dim('输入消息后回车发送；空行忽略；Ctrl+C 退出。'));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
rl.prompt();
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (host.busy) return say(dim('· Grok 还在运行，等它结束再发。'));
  void host.send(text).then(() => {
    say('');
    rl.prompt();
  });
});
rl.on('close', () => void host.stop().then(() => process.exit(0)));
