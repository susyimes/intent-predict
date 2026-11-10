// Pack loading and the load-time rules of SPEC 3.1 / 3.2.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { IntentSpec, Predicate, ScenarioPack } from './types.ts';
import { PLACEHOLDER_RE } from './text.ts';

/** Split an INTENTS.md into its YAML front matter and Markdown body. */
export function parseIntentsMarkdown(text: string): ScenarioPack {
  const lines = text.split(/\r?\n/);
  const marks = lines.flatMap((l, i) => (l.trim() === '---' ? [i] : []));
  if (marks.length < 2 || marks[0] !== 0) throw new Error("a pack file must start with '---' and close its front matter with '---'");
  const pack = parseYaml(lines.slice(1, marks[1]).join('\n')) as ScenarioPack;
  const body = lines.slice(marks[1]! + 1).join('\n').replace(/^\n+|\n+$/g, '');
  if (body.trim()) pack.promptTemplate = body + '\n';
  return pack;
}

export function loadPackFile(path: string): ScenarioPack {
  const text = readFileSync(path, 'utf8');
  const pack = path.endsWith('.json') ? (JSON.parse(text) as ScenarioPack) : parseIntentsMarkdown(text);
  const errors = packErrors(pack);
  if (errors.length) throw new Error(`invalid pack ${path}: ${errors.slice(0, 5).join('; ')}`);
  return pack;
}

const RISKS = ['none', 'read_only', 'reversible', 'side_effect'];
const LEAF_OPS = ['signal', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'matches', 'exists'];
const KEYS = {
  pack: ['id', 'version', 'description', 'policy', 'promptTemplate', 'scenarios'],
  scenario: ['id', 'description', 'priority', 'fallback', 'triggerOnTurnStatuses', 'match', 'intents', 'policy'],
  intent: ['id', 'description', 'examples', 'when', 'slots', 'enumerate', 'render', 'risk', 'passThrough', 'action'],
  slot: ['type', 'description', 'enum', 'from', 'pattern', 'maxLength', 'required', 'default'],
  policy: ['minConfidence', 'sideEffectMinConfidence'],
};

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

function placeholders(obj: unknown): string[] {
  if (typeof obj === 'string') return [...obj.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!);
  if (Array.isArray(obj)) return obj.flatMap(placeholders);
  if (isObj(obj)) return Object.values(obj).flatMap(placeholders);
  return [];
}

