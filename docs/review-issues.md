# 设计审查问题清单（待修复）

## 背景

本仓库为纯设计仓库（无实现代码），审查基线为提交 `d055fc7`。审查范围包括 `SPEC.md`、`INTENTS.md`、`docs/design.md`、`docs/prior-art.md`、`spec/` 下 5 份 JSON Schema（`events`、`scenario-pack`、`prediction`、`feedback`、`rpc`）与 `packages/pack-coding/pack.json`。

本清单合并两轮设计审查的全部结论。其中「实测」类条目已在仓库上实际验证：5 份 Schema 均通过 JSON Schema Draft 2020-12 元校验；`packages/pack-coding/pack.json` 通过 `spec/scenario-pack.schema.json` 校验且各场景先验和为 1.0；`INTENTS.md` 的 YAML front matter 直接校验同 Schema 报错 3 处（见 R3）。

## 修复原则

1. 只修下列问题，不新增功能、不新开文档。
2. 每改一处，必须保证设计文档（`docs/design.md` / `SPEC.md`）、`spec/` Schema、`INTENTS.md` / `packages/pack-coding/pack.json` 三处一致。
3. 修完逐条按编号回复「已改 / 不改+理由」，并注明改动的提交。

## P0（不修复无法施工）

### R1 唯一事实来源未定且已漂移

- 现象：`docs/design.md` §6 称 TS 为权威定义、§15 称 `spec/` 为唯一来源，根目录 `SPEC.md` 又成为第三份规范文本。
- 已确认的漂移：`qualifiedIntentId` / `displayChannel` 在设计中为必填语义，但 `spec/prediction.schema.json` 的 `Prediction.required` 未包含它们；`alternatives` 设计上限 2 条，Schema 为 `maxItems: 3`。
- 要求：明确 precedence（例如 `SPEC.md` 为规范文本、`spec/` 为机读契约、`docs/design.md` 降级为非规范说明并注明冲突时以前两者为准），并消除上述不一致。

### R2 四份 Schema 根节点无效

- 现象：`spec/events.schema.json`、`spec/feedback.schema.json`、`spec/prediction.schema.json`、`spec/rpc.schema.json` 的根只有 `type: object` + `$defs`，无 `$ref` 指向主定义，任意对象（包括 `{}`）都能校验通过，代码生成只会产出空类型。
- 附带问题：`rpc` 只有 params/result 碎片，JSON-RPC 信封、方法名与 `-32001` 等错误码不在 Schema 内；跨文件相对 `$ref` + `https://intent-predict.dev` 形式 `$id` 的解析方式未说明，多数工具会默认联网取。
- 要求：根节点指向主定义；`rpc` 补齐信封、方法与错误码；声明 bundle 或本地 registry 的解析策略，不依赖联网。

### R3 INTENTS.md 过不了自家 Schema（实测 3 处报错）

把 `INTENTS.md` 的 YAML front matter 解析后直接用 Draft 2020-12 校验器对照 `spec/scenario-pack.schema.json`，报错：

1. `observation_stages` 与 Schema 的 `observationStages` 命名不一致，转换规则未定义。
2. 包级 `policy` 在 Schema 中不存在（Schema 只有场景级 `policy`）。
3. 两个 O3 意图（`diagnose_terminal_error`、`fix_ide_diagnostics`）的 `description` 超过 Schema 的 80 字上限。

- 要求：修复后 `INTENTS.md` 须能通过校验（直接校验，或先经规范中显式声明的字段映射转换后校验）；映射规则须写进规范，不得靠实现者猜测。Markdown 正文如何填入 Schema 的 `promptTemplate` 字段也须一并声明。

### R4 INTENTS.md 与 pack.json 已分叉

- 现象（实测比对）：`INTENTS.md` 独有 `coding.subagent_reported`、`coding.ambient_terminal_failed`、`coding.ambient_ide_diagnostics`；`packages/pack-coding/pack.json` 独有 `coding.explained`、`coding.exec_succeeded`、`coding.general_followup`（兜底场景）。版本一个 0.3.0、一个 0.1.0；pack 未填写新增的 `stage` / `triggers` / `observationStages` 字段。共同场景的意图集合一致。
- 后果：用 `INTENTS.md` 丢兜底覆盖梯度，用 `pack.json` 完全没有 O2/O3；两者行为不同但被当作同一包的两种写法。
- 要求：只保留一份为源，另一份改为构建产物并做等值校验（或删除其一）；README 示例中 `qualifiedIntentId` 的版本号与实际包版本一致。

