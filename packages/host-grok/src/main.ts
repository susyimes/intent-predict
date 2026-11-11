#!/usr/bin/env node
// Agent CLIs with intent-predict: a line-based chat with Grok, Hermes, Codex, Kimi or Claude Code in
// headless mode; suggestions for your next message appear on the surface page whose address is printed at start.
//
//   node packages/host-grok/src/main.ts [--agent grok|hermes|codex|kimi|claude] [--cwd DIR] [--model ID]
//     [--resume SESSION_ID] [--eagerness conservative|eager]
//     [--min-confidence N] [--side-effect-min-confidence N] [--alt-min-confidence N]
//     [--cooldown-turns N] [--log FILE] [--timeout MS] [-- <grok args>]
//
// Everything after `--` goes to every `grok` turn, e.g. `-- --allow search_replace` to let it edit.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { AGENT_KINDS, isAgentKind } from './agent.ts';
import type { AgentKind } from './agent.ts';
import { GrokHost } from './host.ts';
import { isSafeName } from './sessions.ts';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const own = split >= 0 ? argv.slice(0, split) : argv;
const grokArgs = split >= 0 ? argv.slice(split + 1) : [];
const flag = (name: string) => {
  const i = own.indexOf(name);
  return i >= 0 ? own[i + 1] : undefined;
};
if (own.includes('--help')) {
  process.stdout.write(
    'usage: main.ts [--agent grok|hermes|codex|kimi|claude] [--cwd DIR] [--model ID] [--resume SESSION_ID]\n'
    + '  [--eagerness conservative|eager]\n'
    + '  [--min-confidence N] [--side-effect-min-confidence N] [--alt-min-confidence N]\n'
    + '  [--cooldown-turns N] [--log FILE] [--timeout MS] [-- <grok args>]\n',
  );
  process.exit(0);
}
const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};
const numberFlag = (name: string) => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${name} needs a number`);
  return value;
};
const confidenceFlag = (name: string) => {
  const value = numberFlag(name);
  if (value !== undefined && (value < 0 || value > 1)) fail(`${name} must be between 0 and 1`);
  return value;
};
const eagernessRaw = flag('--eagerness') ?? 'conservative';
if (eagernessRaw !== 'conservative' && eagernessRaw !== 'eager') fail('--eagerness must be conservative or eager');
const eagerness = eagernessRaw as 'conservative' | 'eager';
const cooldownTurnsAfterDismiss = numberFlag('--cooldown-turns');
if (cooldownTurnsAfterDismiss !== undefined
  && (!Number.isInteger(cooldownTurnsAfterDismiss) || cooldownTurnsAfterDismiss < 0)) {
  fail('--cooldown-turns must be a non-negative integer');
}
const agentRaw = flag('--agent') ?? 'grok';
if (!isAgentKind(agentRaw)) fail(`--agent must be one of ${AGENT_KINDS.join(', ')}`);
const agent = agentRaw as AgentKind;
const resume = flag('--resume');
if (resume !== undefined && !isSafeName(resume)) {
  fail(`--resume needs a session id (letters, digits, '.', '_' or '-', starting with a letter or digit)`);
}

const cwd = resolve(flag('--cwd') ?? process.cwd());
const dim = (s: string) => `\u001b[2m${s}\u001b[0m`;
let midLine = false;
const say = (s: string) => {
  process.stdout.write((midLine ? '\n' : '') + s + '\n');
  midLine = false;
};

const host = new GrokHost({
  cwd, agent, grokArgs, model: flag('--model'), resume, logPath: flag('--log'),
  eagerness,
  minConfidence: confidenceFlag('--min-confidence'),
  sideEffectMinConfidence: confidenceFlag('--side-effect-min-confidence'),
  altMinConfidence: confidenceFlag('--alt-min-confidence'),
  cooldownTurnsAfterDismiss,
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
const LABEL: Record<AgentKind, string> = { grok: 'Grok', hermes: 'Hermes', codex: 'Codex', kimi: 'Kimi', claude: 'Claude Code' };
say(`intent-predict × ${LABEL[host.agent]}   cwd: ${cwd}`);
if (host.agentSessionId) say(dim(`已绑定 ${LABEL[host.agent]} 会话：${host.agentSessionId}（经此发送的消息续接该会话）`));
{
  const gate = host.gateSettings;
  if (gate.eagerness === 'eager' || gate.minConfidence !== undefined || gate.sideEffectMinConfidence !== undefined
    || gate.altMinConfidence !== undefined || gate.cooldownTurnsAfterDismiss !== undefined) {
    say(dim(`门控设置：eagerness=${gate.eagerness}，minConfidence=${gate.minConfidence ?? 'default'}，sideEffectMinConfidence=${gate.sideEffectMinConfidence ?? 'default'}，altMinConfidence=${gate.altMinConfidence ?? 'default'}，cooldownTurnsAfterDismiss=${gate.cooldownTurnsAfterDismiss ?? 'default'}`));
  }
}
say(`打开这个页面看「下一步建议」：${host.surfaceUrl}`);
if (host.surfaceUrl) say(dim(`选择要绑定的会话：${host.surfaceUrl.replace('/?t=', '/sessions?t=')}`));
say(dim('输入消息后回车发送；空行忽略；Ctrl+C 退出。'));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
rl.prompt();
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (host.busy) return say(dim(`· ${LABEL[host.agent]} 还在运行，等它结束再发。`));
  void host.send(text).then(() => {
    say('');
    rl.prompt();
  });
});
rl.on('close', () => void host.stop().then(() => process.exit(0)));
