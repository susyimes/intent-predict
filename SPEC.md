# Intent-Predict Specification (SPEC.md)

Status: Draft v1.0 (Language-Agnostic, Symphony-Style Implementation Contract)

Purpose: Define a deterministic-outer-shell + prompt-contract system that upgrades any host coding or general agent into an **Intent Predict Agent**, evolving across three observation stages (**O1 Single-Session → O2 Agent-Wide → O3 Global Environment**) and three agency stages (**A1 Suggest-Only → A2 Speculative-Prep → A3 Propose-and-Dispatch**).

> **How to use this specification with a coding agent:**
>
> `"Implement intent-predict for <target host/language> according to https://github.com/susyimes/intent-predict/blob/main/SPEC.md and verify conformance against eval/golden.jsonl."`

---

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this specification does not prescribe one universal policy. Implementations MUST document the selected behavior.

---

## 1. Problem Statement & Core Architecture

Open-ended next-message prediction (generating an arbitrary sentence after every turn) suffers from four structural problems: it cannot be offline-evaluated as classification, it cannot bind deterministic actions or per-intent risk policies, it is tightly coupled to a single host UI, and it wastes model calls when no meaningful next step exists.

`intent-predict` solves this by combining:

1. **Bounded Scenarios (`INTENTS.md`)**: Repository-versioned or bundled Markdown contracts with YAML front matter (declaring trigger predicates, a closed catalog of 3–15 intents + `none`, risk levels, slots, and gate overrides) and a Markdown prompt body (the classification instructions).
2. **Deterministic Safety Shell**: Strict signal extraction, proposed-action risk scanning (`proposedRisk`), per-intent gating, atomic slot/action interpolation, and a 9-rule post-filter pipeline that fails closed on any anomaly.
3. **Zero-Config Host Sampler Delegation**: Implementations reuse the host agent's own model connection (`fork` mode sharing the prompt cache prefix, or `compact` mode using the host's active/auxiliary model after SDK redaction).

### 1.1 Two Orthogonal Evolution Axes

Implementations MUST structure capabilities along two orthogonal 3-stage axes so hosts can adopt incrementally without re-architecting:

```mermaid
flowchart TB
  subgraph ObsAxis["观察范围演进（Observation Stages: O1 → O2 → O3）"]
    direction LR
    O1["Stage O1：观察单一会话<br/>(Single-Session)<br/>仅当前 thread 的消息、工具调用与文件产物"]
    O2["Stage O2：观察整个 Agent<br/>(Agent-Wide)<br/>跨会话/子 Agent/后台任务/Kanban/审批与运行时状态"]
    O3["Stage O3：观察全局环境<br/>(Global / Ambient)<br/>外部终端命令、Git 工作区、IDE 焦点/报错、桌面剪贴板"]
    O1 -->|"扩展信号源"| O2 -->|"扩展信号源"| O3
  end

  subgraph Core["确定性外壳 + INTENTS.md 契约内核（本规范核心）"]
    direction LR
    L["1. Intent Loader<br/>解析 INTENTS.md<br/>(YAML Front Matter + Prompt Body)"]
    S["2. Signal & Risk Engine<br/>提取 O1/O2/O3 信号<br/>+ proposedRisk 扫描"]
    R["3. Scenario Router<br/>谓词求值 + 特异度排序<br/>未命中 → 立即返回 none"]
    C["4. Candidate & Sampler<br/>explicit 规则短路<br/>或零配置委托宿主 Sampler"]
    G["5. Fusion & Gate & Filter<br/>Per-Intent 阈值 + 通道裁决<br/>+ 9 条安全过滤"]
    L --> S --> R --> C --> G
  end

  subgraph AgencyAxis["行动力演进（Agency Stages: A1 → A2 → A3）"]
    direction LR
    A1["Stage A1：纯建议输出<br/>(Suggest-Only，默认)<br/>Ghost Text / Chips / 确认按钮"]
    A2["Stage A2：推测预执行<br/>(Speculative-Prep)<br/>后台静默预跑只读检查/预取上下文"]
    A3["Stage A3：建议 + 委托执行<br/>(Propose-and-Dispatch)<br/>用户确认后派发给目标 Agent 执行"]
    A1 -.->|"升级行动力"| A2 -.->|"升级行动力"| A3
  end

  ObsAxis -->|"规范化 AgentEvent 流"| S
  G -->|"结构化 Prediction"| AgencyAxis
```

---

## 2. Three Observation Stages (O1 / O2 / O3)

