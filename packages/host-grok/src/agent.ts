// What the host needs from each agent CLI it can drive (Grok, Hermes, Codex, Kimi, Claude Code).
//
// Two rules hold for every adapter:
//  - A driven turn goes through the agent's own permission flow. No adapter runs a turn in a mode
//    that approves on the user's behalf, and a permission request that reaches the host is refused.
//  - Suggestions for a session are picked by that session's own agent and model (SPEC 6), with no
//    tools, and the classification call leaves nothing behind in the agent's session history.
import type { AgentEvent, SampleResult } from '../../core/src/index.ts';
import type { GrokLine, HistoryReplay } from './grok.ts';
import type { Bin } from './proc.ts';

export const AGENT_KINDS = ['grok', 'hermes', 'codex', 'kimi', 'claude'] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export const isAgentKind = (value: unknown): value is AgentKind => (AGENT_KINDS as readonly unknown[]).includes(value);

/** A concrete session of an agent. */
export interface AgentRef { kind: AgentKind; id: string; cwd: string; profile?: string }

export interface AgentEnv {
  home: string;
  hermesHome?: string;
  bins: Partial<Record<AgentKind, Bin>>;
  /** Grok only: model override and extra arguments for driven turns (e.g. `--allow` rules). */
  grokModel?: string;
  grokArgs: string[];
  /** A private directory for prompt files and classification calls. */
  scratch(): string;
  /** Writes `text` to a new file in scratch() and returns its path. */
  promptFile(text: string): string;
}

export interface TurnContext {
  env: AgentEnv;
  turnId: string;
  cwd: string;
  /** The session to continue; absent: the agent starts a new one. */
  id?: string;
  profile?: string;
  /** Receives the turn's events, ending with exactly one turn.completed. */
  emit(events: AgentEvent[]): void;
  /** Display hook: the agent's output in Grok's line format. */
  onLine?(line: GrokLine): void;
  info(message: string): void;
}

export interface SampleContext {
  env: AgentEnv;
  /** The bound session, whose model is used; absent for a session the host started itself. */
  ref?: AgentRef;
  signal: AbortSignal;
}

export interface Sample extends SampleResult {
  /** Runs after the result is returned, e.g. deleting what the classification call stored. */
  cleanup?: Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** Run one user turn; resolves with the agent's session id once the turn has ended. */
  runTurn(text: string, ctx: TurnContext): Promise<{ sessionId?: string }>;
  /** One classification call on the session's own model, without tools. */
  sample(prompt: string, ctx: SampleContext): Promise<Sample>;
  /** Completed turns from the session's own store: the last `maxTurns`, or all after `after` (> 0). */
  readHistory(ref: AgentRef, env: AgentEnv, maxTurns: number, makeTurnId: () => string, after: number): HistoryReplay | undefined;
  /** Where the store stands now (0 when unreadable): replay starts after it. */
  fingerprint(ref: AgentRef, env: AgentEnv): number;
  /** True when the user started a new turn in the session after `fingerprint`. */
  advanced(ref: AgentRef, env: AgentEnv, fingerprint: number): boolean;
  /** Why the session cannot take a turn from this host right now (another process has it open), if so. */
  busyElsewhere?(ref: AgentRef, env: AgentEnv): string | undefined;
}
