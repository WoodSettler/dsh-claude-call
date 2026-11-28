# ClaudeCallDSH — 让 Claude Code 在 DSH 里唤起会话、派任务、管自动化任务

一个双向自洽的小桥：

- **DSH 侧**：一个 Host 插件（`dsh-claude-call`），在 `127.0.0.1` 上开一个**独立**的回环 HTTP 服务，收到请求后调用
  `ctx.sessionController.create()` 建会话、`prompt()` 投递任务，再从 **会话日志**（唯一真相）里读出 `turn/end`
  和最后一条 `assistant/message` 作为答复；自动化任务则走宿主的 `ctx.schedule` 服务。
- **Claude Code 侧**：一个**零依赖**的 MCP stdio server（`mcp/server.mjs`），把桥包装成 14 个工具：
  `dsh_task` / `dsh_send` / `dsh_wait` / `dsh_status` / `dsh_cancel` /
  `dsh_sessions` / `dsh_workspaces` / `dsh_models` / `dsh_turns` /
  `dsh_schedules` / `dsh_schedule_create` / `dsh_schedule_update` / `dsh_schedule_delete` / `dsh_schedule_history`。

```
Claude Code ──(MCP stdio)──> mcp/server.mjs ──(loopback HTTP + token)──> dsh-claude-call 插件
                                                                              │
                                                                   sessionController.create / prompt
                                                                              │
                                                                       DSH 会话（独立 Agent）
```

## 为什么是独立监听，而不是复用 DSH 的 Web 端口

DSH Desktop 的 Web 服务外面有一层 `desktopBrowserAccess` 网关：只有 Electron renderer（带
`x-dsh-desktop-renderer` 头）或显式放行的普通浏览器能访问，其余请求一律 `403 forbidden`。
插件**不应该**去冒充 renderer（那等于把桌面端的安全边界偷偷扩大），所以桥自带一个只绑
`127.0.0.1`、端口默认由内核分配的监听，用**自己的随机 token** 做认证。

## 已完成的安装（本机）

- bundle：`dsh-claude-call`，以 pnpm `link:` 方式挂在 `~/.dsh/profiles/desktop/node_modules/dsh-claude-call`
  → 指向本仓库。
- 插件行：`claude-call`（profile 的 `cordis.patch.yml` 里有一条 `port: 0` 的覆盖）。
- 发现文件：`~/.dsh/claude-call/endpoint.json`（插件激活时写入，卸载时删除）：
  ```json
  {
    "schema": 1,
    "name": "claude-call",
    "version": "0.3.1",
    "origin": "http://127.0.0.1:<随机端口>",
    "route": "",
    "token": "<每次启动随机生成的 48 位十六进制>",
    "pid": 12345,
    "updatedAt": "2026-11-22T15:44:31.709Z"
  }
  ```

## 在 Claude Code 里注册 MCP server

```powershell
claude mcp add -s user dsh-call -- "D:\Scoop\apps\nodejs\current\node.exe" "E:\Repos\dsh-claude-call\mcp\server.mjs"
claude mcp list    # dsh-call 应显示 connected
```

移除：

```powershell
claude mcp remove -s user dsh-call
```

> MCP server 每次调用都会**重新读取** `endpoint.json`，所以 DSH 重启换了端口也不需要改配置。

