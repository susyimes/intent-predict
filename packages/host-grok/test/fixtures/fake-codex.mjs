// A stand-in for `codex` in tests. Logs its arguments and stdin to the file named by its first
// argument, then prints a `codex exec --json` stream in the format codex-cli 0.159 uses.
import { appendFileSync } from 'node:fs';

const [logFile, ...args] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  appendFileSync(logFile, JSON.stringify({ args, input, cwd: process.cwd() }) + '\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  const resumeAt = args.indexOf('resume');
  out({ type: 'thread.started', thread_id: resumeAt >= 0 ? args[resumeAt + 1] : '01a1ca3a-0000-7000-8000-00000000c0de' });
  out({ type: 'turn.started' });
  if (args.includes('--ephemeral')) {
    if (input.includes('USE_TOOL')) out({ type: 'item.completed', item: { id: 'item_t', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0, status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{"intent":"run_tests","confidence":0.9,"slots":{}}' } });
  } else {
    out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Running the tests.' } });
    out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'npm test', aggregated_output: '1 failing\n', exit_code: 1, status: 'failed' } });
    out({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' } });
    out({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Fixed; please rerun.' } });
  }
  out({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } });
});
