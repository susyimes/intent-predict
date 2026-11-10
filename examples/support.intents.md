---
id: example/support
version: 0.2.0
description: Example (non-coding) support-agent pack with a deterministic slot, a tool action and a side-effect intent.
scenarios:
  - id: support.order_shown
    priority: 20
    description: The support agent just looked up and displayed an order.
    match:
      signal: lastTurn.toolNames
      contains: get_order
    intents:
      - id: track_shipment
        description: Check shipment progress for the order that was just shown.
        examples: ["到哪了", "帮我查下物流", "where is my package"]
        slots:
          orderId: { type: string, from: lastTurn.toolOutputs.get_order.id, required: true, maxLength: 32, pattern: "^[A-Za-z0-9-]+$" }
        render: { zh-CN: "帮我查下物流", en: "where is my package?" }
        action: { type: tool, name: track_shipment, input: { orderId: "{orderId}" } }
        risk: read_only
      - id: request_refund
        description: Request a refund for the shown order.
        examples: ["我要退款", "I'd like a refund"]
        slots:
          orderId: { type: string, from: lastTurn.toolOutputs.get_order.id, required: true, maxLength: 32, pattern: "^[A-Za-z0-9-]+$" }
        render: { zh-CN: "我要退款", en: "I'd like a refund" }
        action: { type: tool, name: request_refund, input: { orderId: "{orderId}" } }
        risk: side_effect
      - id: talk_to_human
        description: Escalate to a human support agent.
        examples: ["转人工", "talk to a human"]
        render: { zh-CN: "转人工", en: "talk to a human" }
        risk: none
---

[INTENT PREDICTION — do not continue the task. Do not call tools.]

Predict the customer's NEXT message, choosing strictly from the catalog below. Prefer "none" over a guess. Fill "slots" only with values that literally appear in the conversation.

Scenario: {{scenario.description}}
{{#each intents}}
- `{{id}}`: {{description}}{{#if examples}} — e.g. {{examples}}{{/if}}
{{/each}}
- `none`: nothing above fits, or you are not confident.

{{#if compact}}
Recent conversation (oldest first):
{{transcript}}
{{/if}}
Signals: {{signals_json}}

Reply with a single JSON object only:
{"intent":"<id>","confidence":0.0,"slots":{},"runnerUps":[{"intent":"<id2>","confidence":0.0}]}
