---
id: builtin/coding
version: 0.3.0
description: Built-in bounded-scenario intent contract across O1 (Single-Session), O2 (Agent-Wide), and O3 (Global Environment).
observation_stages: [O1, O2, O3]
policy:
  minConfidence: 0.60
  minMargin: 0.15
  ghostTextRisks: [none, read_only, reversible]
  cooldownTurnsAfterDismiss: 3
  ignoredBackoff:
    streak: 3
    raiseBy: 0.10
    maxRaise: 0.25
    nearMatchSimilarityThreshold: 0.75

scenarios:
  # ───────────────────────────────────────────────────────────────────────────
  # Stage O1: Single-Session Scenarios (Observed inside the current thread)
  # ───────────────────────────────────────────────────────────────────────────
  - id: coding.checks_failed
    stage: O1
    priority: 30
    description: The agent ran tests, build, or linter commands in the last turn and at least one execution failed.
    triggers: [turn.completed]
    triggerOnTurnStatuses: [completed, failed]
    match:
      signal: lastTurn.failedExecs
      gt: 0
    intents:
      - id: fix_failures
        description: Ask the agent to diagnose and fix the failing tests, build, or lint errors.
        examples: ["修一下这些报错", "fix the failing tests"]
        render: { zh-CN: "修一下这些失败", en: "fix the failures" }
        risk: reversible
        prior: 0.55
      - id: show_details
        description: Ask the agent to explain the root cause or show detailed failure output first.
        examples: ["先看看具体哪里错了", "show me the error details"]
        render: { zh-CN: "先看看具体报错原因", en: "show me the root cause of the failure" }
        risk: none
        prior: 0.20
      - id: rerun_checks
        description: Ask the agent to re-run the failed command or tests (suspecting flakiness).
        examples: ["再跑一次试试", "run it again"]
        render: { zh-CN: "再跑一次试试", en: "run the checks again" }
        risk: reversible
        prior: 0.15
      - id: skip_for_now
        description: Tell the agent to ignore the failure for now and move on with the task.
        examples: ["先跳过这个，继续", "skip this for now"]
        render: { zh-CN: "先跳过这个，继续下一步", en: "skip this for now and continue" }
        risk: none
        prior: 0.10

  - id: coding.awaiting_reply
    stage: O1
    priority: 25
    description: The agent ended its message with a direct question or a numbered list of choices awaiting user decision.
    triggers: [turn.completed]
    match:
      any:
        - { signal: lastAgentMessage.endsWithQuestion, eq: true }
        - { signal: lastAgentMessage.optionsCount, gt: 1 }
    intents:
      - id: confirm
        description: Approve or agree with the agent's proposed plan or default recommendation.
        when:
          all:
            - { signal: lastAgentMessage.endsWithQuestion, eq: true }
            - not: { signal: lastAgentMessage.proposedRisk, in: [side_effect, irreversible] }
        render: { zh-CN: "可以，按这个方案继续", en: "yes, go ahead with that" }
        risk: reversible
        dynamicRiskFromProposedAction: true
        allowedChannels: [chips, action_button]
        prior: 0.45
      - id: choose_option
        description: Pick one of the numbered options presented by the agent.
        when:
          all:
            - { signal: lastAgentMessage.optionsCount, gt: 1 }
            - not: { signal: lastAgentMessage.proposedRisk, in: [side_effect, irreversible] }
        slots:
          index: { type: number, from: lastAgentMessage.preferredOptionIndex, pattern: "^[1-9]$", required: true, default: 1 }
        render: { zh-CN: "选第 {index} 个方案", en: "let's go with option {index}" }
        risk: reversible
        dynamicRiskFromProposedAction: true
        allowedChannels: [chips, action_button]
        prior: 0.35
      - id: ask_tradeoffs
        description: Ask the agent to compare the tradeoffs or clarify before deciding.
        render: { zh-CN: "先说说这几种做法的利弊", en: "what are the tradeoffs between these options?" }
        risk: none
        prior: 0.12
      - id: decline
        description: Reject the proposed direction and ask for a simpler or different approach.
        render: { zh-CN: "不用这样，换个更简单的做法", en: "no, let's use a simpler approach" }
        risk: none
        prior: 0.08

  - id: coding.after_edit
    stage: O1
    priority: 20
    description: The agent modified or created files in this turn without running tests afterward.
    triggers: [turn.completed]
    match:
      all:
        - { signal: lastTurn.filesChanged, gt: 0 }
        - not: { signal: lastTurn.toolKinds, contains: execute }
    intents:
      - id: run_tests
        description: Ask the agent to run the relevant tests or typecheck to verify the changes.
        render: { zh-CN: "跑一下测试验证看看", en: "run the tests to verify" }
        risk: reversible
        prior: 0.42
      - id: review_diff
        description: Ask to inspect or review the diff of the changes made so far.
        render: { zh-CN: "检查一下刚才的改动", en: "review the changes" }
        action: { type: command, command: "/review" }
        risk: read_only
        prior: 0.22
      - id: explain_changes
        description: Ask the agent to briefly explain how or why the change was made this way.
        render: { zh-CN: "解释一下这处改动的原理", en: "walk me through how this change works" }
        risk: none
        prior: 0.14
      - id: continue_task
        description: Ask the agent to proceed with the next step of the plan or implementation.
        render: { zh-CN: "继续下一步", en: "continue with the next step" }
        risk: reversible
        prior: 0.14
      - id: commit_changes
        description: Ask the agent to stage and commit the current changes locally.
        render: { zh-CN: "提交一下当前的改动", en: "commit these changes" }
        risk: reversible
        prior: 0.08

  - id: coding.task_verified
    stage: O1
    priority: 18
    description: The agent modified files and ran verification commands that all succeeded (0 failed execs).
    triggers: [turn.completed]
    match:
      all:
        - { signal: lastTurn.filesChanged, gt: 0 }
        - { signal: lastTurn.toolKinds, contains: execute }
        - { signal: lastTurn.failedExecs, eq: 0 }
    intents:
      - id: commit_changes
        description: Ask the agent to commit the verified changes with a concise commit message.
        render: { zh-CN: "把这些改动提交一下", en: "commit these changes" }
        risk: reversible
        prior: 0.45
      - id: review_diff
        description: Run a code review on the current changes before committing.
        render: { zh-CN: "先 review 一下全部改动", en: "review all changes before committing" }
        action: { type: command, command: "/review" }
        risk: read_only
        prior: 0.25
      - id: open_pr
        description: Push the branch and open a pull request.
        render: { zh-CN: "创建 Pull Request", en: "open a pull request" }
        risk: side_effect
        allowedChannels: [chips, action_button]
        prior: 0.15
      - id: continue_task
        description: Proceed to the next item in the plan or task list.
        render: { zh-CN: "继续下一项任务", en: "move on to the next step" }
        risk: reversible
        prior: 0.15

  # ───────────────────────────────────────────────────────────────────────────
  # Stage O2: Agent-Wide Scenarios (Subagents, background jobs, kanban tasks)
  # ───────────────────────────────────────────────────────────────────────────
  - id: coding.subagent_reported
    stage: O2
    priority: 22
    description: A delegated subagent or background agent job just completed and returned its findings.
    triggers: [agent.subagent_completed, agent.background_job, turn.completed]
    match:
      any:
        - { signal: agent.lastSubagent.status, eq: completed }
        - { signal: agent.lastBackgroundJob.status, eq: completed }
    intents:
      - id: apply_subagent_result
        description: Ask the main agent to integrate or apply the completed subagent's findings.
        render: { zh-CN: "结合子任务的结果继续处理", en: "integrate the subagent findings and continue" }
        risk: reversible
        prior: 0.50
      - id: verify_subagent_work
        description: Ask the main agent to verify the subagent's output or run tests on its changes.
        render: { zh-CN: "验证一下后台任务的产出是否正确", en: "verify the background task output" }
        risk: read_only
        prior: 0.30
      - id: review_pending_tasks
        description: Check remaining open or review-ready tasks on the agent board.
        when: { signal: agent.pendingReviews, gt: 0 }
        render: { zh-CN: "查看待审阅的任务卡片", en: "check the tasks awaiting review" }
        risk: read_only
        prior: 0.20

  # ───────────────────────────────────────────────────────────────────────────
  # Stage O3: Global Environment Scenarios (Shell, Git, IDE, Clipboard)
  # ───────────────────────────────────────────────────────────────────────────
  - id: coding.ambient_terminal_failed
    stage: O3
    priority: 28
    description: The user manually ran a command in the terminal outside the agent turn and it exited with a non-zero code.
    triggers: [env.terminal_command]
    match:
      signal: env.lastTerminalCommand.exitCode
      ne: 0
    intents:
      - id: diagnose_terminal_error
        description: Ask the agent to diagnose and fix the command failure that just occurred in the terminal.
        render: { zh-CN: "帮我看看刚才终端命令为什么报错并修一下", en: "diagnose and fix the terminal command failure" }
        risk: reversible
        prior: 0.65
      - id: explain_terminal_error
        description: Ask the agent to explain the error output without modifying files yet.
        render: { zh-CN: "解释一下刚才终端里的报错原因", en: "explain what caused that terminal error" }
        risk: none
        prior: 0.35

  - id: coding.ambient_ide_diagnostics
    stage: O3
    priority: 16
    description: The user is focused on a file in the IDE that currently reports LSP compile/type errors, or copied a stacktrace.
    triggers: [env.ide_context, env.ambient_context]
    match:
      any:
        - { signal: env.ide.diagnosticsErrors, gt: 0 }
        - { signal: env.ambient.clipboardKind, eq: stacktrace }
    intents:
      - id: fix_ide_diagnostics
        description: Ask the agent to fix the type/compile errors in the active file or clipboard stacktrace.
        render: { zh-CN: "修一下当前文件里的类型/编译报错", en: "fix the diagnostics errors in the active file" }
        risk: reversible
        prior: 0.65
      - id: explain_stacktrace
        description: Ask the agent to trace and explain the stacktrace or diagnostic error.
        render: { zh-CN: "分析一下这段报错栈的原因", en: "trace and explain this error" }
        risk: none
        prior: 0.35
