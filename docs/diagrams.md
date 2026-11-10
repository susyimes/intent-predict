# 说明图（按阶段拆分）

所有图按 [ROADMAP.md](../ROADMAP.md) 的五阶段拆开维护，每阶段只画自己这一格。统一约定：

- **实线蓝框**：该阶段的实现范围。
- **虚线灰框**：规范已定、后续阶段才启用的部分（画出来只为标明边界，不进当前实现）。
- **红框汇点**：fail-closed 抑制出口——任何异常都收束到「不给建议」。

当前阶段是 **Phase 1（O1 × A1）**，只有第 1 节的三张图需要精修到可照着写代码；第 2–5 节是每个后续阶段的单页增量图（只画新增输入/输出，既有核心收成一个框）。

## 0. 全景：双轴总图（完整愿景，不是当前范围）

```text
          A1 纯建议    A2 推测预执行   A3 委托执行
O3 全局    Phase 3  →   Phase 4    →   Phase 5
O2 全Agent Phase 2  ↗
O1 单会话  Phase 1（当前，只做这一格）
```

双轴的完整 mermaid 总图见 [SPEC.md](../SPEC.md) §1.1 与 [design.md](design.md) §5，此处不复制第二份。

## 1. Phase 1（O1 × A1）：当前精修范围

### 1.1 架构主图：一条建议从哪来、在哪被挡下

读图顺序：左边是宿主边界（进来只有 O1 事件，出去只有「填入式」建议）；中间核心从上到下是一条单向流水线，每一级都有虚线通向最下方红框——任何一级不通过都不给建议。

```mermaid
flowchart TB
  classDef now fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef future fill:#f7f7f7,stroke:#9aa0a6,color:#5f6368,stroke-dasharray: 5 5
  classDef stop fill:#fdecec,stroke:#b03a2e,color:#7b241c
  classDef host fill:#eafaf1,stroke:#1e8449,color:#145a32

  EV["宿主 · O1 事件流（唯一输入）<br/>turn / message<br/>tool / artifact / state"]:::host
  XB["O2/O3 事件<br/>agent.* / env.*<br/>接收即忽略"]:::future

  subgraph Core["intent-predict 核心（Phase 1 实现范围）"]
    direction TB
    LD["契约加载 INTENTS.md<br/>仅启用 stage=O1 场景"]:::now
    SS["会话存储 + 信号提取<br/>文件数 / 失败数<br/>尾部问句 / 选项<br/>hints / locale"]:::now
    GD["守卫 + 风险扫描<br/>输入框非空、待确认<br/>plan、incognito 直接退出<br/>proposedRisk 评提议风险"]:::now
    RT["有限场景路由<br/>match 谓词 + 优先级<br/>+ 特异度排序<br/>专用场景 → 兜底场景"]:::now
    CD{"候选从哪来？"}:::now
    RL["规则短路<br/>仅 explicit 提示<br/>斜杠命令<br/>输入引导"]:::now
    MD["模型约束分类<br/>目录内选一<br/>或 none<br/>top-1 + runnerUps"]:::now
    GT["Per-Intent 门控<br/>来源场景策略<br/>阈值 / 分差<br/>风险 / 冷却<br/>通道三选一裁决"]:::now
    RD["渲染交付<br/>槽位严格校验<br/>模板 · Action 插值<br/>9 条后置过滤"]:::now
    PD["Prediction<br/>意图 + 槽位<br/>+ 建议文本"]:::now
    NX["completed + null<br/>SuppressedReason<br/>fail-closed<br/>宁可没有"]:::stop
    LD --> RT
    SS --> GD --> RT --> CD
    CD -->|"explicit 命中，跳过模型"| RL --> GT
    CD -->|"无短路且有 Sampler"| MD --> GT
    CD -.->|"无模型且无显式命中"| NX
    GT --> RD --> PD
    GD -.->|"守卫命中"| NX
    RT -.->|"无场景命中"| NX
    MD -.->|"none / 输出非法"| NX
    GT -.->|"阈值或通道不合"| NX
    RD -.->|"槽位或过滤失败"| NX
  end

  SM["宿主零配置 Sampler<br/>sampler/sample<br/>单轮无工具 · 温度 0<br/>cancel 一到立停"]:::host
  UI["宿主输入框 UI（唯一输出面）<br/>Ghost Text / Chips / 确认按钮<br/>Tab 只填入 · 绝不发送"]:::host
  FB[("本地反馈 JSONL<br/>接受 / 编辑<br/>忽略 / 关闭<br/>+ similarity<br/>在线先验 → Phase 2")]:::now
  AG["A2 推测预执行<br/>A3 委托执行<br/>不在 Phase 1"]:::future

  EV -->|"session/observe"| SS
  XB -.->|"stage 门控"| SS
  MD <-->|"sample / cancel"| SM
  PD -->|"prediction/updated"| UI
  NX -.->|"撤下残留建议"| UI
  UI -->|"Feedback"| FB
  FB -.->|"冷却 / 退避"| GT
```

这张图特意画出的三条 Phase 1 不变量：

1. **输入只有一扇门**：O1 事件进来，O2/O3 事件在门上就被 stage 门控挡下，不产生任何信号。
2. **每条路都有红框出口**：守卫、路由、模型、门控、渲染五级里任何一级出问题，都归入同一个抑制汇点并附标准 `SuppressedReason`，便于回放时逐条计数。
3. **输出只有一个面**：`Prediction` 只能落到输入框的三种低摩擦形态；A2/A3 在图上是虚线孤岛，Phase 1 没有任何边连过去。

