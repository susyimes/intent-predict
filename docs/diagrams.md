# 说明图（Phase 1：O1 × A1）

只画当前阶段。后续阶段的草案在 [future.md](future.md)。图与 [SPEC.md](../SPEC.md) 冲突时以 SPEC 为准。

## 1. 三个角色

```mermaid
flowchart LR
  classDef host fill:#eafaf1,stroke:#1e8449,color:#145a32
  classDef core fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef surf fill:#fef5e7,stroke:#b9770e,color:#7e5109

  H["宿主<br/>会话事件 · 自己的模型 · 可选的发送入口"]:::host
  C["核心<br/>流水线 · 建议的有效期 · 发送规则 · 遥测"]:::core
  S["界面<br/>自带网页，或宿主自己"]:::surf

  H -->|"session/observe"| C
  C -->|"sampler/sample · sampler/cancel"| H
  C -->|"prediction/updated · prediction/invalidated"| S
  S -->|"prediction/act（send / copy / dismiss）"| C
  C -->|"dispatch/message · dispatch/command"| H
```

## 2. 一条建议从哪来、在哪被挡下

每一级都有一条通往「不给建议」的出口；出口上的名字就是记录下来的 `SuppressedReason`。

```mermaid
flowchart TB
  classDef step fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef stop fill:#fdecec,stroke:#b03a2e,color:#7b241c
  classDef done fill:#eafaf1,stroke:#1e8449,color:#145a32

  T["turn.completed<br/>等 settleMs 收齐尾部事件"]:::step
  G["守卫<br/>关闭 / 非交互 / 等待审批 / 中断 / 失败轮 / plan 模式 / 隐私 / 本会话上限"]:::step
  R["选一个场景<br/>按 priority；兜底场景只在没有别的命中时用"]:::step
  K["目录<br/>去掉 when 不成立的、提议有风险时的透传类、无法枚举的"]:::step
  D{"确定性规则命中？<br/>R1 显式提示 · R2 编号选项"}:::step
  M["借宿主模型分类<br/>目录内选一项或 none<br/>严格解析"]:::step
  Q["门槛<br/>冷却中？置信度够吗？"]:::step
  W["槽位校验 → 模板渲染 → 输出检查"]:::step
  P["Prediction"]:::done
  X["prediction: null + 一个原因"]:::stop

  T --> G --> R --> K --> D
  D -->|"是，不调模型"| Q
  D -->|"否"| M --> Q --> W --> P
  G -.-> X
  R -.->|"no_scenario_matched"| X
  K -.->|"empty_catalog"| X
  M -.->|"no_sampler / budget / prompt_too_large<br/>sampler_error / timeout / aborted<br/>invalid_model_output / unknown_intent / model_none"| X
  Q -.->|"in_cooldown / below_min_confidence"| X
  W -.->|"slot_validation_failed / output_invalid / output_dangerous"| X
```

## 3. 时序：出建议，用户发送

```mermaid
sequenceDiagram
  participant U as 用户
  participant S as 界面
  participant C as 核心
  participant H as 宿主

  H->>C: session/observe（t7 的事件，以 turn.completed 收尾）
  C->>H: sampler/sample（expectedTurnId = t7）
  H-->>C: {"intent":"run_tests","confidence":0.84,…}
  C->>S: prediction/updated（建议 p-1）
  U->>S: 看一眼，可改字，点「发给 Agent」
  S->>C: prediction/act（p-1, send, text）
  C->>H: dispatch/message（text, expectedTurnId = t7, predictionId = p-1）
  H-->>C: {}（已当作用户输入开始新的一轮）
  C->>S: prediction/invalidated（p-1, resolved）
  C-->>S: status: dispatched
  H->>C: session/observe（t8 开始…）
```

用户没用建议、自己在宿主里发了下一句时：`t8` 的第一个事件到达，核心发 `prediction/invalidated（turn_started）`；等 `message.user` 到达时把结果记为 `passed`，附字面相似度。

采样途中下一轮开始时：核心发 `sampler/cancel`，以 `aborted` 结束这次求值；宿主之后送来的回复被丢弃。

## 4. 一条建议的一生

```mermaid
stateDiagram-v2
  [*] --> Live: prediction/updated
  Live --> Live: copy（记一笔，仍然有效）
  Live --> Live: send → busy / failed / confirmation_required
  Live --> Resolved: send → dispatched
  Live --> Resolved: dismiss（该意图进入冷却）
  Live --> Invalidated: 别的轮次的事件到达（turn_started）
  Live --> Invalidated: 宿主拒绝派发 TURN_MISMATCH（send → stale）
  Live --> Invalidated: prediction/cancel（cancelled）
  Resolved --> [*]
  Invalidated --> [*]
```

「有效」与「结果已记录」是两件事：一条建议在下一轮开始时就失效（不能再发送），但它的结果要等到用户的下一条消息到达才定为 `passed`，或者在下一轮没有任何用户消息就结束时定为 `expired`。每条建议恰好有一条结果记录。