### R5 O2/O3 触发与过期语义未闭环

1. **信号无时效**：`agent.lastSubagent.status`、`env.lastTerminalCommand.exitCode`、`env.ambient.clipboardKind` 等「最近一次」信号无时效窗口与消费语义。`coding.subagent_reported` 的 `triggers` 含 `turn.completed` 且 priority 22 高于 `coding.after_edit` 的 20，子任务完成一次后将每一轮幽灵命中并压过其他场景。要求给 O2/O3 信号定义新鲜度窗口或事件消费/确认标记。
2. **fork 兼容**：`sourceTurnId = "env-0"` 时 fork 采样按 `expectedTurnId` 校验必然返回 `TURN_MISMATCH`，须写明冷启动 env 触发仅允许 compact 模式。
3. **会话归属**：`agent.*` / `env.*` 事件不带 `sessionId`，须定义经哪个会话通道上报、预测交付给哪个会话，以及 O2 触发时 `sourceTurnId` 的取值规则（现规范只给了 O3 的兜底）。
4. **stage 门控**：场景路由（SPEC §5.3）从未检查 `scenario.stage` 是否超出实现声明的观察等级。要求补齐该检查（及包级 `observationStages` 与场景级 `stage` 的关系），或删除该字段。

### R6 SPEC.md 不自足、conformance 悬空

- 现象：9 条过滤直接引用 `docs/design.md` §7.8.3；信号提取算法（问句检测、编号选项、locale 推断、hints、toolKind 推断）、compact 构建规则、槽位校验细节、Sampler 接口、反馈与相似度、RPC 方法表均不在 `SPEC.md` 内。开篇引用的 `eval/golden.jsonl` 与 §7 所称测试用例在仓库中不存在。
- 要求：二选一并落地——要么把算法细节搬进 `SPEC.md` 使其可独立实现，并提交 `eval/golden.jsonl`；要么删除 conformance 宣称及 README 的「一句话让 Agent 实现」宣传。

### R7 融合公式无据且双份维护

- 现象：`docs/design.md` §7.6 的 α=0.85、显式短路 0.92、`altScore` 权重（0.65/0.35/0.15）与各风险阈值均为未经数据验证的常数，且作用在未校准的模型自报置信度上；这些常数现同时存在于 `docs/design.md` 与 `SPEC.md` 两处，已有漂移一例（SPEC 版默认 prompt 删除了 design 版「总概率 ≤ 1」约束句）。
- 附带硬伤：pack 各场景意图先验和已为 1.0，与融合算法「为 `none` 预留先验 0.25」的归一化组合方式未定义。
- 要求：算法与常数只在一处定义；标注为待校准参数；给出 M0 最简基线（模型原始置信度过阈值）作为默认路径，融合待回放数据验证后再启用。

## P1（方向性风险，须改口径或补设计）

### R8 安全过度承诺

`proposedRisk` 正则词表与脱敏正则表均可被绕过（未命中时默认 `reversible`），须删除「彻底杜绝」「永远不会」「必须 100% 经过脱敏」等表述，降级为纵深防御的一层；`slot.pattern` 与 `privacy.customRedactors` 的正则须补长度/复杂度约束防 ReDoS；ghost text 与 chips 同为「仅填入不发送」，须重新论证把通道差异当作 `side_effect` 安全边界的依据（或改述为体验分级而非安全边界）。

### R9 仓库级 INTENTS.md 的信任面

意图的 `risk` 与提示词正文均由场景包作者自报。随仓库分发的 `INTENTS.md` 可把推送类意图标为 `risk: none` 塞进 ghost text，或用正文 prompt 诱导分类器恒选 `confirm`。要求定义仓库级契约的信任等级：是否默认启用、是否需用户确认、风险等级是否设系统下限。

### R10 隐私与 `signals_json` 黑洞

目标 G7 与 §11.2 承诺「只使用当前会话上下文」，但 O3 事件含剪贴板预览（最长 500 字符）、窗口标题、终端命令原文；而决定实际发送内容的 `signals_json` 的字段枚举、大小上限、逐字段脱敏规则均未定义。要求：逐项枚举 `signals_json`（及 compact `transcript` 的 env/agents 摘要）字段与处理规则；给出观察器（终端/Git/IDE/剪贴板）粒度的开关与同意模型。

