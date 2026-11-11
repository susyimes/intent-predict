# intent-predict

**intent-predict** 在一轮 agent 回复结束后，预测用户下一条消息——不是续写一句自由文本，而是从当前场景的**封闭意图目录里选一项，或者什么都不给**。它与宿主无关：宿主只负责上报会话事件、借出自己的模型；建议显示在一个独立的界面上；不经用户亲手点发送，什么都不会发出去。

> **当前状态：v0.5**——规范重写为只覆盖第一阶段（单会话观察 × 纯建议），并附带 Phase 1 参考实现。
>
> - 已验证：99 条黄金用例在两套独立实现（Python 参考求值器、TypeScript 核心）上全部通过；sidecar 协议测试；自带网页在无头 Chrome 里实际操作通过；对本机 Grok CLI 1.0.77 的端到端跑通（事件、信号、借模型采样、从界面发送）。
> - **没验证**：预测得准不准。还没有任何回放数据，默认阈值都是占位值。这是进入下一阶段前必须补的一项，见 [ROADMAP.md](ROADMAP.md)。

## 一个例子

agent 改完代码没跑测试。核心识别出场景 `coding.after_edit`，请宿主的模型在 5 个意图里选一个；模型选了 `run_tests`、置信度过线，于是界面上出现一张卡片「跑一下测试验证看看」。用户可以改字，点「发给 Agent」才会作为自己的下一条消息发出，且只对这一轮有效——agent 已经进入下一轮时，这次发送会被拒绝。

<!-- validate: prediction.schema.json#/$defs/Prediction -->
```json
{
  "id": "p-1",
  "sessionId": "s1",
  "sourceTurnId": "t7",
  "packId": "builtin/coding",
  "packVersion": "0.5.0",
  "scenarioId": "coding.after_edit",
  "qualifiedIntentId": "builtin/coding@0.5.0/coding.after_edit#run_tests",
  "intent": { "id": "run_tests", "confidence": 0.82, "slots": {} },
  "text": "跑一下测试验证看看",
  "locale": "zh-CN",
  "risk": "reversible",
  "passThrough": false,
  "confirmBeforeSend": false,
  "alternatives": [],
  "source": "model",
  "createdAt": 1762675200450
}
```

## 三个角色，一套协议

```mermaid
flowchart LR
  classDef host fill:#eafaf1,stroke:#1e8449,color:#145a32
  classDef core fill:#e8f3ff,stroke:#2b6cb0,color:#1a365d
  classDef surf fill:#fef5e7,stroke:#b9770e,color:#7e5109

  H["宿主 Host<br/>上报事件 · 借出模型 · 可选地接收发送"]:::host
  C["核心 Core<br/>信号 → 场景 → 规则或模型 → 门控 → 模板渲染<br/>管理建议的有效期与发送规则"]:::core
  S["界面 Surface<br/>显示当前建议 · 转达用户的发送 / 复制 / 关闭"]:::surf

  H -->|"session/observe"| C
  C -->|"sampler/sample"| H
  C -->|"prediction/updated · invalidated"| S
  S -->|"prediction/act"| C
  C -->|"dispatch/message（钉在所属轮次，只发一次）"| H
```

本仓库自带一个界面（本机回环地址上的一个网页，零宿主 UI 改动）。界面是协议里的一个角色，不是限制：宿主想在自己的输入框里呈现建议，用同一套消息即可。

## 跑起来

需要 Node ≥ 22.18（直接运行 TypeScript 源码，无构建步骤）和 Python 3（仅校验工具）。

```bash
npm install                     # 唯一的运行时依赖是 yaml
npm test                        # 黄金用例一致性 + sidecar 协议 + Grok 事件映射
npm run typecheck
pip install jsonschema pyyaml && python tools/validate.py   # 规范、契约、用例、文档互相一致
```

用 Grok CLI 当宿主试用（需已登录的 `grok`）：

