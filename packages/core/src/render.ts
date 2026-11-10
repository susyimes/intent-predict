// Slots, rendering and output checks (SPEC 4.7).
import type { ActionDescriptor, IntentSpec, Signals, SuppressedReason } from './types.ts';
import { compile, resolve } from './signals.ts';
import { DESTRUCTIVE_RE, PLACEHOLDER_RE, cpLength, isNum } from './text.ts';

/** Ends an evaluation with a suppression reason (SPEC 1.3 I1). */
export class Suppress extends Error {
  readonly reason: SuppressedReason;
  constructor(reason: SuppressedReason) {
    super(reason);
    this.reason = reason;
  }
}

const fail = (): never => {
  throw new Suppress('slot_validation_failed');
};
const CONTROL = /[\u0000-\u001f\u007f]/u;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;

export function resolveSlots(
  intent: IntentSpec, signals: Signals, modelSlots: Record<string, unknown>, convo: string,
  preset: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(intent.slots ?? {})) {
    let value: unknown = preset[name];
    let fromModel = false;
    if (value === undefined && spec.from) value = resolve(signals, spec.from);
    if (value === undefined && modelSlots[name] !== undefined && modelSlots[name] !== null) {
      value = modelSlots[name];
      fromModel = true;
    }
    if (value === undefined) value = spec.default ?? undefined;
    if (value === undefined || value === null || value === '') {
      if (spec.required) fail();
      continue;
    }
    if (spec.type === 'number') {
      if (typeof value === 'string' && NUMERIC.test(value)) value = Number(value);
      if (!isNum(value)) fail();
    } else if (typeof value !== 'string') {
      fail();
    } else if (spec.type === 'enum') {
      if (!(spec.enum ?? []).includes(value)) fail();
    } else {
      if (fromModel && !convo.includes(value)) fail();
      const control = CONTROL.test(value);
      if (spec.type === 'path' && (cpLength(value) > 120 || value.includes('..') || control || /[\s;|&$`><]/u.test(value))) fail();
      if (spec.type === 'string' && (cpLength(value) > (spec.maxLength ?? 80) || control)) fail();
    }
    if (spec.pattern && !compile(spec.pattern).test(String(value))) fail();
    out[name] = value;
  }
  return out;
}

function interpolate<T>(obj: T, slots: Record<string, unknown>): T {
  if (typeof obj === 'string') {
    return obj.replace(PLACEHOLDER_RE, (_, name: string) => (name in slots ? String(slots[name]) : fail())) as T;
  }
  if (Array.isArray(obj)) return obj.map((v) => interpolate(v, slots)) as T;
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, ['type', 'name', 'command'].includes(k) ? v : interpolate(v, slots)]),
    ) as T;
  }
  return obj;
}

export interface RenderedItem { slots: Record<string, unknown>; text: string; action?: ActionDescriptor }

export function commandString(action: ActionDescriptor | undefined): string | undefined {
  return action?.type === 'command' ? `${action.command} ${action.args ?? ''}`.trim() : undefined;
}

export function renderItem(intent: IntentSpec, slots: Record<string, unknown>, locale: string): RenderedItem {
  const render = intent.render;
  const template =
    typeof render === 'string'
      ? render
      : (render[locale] ?? render[locale.split('-')[0]!] ?? render['en'] ?? Object.values(render)[0]!);
  const text = interpolate(template, slots);
  const action = intent.action ? interpolate(intent.action, slots) : undefined;
  for (const s of [text, commandString(action)]) {
    if (s === undefined) continue;
    if (!s.trim() || /[\r\n]/.test(s) || cpLength(s) > 200) throw new Suppress('output_invalid');
    if (DESTRUCTIVE_RE.test(s)) throw new Suppress('output_dangerous');
  }
  return action ? { slots, text, action } : { slots, text };
}