## 工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `dsh_task` | 新建 DSH 会话并派任务；默认等一会儿拿答复 | `prompt`（必填）、`cwd`、`title`、`agentPreset`、`workspaceId` / `workspacePath` / `workspaceTitle`、`createWorkspace`、`provider` / `model` / `reasoningEffort`、`wait`（默认 true）、`timeoutSeconds`（默认 40） |
| `dsh_send` | 往已有会话追加上下文（可换模型） | `sessionId`、`prompt`、`provider` / `model` / `reasoningEffort`、`wait`、`timeoutSeconds` |
| `dsh_wait` | 等下一轮结束，返回最新答复 | `sessionId`、`sinceSeq`（必填）、`timeoutSeconds`（默认 45） |
| `dsh_status` | 不等待，读运行状态 + 最近答复 | `sessionId` |
| `dsh_cancel` | 取消当前轮（保留队列） | `sessionId` |
| `dsh_sessions` | 列历史会话（默认 20 条，最新在前）：标题、cwd、workspace、模型与推理等级、运行/可续状态 | `sessionId`（只精读这一个）、`limit`、`workspace`（按 id / 标题 / cwd 过滤） |
| `dsh_workspaces` | 列已注册的 workspace（id、标题、路径、会话数） | — |
| `dsh_models` | 列可用模型（按 provider 分组）与各自支持的 `reasoningEffort`，并给出部署默认 | — |
| `dsh_turns` | 逐轮列出一个会话的耗时（最新在前）：每轮时长、起止时刻、结束原因、步数、该轮的提示 | `sessionId`（必填）、`limit`（默认 20） |
| `dsh_schedules` | 列**自动化任务**：不给 `sessionId` 看全机（含已跑完的 `inactive`），给了就看该会话的活动任务 | `sessionId`、`includeInactive` |
| `dsh_schedule_create` | 建自动化任务：默认**新建一个专用会话**承载投递，给 `sessionId` 则绑到已有会话 | `title`（必填，≤120 字）、`prompt`（必填）、时间选择器五选一、`sessionId`、workspace / cwd / `agentPreset` / 模型字段 |
| `dsh_schedule_update` | 改名字 / 指令 / 时间（仅活动任务；`after_seconds` 只能创建时用） | `id`（必填）、`sessionId`、`title`、`prompt`、时间选择器（`at` / `every_seconds` / `daily` / `weekly` / `cron`） |
| `dsh_schedule_delete` | 彻底删除任务（连同已保存的投递记录）；它绑定的会话保留 | `id`（必填）、`sessionId` |
| `dsh_schedule_history` | 看一条任务的投递记录（最新在前） | `id`（必填）、`sessionId`、`limit`（默认 20）、`before` |

等待超时不会失败，而是返回 `status: "running"` 和 `sinceSeq`，让调用方用 `dsh_wait` 续等——
这样不会被 Claude Code 的 MCP 工具超时截断。`sinceSeq` 只统计**在该序号之后结束**的轮次，
所以历史里的旧答复不会被当成新一轮的结果；`dsh_wait` 因此要求必须给 `sinceSeq`（不给就 400），
避免"随便等一轮"把旧答复当答案。

### 会话、workspace 与模型

三件事的语义（对应 DSH 自身的约束）：

- **列会话**：`dsh_sessions` 走 `sessionController.list()` + **会话投影**（`title`、`modelSelection`），
  所以能看到每个会话的标题、cwd、所属 workspace、以及「下一轮会用哪个模型」。DSH 的列表行本身不带
  title / workspace / model，这些全部来自投影；投影缺失（例如刚建、还没发生 `request/header`）时字段为 `null`，
  不会伪造。
- **指定 workspace**：只在**创建**会话时有效。`dsh_task` 可用 `workspaceId`，或用 `workspacePath`
  （配 `createWorkspace: true` 就地注册新 workspace），或用 `workspaceTitle`（须唯一命中）。给了 workspace 就不能
  再给与之不一致的 `cwd`。**已存在的会话不能改挂 workspace**（见「已知限制」），所以 `dsh_send` 带 workspace
  字段会直接返回 `workspace/immutable`。
- **指定模型与推理等级**：`dsh_task` / `dsh_send` 都可以传 `model`、`reasoningEffort`（`provider` 只在不是部署
  默认时才需要）。**不传就完全不动**，沿用 DSH 默认。传了就调用 DSH 原生的
  `sessionController.selectModel()`，它会把这次选择顺带存成**部署默认模型**——这是 DSH 的原生行为，桥不还原、
  不加开关（见「已知限制」）。

### 每轮耗时

`dsh_turns` 回答"这一趟到底跑多久"。两套计时口径都在：

