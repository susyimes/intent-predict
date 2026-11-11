// Claude Code: transcript replay, stream-json mapping, and driving / classification against a stand-in.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '../../core/src/index.ts';
import type { AgentEnv } from '../src/agent.ts';
import {
  CLAUDE_SAMPLE_ARGS, ClaudeStreamMapper, claudeAdapter, claudeAdvanced, claudePromptText, claudeTranscript, claudeTurnArgs, readClaudeHistory,
} from '../src/claude.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const endStatus = (events: AgentEvent[]) => {
  const last = events[events.length - 1];
  return last?.type === 'turn.completed' ? last.status : undefined;
};

/** Runs `body` with CLAUDE_CONFIG_DIR unset, so <home>/.claude is Claude Code's home. */
async function withoutConfigDir<T>(body: () => T | Promise<T>): Promise<T> {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    return await body();
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'ip-claude-'));
  const log = join(dir, 'claude.log');
  writeFileSync(log, '');
  const env: AgentEnv = {
    home: dir, bins: { claude: { command: process.execPath, prefix: [FAKE, log] } }, grokArgs: [],
    scratch: () => dir, promptFile: () => { throw new Error('claude reads its prompt from stdin'); },
  };
  const calls = (): Array<{ args: string[]; input: string; cwd: string }> => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, env, calls, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// Transcript lines in the shape Claude Code 2.1.322 writes (~/.claude/projects/<project>/<session>.jsonl).
const base = { sessionId: 'c1', cwd: 'D:\\proj', version: '2.1.322', userType: 'external', entrypoint: 'cli', isSidechain: false };
const prompt = (text: string, origin = 'human') =>
  ({ ...base, type: 'user', message: { role: 'user', content: text }, promptSource: origin === 'sdk' ? 'sdk' : 'typed', turnOrigin: origin, turnPosition: { promptIndex: 0, turnIndex: 1 } });
const reply = (content: object[], stop: string) =>
  ({ ...base, type: 'assistant', message: { model: 'claude-opus-5-5', id: 'msg_1', role: 'assistant', content, stop_reason: stop } });
const result = (id: string, content: string, isError: boolean, toolUseResult?: unknown) =>
  ({ ...base, type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] }, toolUseResult });
const said = (content: unknown, extra: object = {}) => ({ ...base, type: 'user', message: { role: 'user', content }, ...extra });
const turnEnd = { ...base, type: 'system', subtype: 'turn_duration', durationMs: 1000, messageCount: 4 };

const HISTORY = [
  { type: 'session-owner', sessionId: 'c1' }, { type: 'queue-operation', operation: 'enqueue', sessionId: 'c1' },
  { ...base, type: 'attachment', attachment: { type: 'hook_success' } },
  prompt('fix the login bug', 'sdk'),
  { type: 'last-prompt', lastPrompt: 'fix the login bug', sessionId: 'c1' },
  { type: 'api-request-blob', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] } },
  reply([{ type: 'text', text: 'Running the tests first.' }], 'tool_use'),
  reply([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pytest -q' } }], 'tool_use'),
  result('b1', 'Exit code 1\n1 failed, 3 passed', true, 'Error: Exit code 1\n1 failed, 3 passed'),
  reply([{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'D:\\proj\\tests\\test_login.py', content: 'x' } }], 'tool_use'),
  result('w1', 'File created successfully at: D:\\proj\\tests\\test_login.py', false, { type: 'create', filePath: 'D:\\proj\\tests\\test_login.py' }),
  reply([{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'D:\\proj\\src\\login.py', old_string: 'a', new_string: 'b' } }], 'tool_use'),
  result('e1', 'The file D:\\proj\\src\\login.py has been updated successfully.', false, { filePath: 'D:\\proj\\src\\login.py' }),
  reply([{ type: 'thinking', thinking: '' }], 'end_turn'),
  reply([{ type: 'text', text: 'Fixed. Shall I run the tests again?' }], 'end_turn'),
  { ...base, type: 'system', subtype: 'stop_hook_summary', hookCount: 1, preventedContinuation: false },
  turnEnd,
  { type: 'cost-state', sessionId: 'c1' }, { type: 'mode', mode: 'default', sessionId: 'c1' },
  // a local command between turns (older lines carry no origin), its output, and a caveat
  said('<command-name>/model</command-name>\n<command-args></command-args>'),
  said('<local-command-stdout>Set model to opus</local-command-stdout>'),
  said('<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>', { isMeta: true }),
  // a subagent's own conversation
  said('search the codebase for the signup form', { isSidechain: true }),
  prompt('now the signup form'),
  reply([{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'rm -rf build' } }], 'tool_use'),
  result('b2', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: deletes files', true),
  said([{ type: 'text', text: '[Request interrupted by user]' }]),
  prompt('deploy it'),
  reply([{ type: 'text', text: 'Deploying in the background.' }], 'end_turn'),
  said('<task-notification>\n<task-id>b7</task-id>\n<status>completed</status>\n</task-notification>', { promptSource: 'system', turnOrigin: 'task_notification' }),
  reply([{ type: 'text', text: 'The deploy finished.' }], 'end_turn'),
  turnEnd,
];

