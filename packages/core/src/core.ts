// The core: session state, the pipeline of SPEC 4, and the action rules of SPEC 5.
import type {
  ActParams, ActStatus, AgentEvent, Alternative, Choice, CoreConfig, DispatchRequest, EvaluationRecord,
  EvaluationResult, GatePolicy, HostBridge, IntentSpec, InvalidatedParams, InvalidationReason, Options,
  OutcomeRecord, Prediction, SampleResult, SamplerMode, ScenarioPack, ScenarioSpec, Selected, Signals,
  SuppressedReason, Trace, UpdatedParams,
} from './types.ts';
import { INVALID_PARAMS, RpcError, SESSION_BUSY, TURN_MISMATCH } from './types.ts';
import { extractSignals, finalAgentText, holds, resolve, toolKind } from './signals.ts';
import { DEFAULT_PROMPT, renderPrompt, signalsJson, transcript } from './prompt.ts';
import { Suppress, commandString, renderItem, resolveSlots } from './render.ts';
import { cpLength, cut, cutStart, isNum, redact, similarity } from './text.ts';

export const DEFAULT_POLICY: GatePolicy = { minConfidence: 0.6, sideEffectMinConfidence: 0.8 };
export const DEFAULT_OPTIONS: Options = {
  enabled: true, blockedModes: ['plan'], settleMs: 150, timeoutMs: 4000, samplerMode: 'compact',
  cooldownTurnsAfterDismiss: 3, altMinConfidence: 0.15, redact: 'default', optionSets: true,
};
const MAX_TURNS = 50;
const MAX_EVENTS = 500;
const HOUR_MS = 3_600_000;

interface Evaluation {
  turnId: string; at: number; controller: AbortController; timer?: ReturnType<typeof setTimeout>;
  phase: 'settling' | 'running' | 'sampling'; done: boolean;
}
interface Session {
  id: string; events: AgentEvent[]; recentTurns: string[]; completedTurns: Set<string>; turnCount: number;
  state: Record<string, unknown>;
  live?: Prediction;                         // SPEC 5.1
  open?: { prediction: Prediction; copied: boolean; shownAt: number };   // outcome not finalized yet (5.4)
  delivered: number; cooldown: Map<string, number>; modelCalls: number[];
  recent: UpdatedParams[];                  // last evaluations, for surfaces attaching later (SPEC 8)
  evaluation?: Evaluation; dispatching?: string; touched: number;
}
type Listeners = { updated: Array<(p: UpdatedParams) => void>; invalidated: Array<(p: InvalidatedParams) => void> };

const str = (x: unknown): x is string => typeof x === 'string';
/** Accept only well-formed events of a type this version defines (SPEC 1.2); everything else is ignored. */
function known(raw: unknown): AgentEvent | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const turn = str(e.turnId) && e.turnId.length > 0;
  const ok = (() => {
    switch (e.type) {
      case 'turn.started': return turn && isNum(e.at);
      case 'message.user': case 'message.agent': return turn && str(e.text);
      case 'tool.call': return turn && str(e.callId) && str(e.name);
      case 'tool.result': return turn && str(e.callId) && ['ok', 'error', 'denied'].includes(e.status as string);
      case 'artifact': return turn && str(e.kind) && str(e.ref);
      case 'state': return str(e.key) && 'value' in e;
      case 'turn.completed': return turn && isNum(e.at) && ['completed', 'failed', 'interrupted'].includes(e.status as string);
      default: return false;
    }
  })();
  return ok ? (raw as AgentEvent) : undefined;
}

export class Core {
  readonly packs: ScenarioPack[];
  readonly policy: GatePolicy;
  readonly options: Options;
  private readonly host: HostBridge;
  private readonly config: CoreConfig;
  private readonly sessions = new Map<string, Session>();
  private readonly owners = new Map<string, string>();     // predictionId -> sessionId
  private readonly listeners: Listeners = { updated: [], invalidated: [] };
  private seq = 0;

  constructor(packs: ScenarioPack[], host: HostBridge = {}, config: CoreConfig = {}) {
    this.packs = packs;
    this.host = host;
    this.config = config;
    this.policy = { ...DEFAULT_POLICY, ...config.policy };
    this.options = { ...DEFAULT_OPTIONS, ...config.options };
  }