- **轮耗时**（`durationMs`）：来自会话日志里 `turn/start` 与 `turn/end` 两条事件的 `time` 差，也就是模型真正
  干活的时间，和 DSH UI 里看到的是同一段。还没结束的最后一轮按 `open: true` 返回，只给 `elapsedMs`，
  **不计入平均耗时**。
- **桥耗时**（`durationMs`，`dsh_task` / `dsh_send` / `dsh_wait` 的返回里）：从桥收到请求（建会话、选模型、
  排队、等轮次）到本次调用返回的墙钟时间；同时还有 `turnDurationMs` 给出那一轮本身的长度。

时间戳一律取自事件自身，所以桥什么时候被叫醒都不影响统计。冷会话（DSH 重启前建的）会先读一遍持久化日志，
`dsh_turns` 因此给它更宽的 60 秒预算。

### 自动化任务

`dsh_schedule_*` 直接驱动 DSH 宿主的 `ctx.schedule` 服务（就是 DSH「自动化任务」页面管的那批提醒）。
一条任务**绑定恰好一个会话**，到点由宿主把 prompt 投进那个会话——所以"绑到哪"决定了它在哪个目录、
用哪个模型和权限跑、以及运行记录落在哪条日志里。

两种绑定方式：

- **默认：新建专用会话**（`mode: "new-session"`）。桥按 `workspaceId` / `workspacePath` / `cwd` 建一个会话，
  用 `⏰ <标题>` 命名，把任务绑进去，再返回 `sessionId`。这与 DSH 自动化任务页的「新建」流程同形：
  历史隔离、和你的对话并行、清理你的工作会话时不会牵动任务。
- **显式绑定已有会话**（`mode: "session"`，传 `sessionId`）。它继承那个会话的 workspace、模型、
  权限预设与历史上下文，适合"接着这条对话继续"；代价是投递会排进该会话的收件箱（和你自己的输入互相排队），
  而且**归档带活动任务的会话会被 DSH 拒绝**，选择"停止"会删掉它所有活动提醒（取消归档也带不回来）。
  注意 DSH 原生工具只能绑"调用它的那个会话"，桥能跨会话绑定是因为它直接调服务。

请求里的时间选择器**恰好给一个**（`after_seconds` / `at` / `every_seconds` / `daily` / `weekly` / `cron`），
`title` 必填且 ≤120 字。其他需要知道的宿主语义：

- **任务比会话活得久**：`GET /schedules` 走全机 catalog，所以能看到已跑完（`inactive`）或绑定会话已归档的任务。
- **同一会话到期的周期任务会被合并成一条消息**（一个轮次），不是各跑各的。
- **回执 ≠ 执行**：投递记录只证明提醒进了会话收件箱，不证明模型跑了、更不证明跑完了（`dsh_status` 看结果）。
- **不支持暂停 / 立即执行 / 每次运行新建会话**；`after_seconds` 只在创建时有效。
- 投递时若绑定的会话恢复失败（被删、被移走），DSH 保留任务并记一条 warn，**没有自动重试定时器**：要等下一次
  任务管理操作、别的计划唤醒或宿主重启才会再试。
- 需要人工审批的自动化会一直等人点，桥**不会**替它改权限预设。
- 写操作（建/改/删）可以用配置项 `allowScheduleWrite: false` 整体关掉，读（列表/历史）不受影响。

### 在 Claude Code 里可以这样说

- 「把 `~/repo-x` 里那个失败的测试修一下，交给 DSH 跑」→ 它会调 `dsh_task`，`cwd` 指向仓库。
- 「让 DSH 在后台整理这三份文档，你先继续」→ `dsh_task` + `wait: false`，之后再 `dsh_wait`。
- 「问问 DSH 那个会话进展如何」→ `dsh_status`。
- 「上次让 DSH 弄的那个还差多少？接着让它干」→ `dsh_sessions` 找到那个会话（拿到 `sessionId`），再 `dsh_send`。
- 「这个活放到 worktree-x 那个 workspace 里做，用 glm-5.3 高推理」→ `dsh_workspaces` / `dsh_models` 取 id，
  再 `dsh_task` + `workspaceId` + `model` + `reasoningEffort`。