test('transcript replay: prompts start turns; tools, refusals, interrupts and background reports are read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-claude-hist-'));
  const file = join(dir, 'c1.jsonl');
  try {
    writeFileSync(file, jsonl(HISTORY));
    let n = 0;
    const replay = readClaudeHistory(file, 'D:\\proj', 3, () => `t${++n}`)!;
    assert.deepEqual(replay.turnIds, ['t1', 't2', 't3']);
    const [first, second, third] = replay.turns as [AgentEvent[], AgentEvent[], AgentEvent[]];
    assert.deepEqual(first.map((e) => e.type), ['turn.started', 'message.user', 'message.agent', 'tool.call', 'tool.result',
      'tool.call', 'tool.result', 'artifact', 'tool.call', 'tool.result', 'artifact', 'message.agent', 'turn.completed']);
    assert.equal(first[1]!.type === 'message.user' && first[1]!.text, 'fix the login bug');
    assert.deepEqual(first[2]!.type === 'message.agent' && [first[2]!.text, first[2]!.final], ['Running the tests first.', false]);
    assert.deepEqual(first[3]!.type === 'tool.call' && [first[3]!.name, first[3]!.command], ['Bash', 'pytest -q']);
    assert.deepEqual(first[4]!.type === 'tool.result' && [first[4]!.status, first[4]!.exitCode, first[4]!.summary], ['error', 1, '1 failed, 3 passed']);
    assert.deepEqual(first.filter((e) => e.type === 'artifact').map((e) => e.type === 'artifact' && [e.kind, e.ref]),
      [['file_created', 'tests/test_login.py'], ['file_changed', 'src/login.py']]);
    assert.deepEqual(first[11]!.type === 'message.agent' && [first[11]!.text, first[11]!.final], ['Fixed. Shall I run the tests again?', true]);
    assert.equal(endStatus(first), 'completed');

    assert.deepEqual(second.map((e) => e.type), ['turn.started', 'message.user', 'tool.call', 'tool.result', 'turn.completed']);
    assert.equal(second[3]!.type === 'tool.result' && second[3]!.status, 'denied', 'the auto-mode classifier refused it');
    assert.equal(endStatus(second), 'interrupted');

    assert.deepEqual(third.filter((e) => e.type === 'message.agent').map((e) => e.type === 'message.agent' && [e.text, e.final]),
      [['Deploying in the background.', false], ['The deploy finished.', true]], 'a background report continues its turn');
    assert.equal(replay.fingerprint, readFileSync(file).length);

    assert.deepEqual(readClaudeHistory(file, 'D:\\proj', 1, () => 'x')!.turns.length, 1, 'only the last maxTurns');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a running turn is not replayed; a later read picks it up, and an API error fails it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ip-claude-hist-'));
  const file = join(dir, 'c1.jsonl');
  try {
    writeFileSync(file, jsonl(HISTORY));
    let n = 0;
    const { fingerprint } = readClaudeHistory(file, 'D:\\proj', 3, () => `t${++n}`)!;
    assert.equal(claudeAdvanced(file, fingerprint), false);
    appendFileSync(file, jsonl([prompt('and the docs?'), reply([{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'D:\\proj\\README.md' } }], 'tool_use')]));
    assert.equal(claudeAdvanced(file, fingerprint), true, 'the user started a turn in Claude Code itself');
    assert.equal(readClaudeHistory(file, 'D:\\proj', 3, () => 'x', fingerprint, true), undefined, 'a running turn is not replayed yet');
    const abandoned = readClaudeHistory(file, 'D:\\proj', 3, () => 'x', fingerprint, false)!;
    assert.deepEqual(abandoned.turns.map(endStatus), ['interrupted'], 'with no Claude Code process left on the session, it will never finish');
    appendFileSync(file, jsonl([
      result('r1', '1\t# proj', false, { type: 'text' }),
      { ...base, type: 'assistant', isApiErrorMessage: true, error: 'rate_limit',
        message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your limit" }], stop_reason: 'stop_sequence' } },
    ]));
    const later = readClaudeHistory(file, 'D:\\proj', 3, () => `t${++n}`, fingerprint, true)!;
    assert.equal(later.turns.length, 1);
    const events = later.turns[0]!;
    assert.deepEqual(events.map((e) => e.type), ['turn.started', 'message.user', 'tool.call', 'tool.result', 'turn.completed']);
    assert.equal(endStatus(events), 'failed', 'the error text is not an agent message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('which user lines start a turn', () => {
  assert.equal(claudePromptText(prompt('hi')), 'hi');
  assert.equal(claudePromptText(prompt('hi', 'sdk')), 'hi', 'a message sent with claude -p');
  assert.equal(claudePromptText(said([{ type: 'text', text: '[Image #1] fix this' }, { type: 'image', source: {} }], { turnOrigin: 'human' })), '[Image #1] fix this');
  assert.equal(claudePromptText(said('<task-notification>x</task-notification>', { turnOrigin: 'task_notification' })), undefined);
  assert.equal(claudePromptText(said('continue', { turnOrigin: 'auto_continuation', isMeta: true })), undefined);
  assert.equal(claudePromptText(said('summary of the conversation', { isCompactSummary: true, isVisibleInTranscriptOnly: true, turnOrigin: 'human' })), undefined);
  assert.equal(claudePromptText(result('x', 'ok', false)), undefined);
  assert.equal(claudePromptText(said('plain old prompt')), 'plain old prompt', 'older lines without an origin');
  assert.equal(claudePromptText(said('<command-name>/clear</command-name>')), undefined);
  assert.equal(claudePromptText(said([{ type: 'text', text: '[Request interrupted by user for tool use]' }])), undefined);
  assert.equal(claudePromptText({ ...prompt('x'), isSidechain: true }), undefined);
});

test('a recorded stream-json turn (Claude Code 2.1.322) maps to events; a refused Write is denied', () => {
  const sid = '68608922-a92b-427e-b90c-67c70942e7e4';
  const denied = 'Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here — so it was denied automatically.';
  const mapper = new ClaudeStreamMapper('t1', 'D:\\proj');
  const events = [
    { type: 'system', subtype: 'hook_started', hook_id: 'h1', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', session_id: sid },
    { type: 'system', subtype: 'init', cwd: 'D:\\proj', session_id: sid, model: 'claude-opus-5-5', permissionMode: 'default' },
    { type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_019T', name: 'Write', input: { file_path: 'D:\\proj\\probe.txt', content: 'hello' } }], stop_reason: null }, parent_tool_use_id: null, session_id: sid },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: sid },
    { type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 'toolu_019T', decision_reason_type: 'asyncAgent', message: denied, session_id: sid },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: denied, is_error: true, tool_use_id: 'toolu_019T' }] }, parent_tool_use_id: null, session_id: sid, tool_use_result: `Error: ${denied}` },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a subagent speaking' }] }, parent_tool_use_id: 'toolu_task', session_id: sid },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }], stop_reason: null }, parent_tool_use_id: null, session_id: sid },
    { type: 'assistant', message: { content: [{ type: 'text', text: "It didn't work: writing probe.txt needed an approval." }], stop_reason: null }, parent_tool_use_id: null, session_id: sid },
    { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', num_turns: 2, session_id: sid, permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_019T', tool_input: {} }] },
  ].flatMap((line) => mapper.push(line));
  assert.deepEqual(events.map((e) => e.type), ['tool.call', 'tool.result', 'message.agent', 'turn.completed']);
  assert.deepEqual(events[1]!.type === 'tool.result' && [events[1]!.status, events[1]!.summary?.slice(0, 40)], ['denied', 'Permission for this tool use was denied.']);
  assert.deepEqual(events[2]!.type === 'message.agent' && [events[2]!.text, events[2]!.final], ["It didn't work: writing probe.txt needed an approval.", true]);
  assert.equal(events[3]!.type === 'turn.completed' && events[3]!.status, 'completed');
  assert.deepEqual([mapper.sessionId, mapper.permissionMode, mapper.refusedTools], [sid, 'default', ['Write']]);
  assert.deepEqual(mapper.finish(), []);

  const failing = new ClaudeStreamMapper('t2', 'D:\\proj');
  const out = [
    { type: 'assistant', error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your limit" }] }, parent_tool_use_id: null, session_id: sid },
    { type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit", session_id: sid },
  ].flatMap((line) => failing.push(line));
  assert.deepEqual(out.map((e) => e.type === 'turn.completed' && e.status), ['failed'], 'an API error is neither a reply nor a success');
});

