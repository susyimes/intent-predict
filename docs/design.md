# intent-predict 设计说明

> 本文不具规范效力：行为以根目录 [SPEC.md](../SPEC.md) 为准，数据结构以 [spec/](../spec) 为准。这里只记录**为什么这么设计**、v0.5 相对 v0.4 改了什么，以及接入宿主时的经验。

| 项 | 内容 |
|---|---|
| 版本 | v0.5（2026-11-11）：按第三轮审查重设计，见 [review-issues.md](review-issues.md) R21–R34 |
| 调研依据 | [prior-art.md](prior-art.md)：Codex composer predictions、Qwen Code NES 与其封闭集合意图分类 |

## 1. 问题与核心思路

Codex 的 composer predictions 在每轮回复后生成一句用户可能要说的话。这种开放文本预测有四个结构性问题：只能看接受率、没法离线回归；文本上挂不了确定性动作和分级的风险策略；效果绑在某个宿主的分叉与界面上；没有可预测的下一步时也照样花一次模型调用。

intent-predict 的做法是把问题改成分类：

> **有限场景**：一种能从会话事件里识别出来的情境，在这种情境下，用户下一步想做的事可以列成一个小的封闭集合，外加一个「都不是」。

例如「agent 改了文件、没跑任何检查」之后，用户多半是要跑测试、看 diff、让它解释、继续、或提交。于是可以：按分类指标评测；给每个意图标风险；意图可以绑定确定性动作（如 `/review`）；识别不出场景就直接不调模型。

这个思路有一个没被验证的前提：封闭目录真的能覆盖足够多的真实下一句。验证它是路线图里排在最前面的未完成项（[ROADMAP.md](../ROADMAP.md) 1D）。

## 2. v0.5 改了什么

v0.4 的规范写得比证据多：融合公式、先验、退避、三档展示通道、O2/O3 的事件与时效规则都进了规范，但没有一条数据。第三轮审查的结论是往回收，并补上能执行的一致性检查。

| 主题 | v0.4 | v0.5 | 原因 |
|---|---|---|---|
| 规范范围 | O1–O3 × A1–A3 全写在 SPEC 里 | SPEC 只写 O1 × A1；其余移到 [future.md](future.md) | 规范即提示词：写了什么，实现者就会去做什么 |
| 界面 | 「永久」只有独立 WebUI，其与核心的协议不规定 | 宿主 / 核心 / 界面三个角色共用一套协议；自带网页是默认界面 | 原写法下别的语言的实现用不了自带界面，也排除了建议最有用的位置 |
| 展示 | `displayChannel` 三档（quick / choice / confirm） | `confirmBeforeSend` 布尔值 + `choices` / `alternatives` | 三档把「展示几个」和「发送前多大摩擦」揉在一起，且内置包走不到 confirm |
| 发送 | `dispatch/message {sessionId, text}` | 带 `expectedTurnId` 与 `predictionId`，宿主忙时拒绝、不排队 | 过期的「可以，继续」会批准别的提问 |
| 透传授权 | 只有 `confirm` / `choose_option` 按提议风险处理 | `passThrough` 标记所有「照你说的办」类意图；提议像外部或破坏性操作时整类不提供；提供时必带 agent 原话 | `apply_suggestion`、`continue_task` 是同一类问题 |
| 打分 | 模型置信度 × 先验 × 规则加分的对数线性融合，分差门槛，备选打分 | 只用模型自报置信度过一个门槛 | 公式算不出文档声称的结果，常数无来源 |
| 场景合并 | 取前 2 个场景合并目录 | 一次求值只选一个场景 | 合并带来先验归一、提示词描述、策略归属等一串歧义 |
| 建议文字 | 模板，或模型生成后过 9 条过滤 | 只有模板；输出检查剩 2 条 | 模型的字不上屏，针对模型文字的过滤就不需要了 |
| 编号选项 | 一个带 `index` 槽位的意图，无推荐标记时固定选 1 | `enumerate`：每个选项一张可选的卡，纯规则 | 固定猜第一项没有依据 |
| 信号 | `failedExecs` 统计整轮失败；有无 `execute` 区分场景 | `lastCheckFailed` / `checkRuns`：只看检查类命令、只看最后一次 | 「失败 → 修复 → 通过」的回合被路由成失败；以 shell 为主的 agent 每轮都有 execute |
| 反馈 | 相似度推断的「忽略」累积成阈值退避 | 相似度只记录；改变行为的只有显式关闭 | 相似度量的是字面；且原规则下事件顺序使其恒为 expired |
| 失效 | `completed + null` 兼作「让卡片过期」 | 单独的 `prediction/invalidated`；空结果不让任何东西失效 | 一次落空的求值不该清掉仍然有效的建议 |
| 阈值归属 | 场景包可以覆盖宿主策略 | 场景包只能收紧 | 仓库里带来的包不该能放松门槛 |
| 一致性 | 20 条手写用例，全部不经过模型 | 99 条用例覆盖全部抑制原因，含录制的模型输出与会话流程；参考求值器实际执行 | 原用例只写规则路径也能全过 |

