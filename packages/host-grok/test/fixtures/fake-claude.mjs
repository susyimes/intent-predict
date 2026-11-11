// A stand-in for `claude` in tests. Logs its arguments and stdin to the file named by its first
// argument, then answers like Claude Code 2.1.322: a `--output-format json` result for a
// classification call, or a `--output-format stream-json` turn whose Write needs an approval
// nobody can give. Resuming the session id `busy-elsewhere` fails the way Claude does when another
// process has the session open. FAKE_CLAUDE_DELAY_MS delays a classification call's answer.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const [logFile, ...args] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  appendFileSync(logFile, JSON.stringify({ args, input, cwd: process.cwd() }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const resumeAt = args.indexOf('--resume');
  const session = resumeAt >= 0 ? args[resumeAt + 1] : 'c0ffee00-0000-4000-8000-000000000001';
  if (args.includes('--no-session-persistence')) {
    const tool = input.includes('USE_TOOL');
    setTimeout(() => out({
      type: 'result', subtype: 'success', is_error: false, stop_reason: tool ? 'tool_use' : 'end_turn', num_turns: tool ? 2 : 1,
      result: '{"intent":"run_tests","confidence":0.9,"slots":{}}', session_id: 'f00d0000-0000-4000-8000-000000000002',
      usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 10 }, permission_denials: [],
    }), Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0));
    return;
  }
  if (session === 'busy-elsewhere') {
    process.stderr.write('Error: That session is running in the background (busy-els). Run `claude attach busy-els` to open it, or `claude stop busy-els` first to resume it here. Add --fork-session to branch off a copy instead.\n');
    process.exit(1);
  }
  const msg = (content) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content, stop_reason: null }, parent_tool_use_id: null, session_id: session });
  const result = (id, content, isError, detail) => ({
    type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, is_error: isError }] },
    parent_tool_use_id: null, session_id: session, tool_use_result: detail,
  });
  out({ type: 'system', subtype: 'hook_started', hook_event: 'SessionStart', session_id: session });
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, model: 'claude-opus-5-5', permissionMode: 'default', tools: ['Bash', 'Edit', 'Write'] });
  out(msg([{ type: 'text', text: 'Running the tests.' }]));
  out(msg([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }]));
  out(result('toolu_1', 'Exit code 1\n1 failing', true, 'Error: Exit code 1\n1 failing'));
  out(msg([{ type: 'tool_use', id: 'toolu_2', name: 'Write', input: { file_path: join(process.cwd(), 'notes.md'), content: 'x' } }]));
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, session_id: session });
  const denied = 'Permission for this tool use was denied. It requires approval, and this session has no approval surface — nobody can answer a permission prompt here — so it was denied automatically.';
  out({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 'toolu_2', message: denied, session_id: session });
  out(result('toolu_2', denied, true, `Error: ${denied}`));
  out(msg([{ type: 'tool_use', id: 'toolu_3', name: 'Edit', input: { file_path: join(process.cwd(), 'src', 'a.ts'), old_string: 'a', new_string: 'b' } }]));
  out(result('toolu_3', 'The file has been updated successfully.', false, { filePath: join(process.cwd(), 'src', 'a.ts') }));
  out(msg([{ type: 'thinking', thinking: '' }]));
  out(msg([{ type: 'text', text: 'Fixed; please rerun.' }]));
  out({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', num_turns: 4, result: 'Fixed; please rerun.', session_id: session,
    permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_2', tool_input: {} }],
  });
});