/** Returns every violation; an empty list means the pack may be loaded. */
export function packErrors(pack: unknown): string[] {
  const errs: string[] = [];
  const unknownKeys = (obj: Record<string, unknown>, allowed: string[], where: string) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push(`${where}: unknown key '${k}'`);
  };
  const regexes: Array<[string, string]> = [];
  const predicate = (p: unknown, where: string) => {
    if (!isObj(p)) return void errs.push(`${where}: predicate must be an object`);
    const pred = p as Predicate;
    if ('all' in pred || 'any' in pred) {
      const list = 'all' in pred ? pred.all : pred.any;
      if (!Array.isArray(list) || !list.length || Object.keys(p).length !== 1) return void errs.push(`${where}: bad all/any`);
      list.forEach((q) => predicate(q, where));
    } else if ('not' in pred) {
      if (Object.keys(p).length !== 1) errs.push(`${where}: bad not`);
      predicate(pred.not, where);
    } else {
      if (!isStr(p.signal)) errs.push(`${where}: leaf predicate needs 'signal'`);
      unknownKeys(p, LEAF_OPS, where);
      if (p.matches !== undefined) regexes.push([where, String(p.matches)]);
    }
  };
  const policy = (p: unknown, where: string) => {
    if (p === undefined) return;
    if (!isObj(p)) return void errs.push(`${where}: policy must be an object`);
    unknownKeys(p, KEYS.policy, where);
    for (const v of Object.values(p)) if (typeof v !== 'number' || v < 0 || v > 1) errs.push(`${where}: thresholds are numbers in [0, 1]`);
  };

  if (!isObj(pack)) return ['pack must be an object'];
  unknownKeys(pack, KEYS.pack, 'pack');
  if (!isStr(pack.id) || !/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/.test(pack.id)) errs.push('pack.id is missing or malformed');
  if (!isStr(pack.version) || !/^\d+\.\d+\.\d+/.test(pack.version)) errs.push('pack.version must be a SemVer string');
  policy(pack.policy, 'pack.policy');
  if (!Array.isArray(pack.scenarios) || !pack.scenarios.length) return [...errs, 'pack.scenarios must be a non-empty list'];

  const scenarioIds = new Set<string>();
  for (const scn of pack.scenarios as unknown[]) {
    if (!isObj(scn) || !isStr(scn.id)) {
      errs.push('every scenario needs an id');
      continue;
    }
    const sw = scn.id;
    unknownKeys(scn, KEYS.scenario, sw);
    if (scenarioIds.has(sw)) errs.push(`duplicate scenario id ${sw}`);
    scenarioIds.add(sw);
    if (!isStr(scn.description) || scn.description.length > 160) errs.push(`${sw}: description is required, at most 160 characters`);
    if (scn.priority !== undefined && !Number.isInteger(scn.priority)) errs.push(`${sw}: priority must be an integer`);
    const statuses = scn.triggerOnTurnStatuses;
    if (statuses !== undefined && !(Array.isArray(statuses) && statuses.length && statuses.every((s) => s === 'completed' || s === 'failed'))) {
      errs.push(`${sw}: triggerOnTurnStatuses lists 'completed' and/or 'failed'`);
    }
    predicate(scn.match, `${sw}.match`);
    policy(scn.policy, `${sw}.policy`);
    if (!Array.isArray(scn.intents) || !scn.intents.length || scn.intents.length > 15) {
      errs.push(`${sw}: needs 1 to 15 intents`);
      continue;
    }
    const intentIds = new Set<string>();
    for (const raw of scn.intents as unknown[]) {
      if (!isObj(raw) || !isStr(raw.id)) {
        errs.push(`${sw}: every intent needs an id`);
        continue;
      }
      const it = raw as unknown as IntentSpec;
      const where = `${sw}#${it.id}`;
      unknownKeys(raw, KEYS.intent, where);
      if (!/^[a-z][a-z0-9_]*$/.test(it.id) || it.id === 'none') errs.push(`${where}: bad intent id`);
      if (intentIds.has(it.id)) errs.push(`duplicate intent id ${where}`);
      intentIds.add(it.id);
      if (!isStr(it.description) || it.description.length > 80) errs.push(`${where}: description is required, at most 80 characters`);
      if (!RISKS.includes(it.risk)) errs.push(`${where}: risk must be one of ${RISKS.join(', ')}`);
      const renderOk = isStr(it.render) || (isObj(it.render) && Object.values(it.render).length > 0 && Object.values(it.render).every(isStr));
      if (!renderOk) errs.push(`${where}: render is required (a template or templates by locale)`);
      if (it.when !== undefined) predicate(it.when, `${where}.when`);
      const slots = it.slots ?? {};
      if (!isObj(slots)) errs.push(`${where}: slots must be an object`);
      for (const [name, slot] of Object.entries(isObj(slots) ? slots : {})) {
        if (!isObj(slot) || !['string', 'number', 'enum', 'path'].includes(String(slot.type))) {
          errs.push(`${where}: slot ${name} needs a type`);
          continue;
        }
        unknownKeys(slot, KEYS.slot, `${where}.${name}`);
        if (slot.pattern !== undefined) regexes.push([`${where}.${name}`, String(slot.pattern)]);
      }
      // SPEC 3.2 rules 2-4
      if (it.passThrough && !['reversible', 'side_effect'].includes(it.risk)) errs.push(`${where}: passThrough requires risk reversible or side_effect`);
      if (it.enumerate) {
        if (slots[it.enumerate.slot]?.type !== 'number') errs.push(`${where}: enumerate.slot must name a number slot`);
        if (it.risk === 'side_effect') errs.push(`${where}: enumerate intents cannot be side_effect`);
        if (it.action) errs.push(`${where}: enumerate intents cannot declare an action`);
      }
      for (const name of [...placeholders(it.render), ...placeholders(it.action)]) {
        if (!(name in slots)) errs.push(`${where}: placeholder {${name}} is not a declared slot`);
      }
    }
  }
  // SPEC 3.2 rule 5
  for (const [where, pattern] of regexes) {
    try {
      if (pattern.length > 256) throw new Error('longer than 256 characters');
      new RegExp(pattern, 'u');
    } catch (e) {
      errs.push(`${where}: bad regex ${JSON.stringify(pattern)}: ${(e as Error).message}`);
    }
  }
  return errs;
}