## 3. 关键决策

| # | 决策 | 放弃的方案 | 理由 |
|---|---|---|---|
| D1 | 预测封闭目录中的一项或 `none` | 开放整句预测 | 可评测、可控、可挂动作 |
| D2 | 没有场景命中就不预测 | 退回通用预测 | 守住「有限场景」的边界 |
| D3 | 借宿主的模型（`sampler/sample`），不另配密钥 | 让用户为 SDK 配一套端点 | 宿主已经有可用的模型连接 |
| D4 | `compact` 是基线采样方式，`fork` 可选 | 以共享缓存的分叉为首选 | 回放只能测 `compact`；分叉并不更快，长会话下也不更省 |
| D5 | 置信度用模型自报值，只过一个门槛 | 融合、分差、校准 | 没有数据时，机制越多越无法归因 |
| D6 | 建议文字只来自模板 | 模型按用户口吻生成 | 模型的字不上屏，注入面小一大块；内置包本来就全是模板 |
| D7 | 发送是显式动作，钉在所属轮次，按 `predictionId` 幂等 | 点卡即发；可排队 | 人在回路要落在「发出去」这一步上 |
| D8 | 透传授权类意图整类特殊对待 | 逐个意图写风险条件 | 风险在 agent 的提议里，不在「可以」这两个字里 |
| D9 | 三个角色一套协议；自带界面只是默认界面 | 界面协议由实现自定 | 一个界面要能配任何一致的核心 |
| D10 | 场景包只能收紧阈值，且需显式启用 | 包策略覆盖宿主策略 | 包的风险标注和提示词是作者自称 |
| D11 | 一阶段一格，规范只写当前格 | 规范先行写全 | 见第 2 节 |
| D12 | 参考求值器 + 黄金用例是一致性的准绳 | 只靠 Schema 与文字 | 两套独立实现对同一批用例给出相同结果，才说明规范是可实现且无歧义的 |
| D13 | 在线只对显式关闭作出反应 | 用推断反馈调阈值 | 推断信号有偏，先离线验证 |

## 4. 流水线为什么长这样

顺序是「守卫 → 选一个场景 → 确定性规则 → 模型 → 门槛 → 槽位与模板 → 输出检查」，每一步失败都收束到同一个出口：不给建议，记一个原因。

- **规则先于模型**。两条规则都不带常数：agent 明说了「运行 `/review`」或「回复『继续』」，就选对应意图；agent 在末尾列了编号选项并且确实是在问，就把每个选项变成一张可选的卡。规则不能选 `side_effect` 意图——那一类必须过模型的高门槛。
- **编号列表不等于在问**。「完成了以下改动：1. … 2. …」也是末尾的编号列表。只有列表前后有问句、或某项带「(推荐)」时才当作选择。
- **检查命令靠一张模式表识别**。这张表注定不全（端到端测试第一次跑就发现缺了 `node --test`），所以宿主可以用 `tool.call.check` 直接声明。宿主不给 `command` 时，退化为「改完文件总是建议跑测试」，由模型兜底说 `none`。
- **门槛只有两个数**：一般意图 0.60，有外部副作用的 0.80。都是占位值。

