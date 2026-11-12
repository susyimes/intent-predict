// Prompts (SPEC 4.5: catalog mode; SPEC 4.9: open mode), signals_json and the compact transcript.
import type { AgentEvent, IntentSpec, SamplerMode, ScenarioSpec, Signals, ToolCall, ToolResult } from './types.ts';
import { finalAgentText, resolve } from './signals.ts';
import { cut, cutStart, firstCps, redact } from './text.ts';

/** Open mode (SPEC 4.9): the session's own agent writes the user's likely next messages itself. */
export const OPEN_PROMPT = `[NEXT MESSAGE PREDICTION — do not continue the task. Do not call tools.]
Below are the latest turns of a session between a user and an AI agent. Predict the message THE USER will send next.

Write up to 3 candidates, each exactly as the user would type it: in the user's language and tone, about as long as their earlier messages. Make the candidates meaningfully different from each other. For each candidate give your probability that the user's next message means essentially the same. The probabilities together must not exceed 1. If nothing plausible comes to mind, return an empty list.

Set "sideEffect": true on a candidate that would have the agent do something with effects outside the workspace, such as pushing, publishing, deploying, sending or deleting.

User locale: {{user.locale}}
{{#if compact}}
Recent conversation (oldest first):
{{transcript}}
{{/if}}
Signals: {{signals_json}}

Reply with a single JSON object only:
{"candidates":[{"text":"...","confidence":0.0,"sideEffect":false}]}`;

/** How much of each turn the compact transcript keeps: catalog mode (SPEC 4.5 step 6) and open mode (4.9). */
export interface TranscriptLimits { user: number; agent: number; tools: number }
export const CATALOG_LIMITS: TranscriptLimits = { user: 500, agent: 1500, tools: 6 };
export const OPEN_LIMITS: TranscriptLimits = { user: 2000, agent: 4000, tools: 12 };

export const DEFAULT_PROMPT = `[INTENT PREDICTION — do not continue the task. Do not call tools.]
Predict the user's NEXT message in this session by choosing from a fixed catalog.

Scenario: {{scenario.description}}
Catalog (pick one id):
{{#each intents}}
- {{id}}: {{description}}{{#if slots}} (slots: {{slots_spec}}){{/if}}{{#if examples}} e.g. {{examples}}{{/if}}
{{/each}}
- none: nothing above is likely to be the user's next message.

Rules:
1. Predict what THE USER would type next, not what you think they should do.
2. Read the last lines of the assistant's message first; if it explicitly offers a next step, prefer the matching intent.
3. Give honest probabilities. When you hesitate between intents, pick the most likely one and list the others as runner-ups; do not hide the guess behind "none" and do not round it up. Whether anything is shown is decided from your probabilities.
4. Fill "slots" only with values that literally appear in the conversation.
5. "confidence" is your probability that the user's next message has this intent. You may list up to 2 runner-ups; all probabilities together must not exceed 1.

{{#if compact}}
Recent conversation (oldest first):
{{transcript}}
{{/if}}
Signals: {{signals_json}}

Reply with a single JSON object only:
{"intent":"<id>","confidence":0.0,"slots":{},"runnerUps":[{"intent":"<id2>","confidence":0.0}]}
`;

export const SIGNAL_KEYS = [
  'session.turnCount', 'lastTurn.status', 'lastTurn.toolKinds', 'lastTurn.filesChanged', 'lastTurn.failedExecs',
  'lastTurn.lastExecFailed', 'lastTurn.checkRuns', 'lastTurn.lastCheckFailed', 'lastAgentMessage.endsWithQuestion',
  'lastAgentMessage.optionsCount', 'lastAgentMessage.optionsPrompted', 'lastAgentMessage.proposedRisk', 'user.locale',
];

export function signalsJson(signals: Signals): string {
  const obj: Record<string, unknown> = {};
  for (const key of SIGNAL_KEYS) {
    const value = resolve(signals, key);
    if (value !== undefined) obj[key] = value;
  }
  return JSON.stringify(obj);
}