An implementation MUST declare which Observation Stage(s) it supports (`["O1"]`, `["O1", "O2"]`, or `["O1", "O2", "O3"]`). Each stage is a strict superset of the previous stage's events and signals.

| Stage | Scope | Observed Events | Key Derived Signals | Typical Trigger |
|---|---|---|---|---|
| **Stage O1: Single-Session** (`single_session`) | Inside one conversation thread | `turn.started`, `message.user`, `message.agent`, `tool.call`, `tool.result`, `artifact`, `state`, `turn.completed` | `session.*`, `lastTurn.*`, `lastAgentMessage.*`, `user.locale`, `state.*` | `turn.completed` |
| **Stage O2: Agent-Wide** (`agent_wide`) | Across the host agent runtime (all sessions, subagents, background jobs, kanban/tasks) | All O1 events + `agent.subagent_completed`, `agent.background_job`, `agent.task_updated`, `agent.session_switched` | `agent.activeSubagents`, `agent.lastBackgroundJob.*`, `agent.pendingReviews`, `agent.openTasksCount`, `agent.recentSessionIds` | `turn.completed`, `agent.subagent_completed`, `agent.background_job` |
| **Stage O3: Global Environment** (`global_ambient`) | Across the user's workstation (shell, git worktree, filesystem, IDE, window/clipboard) | All O1+O2 events + `env.terminal_command`, `env.git_status`, `env.file_changed`, `env.ide_context`, `env.ambient_context` | `env.lastTerminalCommand.*`, `env.git.*`, `env.ide.*`, `env.ambient.*` | Any O1/O2 trigger or debounced `env.*` event |

### 2.1 Stage O1 Requirements (Single-Session — Baseline REQUIRED)

Every conformant implementation MUST implement Stage O1:
- Track per-session turn count (`session.turnCount`), last accepted/edited intent (`session.lastIntent`), current turn tool calls/results, and file artifacts.
- Extract `lastAgentMessage.tail` (last 1,500 chars), `endsWithQuestion`, `options` (numbered lists `1..9`), `preferredOptionIndex`, `hints` (explicit `/slash` commands or `"type X"` prompts), and `proposedRisk`.
- Infer `user.locale` (`zh-CN` | `ja` | `ko` | `en`) from the user's last 3 messages.

### 2.2 Stage O2 Requirements (Agent-Wide — OPTIONAL)

When Stage O2 is enabled, the predictor observes the entire agent instance beyond a single chat tab:
- **Subagent & Delegation Tracking (`agent.subagent_completed`)**: When a background subagent or delegated task finishes, derive `agent.lastSubagent.{id, status, summary}` so scenarios can suggest reviewing or merging the subagent's findings.
- **Background Process Tracking (`agent.background_job`)**: When a background terminal job, build, or test watcher exits or emits a readiness match, derive `agent.lastBackgroundJob.{sessionId, command, status, exitCode, summary}`.
- **Task / Kanban Board Tracking (`agent.task_updated`)**: Track `agent.pendingReviews` (count of tasks in `review` or `blocked` state) and `agent.openTasksCount`.

### 2.3 Stage O3 Requirements (Global Environment — OPTIONAL)

When Stage O3 is enabled, external lightweight observers (shell hooks, git watchers, IDE extensions, clipboard monitors) feed `env.*` events into the engine:
- Events arriving outside an active turn MUST be debounced (`envSettleMs`, default `300ms`) before evaluating scenarios whose `triggers` array includes the corresponding `env.*` event type.
- If a scenario is triggered by an `env.*` event while the agent is idle, `sourceTurnId` MUST be set to the latest completed turn ID (or `"env-0"` if no turn has occurred yet in the session).

---

## 3. Three Agency Stages (A1 / A2 / A3)

| Stage | Identifier | Behavior | Safety Invariant |
|---|---|---|---|
| **Stage A1: Suggest-Only** (`suggest_only`) | Default in v1 | Deliver structured `Prediction` (`text`, `intent`, `displayChannel`, `alternatives`, `action`) to host UI. Pressing `Tab` only fills the composer input. | **Never auto-sends a message; never auto-executes a tool.** |
| **Stage A2: Speculative Preparation** (`speculative_prep`) | Opt-in | While the suggestion is visible, the host MAY execute `prediction.prepPlan` in the background (strictly read-only tools or file prefetches). | **Zero side effects**: no file writes outside disposable memory, no network mutations, immediately aborted if user types something else. |
| **Stage A3: Propose & Dispatch** (`propose_and_dispatch`) | Opt-in | Renders an actionable intent card; once the user explicitly clicks or confirms the card, the host dispatches `prediction.action` to the target agent or tool runner. | **Human-in-the-loop required** on every dispatch; `side_effect` and `irreversible` intents NEVER trigger via single-keystroke `Tab`. |

