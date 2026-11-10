# intent-predict

**intent-predict** 是一个可以接入任意 Agent 的意图预测 SDK，只处理有限场景。每当 agent 回复结束，它会预测用户下一步最可能的意图，并给出一句能直接填进输入框的建议。预测范围限定在一个**有限的意图集合**里，没有把握时就不给建议。

> 当前状态：**施工级设计规范已完成（v0.2）**，已产出完整 JSON Schema 与内置编程场景包。
> - 设计文档：[docs/design.md](docs/design.md)
> - 形式化规范：[spec/](spec/)（`events`、`scenario-pack`、`prediction`、`feedback`、`rpc`）
> - 内置编程场景包：[packages/pack-coding/pack.json](packages/pack-coding/pack.json)
> - 调研笔记：[docs/prior-art.md](docs/prior-art.md)

## 一个例子

agent 改完代码后，输入框里会出现灰色的建议文字「跑一下测试验证看看」，按 Tab 就能填入。同时 SDK 会返回一份结构化结果：

```json
{ "intent": { "id": "run_tests", "confidence": 0.82 }, "text": "跑一下测试验证看看", "risk": "reversible" }
```

宿主可以根据这份结果绑定确定性的动作，比如 `/review`、某个工具调用或快捷按钮，不需要从文本里猜用户的意思。

## 工作流程

```mermaid
flowchart LR
  subgraph Host["宿主 Agent（Hermes / Codex / ACP / 任意）"]
    E["1. 事件流<br/>消息 / 工具 / 产物 / 状态"]
    S["Sampler（零配置委托）<br/>fork 缓存分叉 / compact 宿主模型"]
    UI["4. 输入框 UI<br/>Ghost Text / Chips"]
  end

  subgraph SDK["intent-predict SDK"]
    SG["2. 信号提取 & 守卫"]
    SR["3. 有限场景路由<br/>未命中 → none"]
    CS["候选生成<br/>Rule 短路 / Prior / Model"]
    FG["融合 → 门控 → 模板渲染 → 9 条过滤<br/>任一不通过 → fail-closed"]
    FB[("5. 本地反馈日志<br/>先验更新 / 校准")]
  end

  E -->|"turn.completed"| SG --> SR -->|"命中场景目录"| CS
  CS <-->|"需要模型时复用宿主"| S
  CS --> FG -->|"Prediction"| UI
  UI -->|"Tab 接受 / Esc 关闭 / 忽略"| FB
  FB -.-> CS
```

## 和 Codex composer predictions 有什么不同

本项目借鉴了 OpenAI Codex 的 [composer predictions](docs/prior-art.md#1-openai-codexcomposer-predictions)，两者的主要区别如下：

| | Codex composer predictions | intent-predict |
|---|---|---|
| 预测什么 | 一句开放文本 | 场景内有限意图集合中的一项（或 `none`），附带槽位、置信度、文本和动作 |
| 能在哪里用 | 只能在 Codex 桌面版里用 | 任意 agent（首发适配 **Hermes Agent**），通过适配器或 JSON-RPC sidecar 接入 |
| 模型配置 | 绑定 Codex 自身后端 | **零配置优先**：通过 `Sampler` 直接复用宿主 Agent 已有的模型或缓存分叉 |
| 什么时候出现 | 策略未公开 | 显式门控：阈值、领先幅度、冷却、风险等级 |
| 怎么评估 | 看接受率 | 分类指标 + 接受率 + 校准 |

## 设计要点

- **零配置复用宿主模型**：不需要用户单独为 SDK 配 API Key。SDK 通过 `Sampler`（`fork` 缓存共享分叉或 `compact` 紧凑上下文委托）直接调用宿主 Agent 自己的模型。
- **数据流向**：宿主传入事件，SDK 返回预测，宿主再回传用户反馈。UI 和动作执行都由宿主负责。
- **四级接入与自动降级**：
  - L2（Fork Sampler）：宿主在缓存共享的分叉上采样（如 Hermes 同前缀分叉、Codex `thread/sample`）
  - L1（Host-Delegated）：宿主传入实时事件流，并委托宿主自身模型执行紧凑分类
  - L0（Simple Messages）：每轮结束时传入消息数组
  - L-Local（纯本地）：无模型时仅用本地规则（`RuleSource`）与转移先验（`PriorSource`）
- **宁缺毋滥**：识别不出场景就不预测，出现任何异常都不给建议（fail-closed，标准化 34 种 `SuppressedReason`）。
- **不自动发送**：从不自动发送消息，也从不自动执行有副作用的动作。
- **可评估与隐私安全**：内置脱敏管道、本地 Bigram Dice 相似度计算和离线回放评测。

## 计划中的包

| 包 | 作用 |
|---|---|
| `@intent-predict/core` | 事件和信号、谓词引擎、场景路由、候选来源、融合、门控、渲染、过滤、脱敏 |
| `@intent-predict/ui` | 不依赖 UI 框架的建议控制器状态机，提供 React 和 Ink 绑定 |
| `@intent-predict/sidecar` | JSON-RPC stdio 服务，支持 `sampler/sample` 反向调用，供 Python（如 Hermes）、Rust、Go 等宿主使用 |
| `@intent-predict/adapters/*` | 适配 **Hermes Agent（首发）**、Codex、ACP、Claude Agent SDK、OpenAI Agents、Vercel AI、LangGraph |
| `@intent-predict/pack-coding` | 内置的编程场景包（[`pack.json`](packages/pack-coding/pack.json)） |
| `@intent-predict/models` | 可选的独立模型客户端（当宿主不提供 Sampler 时的兜底） |

路线图见 [design.md §17](docs/design.md#17-路线图)。

## 许可证

[MIT](LICENSE)