  on<K extends keyof Listeners>(event: K, listener: Listeners[K][number]): void {
    (this.listeners[event] as Array<typeof listener>).push(listener);
  }
  get dispatchModes() { return this.host.dispatchModes ?? []; }
  /** True while any evaluation is scheduled or running; `sampling` while one waits for the model. */
  get busy() { return [...this.sessions.values()].some((s) => s.evaluation); }
  get sampling() { return [...this.sessions.values()].some((s) => s.evaluation?.phase === 'sampling'); }
  snapshot(): Array<{ sessionId: string; live?: Prediction }> {
    return [...this.sessions.values()].map((s) => (s.live ? { sessionId: s.id, live: s.live } : { sessionId: s.id }));
  }

  /** A session's retained evaluations, oldest first, for a surface attaching after the fact. */
  recent(sessionId: string): UpdatedParams[] {
    return this.sessions.get(sessionId)?.recent ?? [];
  }

  // ---- events (SPEC 4.1, 5.1, 5.4) ---------------------------------------
  observe(sessionId: string, events: unknown[]): void {
    const s = this.session(sessionId);
    for (const raw of events) {
      const ev = known(raw);
      if (!ev) continue;
      if (ev.type === 'turn.completed' && s.completedTurns.has(ev.turnId)) continue;
      s.events.push(ev);
      const turnId = 'turnId' in ev ? ev.turnId : undefined;
      if (turnId !== undefined) {                          // another turn is under way
        if (s.evaluation && s.evaluation.turnId !== turnId) this.abort(s);
        if (s.live && s.live.sourceTurnId !== turnId) this.invalidate(s, 'turn_started');
      }
      if (ev.type === 'state') {
        s.state[ev.key] = ev.value;
      } else if (ev.type === 'message.user') {
        const open = s.open;
        // while a send is being dispatched, this message is its echo, not the user's own next message
        if (open && open.prediction.sourceTurnId !== turnId && s.dispatching !== open.prediction.id) {
          this.finalize(s, 'passed', { similarity: outcomeSimilarity(open.prediction, ev.text) });
        }
      } else if (ev.type === 'turn.completed') {
        if (s.open && s.dispatching !== s.open.prediction.id) this.finalize(s, 'expired');
        s.completedTurns.add(ev.turnId);
        s.recentTurns.push(ev.turnId);
        s.turnCount++;
        this.trim(s);
        this.schedule(s, ev.turnId, ev.at);
      }
    }
  }

  cancel(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.abort(s);
    this.invalidate(s, 'cancelled');
    if (s.open) this.finalize(s, 'expired');
  }

