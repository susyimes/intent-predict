// Shapes mirror spec/*.schema.json; where they disagree the schemas govern.

export type ToolKind = 'read' | 'search' | 'edit' | 'delete' | 'execute' | 'fetch' | 'ask_user' | 'other';
export type Risk = 'none' | 'read_only' | 'reversible' | 'side_effect';
export type ProposedRisk = 'reversible' | 'side_effect' | 'irreversible';
export type SamplerMode = 'fork' | 'compact';
export type DispatchMode = 'message' | 'command';

// ---- events (spec/events.schema.json) -----------------------------------
export interface TurnStarted { type: 'turn.started'; turnId: string; at: number }
export interface MessageUser { type: 'message.user'; turnId: string; text: string }
export interface MessageAgent { type: 'message.agent'; turnId: string; text: string; final?: boolean }
export interface ToolCall {
  type: 'tool.call'; turnId: string; callId: string; name: string;
  kind?: ToolKind; command?: string; check?: boolean; input?: unknown;
}
export interface ToolResult {
  type: 'tool.result'; turnId: string; callId: string; status: 'ok' | 'error' | 'denied';
  exitCode?: number; summary?: string; output?: unknown;
}
export interface Artifact { type: 'artifact'; turnId: string; kind: string; ref: string }
export interface StateEvent { type: 'state'; key: string; value: unknown }
export interface TurnCompleted {
  type: 'turn.completed'; turnId: string; status: 'completed' | 'failed' | 'interrupted'; at: number;
}
export type AgentEvent =
  | TurnStarted | MessageUser | MessageAgent | ToolCall | ToolResult | Artifact | StateEvent | TurnCompleted;

// ---- packs (spec/scenario-pack.schema.json) -----------------------------
export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | LeafPredicate;
export interface LeafPredicate {
  signal: string;
  eq?: unknown; ne?: unknown; gt?: number; gte?: number; lt?: number; lte?: number;
  in?: unknown[]; contains?: unknown; matches?: string; exists?: boolean;
}
export interface SlotSpec {
  type: 'string' | 'number' | 'enum' | 'path';
  description?: string; enum?: string[]; from?: string; pattern?: string;
  maxLength?: number; required?: boolean; default?: unknown;
}
export type ActionDescriptor =
  | { type: 'command'; command: string; args?: string }
  | { type: 'tool'; name: string; input: Record<string, unknown> }
  | { type: 'custom'; name: string; payload?: unknown };
export interface GatePolicy { minConfidence: number; sideEffectMinConfidence: number }
export interface IntentSpec {
  id: string; description: string; examples?: string[]; when?: Predicate;
  slots?: Record<string, SlotSpec>;
  enumerate?: { slot: string; over: string; preferred?: string };
  render: string | Record<string, string>;
  risk: Risk; passThrough?: boolean; action?: ActionDescriptor;
}
export interface ScenarioSpec {
  id: string; description: string; priority?: number; fallback?: boolean;
  triggerOnTurnStatuses?: Array<'completed' | 'failed'>;
  match: Predicate; intents: IntentSpec[]; policy?: Partial<GatePolicy>;
}
export interface ScenarioPack {
  id: string; version: string; description?: string; policy?: Partial<GatePolicy>;
  promptTemplate?: string; scenarios: ScenarioSpec[];
}

// ---- predictions (spec/prediction.schema.json) --------------------------
export type SuppressedReason =
  | 'disabled' | 'non_interactive' | 'pending_interaction' | 'interrupted_turn' | 'failed_turn_unhandled'
  | 'mode_blocked' | 'incognito' | 'max_per_session_reached' | 'no_scenario_matched' | 'empty_catalog'
  | 'no_sampler' | 'budget_exhausted' | 'prompt_too_large' | 'sampler_error' | 'timeout' | 'aborted'
  | 'invalid_model_output' | 'unknown_intent' | 'model_none' | 'in_cooldown' | 'below_min_confidence'
  | 'slot_validation_failed' | 'output_invalid' | 'output_dangerous';

export interface Choice { slots: Record<string, unknown>; text: string; label: string }
export interface Alternative {
  intentId: string; confidence: number; slots: Record<string, unknown>; text: string;
  risk: Risk; passThrough: boolean; action?: ActionDescriptor;
}
export interface Usage { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; latencyMs: number }
export interface Prediction {
  id: string; sessionId: string; sourceTurnId: string;
  packId: string; packVersion: string; scenarioId: string; qualifiedIntentId: string;
  intent: { id: string; confidence: number | null; slots: Record<string, unknown> };
  text: string; locale: string; risk: Risk; passThrough: boolean; confirmBeforeSend: boolean;
  context?: { excerpt: string };
  action?: ActionDescriptor;
  choices?: Choice[]; preferredChoice?: number;
  alternatives: Alternative[];
  /** An option set (SPEC 4.6): the primary and its alternatives are equal options, none preselected. */
  optionSet?: true;
  source: 'rule' | 'model';
  createdAt: number; usage?: Usage;
}
export type EvaluationResult =
  | { type: 'completed'; prediction: Prediction }
  | { type: 'completed'; prediction: null; suppressedReason: SuppressedReason }
  | { type: 'failed'; error: string };