---

# Intent Classification Prompt Contract

`[INTENT PREDICTION — do not continue the task. Do not call tools.]`

Predict the user's NEXT message or action in this session, choosing strictly from the active scenario's catalog below.

- Active Scenario (`{{scenario.id}}` / Stage `{{scenario.stage}}`): {{scenario.description}}
- User Locale: `{{user.locale}}`

## Candidate Catalog

{{#each intents}}
- `{{id}}`: {{description}}{{#if slots}} (slots: {{slots_spec}}){{/if}}{{#if examples}} — e.g. {{examples}}{{/if}}
{{/each}}
- `none`: nothing above fits, or you are not confident.

## Classification Rules

1. **User Perspective Test**: Predict what THE USER would type next, not what you think they should do. Ask: *"Would the user think 'I was just about to type that'?"*
2. **Explicit Offer Priority**: Read the last few lines of the assistant's message (and any O2/O3 environment signals). If the assistant explicitly offers a next step (a slash command, a direct question, or numbered options), prefer the matching intent.
3. **Destructive & External Side-Effect Veto**: If the assistant is asking to confirm a destructive action (`rm -rf`, `git reset --hard`, `drop table`, force push) or an unrequested external side effect, you MUST return `"none"`.
4. **Fail-Closed Default**: Prefer `"none"` over a guess. A wrong suggestion costs far more than no suggestion.
5. **Voice & Locale**: `"text"` MUST be written in locale `"{{user.locale}}"`, in the user's natural first-person phrasing, one short sentence, no quotes, no markdown, and NEVER in the assistant's voice (`"Let me..."`, `"I will..."`, `"我来..."`). Leave `"text"` empty when `"intent"` is `"none"`.
6. **Literal Slot Grounding**: Fill `"slots"` ONLY with values that literally appear in the conversation or observed signals.
7. **Runner-Ups for Chips**: Optionally include up to 2 plausible runner-up intents in `"runnerUps"` so multi-chip UI surfaces can offer alternatives when margin is tight.

{{#if compact}}
## Recent Conversation (Oldest First, Redacted)
{{transcript}}
{{/if}}

## Observed Signals (O1 / O2 / O3)
`{{signals_json}}`

Reply with a single JSON object only:
`{"intent":"<id>","confidence":0.0,"slots":{},"text":"","runnerUps":[{"intent":"<id2>","confidence":0.0}]}`
