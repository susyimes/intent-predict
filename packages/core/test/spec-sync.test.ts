// The TypeScript core must not drift from SPEC.md, nor its YAML loader from the generated pack.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROMPT, OPEN_PROMPT, PATTERN_SOURCES, SIGNAL_KEYS, loadPackFile, packErrors } from '../src/index.ts';

const file = (rel: string) => fileURLToPath(new URL('../../../' + rel, import.meta.url));
const spec = readFileSync(file('SPEC.md'), 'utf8').replaceAll('\r\n', '\n');   // a Windows checkout may have CRLF

test('every pattern the core uses is printed verbatim in SPEC.md', () => {
  for (const [name, source] of Object.entries(PATTERN_SOURCES)) assert.ok(spec.includes(source), `pattern "${name}" differs from SPEC.md`);
});

test('the default prompt and the signals_json allowlist equal SPEC.md', () => {
  assert.ok(spec.includes(DEFAULT_PROMPT.trim()));
  assert.ok(spec.includes(OPEN_PROMPT.trim()), 'the open-mode prompt (SPEC 4.9) matches too');
  const listed = /\*\*`signals_json`\.\*\*(.*)/.exec(spec)![1]!;
  assert.deepEqual([...listed.matchAll(/`([A-Za-z]+\.[A-Za-z.]+)`/g)].map((m) => m[1]), SIGNAL_KEYS);
});

test('INTENTS.md parsed here equals the generated pack.json', () => {
  assert.deepEqual(loadPackFile(file('INTENTS.md')), JSON.parse(readFileSync(file('packages/pack-coding/pack.json'), 'utf8')));
});

test('load-time rules reject what SPEC 3.2 forbids', () => {
  const intent = { id: 'go', description: 'd', render: 'go {x}', risk: 'none', passThrough: true };
  const errors = packErrors({ id: 'p', version: '1.0.0', scenarios: [{ id: 's', description: 'd', match: { signal: 'a', matches: '(' }, intents: [intent, intent] }] });
  for (const part of ['passThrough requires', 'placeholder {x}', 'duplicate intent id', 'bad regex']) {
    assert.ok(errors.some((e) => e.includes(part)), `missing: ${part} in ${errors.join(' | ')}`);
  }
});