/** Diagnostics for inspector surfaces and tests; not part of conformance (SPEC 8). */
export interface Trace {
  scenarioId?: string; catalog?: string[]; selected?: string; source?: 'rule' | 'model';
  confidence?: number | null; threshold?: number; samplerMode?: SamplerMode;
  /** The intents of an option set, primary first. */
  optionSet?: string[];
  signalsJson?: string;
  /** Only with `debugTrace`: unredacted, never sent to a surface. */
  signals?: Signals; prompt?: string;
}
export interface UpdatedParams { sessionId: string; sourceTurnId: string; result: EvaluationResult; trace?: Trace; at?: number }
export type InvalidationReason = 'turn_started' | 'resolved' | 'cancelled';
export interface InvalidatedParams { sessionId: string; predictionId: string; reason: InvalidationReason }

// ---- telemetry (spec/feedback.schema.json) ------------------------------
export interface EvaluationRecord {
  record: 'evaluation'; timestamp: number; sessionId: string; sourceTurnId: string;
  result: 'delivered' | 'suppressed' | 'failed'; suppressedReason?: SuppressedReason;
  predictionId?: string; qualifiedIntentId?: string; scenarioId?: string; source?: 'rule' | 'model';
  confidence?: number | null; threshold?: number; samplerMode?: SamplerMode; usage?: Usage;
  optionSet?: true;
}
export type Selected =
  | { kind: 'primary' } | { kind: 'choice'; index: number } | { kind: 'alternative'; intentId: string };
export interface OutcomeRecord {
  record: 'outcome'; timestamp: number; sessionId: string; predictionId: string; qualifiedIntentId: string;
  outcome: 'sent' | 'dismissed' | 'passed' | 'expired';
  selected?: Selected; edited?: boolean; copied?: boolean; similarity?: number; msSinceShown?: number;
}
export type TelemetryRecord = EvaluationRecord | OutcomeRecord;

// ---- host bridge and configuration --------------------------------------
export interface SampleRequest {
  sessionId: string; expectedTurnId: string; mode: SamplerMode; prompt: string; maxOutputTokens: number;
}
export interface SampleResult {
  text: string | null;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number };
}
export type DispatchRequest =
  | { method: 'dispatch/message'; sessionId: string; text: string; expectedTurnId: string; predictionId: string }
  | { method: 'dispatch/command'; sessionId: string; command: string; args?: string; expectedTurnId: string; predictionId: string };

/** What the host lends the core (SPEC 5.3, 6). Both calls reject with an RpcError on refusal. */
export interface HostBridge {
  interactive?: boolean;
  samplerModes?: SamplerMode[];
  dispatchModes?: DispatchMode[];
  sample?(request: SampleRequest, signal: AbortSignal): Promise<SampleResult>;
  dispatch?(request: DispatchRequest): Promise<void>;
}

export interface Options {
  enabled: boolean; blockedModes: string[]; settleMs: number; timeoutMs: number; samplerMode: SamplerMode;
  modelBudget?: { maxCallsPerHour: number }; maxPerSession?: number;
  cooldownTurnsAfterDismiss: number; altMinConfidence: number; redact: 'default' | 'strict';
  /** Offer an option set when the first choice alone is below minConfidence (SPEC 4.6). */
  optionSets: boolean;
}
export interface CoreConfig {
  policy?: Partial<GatePolicy>;
  options?: Partial<Options>;
  telemetry?: (record: TelemetryRecord) => void;
  now?: () => number;
  newId?: () => string;
  /** Attach unredacted signals and the rendered prompt to traces. For tests only. */
  debugTrace?: boolean;
  maxSessions?: number;
}

export interface ActParams {
  predictionId: string; action: 'send' | 'copy' | 'dismiss';
  text?: string; choice?: number; alternative?: string; confirmed?: boolean;
}
export type ActStatus =
  | 'dispatched' | 'recorded' | 'stale' | 'busy' | 'confirmation_required' | 'unsupported' | 'failed';

export interface Hint { kind: 'slash' | 'type_literal'; value: string }
export interface Signals {
  session: { turnCount: number };
  lastTurn: {
    status: string; toolKinds: ToolKind[]; toolNames: string[]; filesChanged: number; changedPaths: string[];
    failedExecs: number; checkRuns: number; lastExecFailed?: boolean; lastCheckFailed?: boolean;
    toolOutputs: Record<string, unknown>;
  };
  lastAgentMessage: {
    length: number; tail: string; endsWithQuestion: boolean; optionsCount: number; optionsPrompted: boolean;
    options?: string[]; preferredOptionIndex?: number; hints: Hint[]; proposedRisk: ProposedRisk;
  };
  user: { locale: string };
  state: Record<string, unknown>;
}

export const SESSION_BUSY = -32001;
export const TURN_MISMATCH = -32002;
export const SAMPLER_ABORTED = -32003;
export const UNAUTHORIZED = -32004;
export const INVALID_PARAMS = -32602;

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
