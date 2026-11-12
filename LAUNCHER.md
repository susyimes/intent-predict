# LAUNCHER：替用户打开建议页

写给替用户操作的 Agent（Claude Code、Codex、Kimi、Grok……）。目标：在用户本机把 intent-predict 跑起来，把「下一步建议」页的地址交给用户，需要时替用户把指定的会话绑上。人自己在终端里用，看 [README](README.md#跑起来)。

下面是事实和参考命令，不是必须照走的步骤；按用户的情况取用。

## 先知道这些

- **谁开页面**：宿主 `packages/host-grok/src/main.ts` 启动时带起 sidecar 子进程，页面由 sidecar 开在 `127.0.0.1` 的随机端口上。地址带 `?t=<令牌>`，没有令牌打不开。**端口和令牌每次启动都换**。
- **后台启动要加 `--headless`**。不加时宿主从终端读用户输入，stdin 一关就退出；后台启动的 stdin 通常是空的，进程会立刻结束。加了就不读终端，消息从建议页发，进程一直跑到被结束。
- **地址在标准输出里**，启动后一两秒出现：
  ```
  打开这个页面看「下一步建议」：http://127.0.0.1:<端口>/?t=<令牌>
  选择要绑定的会话：http://127.0.0.1:<端口>/sessions?t=<令牌>
  ```
  用 `http://127\.0\.0\.1:\d+/\?t=[\w-]+` 能取到建议页地址。
- **环境**：Node ≥ 22.18，仓库根目录已 `npm install`。要驱动哪家 Agent，那家的命令行得已装好、已登录。
- **默认值就是想要的**：开放生成、Agent 用自己的默认模型和推理强度写建议。用户没要求就别加 `--mode catalog`、`--sampler-effort low` 之类的降级参数。也别往 `--` 后面塞跳过审批的参数。其余参数见 `node packages/host-grok/src/main.ts --help`。
- **页面文件在 sidecar 启动时读入**：改了 `packages/sidecar/src/*.html`，要重启才能看到。
- **先看看是不是已经开着一个**。同一个会话被两个宿主绑着，两边都会求值，也都能往里发消息。

## 启动

Windows（PowerShell，进程脱离当前 shell 继续跑）：

```powershell
$log = Join-Path $env:TEMP 'intent-predict-host.log'
$p = Start-Process node -ArgumentList 'packages/host-grok/src/main.ts','--headless' `
  -WorkingDirectory '<仓库根目录>' -WindowStyle Hidden `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
# 等地址出现
$url = $null; $deadline = (Get-Date).AddSeconds(30)
while (-not $url -and -not $p.HasExited -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
  $url = (Select-String -Path $log -Pattern 'http://127\.0\.0\.1:\d+/\?t=[\w-]+' -ErrorAction SilentlyContinue).Matches.Value |
    Select-Object -First 1
}
if (-not $url) { Get-Content $log, "$log.err" }   # 没等到地址：看输出和报错
```

macOS / Linux：

```bash
nohup node packages/host-grok/src/main.ts --headless > /tmp/intent-predict-host.log 2>&1 &
grep -m1 -oE 'http://127\.0\.0\.1:[0-9]+/\?t=[A-Za-z0-9_-]+' /tmp/intent-predict-host.log   # 没有就稍等再取
```

还没绑定会话时，宿主默认驱动 Grok，在 `--cwd`（默认是启动目录）里开新会话。多数时候用户要的是绑定一个已有会话，见下一节。

## 绑定会话

可以让用户自己在「选择会话」页点，也可以替用户调页面用的同一套接口：`POST http://127.0.0.1:<端口>/rpc`，头部 `Authorization: Bearer <令牌>`，JSON-RPC 2.0。

- `binding/list`，参数 `{}`：返回 `{ current, sessions, sessionId }`。`sessions` 里每项有 `kind`、`id`、`cwd`、`title`、`updatedAt`、`running`、`bindable`，Hermes 还有 `profile`。
- `binding/bind`，参数 `{ kind, id, cwd, profile? }`，`cwd` 必须是绝对路径：返回 `{ bound, sessionId, replayedTurns }`。

```powershell
$u = [Uri]$url; $t = $u.Query -replace '^\?t=', ''
function Rpc($method, $params) {
  $body = @{ jsonrpc = '2.0'; id = 1; method = $method; params = $params } | ConvertTo-Json -Depth 5
  $r = Invoke-RestMethod -Method Post -Uri "$($u.GetLeftPart('Authority'))/rpc" -Headers @{ Authorization = "Bearer $t" } `
    -ContentType 'application/json' -Body $body
  if ($r.error) { throw "$($r.error.message) ($($r.error.code))" }
  $r.result
}
(Rpc 'binding/list' @{}).sessions | Format-Table kind, id, running, cwd, title
Rpc 'binding/bind' @{ kind = 'grok'; id = '<会话 ID>'; cwd = '<会话所在目录>' }
```

Windows 路径里的反斜杠，在 PowerShell 里交给 `ConvertTo-Json` 转义最省事。在 bash 的 heredoc 或手写的 JSON 字符串里，反斜杠容易被吃掉。

绑定之后：

- 宿主先还原这个会话最近 3 轮，并立即求值。开放模式下，每轮要等十几到几十秒才出建议。
- 用户之后在原工具里继续的轮次，约 2 秒内同步进来，页面不用刷新。
- 用户在原工具里又发了一条之后，页面上的旧建议就不对应最新一轮了，从页面发送会被拒（`TURN_MISMATCH`）。等新一轮同步进来，会出新的建议。
- Claude Code 会话还被另一个活着的进程开着时，从页面发送会被拒（`SESSION_BUSY`）。
- `bindable: false` 的会话不能绑。

`--agent <家> --resume <会话 ID>` 也能让发出的消息续接某个会话，但不会像绑定那样还原最近几轮。

## 重启和结束

- **结束**：
  - Ctrl+C 或 SIGTERM 会干净退出：等正在进行的求值收尾，关掉 sidecar，删掉临时目录。
  - Windows 上 `Stop-Process` 是直接结束进程。实测 sidecar 会随之退出。但正在跑的一轮会被打断，留下半截：Claude Code 会把它当中断处理，其余几家没验证过，可能一直挡住发送（见 [docs/review-issues.md](docs/review-issues.md) R43）。能用 Ctrl+C 就别直接结束进程。
- **重启**就是结束再启动。重启后端口、令牌都换了，绑定也不保留：
  1. 把新地址给用户；
  2. 原来绑着会话的，再调一次 `binding/bind`。
- **找已经在跑的实例**：用启动时拿到的 PID；或者在进程列表里找命令行含 `host-grok/src/main.ts` 的 node 进程，它的子进程是 `sidecar/src/main.ts serve --stdio`。

## 交给用户时

- 地址里的令牌，就是往用户会话里发消息的权限。只交给用户本人；别写进提交，别贴到公开的地方。
- 建议发不发由用户决定。别替用户点「发给 Agent」，也别调 `prediction/act`，除非用户明确要你这么做。
