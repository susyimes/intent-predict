// Signal extraction and predicates (SPEC 2.2, 2.3).
import type {
  AgentEvent, Hint, LeafPredicate, MessageAgent, Predicate, ProposedRisk, Signals, ToolCall, ToolKind, ToolResult,
} from './types.ts';
import {
  CHECK_RE, DESTRUCTIVE_RE, EXTERNAL_RE, LITERAL_RE, NUMBERED_RE, QUESTION_RE, RECOMMENDED_RE, SLASH_RE,
  cpLength, isNum, lastCps,
} from './text.ts';

const KIND_TABLE: Record<Exclude<ToolKind, 'other'>, string> = {
  read: 'read_file read view cat head tail open_file',
  search: 'search_files grep rg find glob ls list_files web_search websearch session_search',
  edit: 'patch write_file write edit multiedit apply_patch create_file str_replace_editor str_replace_based_edit_tool notebook_edit notebookedit',
  delete: 'remove_file delete_file rm',
  execute: 'terminal bash shell powershell exec_command execute_code run_command run_terminal_cmd',
  fetch: 'web_extract web_fetch webfetch fetch curl browser_exec',
  ask_user: 'clarify ask_user askuserquestion request_user_input',
};
const KIND_BY_NAME = new Map<string, ToolKind>(
  Object.entries(KIND_TABLE).flatMap(([kind, names]) => names.split(' ').map((n) => [n, kind as ToolKind] as const)),
);

export const toolKind = (call: ToolCall): ToolKind => call.kind ?? KIND_BY_NAME.get(call.name.toLowerCase()) ?? 'other';
export const callFailed = (r: ToolResult): boolean =>
  r.status === 'error' || (r.exitCode !== undefined && r.exitCode !== null && r.exitCode !== 0);

export function finalAgentText(turnEvents: AgentEvent[]): string {
  const msgs = turnEvents.filter((e): e is MessageAgent => e.type === 'message.agent');
  const finals = msgs.filter((m) => m.final !== false);
  return (finals.length ? finals : msgs).at(-1)?.text ?? '';
}

const isFence = (line: string) => line.trimStart().startsWith('```');

export function proseLines(tail: string): string[] {
  const lines = tail.split('\n');
  let inCode = lines.filter(isFence).length % 2 === 1;
  const out: string[] = [];
  for (const line of lines) {
    if (isFence(line)) inCode = !inCode;
    else if (!inCode && line.trim()) out.push(line.trim());
  }
  return out;
}

const Q_TRAIL = new Set(Array.from('"\'”’)）]】」』'));
export function isQuestion(line: string): boolean {
  const cps = Array.from(line.trimEnd());
  while (cps.length && Q_TRAIL.has(cps[cps.length - 1]!)) cps.pop();
  const rest = cps.join('').trimEnd();
  return rest.endsWith('?') || rest.endsWith('？') || QUESTION_RE.test(rest);
}

export function agentMessageSignals(text: string): Signals['lastAgentMessage'] {
  const tail = lastCps(text, 1500);
  const prose = proseLines(tail);
  const last = prose.at(-1);
  const endsWithQuestion = last !== undefined && isQuestion(last);

  const q = last !== undefined && isQuestion(last) && !NUMBERED_RE.test(last) ? 1 : 0;
  let i = prose.length - q;
  const run: Array<[number, string]> = [];
  for (let m: RegExpExecArray | null; i > 0 && (m = NUMBERED_RE.exec(prose[i - 1]!)); i--) {
    run.unshift([Number(m[1] ?? m[2]), m[3]!.trim()]);
  }
  const valid = run.length >= 2 && run.length <= 9 && run.every(([n], k) => n === k + 1);
  const sig: Signals['lastAgentMessage'] = {
    length: cpLength(text), tail, endsWithQuestion,
    optionsCount: valid ? run.length : 0, optionsPrompted: false, hints: [], proposedRisk: 'reversible',
  };
  if (valid) {
    sig.options = run.map(([, t]) => t);
    const preferred = run.findIndex(([, t]) => RECOMMENDED_RE.test(t));
    if (preferred >= 0) sig.preferredOptionIndex = preferred + 1;
    sig.optionsPrompted = q === 1 || (i > 0 && isQuestion(prose[i - 1]!)) || preferred >= 0;
  }

  for (const line of prose.slice(-5)) {
    const found: Array<[number, Hint]> = [];
    for (const m of line.matchAll(SLASH_RE)) {
      found.push([m.index + m[0].indexOf(m[1]!), { kind: 'slash', value: m[1]!.toLowerCase() }]);
    }
    for (const m of line.matchAll(LITERAL_RE)) {
      found.push([m.index + m[0].indexOf(m[1]!), { kind: 'type_literal', value: m[1]!.trim() }]);
    }
    sig.hints.push(...found.sort((a, b) => a[0] - b[0]).map(([, h]) => h));
  }

  const scan = lastCps(text, 8000);
  const risk: ProposedRisk = DESTRUCTIVE_RE.test(scan) ? 'irreversible' : EXTERNAL_RE.test(scan) ? 'side_effect' : 'reversible';
  sig.proposedRisk = risk;
  return sig;
}