- 「每天早上九点让 DSH 汇总昨天的会议纪要」→ `dsh_schedule_create`（`daily`，默认给它建专用会话）。
- 「现在都设了哪些定时任务？」→ `dsh_schedules`；「把那条改成八点半」→ `dsh_schedule_update`。

## 配置项

写在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `claude-call` 行，全部可选：

| 键 | 默认值 | 说明 |
|---|---|---|
| `endpointFile` | `<DSH_HOME>/claude-call/endpoint.json` | 发现文件路径 |
| `host` | `127.0.0.1` | 只接受回环地址 |
| `port` | `0` | 0 = 内核分配；固定端口便于排查 |
| `defaultCwd` | 会话默认目录 | 请求不带 `cwd` 时用 |
| `agentPreset` | 部署默认 preset | 新建会话的 Agent preset |
| `waitTimeoutSeconds` | `120` | 单次同步 `wait` 默认预算 |
| `maxWaitSeconds` | `240` | 单次同步 `wait` 硬上限（见「已知限制」第 2 条） |
| `listLimit` | `20` | `GET /sessions` 默认返回条数（上限 200） |
| `allowScheduleWrite` | `true` | 是否允许建 / 改 / 删自动化任务；`false` 时写操作返回 403，读不受影响 |
| `scheduleSessionPrefix` | `⏰ ` | 默认新建的任务会话的标题前缀 |
| `token` | 随机 | 想固定 token（例如写自己的脚本）时用 |

## HTTP 接口（给自己的脚本用）

除 `health` 外都要求请求头 `x-claude-call-token: <endpoint.json 里的 token>`。

| 方法与路径 | 请求体 | 返回 |
|---|---|---|
| `GET /health` | — | `{ok, version, pid, origin, sessions, running}` |
| `GET /sessions` | 查询串 `?limit=&workspace=&sessionId=` | `{ok, count, limit, items: [{sessionId, title, cwd, workspace, model, modelLastUsed?, modelSource, live, running, agentAvailable, blank, updatedAt, parentSessionId?, origin?, archived, resumable}]}` |
| `GET /workspaces` | — | `{ok, defaultCwd, count, items: [{id, title, path, createdAt?, updatedAt?, sessions}]}` |
| `GET /models` | — | `{ok, default, routableProviders, count, groups: [{id, name, models: [{id, name, description?, reasoningEfforts, defaultEffort?}]}], failures}` |
| `GET /turns` | 查询串 `?sessionId=&limit=` | `{ok, sessionId, cwd, count, limit, totalDurationMs, averageDurationMs, pending?: {turn, elapsedMs, ...}, items: [{turn, startedAt, endedAt, durationMs, open, elapsedMs?, reason, steps, prompt}]}`（最新在前） |
| `POST /task` | `{prompt, cwd?, title?, agentPreset?, workspaceId?, workspacePath?, workspaceTitle?, createWorkspace?, provider?, model?, reasoningEffort?, wait?, timeoutSeconds?}` | `{ok, sessionId, title, status, text, turnEndReason, turnDurationMs, durationMs, sinceSeq, requestId, model?, workspace?}` |
| `POST /send` | `{sessionId, prompt, provider?, model?, reasoningEffort?, wait?, timeoutSeconds?}` | 同上（带 workspace 字段则 400 `workspace/immutable`） |
| `POST /wait` | `{sessionId, sinceSeq, timeoutSeconds?}` | `{status: "done" \| "running", text, turnEndReason, turnDurationMs}` |
| `GET /status?sessionId=` | — | `{...会话记录, running, live, lastAssistantText, lastTurnEndReason, seq, sinceSeq}` |
| `POST /cancel` | `{sessionId}` | `{cancelled: true}` |
| `GET /schedules` | 查询串 `?sessionId=&includeInactive=` | `{ok, scope: "all" \| "session", count, items: [{id, kind, title, prompt, scheduledAt, scheduledInMs, sessionId, status, lastDelivery?, …规则字段}]}` |
| `GET /schedules/history` | 查询串 `?id=&sessionId=&limit=&before=` | `{ok, sessionId, id, records: [{scheduledAt, deliveredAt, messageId, prompt?}], retention, earlierRecordsUnavailable, earlierRecordsPruned}` |
| `POST /schedule` | `{title, prompt, <一个时间选择器>, sessionId?, workspaceId?/workspacePath?/workspaceTitle?/createWorkspace?/cwd?, agentPreset?, provider?, model?, reasoningEffort?}` | `{ok, mode: "new-session" \| "session", sessionId, sessionCreated, workspace?, schedule}` |
| `POST /schedule/update` | `{id, sessionId?, title?, prompt?, <一个时间选择器，不能是 after_seconds>}` | `{ok, sessionId, schedule}`；未知 id 404、CAS 冲突 409 |
| `POST /schedule/delete` | `{id, sessionId?}` | `{ok, sessionId, id, deleted: true}`；未知 id 404 |