### R11 差异化能力未被样例证明

全部意图仅 1 个槽位（`choose_option.index`）、2 处共用 `/review` 命令动作，`tool` / `custom` 动作零覆盖，槽位字面约束与 Action 插值原子性无法从样例验证。要求在 INTENTS/pack 中补至少 1 个带 `tool` 动作与多槽位的完整场景（可将 `docs/design.md` §14.2 的客服 YAML 例子转成通过 Schema 的正式示例）。

### R12 首发路径与零配置口径

三处须各给一句定版：① TS 优先却选 Python 的 Hermes 为首发宿主，首个用户前须落地 core+sidecar+Python 钩子+三端 UI，是否改为最短路径宿主先行验证；② Hermes 的缓存不变量、事件钩子等关键前提未像 `docs/prior-art.md` 对 Codex/Qwen 那样钉提交号核实，须补证据或标为未验证；③ §8.1 称 L-Local 靠 Rule+Prior 运行，§7.4 又规定无显式规则时 L-Local 直接放弃，PriorSource 在纯本地能否独立产出候选须定版。

### R13 未经验算的阈值

每条须补一个算例验证，或明确降为可调参数并给出初值来源：

1. Bigram Dice 近似命中线 0.75：建议「跑一下测试验证看看」与用户实际发送「跑一下测试」为同一意图，但 Dice = 2×4/(4+8) ≈ 0.67，会被计为未命中负例并触发退避。
2. 「目录截断 15 个意图即稳定落入 4,000 字节」：须给字节预算计算（每个意图含 80 字 description、examples、槽位说明，CJK 字节/字符相差 3 倍）与超限时的降级顺序。
3. chips 通道裁决双处定义：§7.7 在核心按风险裁决、§10.2 又按 margin 区间决定 chips 形态，冲突时以何为准须定唯一裁决方。

## P2（细节漂移，逐项对齐）

### R14 SuppressedReason 计数与死枚举

`README.md` 称 34 种，`spec/prediction.schema.json` 枚举实测 36 个；其中 `budget_exhausted` 在现行语义下永远发不出来（只发 `budget_exhausted_no_explicit_rule`）。修正计数，并删除该枚举或补发射点。

### R15 events 拼写残留

`spec/events.schema.json` 的 `IdeFocusObservedEvent` 中大写 D 的 `DiagnosticsErrors` 与小写的 `diagnosticsErrors` 并存，删大写残留；`AgentEvent` 上的 `discriminator` 是 OpenAPI 关键字，在 JSON Schema 中无语义，删除。

### R16 信号词表三处不一致

`SPEC.md` 的 `agent.activeSubagents`、`agent.recentSessionIds`、`agent.lastBackgroundJob.sessionId` 在 `docs/design.md`、`INTENTS.md` 与事件 Schema 中不存在（事件字段实际为 `jobId` / `subagentId`）。以一方为准，全表对齐（包括 `agent.lastSubagent.*` 的完整字段集）。

### R17 提示词变量不一致

`SPEC.md` §4.1 承诺支持 `{{catalog_lines}}`，`INTENTS.md` 正文实际使用 `{{#each intents}}` 与 `{{scenario.stage}}`（后者不在承诺清单内，前者未被使用）。要求统一模板变量集与语法子集，并说明正文中的 Markdown 标记（反引号、代码围栏）是原样进 prompt 还是剥离。

### R18 AgentTaskUpdatedEvent 计数归属冲突

事件本身携带 `pendingReviews` / `openTasksCount` 聚合快照，与 `SPEC.md` §2.2「SDK 按 task 状态计数」冲突；任务无删除事件、无连接初期的全量快照同步，本地计数必然漂移。二选一：宿主每次上报权威计数，或 SDK 维护任务表并定义快照同步事件。

### R19 死引用清理

过滤规则 4（`filter_evaluative`）豁免的 `acknowledge` 意图在任何场景包中不存在；`freeform` 意图在目标与关键决策中提及，但在 Schema 与 TS API 中无定义落点（缺少 `enabledByDefault: false` 意图的启用开关）。各自补落点或删除提及。

### R20 会话存储与协议施工缺项