```bash
node packages/host-grok/src/main.ts --cwd <你的项目> -- --allow search_replace
# 终端里和 Grok 对话；启动时打印的网页地址里看「下一步建议」
# 网页顶部的「选择会话」可嗅探本机活跃 AI 会话，并热绑定 Grok / Hermes 会话（绑定时还原近 3 轮；刷新页面同步外部新轮次）
# 太难出建议时加 --eagerness eager；可用 --min-confidence/--side-effect-min-confidence/--alt-min-confidence/--cooldown-turns 细调
npm run e2e:grok                # 在一次性目录里对真实 Grok 跑一遍端到端检查（花费几美分）
npm run smoke:webui             # 在无头 Chrome / Edge 里实际点一遍自带网页
```

其他宿主通过 sidecar 接入：`node packages/sidecar/src/main.ts serve --stdio`，协议见 [SPEC.md](SPEC.md) §8。

## 设计要点

- **封闭目录**：模型只能选一个意图 id 或 `none`，造不出新意图；可以按分类问题离线评测。
- **文字只来自模板**：界面上的每个字都出自场景包的模板和通过校验的槽位值，模型的输出从不直接上屏。
- **宁缺毋滥**：任何守卫命中、未识别场景、模型异常、校验失败、超时，结果都是不给建议，并记录 24 种 `SuppressedReason` 之一。
- **发送必须是用户的显式动作，且钉在所属轮次**：过期的「可以，继续」到不了另一个提问；同一条建议最多发一次；有外部副作用的意图多一步确认。
- **「照你说的办」类意图特殊对待**：agent 的提议看起来涉及推送、发布、删除时，这类一键同意不会被提供；提供时必须连同 agent 的原话一起显示。
- **零配置借用宿主模型**：不需要为它单独配 API Key。
- **场景包只能收紧阈值**：仓库里带来的 `INTENTS.md` 不能把门槛调得比宿主更松，且必须显式启用。

## 和 Codex composer predictions 的区别

| | Codex composer predictions | intent-predict |
|---|---|---|
| 预测什么 | 一句开放文本 | 封闭目录中的一项或 `none`，附槽位与可选动作 |
| 在哪用 | Codex 桌面版 | 任意宿主（已接通 Grok CLI），经 sidecar 的 JSON-RPC 接入 |
| 何时出现 | 策略未公开 | 写在规范里：守卫、场景路由、置信度门槛、冷却 |
| 如何评估 | 接受率 | 可回放的分类指标；接受率只是其中之一 |

调研细节见 [docs/prior-art.md](docs/prior-art.md)。

## 仓库地图

| 路径 | 内容 |
|---|---|
| [SPEC.md](SPEC.md) | 行为规范（本阶段唯一的规范性文本） |
| [spec/](spec/) | 数据结构的 JSON Schema：事件、场景包、预测、遥测、RPC |
| [INTENTS.md](INTENTS.md) | 内置编程场景包的唯一来源；普通包与积极包的 `pack.json` 均由它生成 |
| [eval/golden.jsonl](eval/golden.jsonl) | 黄金用例，覆盖全部抑制原因，含录制的模型输出 |
| [tools/](tools/) | `reference.py` 参考求值器（测试基准，不是产品）、`validate.py` 一致性校验、`build_pack.py` |
| [packages/core](packages/core) | 核心：信号、路由、规则、模型分类、门控、渲染、发送与结果规则 |
| [packages/sidecar](packages/sidecar) | stdio JSON-RPC 服务 + 自带界面（单个网页，HTTP + SSE，仅回环地址） |
| [packages/host-grok](packages/host-grok) | Grok CLI 宿主适配：事件映射、采样、发送 |
| [ROADMAP.md](ROADMAP.md) · [docs/design.md](docs/design.md) · [docs/future.md](docs/future.md) | 阶段计划 · 设计理由与决策 · 后续阶段的非规范草案 |

## 许可证

[MIT](LICENSE)