## 测试

```powershell
cd <本仓库目录>
node test/bridge.test.mjs   # 或 node --test test/
```

测试用一个 stub Cordis 上下文直接挂载插件（含 `ctx.schedule` 替身），覆盖：token 认证、建会话 + 等待 + 取答复、
`wait:false`、`wait`/`status` 一致性、`sinceSeq` 边界、续聊、冷会话（重启后 `send`）与其扫描起点、
旧答复不被当成本轮结果、`sinceSeq` 缺失被拒、未知会话/路由、卸载时删除发现文件，会话发现（workspace / 模型 /
可续状态）、单会话精读、workspace 与模型目录、创建时指定 workspace 与模型、`dsh_send` 拒绝 workspace
字段并换模型、归档与子代理会话的拦截，每轮耗时（桥耗时与轮耗时、逐轮列表、未闭合轮次算 pending、
冷会话从持久化日志读、未知会话 404），以及自动化任务（默认新建专用会话、显式绑定已有会话、标题与时间选择器
校验、归档会话被拒、CAS 改名、`after_seconds` 只能创建时用、写开关、无 schedule 服务的部署、
创建失败时回报已建会话）。共 32 个测试，**不依赖运行中的 DSH**。

沙箱提示：DSH 的沙箱不允许 `node --test` 通过管道 spawn 子进程，直接跑 `node --test test/`
会报 `Error: spawn EPERM`；用上面的**进程内**跑法 `node test/bridge.test.mjs` 即可。

## 已知限制

1. **改插件代码后需要重启 DSH**：DSH 的 Loader/Node 模块缓存不会在 profile 重组时丢弃已加载的
   ESM 模块，所以 `index.js` 的改动只有重启后生效（这是 DSH 的现有行为，不是本插件特有）。
2. **单次同步等待不超过 240 秒**：Node/undici 的 `fetch` 默认在约 300 秒内收不到响应头就会中止，桥把默认
   等待压到 120 秒、硬上限 240 秒；更长的工作请用 `wait: false` 派发，再用 `dsh_status` / `dsh_wait` 轮询。
   用 curl 之类没有该限制的客户端时，可在配置里把 `maxWaitSeconds` 调大。
3. **不代改权限策略**：新会话沿用 DSH 当前的沙箱与审批策略；遇到需要人工 approval 的工具调用，
   会话会等你在 DSH UI 里点确认。桥不会自动提权、不会把 policy 改成 `never`。
4. **没有流式输出**：只返回轮次结束后的最终文本；过程中的工具调用细节去 DSH 会话里看。
5. **单机、单用户**：token 放在本机文件里，同机其他进程理论上可读；这是单人本机场景的取舍。
6. **workspace 在创建时就定格**：DSH 的会话归属由 cwd 的 canonical 路径决定，
   `Workspace.attachSession()` 只接受 cwd 恰好等于 workspace 路径的会话，所以**已存在的会话不能改挂到别的
   workspace**。桥的回应是：`POST /task` 收 workspace 字段，`POST /send` 带这些字段直接返回
   `workspace/immutable`。
