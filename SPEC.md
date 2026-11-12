# Intent-Predict Specification (SPEC.md)

Status: Draft v0.5 — the Phase 1 contract (single-session observation, suggest-only)

Purpose: define a thin shell around one model call that, after an agent turn ends, predicts the user's next message. By default (**open mode**, §4.9) the session's own agent writes up to three messages the user is likely to send next, in the user's own words, or nothing. A **catalog mode** (§4.3–§4.8), which picks one intent from a closed catalog and renders it from a template, remains available as an explicit, reversible restriction. The shell is host-agnostic: a host feeds events and lends its model; a surface shows the suggestion; nothing is sent unless the user explicitly sends it.

Design principles: the model's capability is never capped silently (a cheaper or narrower mode is an explicit, reversible choice); rules stay few and loose; the model gets goals and real information rather than scripted steps; early phases favour exploration and learning speed over product-grade restriction. Only the user-protecting rules are firm: nothing is sent without the user, a send reaches only the turn it answers, the agent's own approvals stay in force, and secrets are redacted before text reaches a model or a surface.

> **Using this specification with a coding agent**
>
> `"Implement intent-predict for <host/language> according to SPEC.md, load scenarios from INTENTS.md, and make every case in eval/golden.jsonl pass."`

This document contains only what the current phase builds. Wider observation (agent-wide, ambient), speculative preparation, delegated execution, score fusion and online learning are **not** part of this contract; their sketches live in the non-normative [docs/future.md](docs/future.md). Phasing is in [ROADMAP.md](ROADMAP.md).

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY` are used as in RFC 2119. Lengths and cuts of text are counted in Unicode code points; only the `fork` prompt budget is in UTF-8 bytes. *Implementation-defined* means the behaviour is part of the contract but this document does not fix one policy; implementations MUST document what they chose.

## Authority and precedence

There is exactly one normative source per concern:

1. **Data shapes** — `spec/*.schema.json` (JSON Schema 2020-12). Cross-file `$ref`s are resolved offline against `spec/`; a schema `$id` is an identifier, not a URL to fetch.
2. **Behaviour** — this file.
3. **Built-in pack** — `INTENTS.md`. `packages/pack-coding/pack.json` is generated from it (`tools/build_pack.py`) and MUST NOT be hand-edited.
4. Everything under `docs/` is non-normative rationale.

`tools/reference.py` is an executable reading of this file used to check `eval/golden.jsonl`. It is a test oracle, not the product; where it disagrees with this file, this file governs and the difference is a bug. `python tools/validate.py` checks that all of the above agree.

---

## 1. Model

### 1.1 Three roles

| Role | Does | Never does |
|---|---|---|
| **Host** | Reports session events; lends its model through the sampler; optionally accepts a user-approved send (dispatch). | Decide what is suggested. |
| **Core** | Runs the pipeline of §4; tracks which prediction is live; enforces the action rules of §5; writes telemetry. | Send anything on its own; execute tools. |
| **Surface** | Shows the live prediction; forwards the user's explicit action (`send`, `copy`, `dismiss`). | Decide friction, re-rank, or act without a user action. |

All three speak the single protocol of §8. A reference implementation ships one bundled surface (a local web page); a host MAY act as its own surface by declaring `capabilities.surface`. Which surface is used does not change any rule in this document.

### 1.2 Scope

This version covers **O1 × A1**: observation is one session's own events; the only output is a suggestion a user may send. An `event` whose `type` this version does not define MUST be accepted and ignored: it is not an error, produces no signal, and triggers no evaluation.

### 1.3 Invariants

- **I1 Fail closed.** Any guard, miss, model anomaly, validation failure or timeout yields no suggestion and exactly one `SuppressedReason`.
- **I2 The model writes, the core checks.** In open mode the session's own agent writes the candidate messages; the core only checks, orders, redacts and flags them (§4.9). In catalog mode a prediction's intent is declared in a loaded pack: the model chooses an id and cannot create one.
- **I3 Shown text is safe to show.** Every candidate is redacted (§7.1); one that looks like it would act outside the workspace is flagged for confirmation, never silently hidden. In catalog mode every character comes from a pack template or from a slot value that passed §4.7.
- **I4 Explicit send.** Text leaves the core only through §5.2, in response to a user action on a surface. Nothing is sent automatically; no tool is executed.
- **I5 Turn-pinned send.** A send is valid only for the turn the prediction answers (§5.3), and at most once per prediction.
- **I6 Tighten-only packs.** In catalog mode a pack can make the confidence thresholds stricter than the host's, never looser (§3.3).

---

## 2. Events and signals

### 2.1 Events

`spec/events.schema.json` defines `turn.started`, `message.user`, `message.agent`, `tool.call`, `tool.result`, `artifact`, `state`, `turn.completed`. Within a session the host sends `turn.started` before that turn's `message.user`. Hosts SHOULD send `command` on execute-kind `tool.call` events; without it the core cannot tell a test run from any other command (§2.2).

### 2.2 Signal extraction

Signals are computed when a turn completes, from the events carrying that `turnId`. Regular expressions below are ECMA-262 with the `u` flag; `i` is added where noted.

**Tool calls.** Join `tool.call` and `tool.result` by `callId`; calls without a result are ignored except where stated. `kind` is `tool.call.kind` when present, else inferred from the lower-cased tool name:

| kind | names |
|---|---|
| `read` | `read_file` `read` `view` `cat` `head` `tail` `open_file` |
| `search` | `search_files` `grep` `rg` `find` `glob` `ls` `list_files` `web_search` `websearch` `session_search` |
| `edit` | `patch` `write_file` `write` `edit` `multiedit` `apply_patch` `create_file` `str_replace_editor` `str_replace_based_edit_tool` `notebook_edit` `notebookedit` |
| `delete` | `remove_file` `delete_file` `rm` |
| `execute` | `terminal` `bash` `shell` `powershell` `exec_command` `execute_code` `run_command` `run_terminal_cmd` |
| `fetch` | `web_extract` `web_fetch` `webfetch` `fetch` `curl` `browser_exec` |
| `ask_user` | `clarify` `ask_user` `askuserquestion` `request_user_input` |
| `other` | anything else |

A call *failed* when its result has `status === "error"` or a non-zero `exitCode`. An execute call is a *check* when `tool.call.check` is `true`, or when `check` is absent and `command` matches (flag `i`):

```text
(?:^|[\s;&|(/])(?:pytest|py\.test|unittest|tox|nox|jest|vitest|mocha|ava|playwright\s+test|cypress\s+run|node\s+--test|deno\s+(?:test|check|lint)|go\s+(?:test|vet|build)|cargo\s+(?:test|check|clippy|build)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|tsc|eslint|ruff|mypy|pyright|flake8|make\s+(?:test|check|build|lint)|(?:\./)?gradlew?\s+(?:test|build|check)|mvn\s+(?:test|verify|package|compile)|dotnet\s+(?:test|build)|ctest|phpunit|rspec|rake\s+test|swift\s+(?:test|build)|bazel\s+(?:test|build))\b
```

| Signal | Rule |
|---|---|
| `session.turnCount` | Number of distinct turns recorded as completed, including this one. |
| `lastTurn.status` | `turn.completed.status`. |
| `lastTurn.toolKinds`, `lastTurn.toolNames` | De-duplicated, first-seen order, over all `tool.call` events of the turn. |
| `lastTurn.filesChanged` | Number of distinct `artifact.ref` with kind `file_changed`/`file_created`/`file_deleted`. If the turn has no such artifact: number of `edit`/`delete` calls whose result is `ok`. |
| `lastTurn.changedPaths` | Those artifact refs, first-seen order (empty when the count came from tool calls). |
| `lastTurn.failedExecs` | Number of failed execute calls. Informational: it counts failures that were later fixed. |
| `lastTurn.lastExecFailed` | Whether the last execute call (with a result) failed. Absent when there is none. |
| `lastTurn.checkRuns` | Number of check calls (with a result). `0` when there is none. |
| `lastTurn.lastCheckFailed` | Whether the last check call failed. Absent when `checkRuns` is `0`. |
| `lastTurn.toolOutputs.<name>` | `output` of the last result of tool `<name>`. Readable only by `slot.from`; values larger than 64 KiB serialized behave as absent. |
| `lastAgentMessage.length`, `.tail` | Of the turn's *final agent message* — its last `message.agent` with `final !== false`, else its last `message.agent`, else the empty string: character length, and the last 1,500 characters. |
| `lastAgentMessage.endsWithQuestion` | `Q(last prose line)`. |
| `lastAgentMessage.options`, `.optionsCount`, `.optionsPrompted`, `.preferredOptionIndex` | Numbered-options rule below. |
| `lastAgentMessage.hints` | Hints rule below. |
| `lastAgentMessage.proposedRisk` | Proposed-risk rule below. |
| `user.locale` | Locale rule below. |
| `state.<key>` | Latest value the host sent for `<key>`, verbatim. |

**Prose lines.** Split `tail` into lines; drop lines inside fenced code blocks (a line whose first non-blank characters are three backticks toggles a block; if `tail` contains an odd number of fence lines, the cut removed an opening fence, so everything before the first one is inside a block) and the fence lines themselves; trim; drop empty lines.

**Question test `Q(line)`.** Strip trailing whitespace and any trailing `"` `'` `”` `’` `)` `）` `]` `】` `」` `』`. True when the remainder ends with `?` or `？`, or matches `(?:吗|呢|好吗|可以吗|对吗|是吗|如何|怎样|哪一个|哪个)\s*[。！!.]?$`.

**Numbered options.** Let `N` be `^\s*(?:(\d{1,2})[.)、]|[(（](\d{1,2})[)）])\s+(.+)$`. Let `q = 1` if the last prose line satisfies `Q` and does not match `N`, else `0`. Skipping the last `q` lines, collect the maximal run of trailing consecutive prose lines that match `N`. The run is valid when its numbers are `1, 2, …, n` in order with `2 ≤ n ≤ 9`; then `options` is the list of captured texts and `optionsCount = n`, otherwise `options` is absent and `optionsCount = 0`. `preferredOptionIndex` is the 1-based position of the first option matching `[(（]\s*(?:recommended|推荐)\s*[)）]` (flag `i`), and is absent when none does. `optionsPrompted` is true when the run is valid and at least one holds: `q = 1`; the prose line immediately above the run satisfies `Q`; `preferredOptionIndex` is present. (A trailing numbered list is often a summary, not a question; only a prompted list is treated as a choice.)

**Hints.** Over the last 5 prose lines, ordered by position in the text:
- *slash*: every match of ``(?:^|[`"'“「『])(/[a-z][a-z0-9_-]{1,30})(?=$|[`"'”」』\s])`` (flag `i`), lower-cased. A command must open the line or follow an opening quote/backtick, which excludes paths such as `/usr/bin`.
- *type literal*: every match of `(?:type|run|enter|reply with|输入|发送|回复)\s*["'“「『]([^"'”」』\n]{1,40})["'”」』]` (flag `i`), trimmed.

**Proposed risk.** Scan the last 8,000 characters of the final agent message, code blocks included (flag `i`):
- `irreversible` when it matches the *destructive pattern*
  `(?:\brm\s+-[a-z]*[rf][a-z]*\b|\bgit\s+push\b[^\n]*\s(?:--force\S*|-f)\b|\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*[fd]|\bdrop\s+(?:table|database|schema)\b|\btruncate\s+table\b|\bdelete\s+from\b|\bkubectl\s+delete\b|\bterraform\s+destroy\b|\bformat\s+[a-z]:|\bchmod\s+(?:-R\s+)?777\b|\bcurl\b[^\n]*\|\s*(?:sh|bash)\b|删库|强制推送|清空数据|不可恢复|永久删除)`;
- else `side_effect` when it matches
  `(?:\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b|\b(?:npm|cargo)\s+publish\b|\bdeploy\b|\b(?:kubectl|terraform)\s+apply\b|\bdocker\s+push\b|推送到远端|推到生产|发布到|部署到|合并\s*PR|发送邮件)`;
- else `reversible`.

These patterns are a coarse net, not a proof: they miss paraphrases. They are one of several layers (§7.4).

**Locale.** Concatenate the session's last ≤ 3 `message.user` texts with fenced code blocks and URLs removed; count over non-whitespace characters. Kana (`぀-ヿ`) > 5 % → `ja`; Hangul (`가-힯`) > 5 % → `ko`; CJK ideographs (`一-鿿`) ≥ 10 %, or ≥ 2 ideographs with fewer than 5 Latin words → `zh-CN`; else `en`.

### 2.3 Predicates

A predicate is `{all: […]}`, `{any: […]}`, `{not: …}` or a leaf `{signal, <operators>}`. A path is resolved segment by segment through objects and arrays (`lastTurn.changedPaths.0`); everything after `state.` is one key (`state.ui.mode` reads the key `ui.mode`).

- All operators in one leaf must hold.
- **Missing signal** (`undefined` or `null`): `{exists: false}` is true; every other operator is false, including `ne`. A missing signal never passes a comparison.
- `eq`/`ne`: strict equality. `gt`/`gte`/`lt`/`lte`: only on finite numbers. `in`: the operand is an array containing the value. `contains`: array membership, or substring when the value is a string. `matches`: only on strings, `RegExp(pattern, "u").test(value)`. `exists: true`: the signal is present.

---

## 3. Scenario packs (`INTENTS.md`)

### 3.1 Structure

A pack is a `ScenarioPack` object (`spec/scenario-pack.schema.json`), authored as JSON or as a Markdown file `INTENTS.md` / `*.intents.md` with YAML front matter delimited by `---`:

- The front matter is the `ScenarioPack` exactly as the schema defines it, same camelCase keys.
- The Markdown body, with leading and trailing blank lines stripped, becomes `promptTemplate` verbatim (Markdown markup is sent as-is). An empty body means "use the default prompt of §4.5".

A scenario has a `match` predicate, a `priority`, an optional `fallback` flag and 1–15 intents. An intent declares `id`, `description`, `render` (required), `risk`, and optionally `examples`, `when`, `slots`, `enumerate`, `passThrough`, `action`.

- `risk` is one of `none`, `read_only`, `reversible`, `side_effect`.
- `passThrough: true` marks a message that approves or continues **whatever the agent just proposed** ("yes", "option 2", "go ahead", "continue"). Its real effect is the agent's proposal, not its own words, so it gets the special handling of §4.3 and §4.8.
- `enumerate` turns one intent into one choice per item of a signal array (§4.4).

### 3.2 Load-time rules and trust

A pack MUST be rejected as a whole (engine error, not a suppression) when any of these fails:

1. It validates against the schema; scenario ids are unique in the pack; intent ids are unique in their scenario.
2. Every `passThrough` intent declares `risk` `reversible` or `side_effect`.
3. Every `enumerate.slot` names a declared slot of type `number`; an intent with `enumerate` is not `side_effect` and declares no `action`.
4. Every `{placeholder}` in a `render` template or `action` names a declared slot.
5. Every regex (`matches`, `slot.pattern`) is at most 256 characters and compiles. Implementations MUST bound regex execution (a non-backtracking engine or a match timeout).

A pack's risk labels and prompt are **author claims**. A pack found in a workspace (for example an `INTENTS.md` in a freshly cloned repository) MUST NOT be loaded unless the host or user opted in to that pack explicitly; naming its path in `initialize.packs` is such an opt-in.

### 3.3 Thresholds: packs can only tighten

The host policy is `initialize.policy` over the defaults `minConfidence = 0.60`, `sideEffectMinConfidence = 0.80`. The effective value of each threshold for an intent is the **maximum** of the host value, its pack's `policy` value and its scenario's `policy` value. These defaults are placeholders until replay data exists (ROADMAP Phase 0); they are deliberately few.

---

## 4. Pipeline

### 4.1 Trigger and lifecycle

- An evaluation is triggered by `turn.completed`. A second `turn.completed` for an already recorded `turnId` is ignored. No other event triggers an evaluation.
- After the trigger the core waits `settleMs` (default 150) for trailing `artifact`/`state` events, then runs the guards of §4.2 and, by `options.mode`, §4.9 (`open`, the default) or §4.3–§4.8 (`catalog`).
- Every evaluation ends with exactly one `prediction/updated` carrying an `EvaluationResult`: a prediction, or `prediction: null` with one `suppressedReason`. `type: "failed"` is reserved for internal errors.
- At most one evaluation and one `sampler/sample` are in flight per session. When an event carrying a different `turnId` (the next turn has begun) or a `prediction/cancel` arrives for the session during an evaluation, the core MUST abort it, send `sampler/cancel` if a sample is in flight, and report `aborted`. A sample that outlives `timeoutMs` (default 4000) is cancelled the same way and reported as `timeout`. Late sampler replies are discarded.

### 4.2 Guards

Checked in this order; the first that holds ends the evaluation without calling a model:

| # | Condition | Reason |
|---|---|---|
| 1 | `options.enabled === false` | `disabled` |
| 2 | `capabilities.interactive === false` | `non_interactive` |
| 3 | `state.pendingApproval === true`, or `state.pendingInput === true`, or the turn's last `tool.call` has kind `ask_user` and no result | `pending_interaction` |
| 4 | Catalog mode, and `lastTurn.status === "interrupted"` | `interrupted_turn` |
| 5 | Catalog mode, `lastTurn.status === "failed"`, and no loaded scenario lists `failed` in `triggerOnTurnStatuses` | `failed_turn_unhandled` |
| 6 | `state.mode` is in `options.blockedModes` (default `["plan"]`) | `mode_blocked` |
| 7 | `state.incognito === true` | `incognito` |
| 8 | `options.maxPerSession` is set and that many predictions were already delivered in the session | `max_per_session_reached` |

### 4.3 Routing and catalog

*§4.3–§4.8 apply in catalog mode only.*

1. A scenario is *eligible* when `lastTurn.status` is in its `triggerOnTurnStatuses` (default `["completed"]`) and its `match` holds.
2. Pick **one** scenario: among eligible scenarios without `fallback`, the highest `priority` (ties: earliest in load order, then declaration order); if there is none, the same choice among eligible `fallback` scenarios; if there is none → `no_scenario_matched`.
3. The *catalog* is that scenario's intents in declaration order, minus:
   - intents whose `when` is false;
   - `passThrough` intents when `lastAgentMessage.proposedRisk` is `side_effect` or `irreversible` — a one-click "yes" to an external or destructive proposal is never offered — or when the final agent message is empty (there is nothing to approve);
   - `enumerate` intents whose `over` does not resolve to an array of 2–9 strings.
4. Empty catalog → `empty_catalog`.

Scenarios are never merged: one evaluation has one scenario, one description, one policy.

### 4.4 Deterministic rules

Rules run before any model call. A rule can only select an intent whose `risk` is not `side_effect`. If a rule selects an intent, the model is not called, `source` is `"rule"` and `intent.confidence` is `null`.

- **R1 Explicit hint.** Walk `lastAgentMessage.hints` from last to first. A *slash* hint selects the first catalog intent whose `action` is `{type: "command"}` with that `command`, or one of whose `examples` equals it. A *type literal* hint selects the first catalog intent one of whose `examples` equals it. Comparison is on trimmed, lower-cased strings. The intent must have no `enumerate` and all its `required` slots must resolve from `from` or `default`. The first hint that selects an intent wins.
- **R2 Enumerate.** Otherwise, the first catalog intent with `enumerate` is selected. For each item `k` (1-based) of the `over` array it yields a choice `{slots: {<slot>: k}, text: render with that slot, label: redacted item text, truncated to 80 characters}`; each choice goes through §4.7. `preferredChoice` is `preferred − 1` when `enumerate.preferred` resolves to a position in range. The prediction's `text` and `intent.slots` are those of the preferred choice, else of the first.

### 4.5 Model classification

Reached only when no rule selected an intent.

1. **Availability.** No sampler mode offered by the host → `no_sampler`. `options.modelBudget.maxCallsPerHour` set and that many model calls were made for the session in the trailing hour (measured on the `at` of the triggering events) → `budget_exhausted`. Rules (§4.4) are unaffected by both.
2. **Mode.** `options.samplerMode` (default `compact`) if the host offers it, else the mode the host offers.
3. **Prompt.** Render the pack's `promptTemplate`, or this default:

```text
[INTENT PREDICTION — do not continue the task. Do not call tools.]
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
```

   Template syntax (a Mustache subset; blocks do not nest inside a block of the same kind):
   - Scalars `{{scenario.id}}`, `{{scenario.description}}`, `{{user.locale}}`, `{{signals_json}}`, `{{transcript}}`.
   - `{{#each intents}}…{{/each}}` repeats its body per catalog intent with `{{id}}`, `{{description}}`, `{{#if slots}}…{{slots_spec}}…{{/if}}` and `{{#if examples}}…{{examples}}…{{/if}}`. `slots_spec` lists the slots that have no `from`, as `name:type` joined by `, ` (the block is omitted when there are none); `examples` is the first two examples joined by ` | `.
   - `{{#if compact}}…{{/if}}` is kept only in `compact` mode.
   - A line holding only a block tag is removed together with its line break. Any other `{{…}}` renders as the empty string.
4. **Size.** `fork`: the rendered prompt MUST be ≤ 4,000 bytes of UTF-8. `compact`: ≤ 8,000 characters. If it is too large, render again without `examples`; in `compact` mode then drop whole turns from the transcript, oldest first. Still too large → `prompt_too_large`, without calling the model.
5. **`signals_json`.** A single-line JSON object with exactly these keys, in this order, omitting absent ones: `session.turnCount`, `lastTurn.status`, `lastTurn.toolKinds`, `lastTurn.filesChanged`, `lastTurn.failedExecs`, `lastTurn.lastExecFailed`, `lastTurn.checkRuns`, `lastTurn.lastCheckFailed`, `lastAgentMessage.endsWithQuestion`, `lastAgentMessage.optionsCount`, `lastAgentMessage.optionsPrompted`, `lastAgentMessage.proposedRisk`, `user.locale`. No free text ever enters it.
6. **Compact transcript.** Take the last 3 completed turns, oldest first. Redact first (§7.1), truncate second. Per turn, one line each:
   - `User: <text>` — first 500 characters, then `…`.
   - `Tool: <name>(<command, first 60 characters>) -> <status>[ exit=<code>][: <summary>]`, at most 200 characters. With more than 6 calls keep the first 2 and the last 4 and put `Tool: … (<n> more)` between them.
   - `Assistant: <text>` — of the final message, the **last** 1,500 characters, prefixed with `…` when cut.

   Non-final agent messages, reasoning, and `tool.result.output` are never included.
7. **Call.** `sampler/sample` with `expectedTurnId` = the evaluated turn (§6). A host error → `sampler_error`. A result with `text` null or empty → `invalid_model_output`.
8. **Parse.** Strip at most one enclosing ` ```json ` fence, then parse as JSON; no salvage of partial output. Not an object, or `confidence` not a finite number in [0, 1], or `slots` present and not an object → `invalid_model_output`. `intent` not a string in catalog ∪ `{"none"}` → `unknown_intent`. `runnerUps`, when an array, keeps its first two valid entries (intent in the catalog, different from `intent` and from each other, confidence finite in [0, 1]); invalid entries are ignored.
9. `intent === "none"` → `model_none`.

### 4.6 Gate

For the selected intent, in this order:

1. Its session key `<packId>/<scenarioId>#<intentId>` is in cooldown (§5.2) → `in_cooldown`.
2. Model path only: `confidence` below the effective threshold (§3.3: `sideEffectMinConfidence` for `side_effect`, else `minConfidence`) → an option set, if one forms (below); otherwise `below_min_confidence`.

The model's self-reported confidence is used as is. It is not calibrated and no margin, prior or bonus is applied in this version; that is a deliberate baseline (see docs/future.md).

**Option sets.** When the model's first choice is not likely enough on its own but it and its runner-ups together are, they are offered side by side as equal options. This step is skipped when `options.optionSets` is `false`.

- A *member* is the selected intent or a kept runner-up (§4.5 step 8) that meets all of these: its confidence ≥ `options.altMinConfidence`; its risk is not `side_effect`; it is not in cooldown; it passes §4.7. The selected intent must itself be a member.
- Walk the members in order — the selected intent first, then the runner-ups from the most to the least likely (ties in the order the model listed them) — and stop as soon as their confidences add up to the effective `minConfidence`. Sums are compared with a tolerance of 1e-9.
- If the sum is reached with at least two members, the prediction is an **option set**: the selected intent is its primary, the other members walked are its `alternatives`, and `optionSet` is `true`. Otherwise → `below_min_confidence`.

A set therefore has two or three options, and no more than it needs to reach the threshold. The default prompt asks for probabilities that add up to at most 1, so the sum reads as the model's probability that the user's next message is one of the options.

### 4.7 Slots, rendering, output checks

**Slots.** For each declared slot, take the first that yields a value: the `from` signal path; the model's `slots[name]`; `default`. A model-provided `string` or `path` value must occur literally in the text of the last 3 completed turns (user messages, agent messages, tool summaries). Then validate:

- `required` and empty (`undefined`, `null`, `""`) → fail. An unresolved optional slot is simply omitted.
- `number`: finite number; a string of digits with an optional leading `-` and an optional fraction is converted. `enum`: a string member of `enum`.
- `path`: ≤ 120 characters, no `..`, no whitespace or control characters, none of `` ; | & $ ` > < ``.
- `string`: ≤ `maxLength` (default 80), no line breaks or control characters.
- `pattern`: `RegExp(pattern, "u").test(String(value))`.

**Rendering.** Pick the template for `user.locale`: exact key, then primary subtag (`zh-CN` → `zh`), then `en`, then the first key. Replace `{slot}` placeholders; do the same recursively for strings in `action.args`, `action.input`, `action.payload`. A placeholder without a resolved value fails.

Any failure above → `slot_validation_failed`.

**Output checks**, on the rendered text and on `command` + `args` of a command action:

- `output_invalid`: empty after trimming, contains a line break, or longer than 200 characters.
- `output_dangerous`: matches the destructive pattern of §2.2.

### 4.8 Prediction assembly

- `risk` is the intent's declared risk. `confirmBeforeSend` is `true` exactly when `risk` is `side_effect`.
- `alternatives` (model path only): for an option set, its other members (§4.6). Otherwise, for each kept runner-up, in order, include it when its confidence ≥ `options.altMinConfidence` (default 0.15), its risk is not `side_effect`, it is not in cooldown, and it passes §4.7. A runner-up that fails is dropped silently; it never suppresses the prediction.
- `optionSet` is present, with the value `true`, exactly on an option set.
- `passThrough` mirrors the intent, on the prediction and on each alternative. When it is true on any of them, `context.excerpt` MUST be set: the redacted final agent message, cut to its last 300 characters and prefixed with `…` when cut.
- `qualifiedIntentId` is `<packId>@<packVersion>/<scenarioId>#<intentId>`.

### 4.9 Open mode

The default (`options.mode: "open"`). No scenario, catalog, rule or template is involved: the session's own agent reads the conversation and writes what the user is likely to send next.

1. **Availability and mode.** As §4.5 steps 1 and 2 (`no_sampler`, `budget_exhausted`).
2. **Prompt.** This one, rendered with the template syntax of §4.5 step 3 (`{{user.locale}}`, `{{signals_json}}`, `{{transcript}}`, `{{#if compact}}`):

```text
[NEXT MESSAGE PREDICTION — do not continue the task. Do not call tools.]
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
{"candidates":[{"text":"...","confidence":0.0,"sideEffect":false}]}
```

3. **Transcript.** As §4.5 step 6, but from the last 6 completed turns, with user messages cut to 2,000 characters, the final agent message to its last 4,000, and at most 12 tool lines per turn (the first 4 and the last 8 around `Tool: … (<n> more)`). Size: `fork` ≤ 4,000 bytes; `compact` ≤ 24,000 characters, dropping whole turns oldest first. Still too large → `prompt_too_large`.
4. **Call.** `sampler/sample` with `maxOutputTokens` 800; errors as §4.5 step 7.
5. **Parse.** As §4.5 step 8 up to the JSON parse. Not an object, or `candidates` not an array → `invalid_model_output`. An empty array → `model_none`.
6. **Candidates.** An entry is usable when it is an object whose `text` is a string that, trimmed, is non-empty, at most 1,000 characters long and free of control characters other than tab and line breaks, and whose `confidence` is a finite number in [0, 1]; `sideEffect` counts only when it is `true`. None usable → `invalid_model_output`. Order the usable ones by confidence, highest first (ties keep the model's order); drop one whose text, with runs of whitespace collapsed to a single space, equals an earlier one's; keep those with confidence ≥ `options.minCandidateConfidence` (default 0.15), at most 3. None kept → `below_min_confidence`.
7. **Prediction.** `mode: "open"`; `candidates` in that order; `text` is the first candidate's text; `source: "model"`; `context.excerpt` as in §4.8 whenever the final agent message is not empty. Each candidate's `text` is redacted (§7.1). Its `confirmBeforeSend` is true when `sideEffect` is true or the redacted text matches the destructive pattern of §2.2: a risky candidate is flagged, never dropped.

Open mode has no cooldown and does not use `minConfidence`, `sideEffectMinConfidence`, `altMinConfidence`, `optionSets` or scenario packs. Of the guards of §4.2 it applies all but `interrupted_turn` and `failed_turn_unhandled`: an interrupted or failed turn is evaluated like any other.

---

## 5. Delivery, actions and dispatch

### 5.1 Live predictions

A delivered prediction is *live* until the core sends `prediction/invalidated` for it. A session has at most one live prediction.

| Event | Reason |
|---|---|
| Any event of the session carrying a `turnId` other than the prediction's `sourceTurnId` (in practice the next turn's `turn.started`) | `turn_started` |
| `prediction/cancel` | `cancelled` |
| Successful send, or dismiss | `resolved` |

Nothing else invalidates a prediction. In particular an evaluation that ends with `prediction: null` MUST NOT, and neither does an ignored (unknown) event. A surface shows a prediction as actionable only while it is live; it MAY keep invalidated ones visible as history.

### 5.2 Surface actions

A surface reports a user action with `prediction/act`; the result carries `status`.

- **`copy`** → `recorded`, also for a prediction that is no longer live. A live prediction stays live.
- **`dismiss`** → `stale` if the prediction is not live. Otherwise `recorded`; invalidated (`resolved`). In catalog mode the intent's session key also enters cooldown — for an option set, every option's key, since the user turned all of them down: it is suppressed (`in_cooldown`) in the next `options.cooldownTurnsAfterDismiss` (default 3) evaluated turns of the session. Open mode has no cooldown.
- **`send`**, checked in this order:
  1. The prediction is not live → `stale`.
  2. `choice` / `alternative` / `candidate`, when present, must name an existing item (otherwise JSON-RPC error `-32602`); `candidate` exists only on open predictions, `choice` and `alternative` only on catalog ones. The *selected item* is that one, else the primary (for an open prediction, the first candidate).
  3. `confirmed !== true` and the selected item needs confirmation → `confirmation_required`. It does when it is a candidate whose `confirmBeforeSend` is true, or the primary or one of its choices while the prediction's `confirmBeforeSend` is true. (Alternatives are never `side_effect`, so they never need it.)
  4. The host declared no usable dispatch mode → `unsupported` (the surface falls back to copy). Another send for the session is still being dispatched → `busy`.
  5. Dispatch (§5.3). If `text` equals the selected item's rendered text, the item has a command action and the host accepts `command`, use `dispatch/command`; otherwise `dispatch/message` with `text`.
  6. Host reply: success → `dispatched`, invalidated (`resolved`). `TURN_MISMATCH` → `stale`, invalidated (`turn_started`). `SESSION_BUSY` → `busy`, still live. Any other error → `failed`, still live.

`action.type` `tool` and `custom` are metadata in this version: surfaces MAY display them; nothing executes them.

A surface MUST:
- show the full text that will be sent, and let the user edit it, before the send action;
- for `passThrough` predictions, show `context.excerpt` (and each choice's `label`) next to the suggestion and inside any confirmation step;
- set `confirmed: true` only after a separate confirmation step that states what will be sent to which session;
- not preselect a choice unless `preferredChoice` is present;
- for an option set, present the primary and its alternatives as equal options and preselect none of them: the text to send stays empty until the user picks one;
- for an open prediction, show every candidate in full; the first MAY start in the editor; a candidate with `confirmBeforeSend` goes through the confirmation step;
- display only what the core gives it (which is already redacted).

### 5.3 Dispatch contract (host)

`dispatch/message` and `dispatch/command` carry `expectedTurnId` (the prediction's `sourceTurnId`) and `predictionId`. A host that declares a dispatch mode MUST:

1. Treat the input exactly as if the user had typed it: its normal approval and permission flow applies. The core adds no authority.
2. Refuse with `SESSION_BUSY` while a turn is running, including while another program holds the session open and may run one (an agent that lets only one process continue a session). It MUST NOT queue the input.
3. Refuse with `TURN_MISMATCH` unless `expectedTurnId` is the session's latest completed turn.
4. Be idempotent on `predictionId`: never create a second message for one prediction.

Together with §5.1 this is I5: a "yes" can only reach the question it was predicted for.

### 5.4 Outcomes and telemetry

The core writes telemetry (`spec/feedback.schema.json`) to a local log: one evaluation record per evaluation, and **exactly one** outcome record per delivered prediction, finalized by whichever comes first:

| Outcome | Finalized when |
|---|---|
| `sent` | A send was dispatched. `edited` tells whether the text differed from the rendered text. |
| `dismissed` | The user dismissed it. |
| `passed` | The session's next `message.user` arrives. It does not matter that `turn.started` came first and already invalidated the prediction. `similarity` is recorded. |
| `expired` | A later turn of the session completes without any `message.user`, or the prediction is cancelled, or the session is dropped. |

Because the record is finalized once, the `message.user` echo of a dispatched send changes nothing. A host may start the turn before it answers the dispatch request: events that arrive while a prediction's send is still being dispatched are that send's own echo and MUST NOT finalize its outcome as `passed` or `expired`.

`similarity(a, b)`: collapse whitespace and trim both strings. If both have at least 2 characters and one contains the other, it is 1. Otherwise it is the Dice coefficient over character bigrams, `2·|A ∩ B| / (|A| + |B|)` with multiset intersection. The recorded value is the maximum over the suggestion's candidate strings: the primary text, each choice text, each alternative text, and the command string of any command action; for an open prediction, each candidate's text. An outcome record of an open prediction carries `mode: "open"` instead of `qualifiedIntentId`.

`similarity` measures wording, not intent: a user who types `/review`, or "测一下", after the suggestion "跑一下测试验证看看" scores near 0. It is therefore **recorded only**. In this version the only user feedback that changes behaviour is an explicit dismiss (§5.2). Telemetry never contains message text.

---

## 6. Sampler contract (host)

The core borrows the host's model through `sampler/sample {sessionId, expectedTurnId, mode, prompt, maxOutputTokens?, jsonSchema?}`; no separate API key is involved. A host that declares a sampler mode MUST:

1. Refuse with `SESSION_BUSY` while a turn is running, and with `TURN_MISMATCH` unless `expectedTurnId` is the session's latest completed turn.
2. Sample once, on an ephemeral branch: nothing is persisted, shown, or added to the session's history or usage shown to the user.
3. Execute no tool. If the model asks for one, return `text: null`.
4. Stop when `sampler/cancel` names the request, and answer it with `SAMPLER_ABORTED`.
5. **`compact`**: send exactly `prompt` as a single user message on the host's own model connection, with no tools and the model's normal settings. A cheaper or faster setting (lower reasoning effort, a smaller model) is allowed only as an explicit, reversible choice the user made, never as a silent default.
6. **`fork`**: append `prompt` as the next user message to an exact copy of the session's request — same system prompt, tool declarations, history and request-level settings — so the provider's prompt cache is hit. Do not change reasoning or other request settings if that would change the cache key; `maxOutputTokens` then applies to visible output only.

`compact` is the baseline every sampler-capable host is expected to offer; `fork` is optional.

---

## 7. Privacy, security and bounds

### 7.1 Redaction

Before any text enters a `compact` prompt, a `context.excerpt`, a choice `label`, or anything else a surface or log receives, the core MUST replace:

| Kind | Pattern (summary) | Replacement |
|---|---|---|
| PEM private key blocks | `-----BEGIN … PRIVATE KEY-----` … `-----END … PRIVATE KEY-----` | `[REDACTED_PRIVATE_KEY]` |
| Provider keys | `sk-…`, `gh[pousr]_…`, `github_pat_…`, `xox[baprs]-…`, `AKIA…`, `AIza…`, `hf_…` (≥ 16 further characters) | `[REDACTED_API_KEY]` |
| Authorization values | `Bearer`/`Basic` followed by ≥ 16 token characters | `[REDACTED_TOKEN]` |
| URL credentials | `scheme://user:password@` | `[REDACTED_AUTH]` |
| Secret assignments | `api_key`/`secret`/`token`/`password`/`access_key` `=` or `:` a value of ≥ 8 characters | `[REDACTED_SECRET]` |
| E-mail addresses and phone numbers | only with `options.redact = "strict"` | `[REDACTED_PII]` |

This is pattern matching and misses unprefixed secrets. In `fork` mode the session's history is already at the same provider under the host's own privacy boundary; the core redacts only what it appends.

### 7.2 Data minimisation

Only the current session's events are used. `tool.result.output` is read only by `slot.from` and is never sent to a model or a surface. What `session/turn` returns is redacted (§7.1) and cut: messages to 2,000 (user) and 4,000 (agent) characters, commands to 300, tool summaries and artifact refs to 200. `signals_json` contains only the enumerated keys of §4.5. Telemetry contains no message text.

### 7.3 Surfaces on a network transport

A surface reached over anything but the host's own connection MUST be served on a loopback address only, MUST require a per-launch random token on every request and on `surface/attach`, MUST validate `Origin`/`Host`, and MUST ship its assets with the package (no network dependency). The bundled surface MUST NOT write to, or read keystrokes from, any host input control.

### 7.4 Layers against a hostile transcript

Tool output and fetched pages can steer a model. What stands between that and the user's send button: the closed catalog (I2), template-only text (I3), slot validation with the literal-occurrence rule (§4.7), the proposed-risk exclusion of pass-through intents (§4.3), the output checks (§4.7), the confirmation step for `side_effect` (§5.2), and turn-pinned explicit send (§5.3). None of them alone is a guarantee.

### 7.5 Bounds

Implementation-defined, MUST be documented: events retained per session (RECOMMENDED: the last 50 turns or 500 events, whichever is smaller) and the number of sessions kept (least-recently-used eviction; an evicted session's open outcome is `expired`). Cooldown and delivery counts are in-memory per session. When the core shuts down, every open outcome is finalized as `expired`.

---

## 8. Protocol

JSON-RPC 2.0. Between a host and an out-of-process core the transport is newline-delimited JSON over stdio. A surface uses any transport that carries the same messages in both directions. The bundled one is plain HTTP on loopback (§7.3): requests are `POST`ed as JSON-RPC, notifications arrive as a Server-Sent Events stream. Message shapes are in `spec/rpc.schema.json`.

| From → to | Method | Kind | Purpose |
|---|---|---|---|
| Host → Core | `initialize` | request | Capabilities (`interactive`, `samplerModes`, `dispatchModes`, `surface`, `binding`), packs, `policy`, `options`. The result MAY carry `surfaceUrl`, which the host SHOULD show to the user. |
| Host → Core | `session/observe` | notification | `{sessionId, events}`. |
| Host or Surface → Core | `prediction/cancel` | notification | Abort the evaluation and invalidate the live prediction of a session. |
| Core → Host | `sampler/sample` | request | §6. |
| Core → Host | `sampler/cancel` | notification | `{sampleRequestId, sessionId}`. |
| Core → Host | `dispatch/message`, `dispatch/command` | request | §5.3. |
| Surface → Core | `surface/attach` | request | Start receiving predictions; returns the sessions and their live predictions. Each session also carries its recent evaluations (`recent`, retained per session, capped; suppressed ones only for `inspector: true`), so a surface opened after an evaluation can still show it. |
| Core → Surface | `prediction/updated` | notification | One evaluation result (§4.1). Plain surfaces receive delivered predictions; surfaces attached with `inspector: true` also receive suppressed results and `trace`. |
| Core → Surface | `prediction/invalidated` | notification | §5.1. |
| Core → Surface | `binding/changed` | notification | A binding took effect: `{bound, sessionId}`; attached surfaces refresh without reloading. |
| Surface → Core | `prediction/act` | request | §5.2. |
| Surface → Core | `session/turn` | request | `{sessionId, turnId}` → what happened in one retained turn, so a surface can let the user look back: the user's and the agent's messages, tool calls with their status, exit code and summary, and artifacts, in event order. A turn that is not retained (any more) → `-32602`. |
| Surface → Core | `binding/list`, `binding/bind` | request | Ask which of the host's existing agent sessions can be bound, and bind one. The core forwards both to a host that declared `binding`; other hosts answer `-32601`. |
| Core → Host | `binding/list`, `binding/bind` | request | The forwarded calls. Discovery and binding are the host's alone; the core keeps no session registry of its own. |

Binding points the host at one of its existing agent sessions. `binding/list` returns the currently bound session (or `null`) and the sessions the host discovered, each `{kind, id, cwd, title?, updatedAt?, running, bindable, profile?}`; kinds and discovery are host-defined and host-local, and only metadata crosses. `binding/bind {kind, id, cwd, profile?}` hot-switches the session the host drives: the host MUST fail it with `SESSION_BUSY` while a turn runs, MUST invalidate the live prediction, and observes post-bind turns under a fresh core session id. The host MAY replay the bound session's most recent completed turns as observed events under that id, so a suggestion can be offered at once (the count returns as `replayedTurns`); a host that replays MUST refuse a dispatch for a replayed turn once the bound session has advanced past the replay point (`TURN_MISMATCH`). A replaying host MAY restore completed turns added since its replay point at any time — when handling `binding/list` (which surfaces call on load and refresh), or by watching the session's store so that turns taken in the agent's own interface show up without a refresh — and move that point forward; it MUST NOT restore the same turn twice. A surface MUST offer binding only when `surface/attach` reports `binding: true`, and MUST disable bind actions for entries with `bindable: false`. The attach result also carries the current `bound` session and the host's `activeSessionId` (listed in `sessions` even before its first turn), so a surface opened after a bind starts on the bound session.

Session ids and profile names end up on the host's command lines and in its store paths. A host MUST refuse to bind (`-32602`) any value that could be read as an option or could leave its stores, for example one that starts with `-` or contains a path separator or `..`, and MUST report such discovered entries as `bindable: false`. Turns of a bound session, replayed or new, are evaluated like any other, so excerpts of their recent content (redacted, §7.1) go to the host's sampler. A host SHOULD sample a bound session with that session's own agent (§6), so the content stays with the provider the session already uses; when its sampler uses a different provider, the host MUST say so wherever it offers binding. Turns a host drives in a bound session go through that agent's own permission flow (§5.3 rule 1): the host MUST NOT drive them in a mode that approves actions on the user's behalf, and MUST refuse every permission request the agent sends to it.

A host that declares `capabilities.surface` is treated as an attached surface on its own connection.

Ids of core-originated requests start with `s-`. Error codes beyond the JSON-RPC standard ones: `-32001 SESSION_BUSY`, `-32002 TURN_MISMATCH`, `-32003 SAMPLER_ABORTED`, `-32004 UNAUTHORIZED`. A host MUST keep reading its input while it waits: reverse requests arrive at any time.

---

## 9. Conformance

An implementation conforms to v0.5 when:

1. Every message it emits validates against `spec/*.schema.json`.
2. It loads `INTENTS.md` and the packs under `examples/` and `eval/fixtures/`, and passes every case in `eval/golden.jsonl`.
3. `python tools/validate.py` passes on the repository.

### 9.1 `eval/golden.jsonl`

One JSON object per line; no live model is involved. Common fields: `id`, `kind`, optional `pack` (path of a `*.intents.md` relative to the repository root; default `INTENTS.md`), optional `sessionId`, optional `config`:

| `config` key | Meaning |
|---|---|
| `sampler` | `"none"` (default): the host offers no sampler. Otherwise an object: `mode` (`compact` default, or `fork`) plus one of `reply` (the raw model text returned for every call), `replies` (a list consumed one per call), `replyNull: true`, `error: <code>`, `timeout: true`, `pending: true` (the call never returns). |
| `interactive`, `dispatchModes` | Host capabilities. Defaults `true`, `[]`. |
| `policy`, `options` | As in `initialize`. |

Timing is logical: the settle delay is skipped and `timeout: true` stands for the timeout elapsing.

**`kind: "pipeline"`** — `events` are observed in order; `state` entries, if any, are applied as `state` events just before the last event. `expect` describes the evaluation triggered by the last event and may combine:

- `suppressedReason` — the evaluation ends with `prediction: null` and this reason;
- `prediction` — a prediction is delivered and matches this subset (objects match recursively by subset; scalars and arrays by equality; a top-level key given as `null` asserts that the prediction does not have it). The shorthands `intentId`, `alternativeIds`, `choiceTexts`, `choiceLabels`, `candidateTexts` and `contextIncludes` stand for `intent.id`, the alternatives' ids, the choices' texts and labels, the candidates' texts, and a substring of `context.excerpt`;
- `signals` — these signal paths have these values (`null` asserts absence);
- `catalog` — `{scenarioId, includes, excludes}` after §4.3;
- `prompt` — `{includes, excludes, maxBytes}` on the rendered prompt.

**`kind: "session"`** — `steps` run in order. A step holds one of `observe` (events), `cancel: true` (a `prediction/cancel`), or `act` (`prediction/act` params without `predictionId`; it addresses the session's most recently delivered prediction; `hostReply: {"error": <code>}` makes the host refuse the dispatch), plus an optional `expect` about what that step produced:

- `suppressedReason`, `prediction` — as above, for the evaluation completed in this step; `noEvaluation: true` asserts none completed;
- `invalidated` — a `prediction/invalidated` with this reason was sent; `noInvalidation: true` asserts none was;
- `samplerCancelled: true` — a `sampler/cancel` was sent;
- `status` — the result status of `act`; `error` — `act` failed with this JSON-RPC error code instead;
- `dispatch` — `null` asserts nothing was dispatched; an object is a subset of the dispatch request (`method` plus its params; the string `$predictionId` stands for the id of the addressed prediction);
- `outcome` — an outcome record matching this subset was finalized; `noOutcome: true` asserts none was.

---

## Appendix A — Suppression reasons

| Stage | Reasons |
|---|---|
| Guards (§4.2) | `disabled`, `non_interactive`, `pending_interaction`, `interrupted_turn`, `failed_turn_unhandled`, `mode_blocked`, `incognito`, `max_per_session_reached` |
| Routing (§4.3) | `no_scenario_matched`, `empty_catalog` |
| Model availability and call (§4.1, §4.5) | `no_sampler`, `budget_exhausted`, `prompt_too_large`, `sampler_error`, `timeout`, `aborted` |
| Model output (§4.5) | `invalid_model_output`, `unknown_intent`, `model_none` |
| Gate (§4.6) | `in_cooldown`, `below_min_confidence` |
| Rendering (§4.7) | `slot_validation_failed`, `output_invalid`, `output_dangerous` |

## Appendix B — Defaults

| Name | Default | Set in |
|---|---|---|
| `minConfidence` | 0.60 | `policy` (host, pack, scenario) |
| `sideEffectMinConfidence` | 0.80 | `policy` (host, pack, scenario) |
| `altMinConfidence` | 0.15 | `options` |
| `optionSets` | `true` | `options` |
| `mode` | `open` | `options` |
| `minCandidateConfidence` | 0.15 | `options` |
| `cooldownTurnsAfterDismiss` | 3 | `options` |
| `maxPerSession` | unlimited | `options` |
| `modelBudget.maxCallsPerHour` | unlimited | `options` |
| `blockedModes` | `["plan"]` | `options` |
| `samplerMode` | `compact` | `options` |
| `settleMs` / `timeoutMs` | 150 / 4000 | `options` |
| `redact` | `default` | `options` |
