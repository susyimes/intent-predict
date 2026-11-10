# Roadmap

intent-predict 沿两根正交轴演进：**观察范围 O1 → O2 → O3** 与**行动力 A1 → A2 → A3**（定义见 [SPEC.md](SPEC.md) §2–§3）。本文把 3×3 网格拆成五个阶段，并固定当前只做第一阶段。交付面与宿主**完全解耦**：建议只出现在 SDK 自带的**独立 WebUI** 里（用户面：当前会话的建议流与自己的草稿编辑框；检查面：抑制记录、门控数值、阈值试调与回放）。**不进入也不计划进入宿主输入框**——没有 ghost text、没有宿主按键绑定、没有宿主控件注入。宿主与 SDK 之间只剩数据面：事件与状态进来、采样委托出去，最多再加一个可选的「把用户在 WebUI 里确认的文本作为下一条用户消息发进会话」的 dispatch 能力；没有 dispatch 的宿主退化为一键复制、人工粘贴。此后各阶段沿用同一独立 WebUI，只长内容不换壳。

```text
          A1 纯建议    A2 推测预执行   A3 委托执行
O3 全局    Phase 3  →   Phase 4    →   Phase 5
O2 全Agent Phase 2  ↗
O1 单会话  Phase 1（当前，只做这一格）
```

## 推进原则

1. **每阶段只动一根轴、一格**：效果变化可归因；出问题能退回上一格而不用整片回滚。
2. **观察优先、行动力殿后**：先把「看得更全」在最安全的纯建议行动力下验证完，再升级「做得更多」。
3. **每阶段独立可交付、可度量**：未达到本阶段出口标准，不开启下一格；规范（[SPEC.md](SPEC.md) / [spec/](spec/)）可以领先实现，但任何实现宣称只能报自己做到的格子（如「Phase 1 conformant = O1 × A1」）。
4. **不预设效果数字**：精度/覆盖率门槛一律在量出首个基线后写入，不拍脑袋（沿 [docs/design.md](docs/design.md) §17 口径）。
5. **交付面独立、先影子后放量**：建议的家始终是 SDK 独立 WebUI，与宿主输入框零耦合；任何新格子先在 WebUI 的检查面影子观察、量出精度，再在用户面放量。Phase 1 先把这套独立面本身打磨好。

## Phase 1 — O1 × A1（当前阶段，只做好这一格）

观察范围：**仅当前单个会话**（`turn.*`、`message.*`、`tool.*`、`artifact`、`state`）。
行动力：**仅纯建议输出**（`agencyStage` 恒为 `suggest_only`；从不自动发送、从不执行工具、不产 `prepPlan`）。
交付面：**仅 SDK 独立 WebUI**。预测以卡片出现在 WebUI 的会话建议流里；用户点开卡片进入 WebUI 自己的草稿编辑框，可改字，然后「发给 Agent」（宿主具备 dispatch 时）或「复制」；也可以直接关掉或标没用。`displayChannel` 是 WebUI 内的**摩擦分级**而非宿主通道：`quick`（单卡，一键采纳到草稿，仅低风险）、`choice`（含 alternatives 供挑选）、`confirm`（发送/派发前强制确认一步）。宿主零 UI 改动，只供事件、Sampler 与可选 dispatch。
说明图：[docs/diagrams.md](docs/diagrams.md) 第 1 节（架构主图、时序图、WebUI 建议生命周期图）是本阶段精修对象。本阶段预计长时间打磨：精度靠 WebUI 检查面的影子数据与标注迭代。

### 做（In）

