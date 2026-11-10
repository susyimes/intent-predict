# Roadmap

intent-predict 沿两根正交轴演进：**观察范围 O1 → O2 → O3** 与**行动力 A1 → A2 → A3**（定义见 [SPEC.md](SPEC.md) §2–§3）。本文把 3×3 网格拆成五个阶段，并固定当前只做第一阶段。

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

## Phase 1 — O1 × A1（当前阶段，只做好这一格）

观察范围：**仅当前单个会话**（`turn.*`、`message.*`、`tool.*`、`artifact`、`state`）。
行动力：**仅纯建议输出**（`agencyStage` 恒为 `suggest_only`；ghost text / chips / 确认按钮；从不自动发送、从不执行工具、不产 `prepPlan`）。
说明图：[docs/diagrams.md](docs/diagrams.md) 第 1 节三张图（架构主图、含取消的时序图、UI 控制器状态图）是本阶段的精修对象，随实现打磨同步维护；后续阶段在同文件只有单页增量图，进入该阶段再展开。

### 做（In）

| 分段 | 内容 | 验收锚点 |
|---|---|---|
| **1A 确定性外壳** | 事件→信号（[SPEC.md](SPEC.md) §5.0 的 O1 部分）、守卫、谓词引擎、场景路由（含 stage 门控）、`RuleSource`（explicit 短路 + 结构加分）、Per-Intent 门控与通道裁决、槽位/Action 原子插值、9 条过滤、脱敏。模型路径可以不存在，纯 L-Local 可运行 | `eval/golden.jsonl` 中纯确定性用例（守卫、路由目录、风险剔除、显式短路、filter 类）通过 |
| **1B 模型路径** | `ModelSource` 经宿主 Sampler 调用：compact 为必备、fork 为可选加分（宿主支持才做）；默认提示词、输出严格解析、字节预算降级、4s 超时与取消传播、按小时计数的调用预算。门控用 **baseline profile**（模型原始置信度过阈值）；§7.6 融合公式只作可选项，待校准数据再启用。Sidecar 全双工（含 `sampler/cancel`）在本段落地 | 恶意/残缺模型输出一律抑制（fail-closed）；golden 的 `sampler: "none"` 语义与有模型时一致 |
| **1C UI 与反馈闭环** | 无框架 `SuggestionController` 状态机（300ms 显示延迟、打字即失效、sourceTurnId 过期校验）；三种展示通道按 §7.7 裁决渲染；`Feedback` 回传与本地 JSONL 遥测；Bigram Dice 相似度（含子串包含豁免）、dismiss 冷却、ignored 退避 | 一次真实按键到反馈落盘的端到端回路可复现 |
| **1D 评测与 dogfood** | 离线回放评测 CLI（会话 JSONL → 分类指标/校准/延迟/成本报告）；在一个真实宿主以 L0/L1 方式接入自用（参考接入，不追求三端齐全）；基于回放数据出首份基线报告，并据此在本文件补记 Phase 1 的数字门槛 | 基线报告落盘；有误差分析而不仅是总分 |

场景范围：[INTENTS.md](INTENTS.md) 内置包的 **O1 场景**（`stage: O1` 的 7 个）。O2/O3 场景留在包里做前向兼容，Phase 1 实现靠 stage 门控跳过，不算未完成。

### 不做（Out，明确排除）

- 不启用 O2/O3：不做子 Agent/后台任务/看板观察器，不做终端钩子、Git/FS Watcher、IDE 插件、剪贴板监听。Phase 1 实现收到 `agent.*`/`env.*` 事件必须安全忽略（不报错、不产生信号）。
- 不升级行动力：不执行 `prepPlan`、不派发 `action`；`tool`/`custom` 动作只作为元数据展示。
- 不做在线学习：`PriorSource` 的 Dirichlet 转移先验、`EmbeddingSource` 推迟到 Phase 2（1C 只保证反馈数据采集正确，供后续使用）。
- 不做打字中草稿路由、不做跨会话记忆与用户画像。
- 不追求多宿主齐全：Hermes/Codex/ACP 适配器全量接入放到后续阶段与其钉版本核查一起做。

### 出口标准（全部满足才进 Phase 2）

1. `python tools/validate.py` 全绿；[eval/golden.jsonl](eval/golden.jsonl) 的 **Phase 1 子集 17 条**被真实 core 实现 100% 跑过（排除 `o2-subagent-fresh`、`o2-subagent-stale`、`o3-env-cold-start`，另含 `o1-only-stage-gate` 证明越界事件被忽略）。
2. 1D 基线报告已产生（precision@shown、coverage、接受/编辑率、校准、p50/p95 延迟、每千轮成本），且本文补记了据基线定的数值门槛；至少一轮按误差分析调阈值后回归不退化。
3. 安全不变量经测试：任何路径都不自动发送/执行；`confirm` 类与 `side_effect` 永不走 ghost text；残缺或敌意模型输出必抑制。
4. 延迟在 [docs/design.md](docs/design.md) §12 预算内有实测数据（达不到则先修延迟，不靠放宽门控凑覆盖率）。

## Phase 2 — O2 × A1（看全整个 Agent，仍只建议）

- 范围：`agent.subagent_completed` / `agent.background_job` / `agent.task_updated` / `agent.session_switched` 事件与信号；[SPEC.md](SPEC.md) §2.4 新鲜度（TTL 60s）、单次消费、跨会话归属；计数由宿主权威上报。开启内置包 `coding.subagent_reported` 场景；顺带启用 `PriorSource` 在线先验（数据来自 Phase 1 已采集的反馈）。
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
| M1 接入（Hermes 首发） | Phase 1 的 1C/1D 只做参考接入；Hermes 深度适配顺延至 Phase 2 前后按需开启 |
| M2 学习 | 反馈采集在 Phase 1（1C）；在线先验/校准启用在 Phase 2 |
| M3 扩展（草稿路由、推测执行接口、HTTP/SSE） | 推测执行即 Phase 4；草稿路由与 HTTP/SSE 未排期，不进当前五阶段 |
