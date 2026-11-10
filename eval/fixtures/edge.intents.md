---
id: fixture/edge
version: 0.1.0
description: Test fixture for edge cases of the pipeline (empty catalog, model-filled slots, output checks). Not an example to copy. It has no prompt body, so the default prompt of SPEC 4.5 is used.
scenarios:
  - id: edge.empty
    priority: 50
    description: Every intent is conditional, so the catalog can end up empty.
    match: { signal: state.fixture, eq: empty }
    intents:
      - id: never
        description: An intent whose precondition never holds.
        when: { signal: state.never, eq: true }
        render: "never shown"
        risk: none

  - id: edge.slots
    priority: 40
    description: Intents whose text and action are built from model-provided slots.
    match: { signal: state.fixture, eq: slots }
    intents:
      - id: open_file
        description: Ask the agent to open a file mentioned in the conversation.
        slots:
          path: { type: path, required: true }
        render: { zh-CN: "打开 {path}", en: "open {path}" }
        action: { type: tool, name: open_file, input: { path: "{path}" } }
        risk: read_only
      - id: run_command
        description: Ask the agent to run a command mentioned in the conversation.
        slots:
          cmd: { type: string, required: true, maxLength: 60 }
        render: { zh-CN: "运行 {cmd}", en: "run {cmd}" }
        risk: reversible
      - id: pick_env
        description: Ask the agent to switch to a named environment.
        slots:
          env: { type: enum, enum: [dev, staging], required: true }
        render: "switch to {env}"
        risk: reversible
      - id: long_note
        description: An intent whose template is long enough to overflow the output limit.
        slots:
          note: { type: string, required: true, maxLength: 80 }
        render: "please write the following note into the changelog under the unreleased section and keep the existing formatting exactly as it is today: {note}"
        risk: none
      - id: publish
        description: Publish the package, an external side effect.
        examples: ["publish it"]
        render: "publish the package"
        action: { type: command, command: "/publish" }
        risk: side_effect
---