| 分段 | 内容 | 验收锚点 |
|---|---|---|
| **1A 确定性外壳** | 事件→信号（[SPEC.md](SPEC.md) §5.0 的 O1 部分）、守卫、谓词引擎、场景路由（含 stage 门控）、`RuleSource`（explicit 短路 + 结构加分）、Per-Intent 门控与通道裁决、槽位/Action 原子插值、9 条过滤、脱敏。模型路径可以不存在，纯 L-Local 可运行 | `eval/golden.jsonl` 中纯确定性用例（守卫、路由目录、风险剔除、显式短路、filter 类）通过 |
| **1B 模型路径** | `ModelSource` 经宿主 Sampler 调用：compact 为必备、fork 为可选加分（宿主支持才做）；默认提示词、输出严格解析、字节预算降级、4s 超时与取消传播、按小时计数的调用预算。门控用 **baseline profile**（模型原始置信度过阈值）；§7.6 融合公式只作可选项，待校准数据再启用。Sidecar 全双工（含 `sampler/cancel`）在本段落地 | 恶意/残缺模型输出一律抑制（fail-closed）；golden 的 `sampler: "none"` 语义与有模型时一致 |
| **1C 独立 WebUI（产品面 + 检查面）** | 本地 Web 应用（仅回环地址 + 每次启动随机 token、静态资源随包离线分发；静态资源可由 sidecar 同进程提供）。**用户面**：按会话的建议卡片流（quick/choice/confirm 三种摩擦呈现）、草稿编辑框（点卡片载入、可改字）、「发给 Agent / 复制 / 关闭 / 标没用」四动作，其中发给 Agent 走可选的宿主 `dispatchModes` 能力、无此能力时只剩复制；**检查面**：被抑制记录与 `SuppressedReason`、命中场景与门控数值、会话内阈值试调、标注导出为评测标签。WebUI **永不读写宿主输入框、不监听宿主按键**。反馈一半来自 WebUI 显式动作（send/edit_send/copy/click 计入使用、dismissed 进冷却），一半由核心在下一条 `message.user` 到达时用 Bigram Dice 相似度推断 ignored/近似命中——不依赖宿主 UI 上报 | 端到端回路可复现：真实会话事件 → WebUI 出卡片 → 编辑后发送（或复制）→ 反馈与遥测落盘、冷却生效；同一回路在无 dispatch 的宿主上自动退化为复制 |
| **1D 评测与 dogfood** | 离线回放评测 CLI（会话 JSONL → 分类指标/校准/延迟/成本报告，golden 运行器也可挂控制台做视图、CI 以 CLI 为准）；在一个真实宿主以 L0/L1 方式接入自用（只喂事件与 Sampler、按有无 dispatch 决定发送或复制，宿主 UI 零改动）；基于回放 + WebUI 真实使用数据出首份基线报告，并据此在本文件补记 Phase 1 的数字门槛。注意此口径的接受率是「打开 WebUI 的人里有多少用了卡片」，与将来任何宿主内嵌形态的接受率不可直接相比，报告须注明分母 | 基线报告落盘；有误差分析而不仅是总分 |

场景范围：[INTENTS.md](INTENTS.md) 内置包的 **O1 场景**（`stage: O1` 的 7 个）。O2/O3 场景留在包里做前向兼容，Phase 1 实现靠 stage 门控跳过，不算未完成。

### 不做（Out，明确排除）

- **不碰任何宿主 UI（永久约束，不限本阶段）**：不在宿主输入框渲染任何东西、不绑宿主按键、不读宿主输入状态接口。SDK 唯一人机界面是自己的 WebUI；宿主想在自家界面镜像卡片属于宿主自选行为，不进本设计与路线图。
- 不启用 O2/O3：不做子 Agent/后台任务/看板观察器，不做终端钩子、Git/FS Watcher、IDE 插件、剪贴板监听。Phase 1 实现收到 `agent.*`/`env.*` 事件必须安全忽略（不报错、不产生信号）。
- 不升级行动力：不执行 `prepPlan`、不在 A1 派发工具类 `action`；WebUI 的「发给 Agent」只是把用户在 WebUI 草稿框里确认的文本作为下一条用户消息投递（等价于用户亲手发送），「复制」更是纯人工搬运，二者都不构成 SDK 自动发送。
- 不做在线学习：`PriorSource` 的 Dirichlet 转移先验、`EmbeddingSource` 推迟到 Phase 2（1C/1D 只保证影子日志与标注数据采集正确，供后续使用）。
- 不做打字中草稿路由、不做跨会话记忆与用户画像。
- 不追求多宿主齐全：Hermes/Codex/ACP 适配器全量接入放到后续阶段与其钉版本核查一起做。

### 出口标准（全部满足才进 Phase 2）