1. 事件保留上限（轮数/条数）、`tool.result.output` 大小上限、多会话内存上界未定义。
2. `session/observe` 为通知、无幂等键，事件乱序与重复的处理未定义。
3. 冷却表与退避计数是否跨进程重启持久化未定义。
4. 预算守卫（`budget_exhausted_no_explicit_rule`）无单位定义：调用次数、token 还是金额，窗口如何重置。
5. `PredictionResult.failed` 与 `completed + prediction: null + suppressedReason` 的使用划分未定义。
6. `qualifiedIntentId` 内含包版本号，导致包每次升版即清空冷却与先验计数；应把遥测归档键与在线学习键分离，或声明接受该代价。

---

## 处理记录（v0.4 修订）

以下按编号记录处理结论。验证入口：`python tools/validate.py`（全部通过，含 Schema 元校验、INTENTS/pack/示例校验、pack 等值生成、golden 格式与事件校验）。

- **R1 已改**：`SPEC.md` 卷首新增「Authority & Precedence」（数据结构以 `spec/` 为准、行为以 `SPEC.md` 为准、`docs/design.md` 为非规范说明）；`Prediction.required` 补 `qualifiedIntentId`/`displayChannel`/`agencyStage`；`alternatives` 上限改 2。
- **R2 已改**：四份 Schema 根节点改为 `$ref`/信封 `oneOf`（实测非法对象现被拒）；`rpc` 补方法枚举、请求/通知/响应信封与错误码；`$ref` 离线解析规则写进 `SPEC.md`，`tools/validate.py` 用本地 registry 验证。
- **R3 已改**：`INTENTS.md` 改用与 Schema 相同的 camelCase（`observationStages`）；Schema 新增包级 `policy`；两个超长 `description` 已缩短。实测 front matter 直接校验通过。
- **R4 已改**：`INTENTS.md` 定为单一来源并合入原 pack 独有的 3 个 O1 场景（现共 10 场景、33 意图）；`pack.json` 由 `tools/build_pack.py` 生成（含正文→`promptTemplate` 映射规则）；统一版本 0.4.0，README 示例已同步。
- **R5 已改**：`SPEC.md` §2.4 新增 O2/O3 新鲜度（`signalTtlMs` 默认 60s）、触发单次消费、会话归属与 `env-0` 仅 compact 规则；O2/O3 事件新增可选 `sessionId`；路由 §5.3 新增 stage 门控；`coding.subagent_reported` 移除 `turn.completed` 触发。
- **R6 已改**：`SPEC.md` 补齐 §5.0 信号提取、§5.5.1–5.5.3 字节预算/compact 构建/输出解析、§5.6 全部 9 条过滤正则，使其可独立实现；`eval/golden.jsonl` 已落地（20 条确定性用例，格式定义于 §7）。
- **R7 已改**：融合常数在 `SPEC.md` 标注为待校准默认值并提供可替代的 baseline profile（原始置信度过阈值）；`P_prior` 明确 `none` 占 0.25、包内先验按 0.75 缩放。 design 侧不再另立常数口径。
- **R8 已改**：删除「彻底杜绝/永远不会/100%」类表述并写明边界；包内/自定义正则限长 256 且要求有界执行；通道差异改述为操作摩擦而非安全边界。
- **R9 已改**：`SPEC.md` §4.2 新增仓库包信任模型（按包 id 显式启用、禁止自动加载、按 action 类型设风险下限建议）。
- **R10 已改**：`SPEC.md` §6 第 3 项枚举 `signals_json` 允许字段与上限，自由文本禁止进入；O3 每类观察器须可由用户单独关闭。
- **R11 已改**：新增 `examples/support.intents.md`（`orderId` 确定性槽位 + `tool` 动作插值 + 提示词正文），经 `tools/validate.py` 校验通过。
- **R12 已改（顺序与口径）**：Hermes 顺延为 M1，M0 先以回放定核心；design §8.4 注明 Hermes 内部前提未钉版本核实；L-Local 定版为「只有显式规则候选可独立产出」。
- **R13 已改**：相似度新增子串包含豁免（同一意图的截断文本不计负例）；4,000 字节改为实测口径并给出超限降级顺序；通道裁决唯一化到核心门控并求交 `capabilities.displayChannels`（Schema 与 initialize 示例同步，原 `capabilities.sampler` 布尔改 `samplerModes`）。
- **R14 已改**：删除死枚举 `budget_exhausted`（现 35 种），README 计数同步。
- **R15 已改**：删除 `DiagnosticsErrors` 大写残留与非标准的 `discriminator` 字段。
- **R16 已改**：删除 `agent.activeSubagents`/`agent.recentSessionIds`/`lastBackgroundJob.sessionId` 等无来源信号名，O2 信号字段与事件 Schema 对齐。
- **R17 已改**：模板变量集统一（删除 `catalog_lines`，补 `{{scenario.stage}}` 与 `{{#each intents}}` 语法，未知变量渲染为空）；正文按原样（去首尾空行）进入 prompt 已在 `SPEC.md` §4.1 与 `INTENTS.md` 正文对齐。
- **R18 已改**：定版为宿主上报权威计数、SDK 不自行计数；事件缺计数时信号沿用旧值/缺席（fail-closed）。
- **R19 已改**：`acknowledge` 定为保留意图 id 约定（golden 含豁免用例）；`freeform` 定版为 v1 不提供，相关提及已改。
- **R20 已改**：`SPEC.md` §6 第 4 项补留存上限建议、`tool.result.output` 64KiB 上限、重复 `turn.completed` 不重触发、冷却默认仅内存、预算单位为每小时 ModelSource 调用数、`failed` 与 `completed+null` 划分；学习键改无版本号形式（R1 同步写进 Schema 描述）。

