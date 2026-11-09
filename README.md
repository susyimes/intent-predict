# intent-predict

**intent-predict** 是一个可以接入任意 Agent 的意图预测 SDK，只处理有限场景。每当 agent 回复结束，它会预测用户下一步最可能的意图，并给出一句能直接填进输入框的建议。预测范围限定在一个**有限的意图集合**里，没有把握时就不给建议。

> 当前状态：**设计阶段**，还没有可用代码。
> - 设计文档：[docs/design.md](docs/design.md)
> - 调研笔记：[docs/prior-art.md](docs/prior-art.md)

## 一个例子

agent 改完代码后，输入框里会出现灰色的建议文字「跑一下测试」，按 Tab 就能填入。同时 SDK 会返回一份结构化结果：

```json
{ "intent": { "id": "run_tests", "confidence": 0.82 }, "text": "跑一下测试", "risk": "reversible" }
```

宿主可以根据这份结果绑定确定性的动作，比如 `/review`、某个工具调用或快捷按钮，不需要从文本里猜用户的意思。

## 和 Codex composer predictions 有什么不同

本项目借鉴了 OpenAI Codex 的 [composer predictions](docs/prior-art.md#1-openai-codexcomposer-predictions)，两者的主要区别如下：

| | Codex composer predictions | intent-predict |
|---|---|---|
| 预测什么 | 一句开放文本 | 场景内有限意图集合中的一项（或 `none`），附带槽位、置信度、文本和动作 |
| 能在哪里用 | 只能在 Codex 桌面版里用 | 任意 agent，通过适配器或 JSON-RPC sidecar 接入 |
| 什么时候出现 | 策略未公开 | 显式门控：阈值、领先幅度、冷却、风险等级 |
| 怎么评估 | 看接受率 | 分类指标 + 接受率 + 校准 |

## 设计要点

- **数据流向**：宿主传入事件，SDK 返回预测，宿主再回传用户反馈。UI 和动作执行都由宿主负责。
- **三级接入**：
  - L0：传入消息数组
  - L1：传入实时事件流
  - L2：宿主提供 Sampler，SDK 在缓存共享的分叉上采样（对标 Codex 的 `thread/sample`）
- **候选来源**：规则、先验、模型约束分类，以及可选的向量近邻。
- **宁缺毋滥**：识别不出场景就不预测，出现任何异常都不给建议（fail-closed）。
- **不自动发送**：从不自动发送消息，也从不自动执行有副作用的动作。
- **可评估**：内置反馈记录和离线回放评测。

## 计划中的包

| 包 | 作用 |
|---|---|
| `@intent-predict/core` | 事件和信号、场景路由、候选来源、融合、门控、渲染、过滤 |
| `@intent-predict/models` | 模型客户端：OpenAI、Anthropic、OpenAI 兼容接口、本地模型 |
| `@intent-predict/ui` | 不依赖 UI 框架的建议控制器，提供 React 和 Ink 绑定 |
| `@intent-predict/sidecar` | JSON-RPC 服务，供 Python、Rust、Go 等非 JS 宿主使用 |
| `@intent-predict/adapters/*` | 适配 Codex、ACP、Claude Agent SDK、OpenAI Agents、Vercel AI、LangGraph |
| `@intent-predict/pack-coding` | 内置的编程场景包 |

路线图见 [design.md §17](docs/design.md#17-路线图)。

## 许可证

[MIT](LICENSE)