1. `python tools/validate.py` 全绿；[eval/golden.jsonl](eval/golden.jsonl) 的 **Phase 1 子集 17 条**被真实 core 实现 100% 跑过（排除 `o2-subagent-fresh`、`o2-subagent-stale`、`o3-env-cold-start`，另含 `o1-only-stage-gate` 证明越界事件被忽略）。
2. 1D 基线报告已产生（回放标注口径的 precision@shown、coverage、WebUI 使用率 send+edit_send 与 copy 分别计数、校准、p50/p95 延迟、每千轮成本），且本文补记了据基线定的数值门槛；至少一轮按误差分析调阈值后回归不退化。
3. 安全不变量经测试：WebUI 只监听回环地址且带 token、未授权请求被拒、页面默认只展示脱敏后的信号与文本；任何路径都不自动发送/执行（发给 Agent 必须用户在 WebUI 里点下发送，`confirm` 分级再加一步确认）；`side_effect` 的摩擦分级永不为 `quick`；残缺或敌意模型输出必抑制；代码库内不存在对宿主输入框的写入路径（可审计）。
4. 延迟在 [docs/design.md](docs/design.md) §12 预算内有实测数据（达不到则先修延迟，不靠放宽门控凑覆盖率）。

## Phase 2 — O2 × A1（看全整个 Agent，仍只建议）

- 范围：`agent.subagent_completed` / `agent.background_job` / `agent.task_updated` / `agent.session_switched` 事件与信号；[SPEC.md](SPEC.md) §2.4 新鲜度（TTL 60s）、单次消费、跨会话归属；计数由宿主权威上报。开启内置包 `coding.subagent_reported` 场景；顺带启用 `PriorSource` 在线先验（数据来自 Phase 1 的 WebUI 反馈与推断反馈）。O2 场景照例先在检查面影子观察，再在用户面放量。
- 入口门槛：Phase 1 出口全过。
- 出口要点：O2 的 golden 用例（fresh/stale）通过；子任务完成类建议在真实多会话 dogfood 中不串话到无关会话；A1 不变量不变。
- 主要风险：陈旧信号幽灵触发、多会话 UI 归属错误。

## Phase 3 — O3 × A1（看全工作台，仍只建议）

- 范围：终端 shell hook、Git/FS watcher、IDE 焦点与诊断、剪贴板分类等观察器（实现归属在本阶段定：宿主内置或独立 observers 包）；每类观察器单独同意与开关；`env-0` 冷启动仅 compact。开启内置包两个 O3 场景。
- 入口门槛：Phase 2 出口全过；隐私评审通过（[SPEC.md](SPEC.md) §6 第 3 项的 `signals_json` 白名单与按类关闭）。
- 出口要点：O3 golden（cold-start）通过；观察器关闭时零事件零信号有测试；环境触发的误报率单独统计并可接受。
- 决策点：本阶段与 Phase 4 的先后可在 Phase 2 出口凭数据对调（环境误报治理成本 vs 预执行延迟收益），对调须在本文件留一句记录。

## Phase 4 — × A2（推测预执行）

- 范围：`prepPlan` 的生成规则（哪些意图可预备、只读如何判定）、宿主后台执行与配额、用户打字/拒绝即中止、结果缓存与失效；执行仍由宿主完成，SDK 只给计划。
- 入口门槛：观察轴至少到 O2（走到哪格用哪格信号）；Phase 1 的延迟基线可作对照。
- 出口要点：预备任务零副作用有测试（含中止路径）；接受建议后的端到端延迟相对基线有可测收益；无收益则不上默认开启。
- 主要风险：隐性成本（无谓预跑）、只读判定被绕过。

## Phase 5 — × A3（建议 + 委托执行）

- 范围：意图卡片确认后 `action` 派发契约（命令填入 vs 工具调用的确认分级）、执行审计与撤销说明；`side_effect`/`irreversible` 永远走显式二次确认。
- 入口门槛：Phase 4 出口全过，且 A1/A2 累积的接受率与风险事件数据支持放行。
- 出口要点：每次派发有人在回路的证据链（谁确认、派发了什么、结果如何）；误派发为零容忍并有回归用例。

## 与旧里程碑（M0–M3）的映射

旧命名退役，仅作对照：

| 旧 | 对应新阶段 |
|---|---|
| M0 骨架 | Phase 1 的 1A + 1B |
| M1 接入（Hermes 首发） | Phase 1 为独立 WebUI 交付面 + 影子接入；不做宿主输入框上屏（已取消）；Hermes 深度适配（事件/Sampler/dispatch 三件套）顺延至 Phase 2 前后按需开启 |
| M2 学习 | 反馈（WebUI 动作 + 下一条消息推断）自 Phase 1 起采集（1C/1D）；在线先验/校准启用在 Phase 2 |
| M3 扩展（草稿路由、推测执行接口、HTTP/SSE） | 推测执行即 Phase 4；草稿路由与 HTTP/SSE 未排期，不进当前五阶段 |