test('turn and classification arguments: message on stdin, nothing approves on the user\'s behalf, default model', () => {
  const id = '68608922-a92b-427e-b90c-67c70942e7e4';
  assert.deepEqual(claudeTurnArgs(id), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none', '--resume', id]);
  assert.deepEqual(claudeTurnArgs(), ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none']);
  assert.throws(() => claudeTurnArgs('--dangerously-skip-permissions'), /plain name/);
  for (const args of [claudeTurnArgs(id), CLAUDE_SAMPLE_ARGS]) {
    assert.ok(!args.some((a) => /dangerously|bypassPermissions|acceptEdits|^auto$|dontAsk|--permission-mode|--allowedTools|--allow-/.test(a)), args.join(' '));
  }
  assert.deepEqual(CLAUDE_SAMPLE_ARGS.slice(CLAUDE_SAMPLE_ARGS.indexOf('--tools'), CLAUDE_SAMPLE_ARGS.indexOf('--tools') + 2), ['--tools', ''], 'no tools at all');
  for (const flag of ['--no-session-persistence', '--safe-mode', '--strict-mcp-config']) assert.ok(CLAUDE_SAMPLE_ARGS.includes(flag), flag);
  assert.ok(!CLAUDE_SAMPLE_ARGS.includes('--model'), 'no model override');
});

test('a session\'s transcript is found in its project folder, or anywhere; unsafe ids are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'ip-claude-home-'));
  try {
    const id = '68608922-a92b-427e-b90c-67c70942e7e4';
    mkdirSync(join(root, 'projects', 'D--proj'), { recursive: true });
    writeFileSync(join(root, 'projects', 'D--proj', `${id}.jsonl`), '');
    assert.equal(claudeTranscript(root, id, 'D:\\proj'), join(root, 'projects', 'D--proj', `${id}.jsonl`));
    assert.equal(claudeTranscript(root, id, 'D:\\elsewhere'), join(root, 'projects', 'D--proj', `${id}.jsonl`), 'found by scanning the project folders');
    assert.equal(claudeTranscript(root, '00000000-0000-4000-8000-000000000000', 'D:\\proj'), undefined);
    assert.throws(() => claudeTranscript(root, '../x'), /plain name/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a driven Claude turn continues the session with the message on stdin; refusals are reported', async () => {
  const w = workspace();
  try {
    const events: AgentEvent[] = [];
    const infos: string[] = [];
    const out = await claudeAdapter.runTurn('fix it', {
      env: w.env, turnId: 't1', cwd: w.dir, id: 'c0ffee00-0000-4000-8000-0000000000aa', emit: (e) => events.push(...e), info: (m) => infos.push(m),
    });
    assert.equal(out.sessionId, 'c0ffee00-0000-4000-8000-0000000000aa');
    const [call] = w.calls();
    assert.deepEqual(call!.args, claudeTurnArgs('c0ffee00-0000-4000-8000-0000000000aa'));
    assert.equal(call!.input, 'fix it');
    assert.equal(call!.cwd, w.dir);
    assert.deepEqual(events.map((e) => e.type), ['message.agent', 'tool.call', 'tool.result', 'tool.call', 'tool.result',
      'tool.call', 'tool.result', 'artifact', 'message.agent', 'turn.completed']);
    assert.deepEqual(events[2]!.type === 'tool.result' && [events[2]!.status, events[2]!.exitCode, events[2]!.summary], ['error', 1, '1 failing']);
    assert.equal(events[4]!.type === 'tool.result' && events[4]!.status, 'denied');
    assert.equal(events[7]!.type === 'artifact' && events[7]!.ref, 'src/a.ts');
    assert.deepEqual(events[8]!.type === 'message.agent' && [events[8]!.text, events[8]!.final], ['Fixed; please rerun.', true]);
    assert.ok(infos.some((m) => /refused what needed approval \(Write\)/.test(m)), infos.join(' | '));

    const fresh = await claudeAdapter.runTurn('hi', { env: w.env, turnId: 't2', cwd: w.dir, emit: () => {}, info: () => {} });
    assert.equal(fresh.sessionId, 'c0ffee00-0000-4000-8000-000000000001', 'a new session reports its id');
    assert.deepEqual(w.calls()[1]!.args, claudeTurnArgs());
  } finally {
    w.done();
  }
});

test('a session open in another Claude Code process fails the turn with Claude\'s reason, and the host can tell beforehand', async () => {
  const w = workspace();
  try {
    const events: AgentEvent[] = [];
    const infos: string[] = [];
    await claudeAdapter.runTurn('hi', { env: w.env, turnId: 't1', cwd: w.dir, id: 'busy-elsewhere', emit: (e) => events.push(...e), info: (m) => infos.push(m) });
    assert.deepEqual(events.map((e) => e.type === 'turn.completed' && e.status), ['failed']);
    assert.ok(infos.some((m) => /claude exited with 1: Error: That session is running in the background/.test(m)), infos.join(' | '));

    await withoutConfigDir(() => {
      const registry = join(w.dir, '.claude', 'sessions');
      mkdirSync(registry, { recursive: true });
      writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'c-open', cwd: w.dir, kind: 'interactive', status: 'idle' }));
      writeFileSync(join(registry, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'c-closed', cwd: w.dir, kind: 'interactive' }));
      const why = claudeAdapter.busyElsewhere!({ kind: 'claude', id: 'c-open', cwd: w.dir }, w.env);
      assert.match(why ?? '', new RegExp(`open in another Claude Code process \\(pid ${process.pid}\\)`));
      assert.equal(claudeAdapter.busyElsewhere!({ kind: 'claude', id: 'c-closed', cwd: w.dir }, w.env), undefined, 'a registry entry whose process is gone');
      assert.equal(claudeAdapter.busyElsewhere!({ kind: 'claude', id: 'c-other', cwd: w.dir }, w.env), undefined);
    });
  } finally {
    w.done();
  }
});

test('a Claude classification call keeps nothing and runs no tools; a call that reached for a tool is void', async () => {
  const w = workspace();
  try {
    const sample = await claudeAdapter.sample('[INTENT PREDICTION] pick one', { env: w.env, signal: new AbortController().signal });
    assert.equal(sample.text, '{"intent":"run_tests","confidence":0.9,"slots":{}}');
    assert.deepEqual(sample.usage, { inputTokens: 125, cachedInputTokens: 20, outputTokens: 10 });
    assert.equal(sample.cleanup, undefined, 'nothing to delete: the call kept no session');
    const [call] = w.calls();
    assert.deepEqual(call!.args, CLAUDE_SAMPLE_ARGS);
    assert.equal(call!.input, '[INTENT PREDICTION] pick one');
    const withTool = await claudeAdapter.sample('[INTENT PREDICTION] USE_TOOL', { env: w.env, signal: new AbortController().signal });
    assert.equal(withTool.text, null);
  } finally {
    w.done();
  }
});
