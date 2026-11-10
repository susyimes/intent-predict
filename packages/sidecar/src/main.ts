#!/usr/bin/env node
// intent-predict sidecar: `node packages/sidecar/src/main.ts serve --stdio [--port N] [--log FILE]`
// stdout carries JSON-RPC only; everything human-readable goes to stderr.
import { startSidecar } from './server.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] !== 'serve' || !args.includes('--stdio')) {
  process.stderr.write(
    'usage: main.ts serve --stdio [--port N] [--log FILE]\n' +
    '  --port N    port of the bundled surface on 127.0.0.1 (default: a free port)\n' +
    '  --log FILE  append telemetry records (one JSON object per line)\n',
  );
  process.exit(args.includes('--help') ? 0 : 2);
}

const port = flag('--port');
const sidecar = startSidecar({
  input: process.stdin,
  output: process.stdout,
  logPath: flag('--log'),
  surfacePort: port === undefined ? undefined : Number(port),
  log: (message) => process.stderr.write(`[intent-predict] ${message}\n`),
});
void sidecar.closed.then(() => process.exit(0));