## 5. 界面与发送

界面是协议角色。自带的那个是 sidecar 在回环地址上提供的单个网页：HTTP POST 发请求，Server-Sent Events 收通知，每次启动换 token，校验 Host 与 Origin，不加载任何外部资源，也不碰宿主的输入框。它同时是检查面：能看到被抑制的求值和原因。

把建议放在独立网页上，宿主一行界面代码都不用改，这是它被选为默认界面的原因；代价是用户要切窗口。**建议放在哪里最有用是个待测的问题**，不是设计前提：同一套协议下，宿主可以声明自己就是界面。

发送的三条规矩都落在核心与宿主之间，界面绕不过去：

1. 建议只在所属轮次内有效。会话里一出现别的轮次的事件，核心就发 `prediction/invalidated`，之后的发送返回 `stale`。
2. 派发请求带 `expectedTurnId`，宿主自己再核对一次，忙时拒绝而不是排队。
3. `side_effect` 意图没带 `confirmed: true` 时核心不派发。

## 6. 接入宿主

一次完整的交互（消息均可用 `spec/rpc.schema.json` 校验）：

```jsonc
// 宿主 → 核心：声明能力。timeoutMs 调大是因为这个宿主靠起进程来借模型
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"0.5","client":{"name":"grok-cli-host","version":"0.5.0"},"capabilities":{"interactive":true,"samplerModes":["compact"],"dispatchModes":["message"]},"packs":["builtin/coding"],"options":{"timeoutMs":60000}}}
// 宿主 → 核心：一轮的事件，以 turn.completed 收尾
{"jsonrpc":"2.0","method":"session/observe","params":{"sessionId":"s1","events":[{"type":"artifact","turnId":"t7","kind":"file_changed","ref":"src/index.ts"},{"type":"turn.completed","turnId":"t7","status":"completed","at":1762675200000}]}}
// 核心 → 宿主：借模型做一次受约束的分类
{"jsonrpc":"2.0","id":"s-1","method":"sampler/sample","params":{"sessionId":"s1","expectedTurnId":"t7","mode":"compact","prompt":"[INTENT PREDICTION ...]","maxOutputTokens":120}}
{"jsonrpc":"2.0","id":"s-1","result":{"text":"{\"intent\":\"run_tests\",\"confidence\":0.84,\"slots\":{}}","usage":{"inputTokens":700,"outputTokens":24}}}
// 核心 → 界面：一条建议
{"jsonrpc":"2.0","method":"prediction/updated","params":{"sessionId":"s1","sourceTurnId":"t7","result":{"type":"completed","prediction":{"id":"p-1","sessionId":"s1","sourceTurnId":"t7","packId":"builtin/coding","packVersion":"0.5.0","scenarioId":"coding.after_edit","qualifiedIntentId":"builtin/coding@0.5.0/coding.after_edit#run_tests","intent":{"id":"run_tests","confidence":0.84,"slots":{}},"text":"跑一下测试验证看看","locale":"zh-CN","risk":"reversible","passThrough":false,"confirmBeforeSend":false,"alternatives":[],"source":"model","createdAt":1762675200450}}}}
// 界面 → 核心：用户点了发送
{"jsonrpc":"2.0","id":7,"method":"prediction/act","params":{"predictionId":"p-1","action":"send","text":"跑一下测试验证看看"}}
// 核心 → 宿主：钉在 t7 上的一次派发
{"jsonrpc":"2.0","id":"s-2","method":"dispatch/message","params":{"sessionId":"s1","text":"跑一下测试验证看看","expectedTurnId":"t7","predictionId":"p-1"}}
{"jsonrpc":"2.0","id":"s-2","result":{}}
```

