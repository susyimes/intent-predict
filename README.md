# intent-predict

**intent-predict** 在一轮 agent 回复结束后，预测用户下一条消息：把最近几轮交给**这个会话自己的 Agent**，由它用你的口吻写出最多 3 条你可能要发的话，各带把握；没有把握就什么都不给。它与宿主无关：宿主只负责上报会话事件、借出自己的模型；建议显示在一个独立的界面上；不经用户亲手点发送，什么都不会发出去。

设计遵循 [Agent 系统原则](https://github.com/susyimes/agent-coding-principle/blob/main/AGENT.md)：不限制模型的上限，规则保持宽松，给目标和真实信息而不是写死步骤，早期优先探索和学习速度。原来的「封闭意图目录 + 模板文字」仍保留为显式、可切换的目录模式（`--mode catalog`）。

> **当前状态：v0.5，Phase 1（单会话观察 × 纯建议）**，默认是开放生成。规范只覆盖这一阶段，附带参考实现，以及一个能驱动 Grok、Hermes、Codex、Kimi、Claude Code 五家命令行的宿主。
>
> - 已验证：
>   - 131 条黄金用例（开放模式与目录模式）在两套独立实现（Python 参考求值器、TypeScript 核心）上全部通过。
>   - sidecar 协议、会话绑定和五个 Agent 适配器都有单元测试，用的是实测录下的事件格式和测试替身。
>   - 自带网页在无头 Chrome 里实际操作通过。
>   - 对 Grok CLI 的端到端检查在开放模式下通过（4 轮都给出了候选）；对 Hermes 0.22、Codex 0.159、Kimi Code 2.5、Claude Code 2.1.322 的实机检查也都通过。
> - **没验证**：预测得准不准。还没有任何回放数据，默认门槛都是占位值。这是进入下一阶段前必须补的一项，见 [ROADMAP.md](ROADMAP.md)。

## 一个例子

agent 改完代码没跑测试。核心把最近几轮交给这个会话自己的 Agent，请它写出用户最可能发的下一句。它写了三条：「跑一下测试看看」（把握 0.45）、「顺便把 README 也更新一下」（0.25）和「推到远端吧」（0.15，可能有外部影响）。界面上列出这三条，第一条已经填在输入框里，可以改字，也可以换一条；点「发给 Agent」才会作为你的下一条消息发出。第三条发送前还要多确认一步。建议只对这一轮有效：agent 已经进入下一轮时，这次发送会被拒绝。

<!-- validate: prediction.schema.json#/$defs/Prediction -->
```json
{
  "mode": "open",
  "id": "p-1",
  "sessionId": "s1",
  "sourceTurnId": "t7",
  "text": "跑一下测试看看",
  "candidates": [
    { "text": "跑一下测试看看", "confidence": 0.45, "sideEffect": false, "confirmBeforeSend": false },
    { "text": "顺便把 README 也更新一下", "confidence": 0.25, "sideEffect": false, "confirmBeforeSend": false },
    { "text": "推到远端吧", "confidence": 0.15, "sideEffect": true, "confirmBeforeSend": true }
  ],
  "locale": "zh-CN",
  "context": { "excerpt": "已经改完了登录逻辑。" },
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
  C["核心 Core<br/>把最近几轮交给会话自己的 Agent → 检查、排序、脱敏、标风险<br/>管理建议的有效期与发送规则"]:::core
  S["界面 Surface<br/>显示当前建议 · 转达用户的发送 / 复制 / 关闭"]:::surf

  H -->|"session/observe"| C
  C -->|"sampler/sample"| H
  C -->|"prediction/updated · invalidated"| S
  S -->|"prediction/act"| C
  C -->|"dispatch/message（钉在所属轮次，只发一次）"| H
```

会话绑定（`binding/list`、`binding/bind`）由界面发起，经核心转给宿主。宿主据此改为驱动本机上某个已有的 Agent 会话。

本仓库自带一个界面，是本机回环地址上的两个网页：「下一步建议」页显示建议，「选择会话」页用来绑定会话。宿主自己的 UI 不用改。界面只是协议里的一个角色，不是限制：宿主想在自己的输入框里呈现建议，用同一套消息即可。

## 跑起来

需要 Node ≥ 22.18（直接运行 TypeScript 源码，无构建步骤）和 Python 3（仅校验工具）。

```bash
npm install                     # 唯一的运行时依赖是 yaml
npm test                        # 黄金用例一致性、sidecar 协议、会话绑定、五个 Agent 适配器（全用测试替身，不调真模型）
npm run typecheck
pip install jsonschema pyyaml && python tools/validate.py   # 规范、契约、用例、文档互相一致
```

### 用本机的 Agent 当宿主

先装好并登录要用的 Agent 命令行，然后：

```bash
node packages/host-grok/src/main.ts --agent claude --cwd <你的项目>
# --agent 可选 grok（默认）/ hermes / codex / kimi / claude
# 续接已有会话：--resume <会话 ID>
# --model 只对 Grok 有效；其余几家都用各自的默认模型
# --mode catalog 切回封闭目录模式；--sampler-effort low 让挑建议用低推理强度（更快更省，默认不降）
# 开放模式下低于 0.15 把握的候选不显示，可用 --min-candidate-confidence 调
# 目录模式下默认用 eager 预设（门槛 0.35）；--eagerness conservative 回到规范默认值（0.60），
#   还可用 --min-confidence、--side-effect-min-confidence、--alt-min-confidence、--cooldown-turns 细调
```

启动后在终端里和 Agent 对话，终端会打印两个网页地址：

- **「下一步建议」页**：每轮结束后显示 Agent 写的候选，最可能的一条已经填进输入框，可以改字或换一条。点「发给 Agent」才会作为你的下一条消息发出，也可以只复制。下方的「轮次记录」每轮一行；点开一行，能看到这一轮里你说了什么、Agent 调了哪些工具、结果如何、改了哪些文件、最后回了什么，以及为什么给或没给建议（场景、候选意图、模型的选择和把握、门槛）。
- **「选择会话」页**：列出本机活跃的 AI 会话。绑定后，宿主改为驱动这个会话：
  - 先还原最近 3 轮，并立即求值；
  - 之后你在原工具里继续的轮次，约 2 秒内自动同步进来，不用刷新页面；
  - 经宿主发出的消息续接这个会话。

五家的接法如下，实测细节见 [docs/design.md](docs/design.md)。

| Agent | 宿主怎么驱动它 | 谁来挑建议 | 发出的消息怎么审批 |
|---|---|---|---|
| Grok | 无头模式，`--resume` 续接 | Grok 自己。不带工具，推理强度调低，用完删掉临时会话 | 没被允许的工具调用一律拒绝。`--` 后面的参数原样传给每一轮，如 `-- --allow search_replace` |
| Hermes | `hermes chat --oneshot`。不用 `-z`，因为它会自动批准危险命令 | Hermes 自己。只给没有副作用的 `clarify` 工具集，用完删除会话 | 按 Hermes 的单次查询审批设置处理，默认拒绝危险命令 |
| Codex | `codex exec --json resume <id>` | Codex 自己。`--ephemeral` 加只读沙箱，不写会话文件 | `exec` 从不询问，能做什么由你配置的沙箱决定 |
| Kimi | ACP（`kimi acp`）。不用 `-p`，因为它会强制自动执行一切 | Kimi 自己。用临时 ACP 会话，用完删除 | 会话保持自己的权限模式，权限请求一律拒绝 |
| Claude Code | `claude -p --resume <id> --permission-prompts none` | Claude 自己。用默认模型，推理强度调低，不带工具、钩子和 MCP，不写会话文件 | 会话自己的权限规则决定哪些操作不用问，需要询问的一律拒绝 |

挑建议时，宿主把会话最近几轮的节选（已脱敏）交给这个会话自己的 Agent，用它的默认模型来挑，内容不会发给别家。

Claude Code 会话如果还在别的终端里开着，就不能从网页发送，因为 Claude 只允许一个进程续接会话。这时建议照常出现，可以复制后贴过去。

```bash
npm run e2e:grok                # 在一次性目录里对真实 Grok 跑一遍端到端检查（花费几美分）
npm run smoke:webui             # 在无头 Chrome / Edge 里实际点一遍自带网页
```

其他宿主通过 sidecar 接入：`node packages/sidecar/src/main.ts serve --stdio`，协议见 [SPEC.md](SPEC.md) §8。

## 设计要点

- **模型自己写**：会话自己的 Agent 读最近 6 轮，直接写出你可能要发的话，最多 3 条，各带把握；核心只做检查、排序、去重和脱敏，不替模型设场景、列选项、套模板。
- **不悄悄限制模型**：挑建议默认用 Agent 自己的模型和推理强度；更省更快的设置（`--sampler-effort low`）、封闭目录模式（`--mode catalog`）都是显式、可切回的选择。
- **出错就不给**：守卫命中、模型异常、回复格式不对、超时，结果都是不给建议，并记录 24 种 `SuppressedReason` 之一。
- **有风险的标出来，不拦**：模型说会有外部影响、或文字像危险操作（推送、删除等）的候选照样显示，但发送前要再确认一次。
- **发送必须是用户的显式动作，且钉在所属轮次**：过期的「可以，继续」到不了另一个提问；同一条建议最多发一次；有外部副作用的意图多一步确认。
- **「照你说的办」类意图特殊对待**：agent 的提议看起来涉及推送、发布、删除时，这类一键同意不会被提供；提供时必须连同 agent 的原话一起显示。
- **零配置借用宿主模型**：不需要单独配 API Key。绑定的会话由它自己的 Agent 写建议；这次调用不带工具，也不在会话里留下记录。
- **不替用户批准任何事**：宿主驱动的轮次走该 Agent 自己的审批规则，不用任何自动批准的模式，Agent 发来的权限请求一律拒绝。
- **目录模式**：模型只能从场景包的封闭目录里选一个意图，文字来自模板；没把握时可给出 2–3 个并列选项（选项组）；场景包只能收紧门槛。适合需要稳定、可按分类评测的场合。

## 和 Codex composer predictions 的区别

| | Codex composer predictions | intent-predict |
|---|---|---|
| 预测什么 | 一句开放文本 | 最多 3 条开放文本（会话自己的 Agent 写），附把握和风险标记；也可切到封闭目录 |
| 在哪用 | Codex 桌面版 | 任意宿主，经 sidecar 的 JSON-RPC 接入；已接通 Grok、Hermes、Codex、Kimi、Claude Code 的命令行 |
| 何时出现 | 策略未公开 | 写在规范里：守卫、把握门槛；目录模式另有场景路由和冷却 |
| 如何评估 | 接受率 | 可回放的分类指标；接受率只是其中之一 |

调研细节见 [docs/prior-art.md](docs/prior-art.md)。

## 仓库地图

| 路径 | 内容 |
|---|---|
| [SPEC.md](SPEC.md) | 行为规范（本阶段唯一的规范性文本） |
| [spec/](spec/) | 数据结构的 JSON Schema：事件、场景包、预测、遥测、RPC |
| [INTENTS.md](INTENTS.md) | 目录模式的内置编程场景包，唯一来源；普通包与积极包的 `pack.json` 均由它生成 |
| [eval/golden.jsonl](eval/golden.jsonl) | 黄金用例：开放模式与目录模式，覆盖全部抑制原因，含录制的模型输出 |
| [tools/](tools/) | `reference.py` 参考求值器（测试基准，不是产品）、`validate.py` 一致性校验、`build_pack.py` |
| [packages/core](packages/core) | 核心：信号、开放生成（默认）与目录模式的流水线、发送与结果规则 |
| [packages/sidecar](packages/sidecar) | stdio JSON-RPC 服务 + 自带界面（「下一步建议」与「选择会话」两个网页，HTTP + SSE，仅回环地址） |
| [packages/host-grok](packages/host-grok) | Agent 命令行宿主（包名沿用最初的 Grok 宿主）：Grok、Hermes、Codex、Kimi、Claude Code 五个适配器，负责驱动回合、还原历史、借模型挑建议、接收发送；以及本机会话的嗅探与绑定 |
| [ROADMAP.md](ROADMAP.md) · [docs/design.md](docs/design.md) · [docs/future.md](docs/future.md) | 阶段计划与实测记录 · 设计理由与决策 · 后续阶段的非规范草案 |
| [docs/diagrams.md](docs/diagrams.md) · [docs/review-issues.md](docs/review-issues.md) · [docs/prior-art.md](docs/prior-art.md) | 说明图 · 审查和实测中发现的问题及处理 · 同类产品调研 |

## 许可证

[MIT](LICENSE)
