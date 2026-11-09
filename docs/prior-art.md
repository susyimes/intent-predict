# 调研：下一句与下一步预测的现有实现

调研日期为 2026-11-09。代码引用固定在以下两个提交：

- openai/codex @ [`e54a5713`](https://github.com/openai/codex/tree/e54a5713caf331f42a6eef0166186df5f7563c29)（2026-11-09），Apache-2.0
- QwenLM/qwen-code @ [`a237758b`](https://github.com/QwenLM/qwen-code/tree/a237758b5abc5914c289db2ca59f1a397f3af594)（2026-11-09），Apache-2.0

本项目只借鉴思路，没有复制代码。

---

## 1. OpenAI Codex：composer predictions

### 1.1 产品行为（公开信息）

- 2026 年 10 月以 beta 形式上线。面向年满 18 岁的个人 ChatGPT Pro 用户，只在 Codex 桌面版中提供，并且只用于本地和 SSH 线程。
- 每轮回复结束后，输入框里可能出现一条建议，但不保证每轮都有。
- 按 Tab 接受，接受后可以编辑，**不会自动发送**。
- 只使用当前线程中已有的上下文，"don't independently retrieve memories or information from connected apps"。
- beta 期间生成预测不额外收费，不计入 Codex 用量，也不消耗 credits。
- 关闭方法：Settings → General → Composer → Show predictions。

调研时，官方帮助页 <https://help.openai.com/en/articles/20001601-composer-predictions-in-codex> 的抓取请求被返回 403。上面的信息来自官方公告（[X](https://x.com/OpenAIDevs/status/2108624138369929725)）和 [OpenAI 社区帖](https://community.openai.com/t/codex-can-now-suggest-your-next-message-composer-predictions-beta/1404842)。

社区还提过两个相关需求，目前都还只是提案：
- [#42587](https://github.com/openai/codex/issues/42587)：在输入框里根据上下文建议下一条 prompt。
- [#56852](https://github.com/openai/codex/issues/56852)：在输入框上方显示三个可选的建议。

### 1.2 开源后端：`thread/sample`

这是 app-server 的实验接口，代码在 `codex-rs/app-server-protocol/src/protocol/v2/thread_sample.rs` 和 `codex-rs/app-server/src/thread_sample.rs`：

> One model response on an ephemeral fork that inherits the source's configuration and context.

**参数**（节选）：

| 字段 | 说明 |
|---|---|
| `threadId` | 源线程 |
| `expectedTurnId` | 必须是源线程最近一次已结束的 turn（completed、failed 或 interrupted），否则请求会被拒绝 |
| `prompt` | 追加在末尾的 prompt |
| `effort` | 只有提供方和模型支持"不破坏缓存的推理强度更新"时才生效 |
| `disableMcp` | 在特定条件下禁用 MCP |
| `interruptOnCancel` | 取消时是否中断上游请求 |

**返回**：
- `sourceTurnId`
- `responseId`
- `text`：如果模型试图调用工具，或者没有输出文本，则为 null
- `inputTokens`、`cachedInputTokens`、`outputTokens`

**实现要点**：
- 源线程必须空闲，并且必须是持久化的根线程，不能是子 agent 或临时线程。
- 分叉是临时的（ephemeral），并且关闭了自动压缩，打开了 reasoning effort override。
- 推理强度的覆盖方式：在上下文末尾追加一条 `configuration_update`，请求级设置保持不变，这样缓存不受影响。可以对照测试快照 `codex-rs/app-server/tests/suite/v2/snapshots/all__suite__v2__thread_sample__sample_inherits_parent_context.snap`：父线程用 high，采样请求在末尾追加 `configuration_update:reasoning={"effort":"medium"}`，请求设置仍然是 high。
- 相关常量：`SAMPLE_TIMEOUT = 30s`、`MAX_PROMPT_BYTES = 4_000`、`MAX_OUTPUT_BYTES = 64 KiB`。
- 可以通过 `thread/sample/cancel` 取消。

**相关接口**：
- `thread/fork` 有一个 `experimentalPredictionMode` 参数。它基于已加载父线程的有效配置、工具、环境和持久化历史开分叉，目的是 "to maximize prompt-cache reuse"。要求 `ephemeral: true`，不能带配置覆盖，也不能带 turn 截断参数。
- feature flag `prediction_preserve_parent_tools`："Preserve inherited tool declarations in MCP-disabled prediction forks"。工具声明是缓存前缀的一部分。
- 协议中已经定义了 `thread/prediction/request`（参数：threadId、sourceTurnId）和 `thread/prediction/updated` 通知，后者的结果是 `completed { text }` 或 `failed`。不过：
  - 开源 app-server 对前者直接返回 `"thread/prediction/request is not implemented yet"`，见 `codex-rs/app-server/src/message_processor.rs`。
  - 开源 TUI 收到后者时什么也不做，只有一个空分支，见 `codex-rs/tui/src/chatwidget/protocol.rs`。

### 1.3 闭源部分与推断

- 预测用的 prompt、什么时候展示、UI 交互都在闭源的桌面客户端里。
- **以下是推断，未经证实**：根据接口的形态，桌面端的流程很可能是：turn 结束后调用 `thread/sample`，追加一段"预测用户下一句"的 prompt，对返回的文本做筛选，然后显示出来。

### 1.4 值得借鉴的点

1. 分叉的前缀必须和主请求**完全一致**，包括配置、工具声明和历史。任何改动都会让缓存失效。
2. 用 `expectedTurnId` 防止展示过期结果。
3. 模型试图调用工具，就说明这次采样无效，直接作废。
4. 追加的 prompt 有硬上限（4,000 字节）。
5. 接受建议后不自动发送。不保证每轮都给出建议。

---

## 2. Qwen Code：Next-step Suggestion（NES）

### 2.1 建议生成

参考文档：`docs/design/prompt-suggestion/prompt-suggestion-design.md`。

- 在 Responding → Idle 的状态切换时触发，先检查一组守卫条件：
  - 功能开关
  - 是否处于非交互模式或 SDK 模式
  - 是否有 API 错误
  - 是否有确认对话框或权限对话框
  - 是否有 elicitation
  - 是否处于 plan 模式
  - 对话是否太短（`modelTurns < 2`）
- 能拿到 CacheSafeParams 时，走缓存共享的 `runForkedQuery()`；拿不到时，退回独立的 `BaseLlmClient.generateJson()`。
- prompt 的要点：
  - 先读助手最后一条消息的**最后几行**，下一步提示通常写在那里。
  - 预测用户会输入什么，而不是你认为他该做什么："THE TEST: Would they think 'I was just about to type that'?"
  - 如果助手明确给出了 "type X" 之类的提示，就直接取 X。
  - 长度 2 到 12 个词，匹配用户的说话风格，或者什么都不输出。
- 12 条过滤规则：done、meta_text、meta_wrapped、error_message、prefixed_label、too_few_words、too_many_words、too_long、multiple_sentences、has_formatting、evaluative、ai_voice。
- 所有后台任务都关闭 thinking。这样做不影响缓存，因为缓存前缀只由 systemInstruction、tools 和 history 决定，和 thinking 配置无关。
- 后台调用使用专门的 prompt id（`prompt_suggestion`、`forked_query`、`speculation`），不会出现在用户可见的日志里。
- 可以单独配置一个 `fastModel` 来运行所有后台任务。

### 2.2 交互与遥测

- `FollowupController` 不依赖具体 UI 框架，CLI（Ink）和 WebUI（React）共用同一个。它延迟 300ms 显示建议，接受后有 100ms 的防抖锁。
- 按键：
  - Tab 或 →：填入建议，不发送。
  - Enter：填入并发送。
  - 直接打字或粘贴：关闭建议。
- 遥测事件 `PromptSuggestionEvent` 包含以下字段：
  - outcome（accepted、ignored、suppressed）、accept_method
  - time_to_accept_ms、time_to_ignore_ms、time_to_first_keystroke_ms
  - similarity、was_focused_when_shown
  - suppressed 时的过滤原因

### 2.3 推测执行（speculation，默认关闭）

参考文档：`docs/design/prompt-suggestion/speculation-design.md`。

- 建议一出现，就在缓存共享的分叉里**提前执行**这条建议。
- 文件写入走写时复制（copy-on-write）的 overlay 目录。用户接受时，把文件拷回真实目录；用户不接受时，删除 overlay。
- 工具闸门：
  - 只读工具直接放行。
  - 写文件只在 auto-edit 或 yolo 模式下放行，并重定向到 overlay。
  - shell 命令只放行经 AST 判定为只读的。
  - 网络请求、子 agent、询问用户、MCP 等，一律视为边界，在这里停止。
- 最多执行 20 轮、100 条消息。执行完成后，还会预先生成下一条建议（pipelined suggestion）。

### 2.4 封闭集合的意图分类

参考文档：`docs/design/2026-07-28-web-shell-composer-intent-suggestions.md`。

- 对用户**正在输入的草稿**做保守分类，输出 `btw | new_session | none` 外加 confidence。只有达到阈值，才给出一个不阻塞输入的动作。
- 采用 fail-closed 策略：输出格式错误、出现未知动作、置信度无效、调用出错或被取消，都不给动作。
- 会话切换、草稿或附件发生变化时，建议立即失效。用户点击时，还会再校验一次草稿和会话。
- 这是"有限意图集合 + none + 阈值"这一做法在生产代码中的直接先例，也是本项目核心思路最近的参照。

---

## 3. 其他开源实现

以下项目只看过 README 或 PR 描述，没有审阅代码：

- [inference-gateway/cli PR #1554](https://github.com/inference-gateway/cli/pull/1554)：每轮结束后，用一个可以单独配置的模型，只看最近几条消息，生成一行建议，按 Tab 或 → 接受。用户打字、按 Esc 或新一轮开始时，取消正在进行的请求。
- [olasundell/opencode-prompt-suggester](https://github.com/olasundell/opencode-prompt-suggester)：OpenCode 插件，用启发式规则加后台模型生成下一句，显示为输入框的占位文本。
- [sanif/pi-chat-suggest](https://github.com/sanif/pi-chat-suggest)：Pi 扩展。Tab 接受，↑↓ 浏览备选，Esc 关闭。
- [liush2yuxjtu/pi-ghost-text-zh](https://github.com/liush2yuxjtu/pi-ghost-text-zh)：Pi 的"建议语言与用户一致"版本，fork 自 jcv/pi-ghost-text，MIT 许可。

## 4. 闭源的同类功能

- Claude Code 的 prompt suggestions：回复结束后在输入框显示灰色建议，用户可以接受。它没有开源，这里不展开。

---

## 5. 借鉴清单

| 来源 | 借鉴点 | 对应本项目设计文档的章节 |
|---|---|---|
| Codex `thread/sample` | 前缀一致的临时分叉；`expectedTurnId`；模型调用工具即作废；prompt 上限 | Sampler 接口与实现规范（§8.3） |
| Codex 产品行为 | Tab 接受但不发送；不保证每轮都有；只用当前会话的上下文 | UI 规范（§10）、门控（§7.7）、隐私（§11） |
| Qwen NES | 守卫条件；先读最后几行；显式提示优先；过滤规则；关闭 thinking；内部 prompt id | §7.2、§7.4、§7.5、§7.8、§12 |
| Qwen FollowupController | 不依赖 UI 框架的控制器；300ms 延迟；防抖；遥测字段 | §10、§7.10 |
| Qwen speculation | overlay 和工具闸门 | M3：只读意图的推测执行策略接口（§17） |
| Qwen 意图分类 | 封闭集合 + none + 阈值 + fail-closed + 失效校验 | 核心思路（§3）、门控（§7.7） |

## 6. 来源

- OpenAI Developers 公告：<https://x.com/OpenAIDevs/status/2108624138369929725>、<https://x.com/OpenAIDevs/status/2108624150344646752>
- OpenAI 社区帖：<https://community.openai.com/t/codex-can-now-suggest-your-next-message-composer-predictions-beta/1404842>
- OpenAI 帮助页（调研时返回 403）：<https://help.openai.com/en/articles/20001601-composer-predictions-in-codex>
- openai/codex issues：[#42587](https://github.com/openai/codex/issues/42587)、[#56852](https://github.com/openai/codex/issues/56852)
- Qwen Code 文档站：<https://qwenlm.github.io/qwen-code-docs/en/design/prompt-suggestion/prompt-suggestion-implementation/>
- ACP 扩展机制：<https://agentclientprotocol.com/protocol/extensibility>