仍开放（非本文问题，留待实现阶段）：效果指标目标待真实回放数据（M0）；Hermes 前提的钉版本核查（M1）；观察器（shell hook 等）的具体实现归属（M1+）。

---

# 第三轮审查与 v0.5 重设计

审查基线为提交 `4168a00`（v0.4）。前两轮把文档之间的不一致改掉了，这一轮的问题换了类型：规范写得比证据多、最新一次界面改造没改干净并在「人在回路」上留了洞、一致性测试测不到最容易写错的部分。处理方式不是逐条打补丁，而是重写规范（只留 Phase 1），并补一个能实际执行黄金用例的参考求值器；随后按新规范做了 Phase 1 的实现。

以上 R1–R20 的处理记录描述的是 v0.4，其中不少机制（融合常数、`displayChannel`、9 条过滤、O2/O3 时效规则）在 v0.5 已移除或移入 [future.md](future.md)。

## 问题与处理

- **R21 核心假设排在最后验证**。「封闭目录能覆盖用户的下一句」没有任何数据，而第一份数据排在 core、sidecar、界面都写完之后。
  处理：**部分**。回放验证定为进入 Phase 2 的唯一门槛，并写了开跑前固定的止损线（ROADMAP 1D）。回放工具本身还没做；Phase 1 的实现按要求先行完成了。
- **R22 独立 WebUI 被写成永久约束，它与核心的协议却「实现自定」**。别的语言按规范做出的核心用不了自带界面；多个宿主进程时页面地址要靠宿主显示，「宿主 UI 改动恒为零」不成立。
  处理：已改。宿主 / 核心 / 界面三个角色共用一套协议（SPEC §1.1、§8）；自带网页是默认界面；`initialize` 的结果带 `surfaceUrl`，由宿主显示。
- **R23 `composer_dirty` 守卫与「不读宿主输入状态」矛盾**。
  处理：已改。删除该守卫和对应的取消条件；输入框状态属于宿主原生界面的事（future.md §5）。
- **R24 `dispatch/message` 没有轮次核对和幂等键**。针对上一个提问的「可以，继续」会落到下一个提问上；宿主忙时「排队」更糟。
  处理：已改。派发带 `expectedTurnId` 与 `predictionId`；宿主忙时拒绝、不排队；核心侧另有有效期（SPEC §5.1–§5.3）。黄金用例 `send-*`、sidecar 测试、Grok 端到端都覆盖。
- **R25 确认卡脱离它确认的内容；「照你说的办」类意图只标了两个**。
  处理：已改。`passThrough` 标记这一类（内置包里 `confirm`、`choose_option`、`continue_task`、`apply_suggestion`、`skip_for_now`）；agent 的提议像外部或破坏性操作、或 agent 什么都没说时，整类不进目录；进了目录就必须带 `context.excerpt`，界面必须显示。
- **R26 备选意图绕过风险门槛**。
  处理：已改。`side_effect` 意图不作备选。
