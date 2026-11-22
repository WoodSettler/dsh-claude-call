# ClaudeCallDSH — 让 Claude Code 在 DSH 里唤起会话并派任务

一个双向自洽的小桥：

- **DSH 侧**：一个 Host 插件（`dsh-claude-call`），在 `127.0.0.1` 上开一个**独立**的回环 HTTP 服务，收到请求后调用
  `ctx.sessionController.create()` 建会话、`prompt()` 投递任务，再从 **会话日志**（唯一真相）里读出 `turn/end`
  和最后一条 `assistant/message` 作为答复。
- **Claude Code 侧**：一个**零依赖**的 MCP stdio server（`mcp/server.mjs`），把桥包装成 5 个工具：
  `dsh_task` / `dsh_send` / `dsh_wait` / `dsh_status` / `dsh_cancel`。

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
    "version": "0.1.0",
    "origin": "http://127.0.0.1:<随机端口>",
    "route": "",
    "token": "<每次启动随机生成的 48 位十六进制>",
    "pid": 12345,
    "updatedAt": "2026-11-22T15:44:31.709Z"
  }
  ```

## 在 Claude Code 里注册 MCP server

```powershell
claude mcp add -s user dsh-call -- "D:\Scoop\apps\nodejs\current\node.exe" "S:\Repos\dshplugin\ClaudeCallDSH\mcp\server.mjs"
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
| `dsh_task` | 新建 DSH 会话并派任务；默认等一会儿拿答复 | `prompt`（必填）、`cwd`、`title`、`agentPreset`、`wait`（默认 true）、`timeoutSeconds`（默认 40） |
| `dsh_send` | 往已有会话追加上下文 | `sessionId`、`prompt`、`wait`、`timeoutSeconds` |
| `dsh_wait` | 等下一轮结束，返回最新答复 | `sessionId`、`sinceSeq`（必填）、`timeoutSeconds`（默认 45） |
| `dsh_status` | 不等待，读运行状态 + 最近答复 | `sessionId` |
| `dsh_cancel` | 取消当前轮（保留队列） | `sessionId` |

等待超时不会失败，而是返回 `status: "running"` 和 `sinceSeq`，让调用方用 `dsh_wait` 续等——
这样不会被 Claude Code 的 MCP 工具超时截断。`sinceSeq` 只统计**在该序号之后结束**的轮次，
所以历史里的旧答复不会被当成新一轮的结果；「下一轮还没开始就结束」的边界也已处理。

### 在 Claude Code 里可以这样说

- 「把 `~/repo-x` 里那个失败的测试修一下，交给 DSH 跑」→ 它会调 `dsh_task`，`cwd` 指向仓库。
- 「让 DSH 在后台整理这三份文档，你先继续」→ `dsh_task` + `wait: false`，之后再 `dsh_wait`。
- 「问问 DSH 那个会话进展如何」→ `dsh_status`。

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
| `maxWaitSeconds` | `240` | 单次同步 `wait` 硬上限（见下方说明） |
| `token` | 随机 | 想固定 token（例如写自己的脚本）时用 |

## HTTP 接口（给自己的脚本用）

除 `health` 外都要求请求头 `x-claude-call-token: <endpoint.json 里的 token>`。

| 方法与路径 | 请求体 | 返回 |
|---|---|---|
| `GET /health` | — | `{ok, version, pid, origin, sessions, running}` |
| `POST /task` | `{prompt, cwd?, title?, agentPreset?, wait?, timeoutSeconds?}` | `{ok, sessionId, title, status, text, turnEndReason, sinceSeq, requestId}` |
| `POST /send` | `{sessionId, prompt, wait?, timeoutSeconds?}` | 同上 |
| `POST /wait` | `{sessionId, sinceSeq, timeoutSeconds?}` | `{status: "done" \| "running", text, turnEndReason}` |
| `GET /status?sessionId=` | — | `{running, live, lastAssistantText, lastTurnEndReason, sinceSeq}` |
| `POST /cancel` | `{sessionId}` | `{cancelled: true}` |

## 测试

```powershell
cd S:\Repos\dshplugin\ClaudeCallDSH
node test/bridge.test.mjs
```

测试用一个 stub Cordis 上下文直接挂载插件，覆盖：token 认证、建会话 + 等待 + 取答复、`wait:false`、
`wait`/`status` 一致性、续聊、冷会话（重启后 `send`）、`sinceSeq` 边界、未知会话/路由、卸载时删除发现文件。
**不依赖运行中的 DSH**。

## 已知限制

1. **改插件代码后需要重启 DSH**：DSH 的 Loader/Node 模块缓存不会在 profile 重组时丢弃已加载的
   ESM 模块，所以 `index.js` 的改动只有重启后生效（这是 DSH 的现有行为，不是本插件特有）。
2. **单次同步等待不超过 240 秒**：Node/undici 的 `fetch` 默认在约 300 秒内收不到响应头就会中止，
   桥把默认等待压到 120 秒、硬上限 240 秒；更长的工作请用 `wait:false` 派发，再用 `dsh_status` /
   `dsh_wait` 轮询。用 curl 之类没有该限制的客户端时，可在配置里把 `maxWaitSeconds` 调大。
3. **不代改权限策略**：新会话沿用 DSH 当前的沙箱与审批策略；遇到需要人工 approval 的工具调用，
   会话会等你在 DSH UI 里点确认。桥不会自动提权、不会把 policy 改成 `never`。
4. **没有流式输出**：只返回轮次结束后的最终文本；过程中的工具调用细节去 DSH 会话里看。
5. **单机、单用户**：token 放在本机文件里，同机其他进程理论上可读；这是单人本机场景的取舍。

## 故障排查

| 现象 | 检查 |
|---|---|
| MCP 报 “DSH bridge is not reachable” | DSH 是否在跑；`~/.dsh/claude-call/endpoint.json` 是否存在；插件行是否启用 |
| HTTP 401 | 请求头 token 与 `endpoint.json` 里的不一致（DSH 重启会换 token，客户端应重读文件） |
| HTTP 404 `session not found` | `sessionId` 拼错，或会话已被删除/归档 |
| `status: running` 一直不变 | 会话在等人审批，或任务本身很长；用 `dsh_status` 看，必要时 `dsh_cancel` |
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