---

## 4. Repository-Owned `INTENTS.md` Contract Format

Inspired by Symphony's `WORKFLOW.md`, scenario packs MAY be authored either as JSON (`packages/pack-coding/pack.json`, validated by `spec/scenario-pack.schema.json`) or as a self-contained Markdown file **`INTENTS.md`** (or `*.intents.md`) with YAML front matter and a Markdown prompt body.

### 4.1 `INTENTS.md` Structure

An `INTENTS.md` file consists of:
1. **YAML Front Matter** delimited by `---`:
   - `id`: Pack identifier (e.g. `builtin/coding`).
   - `version`: SemVer string (e.g. `0.3.0`).
   - `observation_stages`: Array of required/supported observation stages (`[O1]`, `[O1, O2]`, or `[O1, O2, O3]`).
   - `policy`: Optional pack-level `GatePolicy` overrides.
   - `scenarios`: List of `ScenarioSpec` objects (matching `spec/scenario-pack.schema.json`).
2. **Markdown Body**:
   - The prompt template and domain-specific classification rules sent to the model when `ModelSource` is invoked.
   - Supports Mustache-style variables: `{{scenario.id}}`, `{{scenario.description}}`, `{{catalog_lines}}`, `{{user.locale}}`, `{{signals_json}}`, and `{{#if compact}}{{transcript}}{{/if}}`.
   - If the Markdown body is empty, the engine MUST use the default classification prompt defined in §5.5.

---

## 5. Deterministic Pipeline Specification

### 5.1 Guards (`SuppressedReason`)

Before evaluating any scenario, the engine MUST check the following guards in order. If any guard trips, the engine MUST immediately return `{ type: "completed", prediction: null, suppressedReason }` without calling any model:

1. Predictor disabled → `disabled`
2. Host `interactive === false` → `non_interactive`
3. `state.pendingApproval === true` or `state.pendingInput === true` or last tool kind was `ask_user` → `pending_interaction`
4. `lastTurn.status === "interrupted"` → `interrupted_turn`
5. `lastTurn.status === "failed"` and no loaded scenario declares `"failed"` in `triggerOnTurnStatuses` → `failed_turn_unhandled`
6. `session.turnCount < minTurns` (default `1` for `turn.completed` triggers; `0` for O3 `env.*` triggers) → `min_turns_not_met`
7. `state["composer.dirty"] === true` → `composer_dirty`
8. `state.mode` is in `blockedModes` (default `["plan"]`) → `mode_blocked`
9. `state.incognito === true` → `incognito`

*(Note: Model budget exhaustion is checked at §5.4 after `RuleSource`, not here, so zero-cost `explicit` rules still work when model budget is exhausted.)*

### 5.2 Signal Predicate Evaluation & Specificity

1. **Missing Signals (Fail-Closed)**: When `signal` resolves to `undefined` or `null`:
   - `{ exists: false }` evaluates to `true`.
   - `{ exists: true }` evaluates to `false`.
   - `{ ne: x }` (where `x !== null`) evaluates to `false` (a missing signal MUST NOT pass a `ne` check unless paired with `exists: false`).
   - All other operators (`eq`, `gt`, `gte`, `lt`, `lte`, `in`, `contains`, `matches`) evaluate to `false`.
2. **Specificity Score `specificity(pred)`**:
   - Evaluates to `0` if the predicate returns `false`.
   - Matched leaf predicate: `1.0`.
   - `{ all: [...] }`: sum of children's specificity scores.
   - `{ any: [...] }`: maximum of matched children's specificity scores.
   - `{ not: child }`: `0.5`.

### 5.3 Scenario Routing & Origin-Scoped Merging

1. Filter scenarios whose `triggers` include the triggering event type and whose `match` predicate evaluates to `true`.
2. Sort matched scenarios descending by:
   1. `scenario.priority ?? 0`
   2. `specificity(scenario.match)`
   3. Declaration order