### 已接通：Grok CLI（1.0.77）

`packages/host-grok` 用 Grok 的无头模式做宿主，每个事实都来自实际运行：

- **事件**：`grok --prompt-file … --output-format streaming-json` 每行是一条 ACP 会话更新。`tool_call` 自带 `kind`（read / edit / search / execute），可以直接映射；终端命令在 `rawInput.command`，退出码在最后一条 `tool_call_update` 的 `rawOutput.exit_code`。Grok 把退出码非零的命令也标成 `completed`，所以判断失败必须看退出码。工具调用之前的文字是旁白，不是该轮的最终消息。
- **采样**：再起一次 `grok`，关掉全部内置工具、覆盖系统提示词、推理强度调低、限 1 轮。单次 10–12 秒（不关工具、不调低推理时约 35 秒）。Grok 没有不落盘的模式，适配器在采样后删除它留下的会话。
- **发送**：`grok --resume <会话>` 把文本作为下一条用户消息。适配器核对 `expectedTurnId`、在回合进行中拒绝、对 `predictionId` 去重。
- **权限**：无头模式下没被允许的工具调用会被拒绝并使该轮以 `cancelled` 结束，映射为 `interrupted`，核心不出建议。

### 尚未核实的宿主

Codex app-server 的 `thread/sample`（[prior-art.md](prior-art.md) 钉过提交）天然对应 `fork` 采样。Hermes、ACP 代理、Claude Agent SDK 等没有做过任何实测，接入前需要像上面那样逐项核实，不能照旧文档的描述估工作量。

## 7. 评估方法

离线回放是主要手段（工具待建，见 [ROADMAP.md](../ROADMAP.md) 1D）：对每个轮次边界，只用边界之前的事件做预测，与「真实下一句被标注到同一目录后的意图」比较。

| 指标 | 定义 | 用途 |
|---|---|---|
| 目录覆盖率上限 | 真实下一句能落进所在场景目录的比例 | 这个前提成不成立 |
| 展示精度 | 展示的建议中意图命中的比例 | 第一指标 |
| 覆盖率 | 有建议的轮次占比 | 与精度一起看曲线 |
| 校准 | 自报置信度与实际命中率的差 | 门槛定在哪里 |
| 延迟、调用次数 | 每千轮 | 成本 |

线上遥测里的 `similarity` 是字面相似度，只适合作为粗粒度参考：用户敲 `/review` 与建议「检查一下刚才的改动」意图相同而相似度为 0（除非建议本身带同名命令）。

## 8. 代码结构

```text
packages/core        核心（零界面、零传输）：signals / packs / prompt / render / core
packages/sidecar     stdio JSON-RPC 服务、回环界面服务、单文件网页
packages/host-grok   Grok CLI 宿主：事件映射、采样、发送、命令行对话、端到端检查
packages/pack-coding 由 INTENTS.md 生成的 pack.json
tools/               reference.py（参考求值器）、validate.py、build_pack.py
eval/                golden.jsonl 与测试用的场景包
```

TypeScript 源码直接由 Node（≥ 22.18）运行，没有构建步骤；唯一的运行时依赖是解析 YAML 的 `yaml`。要发布成 npm 包还需要补一步编译。核心的用法：

```ts
import { Core, loadPackFile } from './packages/core/src/index.ts';

const core = new Core([loadPackFile('packages/pack-coding/pack.json')], {
  samplerModes: ['compact'],
  sample: async ({ prompt }, signal) => ({ text: await myModel(prompt, signal) }),
  dispatchModes: ['message'],
  dispatch: async (request) => { /* 核对 expectedTurnId 后，把 request.text 当作用户输入 */ },
});
core.on('updated', ({ result }) => { /* 有 prediction 就显示 */ });
core.on('invalidated', ({ predictionId }) => { /* 不再可发送 */ });
core.observe('session-1', eventsOfTheTurn);              // 以 turn.completed 结尾
await core.act({ predictionId, action: 'send', text });  // 用户点了发送
```