7. **指定模型会顺带改 DSH 的全局默认模型**：`sessionController.selectModel()` 除了设置会话模型，还会在后台把
   这次选择存成**部署默认**（DSH 原生行为，且不 await）。桥按约定**不还原、不加开关**；只有显式传了
   `model` / `reasoningEffort` 才会触发，不传就完全不动。
8. **归档会话与子代理会话不能续聊**：归档会话的 prompt 会被接受，但 `agent/pre-step` 会直接拒绝它（表现为
   发得出去、永远推不动）；`origin === 'subagent'` 的会话不允许被 resume。桥现在提前拦截，分别返回
   `session/archived` 与 `session/not-resumable`，并在 `dsh_sessions` 里标出 `archived` 与 `resumable: false`。
9. **每轮耗时的口径**：`dsh_turns` 的时长＝`turn/end.time - turn/start.time`。日志里缺 `turn/start`（例如从更早
   的格式迁移来、或续聊时只看到半轮）时该轮 `durationMs` 为 `null`，桥不猜。fork 出来的会话会带父会话的
   继承前缀，那些轮次也会一起列出。
10. **自动化任务的宿主约束照单全收**：任务绑定唯一会话（默认新建专用会话，给 `sessionId` 才绑已有会话）、
    归档带活动任务的会话会被 DSH 拒绝、同一会话到期的周期任务合并成一条消息、不支持暂停 / 立即执行 /
    每次运行新建会话、投递回执不证明模型执行。详见上面「自动化任务」一节。

## 故障排查

| 现象 | 检查 |
|---|---|
| MCP 报 “DSH bridge is not reachable” | DSH 是否在跑；`~/.dsh/claude-call/endpoint.json` 是否存在；插件行是否启用 |
| HTTP 401 | 请求头 token 与 `endpoint.json` 里的不一致（DSH 重启会换 token，客户端应重读文件） |
| HTTP 404 `session not found` | `sessionId` 拼错，或会话已被删除 |
| HTTP 404 `workspace not found` / `no workspace is registered for …` | workspace id / 路径不对；用 `GET /workspaces` 或 `dsh_workspaces` 看真实 id 与路径；确实要新建就传 `createWorkspace: true` |
| HTTP 400 `workspace/immutable` | 想给已有会话换 workspace：DSH 不支持，只能在 `POST /task` 建会话时指定 |
| HTTP 400 `session/archived` | 会话已归档；先在 DSH UI 里取消归档再续聊 |
| HTTP 400 `session/not-resumable` | 该会话属于子代理，不能在桥里继续，请在 DSH UI 里操作 |
| `dsh_sessions` 里 `model` 是 `null` | 该会话还没有 `request/header`（刚建、还没跑过），DSH 里也没有别的记录；用 `dsh_models` 看默认模型 |
| `status: running` 一直不变 | 会话在等人审批，或任务本身很长；用 `dsh_status` 看，必要时 `dsh_cancel` |
| `dsh_turns` 里 `durationMs` 是 `null` | 该轮日志缺 `turn/start`（迁移来的旧会话，或只看到半轮）；`open: true` 的那轮本来就没有结束时间，看 `elapsedMs` |
| 改了代码没生效 | 重启 DSH Desktop |

## 卸载

```powershell
claude mcp remove -s user dsh-call
# 在 DSH 里用 plugin_manager 移除 bundle：
#   remove_bundle target = dsh-claude-call
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\claude-call"
```

## 目录

```
index.js             Host 插件：回环 HTTP 桥 + 会话编排
mcp/server.mjs       Claude Code 侧无依赖 MCP stdio server
cordis.patch.yml     bundle patch（插入 claude-call 行）
locale/{en,zh}.json  插件管理器的标题与描述
icon.svg             插件图标
test/bridge.test.mjs stub 上下文下的桥集成测试
```