3. **Hard Boundary**: If zero scenarios match, return `suppressedReason: "no_scenario_matched"` immediately. MUST NOT call the model.
4. **Slope Fallback Exclusion**: If at least one matched scenario has `priority >= 10`, exclude any fallback scenario with `priority <= 1` from the merge set.
5. Take the top `k = 2` scenarios. Collect their intents (filtering out `enabledByDefault === false` and intents whose `when` predicate evaluates to `false`), deduplicating by `intent.id` (keeping the higher-priority scenario's definition) and capping at 15 intents.
6. **Origin Policy & Qualified ID Binding**: Every candidate intent retains its `originScenario` reference. When an intent wins, `prediction.scenarioId`, `prediction.qualifiedIntentId` (`<packId>@<packVersion>/<originScenarioId>#<intentId>`), and the active `GatePolicy` overrides MUST come from that intent's `originScenario`.

### 5.4 Candidate Generation & Short-Circuit Rules

1. **Proposed-Action Risk Scanner (`lastAgentMessage.proposedRisk`)**:
   - Scan `lastAgentMessage.tail`:
     - Matches destructive patterns (`rm -rf`, `git push --force`, `git reset --hard`, `git clean -f`, `DROP TABLE/DATABASE`, `TRUNCATE TABLE`, `DELETE FROM`, `kubectl delete`, `terraform destroy`, or CJK equivalents `删库|强制推送|清空数据|不可恢复|永久删除`) → `'irreversible'`.
     - Matches external side-effect patterns (`git push`, `gh pr create/merge`, `npm/cargo publish`, `deploy`, `kubectl/terraform apply`, `docker push`, or CJK equivalents `推送到远端|推到生产|发布到|部署到|合并 PR|发送邮件`) → `'side_effect'`.
     - Otherwise → `'reversible'`.
   - For any intent with `dynamicRiskFromProposedAction: true` (such as `confirm` and `choose_option`), its runtime effective risk is:
     $$\text{effectiveRisk} = \max(\text{intent.risk}, \text{lastAgentMessage.proposedRisk})$$
2. **`RuleSource`**:
   - **Explicit Hints (`explicit: true`)**: If `lastAgentMessage.hints` contains a slash command matching `intent.action.command` or `intent.examples`, or a `"type X"` literal matching `intent.examples`, emit `{ intentId, score: 0.92, explicit: true }`.
   - **Structural Bonuses (`explicit: false`)**: If `optionsCount > 1`, prefill `choose_option.slots.index = preferredOptionIndex` and set bonus $b_{\text{rule}} = 0.20$; if `endsWithQuestion === true`, set bonus $b_{\text{rule}}(\text{confirm}) = 0.15$.
3. **Short-Circuit Invariant**:
   - If `RuleSource` emits an `explicit: true` candidate whose `effectiveRisk` is in `{'none', 'read_only', 'reversible'}` and whose required slots are all resolved deterministically, the engine MUST short-circuit and skip `ModelSource`.
   - Otherwise, if model budget is exhausted (`budget_exhausted_no_explicit_rule`) or no `Sampler`/`ModelClient` is configured (`no_rule_hit_in_local_mode`), return `prediction: null` immediately.

### 5.5 Default Model Prompt & Output Contract

When `ModelSource` runs, it sends the prompt from `INTENTS.md` (or the default below) via `Sampler.sample`:

```text
[INTENT PREDICTION — do not continue the task. Do not call tools.]
Predict the user's NEXT message in this session, choosing from a fixed catalog.

Scenario: {{scenario.description}}
Catalog (pick from these ids):
{{#each intents}}- {{id}}: {{description}}{{#if slots}} (slots: {{slots_spec}}){{/if}}{{#if examples}} e.g. {{examples}}{{/if}}
{{/each}}- none: nothing above fits, or you are not confident.

Rules:
1. Predict what THE USER would type next, not what you think they should do.
   THE TEST: Would the user think "I was just about to type that"?
2. Read the last few lines of the assistant's message carefully: if it explicitly
   offers a next step (a slash command, a direct question, or numbered options),
   prefer the matching intent. If the assistant asks to confirm a destructive or
   external side-effect action, return "none".
3. Prefer "none" over a guess. A wrong suggestion costs more than no suggestion.
4. "text" is what the user would type in locale "{{user.locale}}": one short
   sentence matching the user's tone, no quotes, no markdown, never in the
   assistant's voice. Leave "text" empty if intent is "none".
5. Fill "slots" ONLY with values that literally appear in the conversation.
6. Optionally list up to 2 plausible runner-up intents in "runnerUps".

{{#if compact}}Recent conversation (oldest first):
{{transcript}}
{{/if}}Signals: {{signals_json}}

Reply with a single JSON object only:
{"intent":"<id>","confidence":0.0,"slots":{},"text":"","runnerUps":[{"intent":"<id2>","confidence":0.0}]}
```

### 5.6 Fusion, Gating, Channel Resolution & 9-Rule Filter

1. **Model `none` Veto**: If `ModelSource` returns `intent === "none"`, the engine MUST immediately return `suppressedReason: "model_none"`. Non-explicit structural bonuses MUST NOT override a model `none`.
2. **Log-Linear Fusion**:
   - Given model top-1 $(i_1, c_1)$ and optional `runnerUps` $(i_2, c_2), (i_3, c_3)$, let $S = \min(0.98, c_1 + c_2 + c_3)$, $P_{\text{model}}(\text{none}) = \max(1 - c_1, 1 - S)$, and $\epsilon_0 = 0.02 / m$ for unlisted intents.
   - Compute $\tilde{S}(i) = (P_{\text{model}}(i) + 0.15 \cdot b_{\text{rule}}(i))^{\alpha} \cdot P_{\text{prior}}(i)^{1 - \alpha}$ with $\alpha = 0.85$, normalized over $\mathcal{I} = \text{catalog} \cup \{\text{none}\}$.
   - Compute `alternatives` (up to 2 items) using $\text{altScore}(j) = 0.65 \cdot P_{\text{model}}(j) + 0.35 \cdot P_{\text{prior}}(j) + 0.15 \cdot b_{\text{rule}}(j) \ge 0.18$.
3. **Gate Thresholds & Channel Resolution**:
   - Check `model_none` ($\text{final}(\text{none}) \ge \text{final}(i_{(1)})$), `max_per_session_reached`, `in_cooldown` (3 turns after `Esc` dismiss on `qualifiedIntentId`), `below_min_confidence` (default `0.60` + `backoffDelta`), `below_risk_confidence` (`none: 0.55`, `read_only: 0.60`, `reversible: 0.65`, `side_effect: 0.80`, `irreversible: 0.95`), and `below_min_margin` (default `0.15`).
   - `ghostTextRisks` defaults to `['none', 'read_only', 'reversible']`. Intents with `effectiveRisk === 'side_effect'` or `confirm`/`choose_option` (`allowedChannels: ['chips', 'action_button']`) MUST NOT be delivered as `ghost_text`.
4. **Atomic Slot & Action Interpolation**:
   - Resolve slots in order: `slot.from` signal path → model `slots[k]` (must literally appear in recent conversation for `string`/`path`) → `slot.default`.
   - Validate `required`, `type`, `enum`, `maxLength`, `pattern`, and path traversal/metacharacter bans.
   - Interpolate `{slotName}` placeholders in both `render` templates and `action` payloads (`args`, `input`, `payload`). Any unresolved placeholder aborts the entire prediction with `slot_validation_failed`.
5. **9-Rule Post-Filter Pipeline**:
   - Every rendered `text` MUST pass all 9 deterministic filters (`filter_empty_or_meta`, `filter_label_prefix`, `filter_ai_voice`, `filter_evaluative`, `filter_multiple_sentences`, `filter_formatting`, `filter_length`, `filter_error_text`, `filter_dangerous`) defined in `docs/design.md` §7.8.3.

---

## 6. Privacy & Full-Duplex RPC Invariants

1. **Split Privacy Guarantee**:
   - **Fork Mode (`mode: 'fork'`)**: Shares the host session's exact prompt prefix to hit Prompt Cache; historical message redaction is governed by the host session's own boundary, while SDK redacts the appended prompt and `signals_json`.
   - **Compact Mode (`mode: 'compact'`)**: SDK MUST run the full redaction pipeline (PEM keys, cloud/AI API keys, Bearer tokens, URL credentials, secret assignments, and optional strict PII) on all transcript and signal strings before invoking the model.
2. **Full-Duplex Sidecar Multiplexing**:
   - Host-to-SDK requests use integer or `"h-*"` IDs; SDK-to-host reverse `sampler/sample` requests use `"s-*"` IDs.
   - At most 1 in-flight prediction and 1 in-flight `sampler/sample` per session.
   - On `turn.started`, `message.user`, `state(composer.dirty=true)`, `prediction/cancel`, or 4s timeout, SDK MUST immediately emit `sampler/cancel` (`{ sampleRequestId, sessionId }`) and `prediction/updated` (`prediction: null`).

---

## 7. Conformance Verification

An implementation is conformant if:
1. All emitted payloads validate against `spec/*.schema.json` (Draft 2020-12).
2. It loads `INTENTS.md` (or `packages/pack-coding/pack.json`) and passes all deterministic guard, routing, risk-escalation, slot-validation, and filter test cases.