export function transcript(events: AgentEvent[], turnIds: string[], strict: boolean, limits: TranscriptLimits = CATALOG_LIMITS): string {
  const lines: string[] = [];
  for (const turnId of turnIds) {
    const evs = events.filter((e) => 'turnId' in e && e.turnId === turnId);
    const results = new Map(evs.filter((e): e is ToolResult => e.type === 'tool.result').map((r) => [r.callId, r]));
    for (const e of evs) if (e.type === 'message.user') lines.push('User: ' + cut(redact(e.text, strict), limits.user));
    let tools: string[] = [];
    for (const c of evs.filter((e): e is ToolCall => e.type === 'tool.call')) {
      const r = results.get(c.callId);
      if (!r) continue;
      let line = `Tool: ${c.name}(${firstCps(redact(c.command ?? '', strict), 60)}) -> ${r.status}`;
      if (r.exitCode !== undefined && r.exitCode !== null) line += ` exit=${r.exitCode}`;
      if (r.summary) line += ': ' + redact(r.summary, strict);
      tools.push(firstCps(line, 200));
    }
    if (tools.length > limits.tools) {
      const head = Math.floor(limits.tools / 3);
      tools = [...tools.slice(0, head), `Tool: … (${tools.length - limits.tools} more)`, ...tools.slice(-(limits.tools - head))];
    }
    lines.push(...tools);
    const final = redact(finalAgentText(evs), strict);
    if (final) lines.push('Assistant: ' + cutStart(final, limits.agent));
  }
  return lines.join('\n');
}

const BLOCK_TAGS = ['\\{\\{#each intents\\}\\}', '\\{\\{/each\\}\\}', '\\{\\{#if compact\\}\\}', '\\{\\{/if\\}\\}'];

export function renderPrompt(
  template: string, scenario: ScenarioSpec, catalog: IntentSpec[], signals: Signals, mode: SamplerMode,
  transcriptText: string, withExamples: boolean,
): string {
  // A line holding only a block tag disappears together with its line break.
  for (const tag of BLOCK_TAGS) {
    template = template.replace(new RegExp(`^[ \\t]*${tag}[ \\t]*\\r?\\n`, 'gm'), (m) => m.trim());
  }
  const fill = (s: string, key: string, value: string) => s.split(key).join(value);
  const each = (_: string, body: string) =>
    catalog
      .map((it) => {
        const free = Object.entries(it.slots ?? {}).filter(([, s]) => !s.from).map(([n, s]) => `${n}:${s.type}`);
        const examples = withExamples ? (it.examples ?? []).slice(0, 2) : [];
        let row = body.replace(/\{\{#if slots\}\}(.*?)\{\{\/if\}\}/gs, (_m, inner: string) =>
          free.length ? fill(inner, '{{slots_spec}}', free.join(', ')) : '');
        row = row.replace(/\{\{#if examples\}\}(.*?)\{\{\/if\}\}/gs, (_m, inner: string) =>
          examples.length ? fill(inner, '{{examples}}', examples.join(' | ')) : '');
        return fill(fill(row, '{{id}}', it.id), '{{description}}', it.description);
      })
      .join('');
  let out = template.replace(/\{\{#if compact\}\}(.*?)\{\{\/if\}\}/gs, (_m, inner: string) => (mode === 'compact' ? inner : ''));
  out = out.replace(/\{\{#each intents\}\}(.*?)\{\{\/each\}\}/gs, each);
  const scalars: Record<string, string> = {
    'scenario.id': scenario.id,
    'scenario.description': scenario.description,
    'user.locale': signals.user.locale,
    signals_json: signalsJson(signals),
    transcript: transcriptText,
  };
  return out.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, name: string) => scalars[name] ?? '');
}

/** The open-mode prompt (SPEC 4.9): no scenario and no catalog, only the conversation and its signals. */
export function renderOpenPrompt(signals: Signals, mode: SamplerMode, transcriptText: string, template = OPEN_PROMPT): string {
  return renderPrompt(template, { id: '', description: '' } as ScenarioSpec, [], signals, mode, transcriptText, false);
}