  /** Shut down: in-flight evaluations are aborted and open outcomes expire (SPEC 5.4, 7.5). */
  close(): void {
    for (const id of [...this.sessions.keys()]) {
      this.cancel(id);
      this.sessions.delete(id);
    }
  }

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id, events: [], recentTurns: [], completedTurns: new Set(), turnCount: 0, state: {},
        delivered: 0, cooldown: new Map(), modelCalls: [], recent: [], touched: 0,
      };
      this.sessions.set(id, s);
      const max = this.config.maxSessions ?? 64;
      if (this.sessions.size > max) {                      // SPEC 7.5: least recently used goes
        const oldest = [...this.sessions.values()].filter((x) => x !== s).sort((a, b) => a.touched - b.touched)[0]!;
        this.cancel(oldest.id);
        this.sessions.delete(oldest.id);
      }
    }
    s.touched = this.now();
    return s;
  }

  private trim(s: Session): void {
    while (s.recentTurns.length > MAX_TURNS || (s.events.length > MAX_EVENTS && s.recentTurns.length > 1)) {
      const dropped = s.recentTurns.shift()!;
      s.events = s.events.filter((e) => !('turnId' in e) || e.turnId !== dropped);
    }
  }

  private now(): number { return (this.config.now ?? Date.now)(); }

  private emitUpdated(s: Session, turnId: string, result: EvaluationResult, trace: Trace): void {
    const record: EvaluationRecord = {
      record: 'evaluation', timestamp: this.now(), sessionId: s.id, sourceTurnId: turnId,
      result: result.type === 'failed' ? 'failed' : result.prediction ? 'delivered' : 'suppressed',
    };
    if (result.type === 'completed') {
      if (result.prediction) {
        Object.assign(record, { predictionId: result.prediction.id, qualifiedIntentId: result.prediction.qualifiedIntentId });
        if (result.prediction.usage) record.usage = result.prediction.usage;
      } else {
        record.suppressedReason = result.suppressedReason;
      }
    }
    if (trace.scenarioId) record.scenarioId = trace.scenarioId;
    if (trace.source) record.source = trace.source;
    if (trace.confidence !== undefined) record.confidence = trace.confidence;
    if (trace.threshold !== undefined) record.threshold = trace.threshold;
    if (trace.samplerMode) record.samplerMode = trace.samplerMode;
    if (result.type === 'completed' && result.prediction?.optionSet) record.optionSet = true;
    this.config.telemetry?.(record);
    const params: UpdatedParams = { sessionId: s.id, sourceTurnId: turnId, result, trace, at: record.timestamp };
    s.recent.push(params);
    while (s.recent.length > 50) s.recent.shift();
    for (const l of this.listeners.updated) l(params);
  }

  private abort(s: Session): void {
    const ev = s.evaluation;
    if (!ev || ev.done) return;
    ev.done = true;
    s.evaluation = undefined;
    clearTimeout(ev.timer);
    ev.controller.abort();                                 // the host bridge turns this into sampler/cancel
    this.emitUpdated(s, ev.turnId, { type: 'completed', prediction: null, suppressedReason: 'aborted' }, {});
  }

  private invalidate(s: Session, reason: InvalidationReason): void {
    if (!s.live) return;
    const predictionId = s.live.id;
    s.live = undefined;
    for (const l of this.listeners.invalidated) l({ sessionId: s.id, predictionId, reason });
  }

  private finalize(s: Session, outcome: OutcomeRecord['outcome'], extra: Partial<OutcomeRecord> = {}): void {
    const open = s.open;
    if (!open) return;
    s.open = undefined;
    this.config.telemetry?.({
      record: 'outcome', timestamp: this.now(), sessionId: s.id, predictionId: open.prediction.id,
      qualifiedIntentId: open.prediction.qualifiedIntentId, outcome, copied: open.copied,
      msSinceShown: Math.max(0, this.now() - open.shownAt), ...extra,
    });
  }

  // ---- evaluation lifecycle (SPEC 4.1) -----------------------------------
  private schedule(s: Session, turnId: string, at: number): void {
    const ev: Evaluation = { turnId, at, controller: new AbortController(), phase: 'settling', done: false };
    s.evaluation = ev;
    if (this.options.settleMs > 0) ev.timer = setTimeout(() => void this.run(s, ev), this.options.settleMs);
    else void this.run(s, ev);
  }

  private async run(s: Session, ev: Evaluation): Promise<void> {
    if (ev.done) return;
    ev.phase = 'running';
    const trace: Trace = {};
    let result: EvaluationResult;
    try {
      result = { type: 'completed', prediction: await this.pipeline(s, ev, trace) };
    } catch (e) {
      if (e instanceof Suppress) result = { type: 'completed', prediction: null, suppressedReason: e.reason };
      else result = { type: 'failed', error: e instanceof Error ? e.message : String(e) };
    }
    if (ev.done) return;                                   // aborted meanwhile: already reported, reply discarded
    ev.done = true;
    s.evaluation = undefined;
    if (result.type === 'completed' && result.prediction) {
      const prediction = result.prediction;
      s.live = prediction;                                 // any older one was invalidated by this turn's events
      s.open = { prediction, copied: false, shownAt: this.now() };
      s.delivered++;
      this.owners.set(prediction.id, s.id);
      if (this.owners.size > 4096) this.owners.delete(this.owners.keys().next().value!);
    }
    this.emitUpdated(s, ev.turnId, result, trace);
  }

  private sample(s: Session, ev: Evaluation, mode: SamplerMode, prompt: string): Promise<SampleResult> {
    const signal = ev.controller.signal;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        reject(new Suppress('timeout'));
        ev.controller.abort();
      }, this.options.timeoutMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Suppress('aborted'));
      }, { once: true });
      this.host.sample!({ sessionId: s.id, expectedTurnId: ev.turnId, mode, prompt, maxOutputTokens: 120 }, signal).then(
        (r) => { clearTimeout(timer); resolvePromise(r); },
        () => { clearTimeout(timer); reject(new Suppress('sampler_error')); },
      );
    });
  }

  // ---- pipeline (SPEC 4.2 - 4.8) -----------------------------------------
  private async pipeline(s: Session, ev: Evaluation, trace: Trace): Promise<Prediction> {
    const { turnId, at } = ev;
    const opts = this.options;
    const sig = extractSignals({ events: s.events, completedCount: s.turnCount, state: s.state }, turnId);
    trace.signalsJson = signalsJson(sig);
    if (this.config.debugTrace) trace.signals = sig;
    const status = sig.lastTurn.status;
    const turnEvents = s.events.filter((e) => 'turnId' in e && e.turnId === turnId);
    const lastCall = turnEvents.findLast((e) => e.type === 'tool.call');
    const answered = new Set(turnEvents.flatMap((e) => (e.type === 'tool.result' ? [e.callId] : [])));
    const scenarios = this.packs.flatMap((pack) => pack.scenarios.map((scn) => ({ pack, scn })));
    const statuses = (scn: ScenarioSpec) => scn.triggerOnTurnStatuses ?? ['completed'];

    // 4.2 guards
    const guards: Array<[boolean, SuppressedReason]> = [
      [opts.enabled === false, 'disabled'],
      [this.host.interactive === false, 'non_interactive'],
      [s.state.pendingApproval === true || s.state.pendingInput === true
        || (lastCall?.type === 'tool.call' && toolKind(lastCall) === 'ask_user' && !answered.has(lastCall.callId)), 'pending_interaction'],
      [status === 'interrupted', 'interrupted_turn'],
      [status === 'failed' && !scenarios.some(({ scn }) => statuses(scn).includes('failed')), 'failed_turn_unhandled'],
      [str(s.state.mode) && opts.blockedModes.includes(s.state.mode), 'mode_blocked'],
      [s.state.incognito === true, 'incognito'],
      [opts.maxPerSession !== undefined && s.delivered >= opts.maxPerSession, 'max_per_session_reached'],
    ];
    for (const [tripped, reason] of guards) if (tripped) throw new Suppress(reason);

    // 4.3 routing and catalog
    const eligible = scenarios.filter(({ scn }) => (statuses(scn) as string[]).includes(status) && holds(scn.match, sig));
    const specific = eligible.filter(({ scn }) => !scn.fallback);
    const pool = specific.length ? specific : eligible;
    if (!pool.length) throw new Suppress('no_scenario_matched');
    const { pack, scn } = pool.reduce((best, x) => ((x.scn.priority ?? 0) > (best.scn.priority ?? 0) ? x : best));
    const finalText = finalAgentText(turnEvents);
    // a pass-through "yes" needs something to approve, and that something must look local
    const risky = !finalText.trim() || sig.lastAgentMessage.proposedRisk !== 'reversible';
    const enumerable = (it: IntentSpec) => {
      const over = resolve(sig, it.enumerate!.over);
      return Array.isArray(over) && over.length >= 2 && over.length <= 9 && over.every(str);
    };
    const catalog = scn.intents.filter((it) =>
      (!it.when || holds(it.when, sig)) && !(it.passThrough && risky) && (!it.enumerate || enumerable(it)));
    trace.scenarioId = scn.id;
    trace.catalog = catalog.map((it) => it.id);
    if (!catalog.length) throw new Suppress('empty_catalog');

    const locale = sig.user.locale;
    const strict = opts.redact === 'strict';
    const recent = s.recentTurns.slice(-3);
    const convo = s.events
      .filter((e) => 'turnId' in e && recent.includes(e.turnId))
      .flatMap((e) => (e.type === 'message.user' || e.type === 'message.agent' ? [e.text] : e.type === 'tool.result' && e.summary ? [e.summary] : []))
      .join('\n');
    const key = (it: IntentSpec) => `${pack.id}/${scn.id}#${it.id}`;
    const cooling = (it: IntentSpec) => (s.cooldown.get(key(it)) ?? 0) >= sig.session.turnCount;

    // 4.4 rules
    let selected: IntentSpec | undefined;
    let source: 'rule' | 'model' = 'rule';
    let confidence: number | null = null;
    let modelSlots: Record<string, unknown> = {};
    let runnerUps: Array<{ intent: string; confidence: number; slots?: unknown }> = [];
    let choices: Choice[] | undefined;
    let preferred: number | undefined;
    let usage: Prediction['usage'];

    for (const hint of [...sig.lastAgentMessage.hints].reverse()) {       // R1
      const value = hint.value.trim().toLowerCase();
      selected = catalog.find((it) => {
        if (it.risk === 'side_effect' || it.enumerate) return false;
        const byCommand = hint.kind === 'slash' && it.action?.type === 'command' && it.action.command.toLowerCase() === value;
        if (!byCommand && !(it.examples ?? []).some((e) => e.trim().toLowerCase() === value)) return false;
        try {
          resolveSlots(it, sig, {}, convo);
          return true;
        } catch {
          return false;
        }
      });
      if (selected) break;
    }
    if (!selected) {                                                      // R2
      selected = catalog.find((it) => it.enumerate);
      if (selected) {
        const en = selected.enumerate!;
        const items = resolve(sig, en.over) as string[];
        choices = items.map((item, k) => {
          const r = renderItem(selected!, resolveSlots(selected!, sig, {}, convo, { [en.slot]: k + 1 }), locale);
          return { slots: r.slots, text: r.text, label: cut(redact(item, strict), 80) };
        });
        const pos = en.preferred ? resolve(sig, en.preferred) : undefined;
        if (isNum(pos) && pos >= 1 && pos <= choices.length) preferred = Math.trunc(pos) - 1;
      }
    }

    // 4.5 model
    const byId = new Map(catalog.map((it) => [it.id, it]));
    if (!selected) {
      source = 'model';
      const modes = this.host.samplerModes ?? [];
      if (!modes.length || !this.host.sample) throw new Suppress('no_sampler');
      s.modelCalls = s.modelCalls.filter((t) => at - t < HOUR_MS);
      if (opts.modelBudget && s.modelCalls.length >= opts.modelBudget.maxCallsPerHour) throw new Suppress('budget_exhausted');
      const mode = modes.includes(opts.samplerMode) ? opts.samplerMode : modes[0]!;
      trace.samplerMode = mode;
      const template = pack.promptTemplate || DEFAULT_PROMPT;
      const fits = (p: string) => (mode === 'fork' ? Buffer.byteLength(p, 'utf8') <= 4000 : cpLength(p) <= 8000);
      let turns = recent;
      const build = (withExamples: boolean) =>
        renderPrompt(template, scn, catalog, sig, mode, transcript(s.events, turns, strict), withExamples);
      let prompt = build(true);
      if (!fits(prompt)) prompt = build(false);
      while (!fits(prompt) && mode === 'compact' && turns.length) {
        turns = turns.slice(1);
        prompt = build(false);
      }
      if (this.config.debugTrace) trace.prompt = prompt;
      if (!fits(prompt)) throw new Suppress('prompt_too_large');

      s.modelCalls.push(at);
      ev.phase = 'sampling';
      const started = this.now();
      const sampled = await this.sample(s, ev, mode, prompt);
      ev.phase = 'running';
      usage = { ...sampled.usage, latencyMs: Math.max(0, this.now() - started) };
      if (!str(sampled.text) || !sampled.text.trim()) throw new Suppress('invalid_model_output');

      const body = sampled.text.trim();
      const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(body);
      let reply: unknown;
      try {
        reply = JSON.parse(fenced ? fenced[1]! : body);
      } catch {
        throw new Suppress('invalid_model_output');
      }
      const validConf = (c: unknown): c is number => isNum(c) && c >= 0 && c <= 1;
      const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
      if (!isObj(reply) || !validConf(reply.confidence) || ('slots' in reply && !isObj(reply.slots))) {
        throw new Suppress('invalid_model_output');
      }
      if (!str(reply.intent) || (reply.intent !== 'none' && !byId.has(reply.intent))) throw new Suppress('unknown_intent');
      if (reply.intent === 'none') throw new Suppress('model_none');
      selected = byId.get(reply.intent)!;
      confidence = reply.confidence;
      modelSlots = (reply.slots as Record<string, unknown> | undefined) ?? {};
      for (const ru of Array.isArray(reply.runnerUps) ? reply.runnerUps : []) {
        if (isObj(ru) && str(ru.intent) && byId.has(ru.intent) && ru.intent !== selected.id
          && !runnerUps.some((r) => r.intent === ru.intent) && validConf(ru.confidence)) {
          runnerUps.push({ intent: ru.intent, confidence: ru.confidence, slots: ru.slots });
        }
      }
      runnerUps = runnerUps.slice(0, 2);
    }

    // A runner-up that may be offered next to the primary (4.6 option sets, 4.8 alternatives); one that
    // fails is dropped silently, it never suppresses the prediction.
    const offerable = (ru: (typeof runnerUps)[number]): Alternative | undefined => {
      const it = byId.get(ru.intent)!;
      if (ru.confidence < opts.altMinConfidence || it.risk === 'side_effect' || cooling(it)) return undefined;
      try {
        const slots = ru.slots !== null && typeof ru.slots === 'object' ? (ru.slots as Record<string, unknown>) : {};
        const alt = renderItem(it, resolveSlots(it, sig, slots, convo), locale);
        return { intentId: it.id, confidence: ru.confidence, ...alt, risk: it.risk, passThrough: !!it.passThrough };
      } catch (e) {
        if (!(e instanceof Suppress)) throw e;
        return undefined;
      }
    };

    // 4.6 gate
    trace.selected = selected.id;
    trace.source = source;
    trace.confidence = confidence;
    if (cooling(selected)) throw new Suppress('in_cooldown');
    let set: { primary: ReturnType<typeof renderItem>; alternatives: Alternative[] } | undefined;
    if (source === 'model') {
      const name = selected.risk === 'side_effect' ? 'sideEffectMinConfidence' : 'minConfidence';
      const threshold = Math.max(this.policy[name], pack.policy?.[name] ?? 0, scn.policy?.[name] ?? 0);
      trace.threshold = threshold;
      if (confidence! < threshold) {
        // an option set: the first choice and as few runner-ups as it takes to reach the threshold together
        const reached = (sum: number) => sum >= threshold - 1e-9;
        let first: ReturnType<typeof renderItem> | undefined;
        const others: Alternative[] = [];
        let sum = confidence!;
        if (opts.optionSets && selected.risk !== 'side_effect' && confidence! >= opts.altMinConfidence) {
          try {
            first = renderItem(selected, resolveSlots(selected, sig, modelSlots, convo), locale);
          } catch (e) {
            if (!(e instanceof Suppress)) throw e;
          }
          for (const ru of first ? runnerUps : []) {
            if (reached(sum)) break;
            const member = offerable(ru);
            if (member) {
              others.push(member);
              sum += member.confidence;
            }
          }
        }
        if (!first || !others.length || !reached(sum)) throw new Suppress('below_min_confidence');
        set = { primary: first, alternatives: others };
        trace.optionSet = [selected.id, ...others.map((o) => o.intentId)];
      }
    }

    // 4.7 slots, rendering, output checks
    const primary = set
      ? set.primary
      : choices
        ? { slots: choices[preferred ?? 0]!.slots, text: choices[preferred ?? 0]!.text, action: undefined }
        : renderItem(selected, resolveSlots(selected, sig, modelSlots, convo), locale);

    // 4.8 assembly
    const alternatives: Alternative[] = set
      ? set.alternatives
      : runnerUps.map(offerable).filter((a): a is Alternative => a !== undefined);

    const prediction: Prediction = {
      id: this.config.newId?.() ?? `p-${Date.now().toString(36)}-${++this.seq}`,
      sessionId: s.id, sourceTurnId: turnId,
      packId: pack.id, packVersion: pack.version, scenarioId: scn.id,
      qualifiedIntentId: `${pack.id}@${pack.version}/${scn.id}#${selected.id}`,
      intent: { id: selected.id, confidence, slots: primary.slots },
      text: primary.text, locale, risk: selected.risk, passThrough: !!selected.passThrough,
      confirmBeforeSend: selected.risk === 'side_effect',
      alternatives, source, createdAt: this.now(),
    };
    if (primary.action) prediction.action = primary.action;
    if (set) prediction.optionSet = true;
    if (choices) {
      prediction.choices = choices;
      if (preferred !== undefined) prediction.preferredChoice = preferred;
    }
    if (prediction.passThrough || alternatives.some((a) => a.passThrough)) {
      prediction.context = { excerpt: cutStart(redact(finalText, strict), 300) };
    }
    if (usage) prediction.usage = usage;
    return prediction;
  }

  // ---- surface actions (SPEC 5.2, 5.3) -----------------------------------
  async act(params: ActParams): Promise<ActStatus> {
    const s = this.sessions.get(this.owners.get(params.predictionId) ?? '');
    if (!s) return 'stale';
    if (params.action === 'copy') {
      if (s.open?.prediction.id === params.predictionId) s.open.copied = true;
      return 'recorded';
    }
    const p = s.live?.id === params.predictionId ? s.live : undefined;
    if (!p) return 'stale';
    if (params.action === 'dismiss') {
      // the user turned down every option of a set, not just the first
      for (const id of [p.intent.id, ...(p.optionSet ? p.alternatives.map((a) => a.intentId) : [])]) {
        s.cooldown.set(`${p.packId}/${p.scenarioId}#${id}`, s.turnCount + this.options.cooldownTurnsAfterDismiss);
      }
      this.finalize(s, 'dismissed');
      this.invalidate(s, 'resolved');
      return 'recorded';
    }

    let item: { text: string; action?: Prediction['action'] } = p;
    let selected: Selected = { kind: 'primary' };
    let needsConfirm = p.confirmBeforeSend;
    if (params.choice !== undefined) {
      const choice = p.choices?.[params.choice];
      if (!Number.isInteger(params.choice) || !choice) throw new RpcError(INVALID_PARAMS, 'no such choice');
      item = { text: choice.text, action: p.action };
      selected = { kind: 'choice', index: params.choice };
    } else if (params.alternative !== undefined) {
      const alt = p.alternatives.find((a) => a.intentId === params.alternative);
      if (!alt) throw new RpcError(INVALID_PARAMS, 'no such alternative');
      item = alt;
      selected = { kind: 'alternative', intentId: alt.intentId };
      needsConfirm = false;
    }
    const text = params.text;
    if (!str(text) || !text.trim() || cpLength(text) > 4000) throw new RpcError(INVALID_PARAMS, 'send needs 1-4000 characters of text');
    if (needsConfirm && params.confirmed !== true) return 'confirmation_required';

    const modes = this.dispatchModes;
    const base = { sessionId: s.id, expectedTurnId: p.sourceTurnId, predictionId: p.id };
    let request: DispatchRequest;
    if (text === item.text && item.action?.type === 'command' && modes.includes('command')) {
      request = { method: 'dispatch/command', command: item.action.command, ...base };
      if (item.action.args) request.args = item.action.args;
    } else if (modes.includes('message')) {
      request = { method: 'dispatch/message', text, ...base };
    } else {
      return 'unsupported';
    }
    if (!this.host.dispatch) return 'unsupported';
    if (s.dispatching) return 'busy';                      // one send at a time: no double dispatch on a double click

    s.dispatching = p.id;
    try {
      await this.host.dispatch(request);
    } catch (e) {
      const code = e instanceof RpcError ? e.code : undefined;
      if (code === TURN_MISMATCH) {
        if (s.live?.id === p.id) this.invalidate(s, 'turn_started');
        return 'stale';
      }
      return code === SESSION_BUSY ? 'busy' : 'failed';
    } finally {
      s.dispatching = undefined;
    }
    if (s.open?.prediction.id === p.id) this.finalize(s, 'sent', { edited: text !== item.text, selected });
    if (s.live?.id === p.id) this.invalidate(s, 'resolved');
    return 'dispatched';
  }
}

function outcomeSimilarity(p: Prediction, text: string): number {
  const candidates = [p.text, ...(p.choices ?? []).map((c) => c.text), ...p.alternatives.map((a) => a.text)];
  for (const item of [p, ...p.alternatives]) {
    const command = commandString(item.action);
    if (command) candidates.push(command);
  }
  return Math.round(Math.max(...candidates.map((c) => similarity(c, text))) * 1e4) / 1e4;
}

export type { Signals };