- **R27 `displayChannel` 把「展示几个」和「发送前多大摩擦」揉成一个枚举**，内置包走不到 `confirm` 档，README 却说会多确认一步。
  处理：已改。换成 `confirmBeforeSend`（仅 `side_effect` 为真，由核心强制）与 `choices` / `alternatives`。
- **R28 一致性测试测不到模型路径**；RPC Schema 没把方法绑定到参数；文档里的示例自己过不了 Schema。
  处理：已改。黄金用例（当时 99 条）覆盖全部 24 种抑制原因，含录制的模型输出和会话流程；`tools/reference.py` 实际执行它们；`rpc.schema.json` 按方法校验参数；`validate.py` 校验文档里的 JSON 示例、规范与求值器的模式串和默认提示词是否一致。
- **R29 融合公式算不出它声称的结果**（`P(none)` 中的 S 项几乎不起作用；文档自己的例子 altScore 为 0.060，门槛 0.18）；先验在过滤与合并后的归一、合并时用哪个场景描述均未定义。
  处理：已改。融合、先验、分差、备选打分、场景合并全部移除；一次求值一个场景，模型自报置信度过一个门槛。数据到位后的重启顺序见 future.md §6。
- **R30 O1 信号把最常见的回合路由错**。`failedExecs` 统计整轮失败；任何 shell 命令都算 `execute`。
  处理：已改。新增 `checkRuns`、`lastCheckFailed`、`lastExecFailed`，场景改用它们；`tool.call` 增加 `command` 与 `check`；工具名推断不分大小写。
- **R31 推断反馈**：按规范事件顺序恒为 `expired`；相似度量的是字面；退避状态机未定义。
  处理：已改。结果记录恰好一条，由下一条用户消息定为 `passed`；相似度只记录；在线只对显式关闭作出反应。
- **R32 `completed + null` 兼作失效通知**。
  处理：已改。新增 `prediction/invalidated`；空结果不让任何建议失效。
- **R33 编号选项固定猜第一项**。
  处理：已改。`enumerate` 把每个选项变成一张可选的卡，纯规则；末尾的编号列表只有在确实是提问时才算（`optionsPrompted`）。
- **R34 细节漂移**：版本号三处不同；输入框时代的措辞残留；`displayChannel` 默认最低摩擦；`fromSessionId` 必填与否不一致；多个配置项在 `initialize` 里没有入口；提示词超预算误用 `invalid_model_output`；兜底排除靠优先级魔数。
  处理：已改。版本统一为 v0.5；所有配置项进 `initialize.options` / `policy`；新增 `prompt_too_large`；兜底用显式的 `fallback: true`；其余随相关字段的删除而消失。

## 实现时发现的问题

按新规范写 TypeScript 核心、sidecar 和 Grok 适配时又发现几处，均已回写规范并加了用例：

- 默认的检查命令模式不认识 `node --test`、`deno test`（Grok 端到端第一次运行时暴露）。
- 宿主可能在回复派发请求之前就开始新的一轮，这时到达的用户消息是这次发送的回显，不能把结果记成 `passed`（SPEC §5.4）。
- 连点两次发送：前一次派发尚未返回时，后一次应得到 `busy`（SPEC §5.2）。
- `enumerate` 意图若带 `action`，每个选项的动作无处安放，定为加载时拒绝（SPEC §3.2）。
- 核心退出时未定结果的建议要记为 `expired`（SPEC §7.5）。
- 黄金用例里不能写死预测的 id 格式，改用占位符 `$predictionId`。

## 仍开放

- 预测效果没有任何数据（R21）。
- 经 Grok CLI 进程借模型，单次采样 10–12 秒，适配器把超时从默认 4 秒调到 60 秒。延迟预算要按宿主借出模型的方式分别定。
- TypeScript 实现没有做 JSON Schema 级的输入校验，只做了结构检查；对外发出的消息由 Python 侧的校验覆盖参考求值器，TypeScript 侧靠两套实现在黄金用例上结果一致来间接保证。
- 只接了一个宿主；`fork` 采样没有任何实现。（后来又接了 Hermes、Codex、Kimi、Claude Code，见下一节；`fork` 仍没有实现。）

---

# 会话绑定与多 Agent 宿主的审查（v0.5.1）

## 合并前审查（提交 `c6fddf2`，修复于 `f60cd41`）