### 1.2 时序图：一次完整的建议（含取消）

```mermaid
sequenceDiagram
  participant U as 用户
  participant H as 宿主 Agent
  participant P as intent-predict（Phase 1）
  participant M as 宿主 Sampler
  participant UI as 输入框

  H->>P: session/observe（本轮 O1 事件 + turn.completed）
  P->>P: settle 150ms 收齐尾部事件 → 守卫 → 场景路由
  alt 规则 explicit 命中（低风险、槽位已齐）
    P-->>H: prediction/updated（短路，不调模型）
  else 需要模型分类
    P->>M: sampler/sample（id=s-1，封闭目录提示词）
    alt 采样期间用户开始打字 / 新一轮开始
      U->>UI: 输入字符
      H->>P: session/observe（composer.dirty=true）
      P->>M: sampler/cancel（s-1）
      P-->>H: prediction/updated（null，aborted）
      H->>UI: 立即撤下建议
    else 采样正常返回
      M-->>P: intent + confidence + runnerUps + slots
      P->>P: 门控与通道裁决 → 槽位校验 → 9 条过滤
      P-->>H: prediction/updated（ghost_text / chips / action_button）
    end
  end
  H->>H: 展示前复查 sourceTurnId 未过期、输入框仍为空
  H->>UI: 300ms 后按通道渲染
  alt 用户按 Tab
    UI-->>P: Feedback accepted（或发送前修改记 edited）
  else 用户直接打自己的话并发送
    UI-->>P: Feedback ignored + 本地计算的 similarity
  else 用户按 Esc
    UI-->>P: Feedback dismissed → 该意图进入冷却
  end
```

### 1.3 UI 控制器状态图（A1 的全部交互）

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> PendingShow: 收到 Prediction，起 300ms 计时
  PendingShow --> Idle: 计时内打字/新一轮<br/>未展示，不记反馈
  PendingShow --> Visible: 300ms 到且输入框仍为空
  Visible --> AcceptedLock: Tab / 点 Chip<br/>只填入，100ms 防重
  AcceptedLock --> PostAcceptTracking: 解锁编辑
  PostAcceptTracking --> Idle: 用户发送<br/>未改 accepted / 改过 edited
  Visible --> Idle: Esc → dismissed + 冷却
  Visible --> IgnoredTracking: 直接打字，建议立刻隐藏
  IgnoredTracking --> Idle: 用户发送 → ignored + similarity
  Visible --> Idle: 新一轮开始 → expired
```

状态机只管「显与隐、何时记什么反馈」；通道已由核心在 `displayChannel` 里定好，UI 不重新裁决（[SPEC.md](../SPEC.md) §6 第 2 项）。

---

以下四张是**增量图**：灰框是上一阶段已完成的部分收成的整体，每张图只画本阶段新增的输入或输出。进入某阶段时，再把它的增量图展开成 1.1 那样可以照着写的全图。

## 2. Phase 2（O2 × A1）增量：多看，一个动作不多做

```mermaid
flowchart LR
  classDef now fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef prev fill:#f7f7f7,stroke:#9aa0a6,color:#5f6368
  NEW["新增输入（O2）<br/>子 Agent 完成 / 后台任务结束<br/>看板计数（宿主权威上报）<br/>60s 新鲜度 + 单次消费 + 会话归属"]:::now
  CORE["Phase 1 核心（不变）<br/>+ stage 门控放行 O2 场景<br/>+ 在线先验 PriorSource 启用"]:::prev
  OUT["输出不变<br/>仍是 A1 建议<br/>只多了跨会话场景"]:::prev
  NEW --> CORE --> OUT
```

## 3. Phase 3（O3 × A1）增量：多看工作台，先过隐私关

```mermaid
flowchart LR
  classDef now fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef prev fill:#f7f7f7,stroke:#9aa0a6,color:#5f6368
  NEW["新增输入（O3）<br/>终端命令 / Git / IDE 诊断 / 剪贴板分类<br/>每类单独开关，关即零事件"]:::now
  GATE["新增闸门<br/>按类同意<br/>signals_json 白名单<br/>env-0 冷启动仅 compact"]:::now
  CORE["Phase 1–2 核心（不变）<br/>+ O3 场景启用"]:::prev
  OUT["输出不变<br/>仍是 A1 建议"]:::prev
  NEW --> GATE --> CORE --> OUT
```

## 4. Phase 4（× A2）增量：建议在场时，先悄悄备好料

```mermaid
flowchart LR
  classDef now fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef prev fill:#f7f7f7,stroke:#9aa0a6,color:#5f6368
  CORE["Phase 1–3 核心（不变）<br/>Prediction 开始附带<br/>只读 prepPlan"]:::prev
  NEW["新增后台动作（宿主执行）<br/>建议可见期间预跑只读检查<br/>预取文件与上下文<br/>用户一打字立刻全停"]:::now
  OUT["用户体验变化<br/>按 Tab 后接近秒回<br/>仍不自动发送"]:::prev
  CORE --> NEW --> OUT
```

## 5. Phase 5（× A3）增量：确认之后，才准动手

```mermaid
flowchart LR
  classDef now fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef prev fill:#f7f7f7,stroke:#9aa0a6,color:#5f6368
  CORE["Phase 1–4 核心（不变）<br/>意图卡片 + action 描述"]:::prev
  NEW["新增派发通道<br/>用户在卡片上显式确认<br/>side_effect / irreversible 二次确认<br/>每次派发留审计记录"]:::now
  OUT["宿主执行 action<br/>SDK 本身仍不执行"]:::prev
  CORE --> NEW --> OUT
```