export function localeOf(userTexts: string[]): string {
  const text = userTexts.slice(-3).join(' ').replace(/```[\s\S]*?```/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const chars = Array.from(text).filter((c) => !/\s/u.test(c));
  const n = chars.length || 1;
  const count = (lo: string, hi: string) => chars.filter((c) => c >= lo && c <= hi).length;
  const cjk = count('一', '鿿');
  if (count('぀', 'ヿ') / n > 0.05) return 'ja';
  if (count('가', '힯') / n > 0.05) return 'ko';
  if (cjk / n >= 0.1 || (cjk >= 2 && (text.match(/[A-Za-z]+/g)?.length ?? 0) < 5)) return 'zh-CN';
  return 'en';
}

export interface SessionView {
  events: AgentEvent[];
  completedCount: number;
  state: Record<string, unknown>;
}

export function extractSignals(session: SessionView, turnId: string): Signals {
  const evs = session.events.filter((e) => 'turnId' in e && e.turnId === turnId);
  const status = evs.find((e) => e.type === 'turn.completed')?.status ?? 'completed';
  const calls = evs.filter((e): e is ToolCall => e.type === 'tool.call');
  const results = new Map(evs.filter((e): e is ToolResult => e.type === 'tool.result').map((r) => [r.callId, r]));
  const dedupe = <T>(items: T[]) => [...new Set(items)];

  const refs = dedupe(
    evs.flatMap((e) => (e.type === 'artifact' && ['file_changed', 'file_created', 'file_deleted'].includes(e.kind) ? [e.ref] : [])),
  );
  const editsOk = calls.filter((c) => ['edit', 'delete'].includes(toolKind(c)) && results.get(c.callId)?.status === 'ok').length;
  const execs = calls.flatMap((c) => {
    const r = results.get(c.callId);
    return toolKind(c) === 'execute' && r ? [[c, r] as const] : [];
  });
  const isCheck = (c: ToolCall) => (typeof c.check === 'boolean' ? c.check : !!c.command && CHECK_RE.test(c.command));
  const checks = execs.filter(([c]) => isCheck(c));
  const toolOutputs: Record<string, unknown> = {};
  for (const c of calls) {
    const r = results.get(c.callId);
    if (r && r.output !== undefined && Buffer.byteLength(JSON.stringify(r.output) ?? '') <= 64 * 1024) {
      toolOutputs[c.name] = r.output;
    }
  }

  const lastTurn: Signals['lastTurn'] = {
    status,
    toolKinds: dedupe(calls.map(toolKind)),
    toolNames: dedupe(calls.map((c) => c.name)),
    filesChanged: refs.length || editsOk,
    changedPaths: refs,
    failedExecs: execs.filter(([, r]) => callFailed(r)).length,
    checkRuns: checks.length,
    toolOutputs,
  };
  if (execs.length) lastTurn.lastExecFailed = callFailed(execs.at(-1)![1]);
  if (checks.length) lastTurn.lastCheckFailed = callFailed(checks.at(-1)![1]);

  return {
    session: { turnCount: session.completedCount },
    lastTurn,
    lastAgentMessage: agentMessageSignals(finalAgentText(evs)),
    user: { locale: localeOf(session.events.flatMap((e) => (e.type === 'message.user' ? [e.text] : []))) },
    state: { ...session.state },
  };
}

// ---- predicates -----------------------------------------------------------
export function resolve(signals: Signals, path: string): unknown {
  if (path.startsWith('state.')) return signals.state[path.slice('state.'.length)] ?? undefined;
  let cur: unknown = signals;
  for (const seg of path.split('.')) {
    if (Array.isArray(cur)) cur = /^\d+$/.test(seg) ? cur[Number(seg)] : undefined;
    else if (cur !== null && typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

const scalar = (x: unknown) => typeof x === 'string' || typeof x === 'boolean' || isNum(x);
const strictEq = (a: unknown, b: unknown) => scalar(a) && scalar(b) && a === b;
const regexCache = new Map<string, RegExp>();
export function compile(pattern: string): RegExp {
  let rx = regexCache.get(pattern);
  if (!rx) regexCache.set(pattern, (rx = new RegExp(pattern, 'u')));
  return rx;
}

export function holds(pred: Predicate, signals: Signals): boolean {
  if ('all' in pred) return pred.all.every((p) => holds(p, signals));
  if ('any' in pred) return pred.any.some((p) => holds(p, signals));
  if ('not' in pred) return !holds(pred.not, signals);
  const leaf: LeafPredicate = pred;
  const value = resolve(signals, leaf.signal);
  const ops = Object.entries(leaf).filter(([k]) => k !== 'signal');
  if (value === undefined) return ops.length === 1 && ops[0]![0] === 'exists' && ops[0]![1] === false;
  return ops.every(([op, arg]) => {
    switch (op) {
      case 'exists': return arg === true;
      case 'eq': return strictEq(value, arg);
      case 'ne': return !strictEq(value, arg);
      case 'gt': return isNum(value) && value > (arg as number);
      case 'gte': return isNum(value) && value >= (arg as number);
      case 'lt': return isNum(value) && value < (arg as number);
      case 'lte': return isNum(value) && value <= (arg as number);
      case 'in': return Array.isArray(arg) && arg.some((x) => strictEq(value, x));
      case 'contains':
        return Array.isArray(value)
          ? value.some((x) => strictEq(x, arg))
          : typeof value === 'string' && typeof arg === 'string' && value.includes(arg);
      case 'matches': return typeof value === 'string' && typeof arg === 'string' && compile(arg).test(value);
      default: return false;
    }
  });
}