- **R35 会话 ID 可以被当成命令行参数**。绑定时没有校验会话 ID 和 profile，它们会原样拼进 `grok --resume <id>` 和 `hermes -p <profile>`。实测 `grok --resume --version` 会打印版本号，说明以 `-` 开头的值被当成了参数。所以绑定 ID 为 `--always-approve` 的会话，之后每一轮都会自动批准全部工具。
  处理：已改。ID 和 profile 只接受普通名字；拼命令行和文件路径的地方再查一遍。
- **R36 绑定的 Hermes 会话内容被发给 Grok**。挑建议一律借 Grok 的模型。
  处理：先在页面上说明，随后按用户要求改为由会话自己的 Agent 用它的默认模型挑（R38）。

## 接入 Codex、Kimi 时发现的问题

- **R37 驱动 Hermes 会话用的是 `hermes -z`，它会自动批准危险命令**。Hermes 的帮助和源码都写明了 one-shot 模式下审批会被自动跳过。这违反了 SPEC §5.3 第 1 条"按用户亲手输入处理，走原生审批"。
  处理：已改。改用 `hermes chat --query-file … --oneshot --format stream-json`，单次查询模式下危险命令按 `approvals.single_query_mode` 处理，默认拒绝。顺带拿到了工具调用和退出码，Hermes 回合的信号不再只有最终文本。
- **R38 建议应由会话自己的 Agent 来挑**。
  处理：已改。四家都由自己的命令行、用默认模型挑建议，不带工具，不留痕迹：
  - Hermes：只给 `clarify` 工具集、`--source tool`，调用完删除会话；
  - Codex：`--ephemeral` 加只读沙箱；
  - Kimi：ACP 临时会话，用完 `session/delete`；
  - 模型只要调用了工具，这次结果就作废。
- **R39 Kimi 的 `-p` 会强制"自动执行一切"的权限模式**。
  处理：不用 `-p`。驱动 Kimi 会话改走 ACP，会话保持自己的权限模式，权限请求一律只拒绝这一次。
- **R40 Codex 和 Kimi 是 npm 的 `.cmd` 包装脚本**。Node 不经 shell 无法启动它们，经 shell 又会重新解析用户发送的文本。
  处理：已改。找到包装脚本背后的 JS 入口，用当前的 Node 直接运行；同时补了参数原样到达的测试。

SPEC §8 相应补了两条：宿主应该用会话自己的 Agent 挑建议；宿主驱动的轮次不得使用替用户批准的模式，必须拒绝 Agent 发来的权限请求。

## 接入 Claude Code 时发现的问题

- **R41 宿主停止时，在途采样的回复会写进已关闭的管道，宿主进程崩溃**（`ERR_STREAM_WRITE_AFTER_END`）。之前三家的实机检查没撞上，因为它们第二轮的回复不触发采样。
  处理：已改。停止时先拒绝新请求，等在途请求答完再关管道；RPC 层在连接关闭后丢弃迟到的回复，写失败只记日志。补了回归测试，撤掉修复时它以同样的错误失败。
- **R42 Claude 不让第二个进程续接已打开的会话**：`claude -p --resume <id>` 直接报错退出，不会悄悄分叉。
  处理：发送前查 Claude 的会话登记表，会话开着就回 `SESSION_BUSY`，不启动 `claude`。网页上的提示改成"Agent 正在运行，或这个会话正在别处打开着"。SPEC §5.3 第 2 条写明了这种情况。
- **R43 半截轮次会一直挡住发送**：进程在一轮中途被停掉后，转录里只有提问没有回答，"会话已前进"的判定就一直成立。
  处理：Claude 适配器在没有进程开着会话时，把末尾的半截轮次当作已中断（`claude -p` 运行时也会登记，所以登记表可靠）。另外四家有没有同样的问题尚未核实，例如 Codex 进程被杀掉时可能只留下 `task_started`。
- **R44 不能用 `claude purge <目录>` 清理测试会话**。对没有自己项目条目的目录，它要删的是最近的上级目录的条目，实测是 `~/.claude.json` 里的 `projects["C:/"]`。
  处理：实机检查只删除测试会话自己的转录和 `session-env/<id>`。另外，在 C 盘下任意目录运行 Claude，都会更新 `projects["C:/"]` 的 `lastSessionId` 等统计字段。
