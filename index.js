/**
 * dsh-claude-call — a loopback HTTP bridge that lets an external process
 * (Claude Code through `mcp/server.mjs`) wake a DSH session, hand it a task,
 * and read the answer back.
 *
 * Design notes
 * - The bridge owns no state: every request is answered from the live Session
 *   log, which is the only source of truth (see Harness plugin practices).
 * - It owns a private listener on 127.0.0.1 (ephemeral port by default) instead
 *   of a route on the Web GUI server: DSH Desktop fences its own server with a
 *   renderer capability, and a plugin must not impersonate the renderer.
 * - Discovery is a small JSON file written on activation and removed on
 *   disposal, so clients survive DSH restarts and port changes.
 * - Auth is a per-process random token in a header, compared in constant time.
 *
 * Plugin config (all optional, read from the cordis.patch.yml row):
 *   endpointFile         discovery file path (default <DSH_HOME>/claude-call/endpoint.json)
 *   host                 bind address, loopback only (default 127.0.0.1)
 *   port                 bind port, 0 = ephemeral (default 0)
 *   defaultCwd           directory used when a request names none
 *   agentPreset          default Agent preset for spawned sessions
 *   waitTimeoutSeconds   default wait budget (default 120)
 *   maxWaitSeconds       hard cap for one synchronous wait (default 240)
 *   listLimit            default page size for GET /sessions (default 20)
 *   allowScheduleWrite   allow creating/editing/deleting automation tasks (default true)
 *   scheduleSessionPrefix  title prefix for a task's dedicated session (default "⏰ ")
 *   token                fixed token instead of a random per-process one
 *
 * Read-only discovery (GET /sessions, /workspaces, /models, /turns) answers from DSH
 * views and projections only, so a caller can find the session, workspace or
 * model it wants before it dispatches work. The projections supply the session
 * title and the model it is using, which the session header does not carry.
 * GET /turns folds the event log into one row per turn, so a caller can see how
 * long each dispatched turn took (the timestamps are the DSH event times).
 *
 * Automation tasks (GET /schedules, /schedules/history, POST /schedule,
 * /schedule/update, /schedule/delete) drive the host `ctx.schedule` service.
 * A task is bound to exactly one session and delivers its prompt there; by
 * default the bridge creates a dedicated session for it (the same shape DSH's
 * own automation page uses) and only binds to an existing session when the
 * caller names one.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

const NAME = 'claude-call'
const VERSION = '0.3.2'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_ENDPOINT = join(DSH_HOME, 'claude-call', 'endpoint.json')
const BODY_LIMIT = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200
/** Timing selectors DSH accepts on create; exactly one per request. */
const SCHEDULE_SELECTORS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron']
/** `after_seconds` is create-only: DSH has no relative reschedule. */
const SCHEDULE_UPDATE_SELECTORS = ['at', 'every_seconds', 'daily', 'weekly', 'cron']
const SCHEDULE_TITLE_LIMIT = 120

export const name = NAME
/** Every capability this plugin touches; the plugin stays inactive without them. */
export const inject = ['sessionController', 'sessions', 'agents']

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function apply(ctx, config) {
  const options = normalizeOptions(config)
  const token = options.token === '' ? randomBytes(24).toString('hex') : options.token
  let origin = ''
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[${NAME}] ${message}`)
    } catch {
      /* logging is best effort */
    }
  }

  ctx.effect(() => {
    let stopped = false
    const server = createServer((req, res) => {
      void handle(req, res)
    })
    server.on('clientError', (_error, socket) => {
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    })
    server.on('error', (error) => log(`listener error: ${describe(error)}`))
    server.listen(options.port, options.host, () => {
      if (stopped) return
      const address = server.address()
      if (address === null || typeof address === 'string') {
        log('listener reported no TCP address')
        return
      }
      origin = `http://${options.host}:${address.port}`
      publishEndpoint(origin).catch((error) => log(`endpoint file not published: ${describe(error)}`))
      log(`listening on ${origin} (v${VERSION}, pid ${process.pid})`)
    })

    async function publishEndpoint(listenOrigin) {
      const payload = {
        schema: 1,
        name: NAME,
        version: VERSION,
        origin: listenOrigin,
        route: '',
        token,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
      }
      await mkdir(dirname(options.endpointFile), { recursive: true })
      const temporary = `${options.endpointFile}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, options.endpointFile)
      log(`endpoint published: ${options.endpointFile}`)
    }

    async function unpublishEndpoint() {
      try {
        const current = JSON.parse(await readFile(options.endpointFile, 'utf8'))
        // Only remove the file this activation wrote, never a newer instance's.
        if (current?.token !== token) return
        await rm(options.endpointFile, { force: true })
        log('endpoint removed')
      } catch {
        /* a missing or unreadable file needs no cleanup */
      }
    }

    return async () => {
      stopped = true
      server.closeAllConnections?.()
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
      })
      await unpublishEndpoint()
    }
  })

  log(`ready: endpoint ${options.endpointFile}, default cwd ${options.defaultCwd || '(session default)'}`)

  // ------------------------------------------------------------------ routing

  async function handle(req, res) {
    try {
      if (!authorized(req)) {
        respond(res, 401, { ok: false, error: 'unauthorized: missing or wrong x-claude-call-token' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname.replace(/\/+$/, '') || '/'
      const key = `${req.method ?? 'GET'} ${path}`

      switch (key) {
        case 'GET /health':
          return respond(res, 200, health())
        case 'POST /task':
          return respond(res, 200, await task(await readJson(req)))
        case 'POST /send':
          return respond(res, 200, await send(await readJson(req)))
        case 'POST /wait':
          return respond(res, 200, await wait(await readJson(req)))
        case 'POST /cancel':
          return respond(res, 200, cancel(await readJson(req)))
        case 'GET /status':
          return respond(res, 200, await status(url.searchParams.get('sessionId')))
        case 'GET /sessions':
          return respond(res, 200, await sessions(url.searchParams))
        case 'GET /workspaces':
          return respond(res, 200, workspaces())
        case 'GET /models':
          return respond(res, 200, await models())
        case 'GET /turns':
          return respond(res, 200, await turns(url.searchParams))
        case 'GET /schedules':
          return respond(res, 200, await schedules(url.searchParams))
        case 'GET /schedules/history':
          return respond(res, 200, await scheduleHistory(url.searchParams))
        case 'POST /schedule':
          return respond(res, 200, await scheduleCreate(await readJson(req)))
        case 'POST /schedule/update':
          return respond(res, 200, await scheduleUpdate(await readJson(req)))
        case 'POST /schedule/delete':
          return respond(res, 200, await scheduleDelete(await readJson(req)))
        default:
          return respond(res, 404, { ok: false, error: `unknown route: ${key}` })
      }
    } catch (error) {
      const outcome = error instanceof HttpError ? error.status : 500
      log(`${req.method} ${req.url} failed (${outcome}): ${describe(error)}`)
      return respond(res, outcome, { ok: false, error: describe(error) })
    }
  }

  function health() {
    const live = ctx.sessions.list()
    return {
      ok: true,
      name: NAME,
      version: VERSION,
      pid: process.pid,
      origin,
      sessions: live.length,
      running: live.filter((session) => ctx.agents.get(session.id)?.status === 'running').length,
    }
  }

  // -------------------------------------------------------------- operations

  async function task(body) {
    const startedAt = Date.now()
    const prompt = requireText(body?.prompt, 'prompt')
    const target = await resolveWorkspaceTarget(body)
    const preset = optionalText(body?.agentPreset) ?? options.agentPreset
    const title = optionalText(body?.title) ?? titleFor(prompt)
    const sessionId = await createSession({ cwd: target.cwd, preset, title, workspace: target.workspace })
    // 只有显式给了 model/provider/reasoningEffort 才切换；否则沿用 DSH 的部署默认。
    const model = await applyModel(sessionId, body)
    const scanFrom = currentSeq(sessionId)
    const requestId = newRequestId()
    await admit(sessionId, prompt, requestId)
    // 本轮可能在本行之前就已落下 turn/end，上报的 sinceSeq 必须把它覆盖住。
    const sinceSeq = Math.max(scanFrom, currentSeq(sessionId) - 1)
    return finish({
      sessionId,
      title,
      scanFrom,
      sinceSeq,
      requestId,
      body,
      wait: body?.wait !== false,
      model,
      workspace: target.workspace,
      startedAt,
    })
  }

  async function send(body) {
    const startedAt = Date.now()
    const sessionId = requireId(body?.sessionId)
    const prompt = requireText(body?.prompt, 'prompt')
    rejectWorkspaceFields(body)
    const { header, nextSeq } = await describeSession(sessionId)
    assertResumable(sessionId, header)
    const model = await applyModel(sessionId, body)
    const requestId = newRequestId()
    await admit(sessionId, prompt, requestId)
    const sinceSeq = Math.max(nextSeq, currentSeq(sessionId) - 1)
    const title = optionalText(body?.title) ?? ''
    return finish({ sessionId, title, scanFrom: nextSeq, sinceSeq, requestId, body, wait: body?.wait !== false, model, startedAt })
  }

  async function finish({ sessionId, title, scanFrom, sinceSeq, requestId, body, wait, model, workspace, startedAt }) {
    const base = {
      ok: true,
      sessionId,
      ...(title === '' ? {} : { title }),
      sinceSeq,
      requestId,
      origin,
      ...(model === undefined || model === null ? {} : { model }),
      ...(workspace === undefined ? {} : { workspace: workspaceView(workspace) }),
    }
    // 桥侧墙钟耗时：从收到请求（建会话、选模型、等轮次）到此刻。
    const elapsed = () => Date.now() - startedAt
    if (!wait) return { ...base, status: 'dispatched', text: '', turnEndReason: null, durationMs: elapsed() }
    const limitMs = waitBudget(body?.timeoutSeconds) * 1000
    const outcome = await waitForTurn(sessionId, { requestId, afterSeq: scanFrom }, limitMs)
    return { ...base, ...outcome, durationMs: elapsed() }
  }

  async function wait(body) {
    const sessionId = requireId(body?.sessionId)
    await knownHeader(sessionId)
    const rawSinceSeq = body?.sinceSeq
    // 不给起点就等着"下一轮"，很容易把历史里的旧答复当成答案，所以直接拒掉。
    if (typeof rawSinceSeq !== 'number' || !Number.isFinite(rawSinceSeq)) {
      throw new HttpError(400, 'sinceSeq is required: pass the sinceSeq returned by dsh_task or dsh_status')
    }
    const limitMs = waitBudget(body?.timeoutSeconds) * 1000
    const outcome = await waitForTurn(sessionId, { requestId: '', afterSeq: rawSinceSeq }, limitMs)
    return { ok: true, sessionId, sinceSeq: rawSinceSeq, ...outcome }
  }

  function cancel(body) {
    const sessionId = requireId(body?.sessionId)
    ctx.sessionController.cancel({ sessionId })
    return { ok: true, sessionId, cancelled: true }
  }

  // ------------------------------------------------------- read-only discovery

  /**
   * GET /sessions：列出会话。
   * 默认只读一次 sessionController.list()（它已经带全量投影，零额外 I/O）；
   * 只有点名 sessionId 时才做单会话精读，避免为每一行去翻冷会话日志。
   */
  async function sessions(params) {
    const sessionId = optionalText(params.get('sessionId'))
    // 单会话精读：projections() 拿不到值（例如从没落过投影缓存的会话）时，
    // 用列表行自带的投影提示兜底，至少不让 title/model 无故消失。
    const summaries = sessionRows(await listSessions())
    if (sessionId !== undefined) {
      const header = await knownHeader(sessionId)
      const row = summaries.find((candidate) => String(candidate?.sessionId) === String(sessionId))
      const hints = (await readProjections(sessionId)) ?? row?.projections
      return {
        ok: true,
        origin,
        items: [
          sessionRecord({
            sessionId,
            hints,
            row,
            header,
            live: ctx.sessions.get(sessionId),
            agent: ctx.agents.get(sessionId),
            archived: archivedIds(),
          }),
        ],
      }
    }
    const limit = clampNumber(params.get('limit'), options.listLimit, 1, MAX_LIST_LIMIT)
    const filter = optionalText(params.get('workspace'))
    const archived = archivedIds()
    const items = []
    for (const row of summaries) {
      if (row?.sessionId === undefined) continue
      const record = sessionRecord({
        sessionId: row.sessionId,
        hints: row.projections,
        row,
        // 列表行不告诉你会话是否还挂在宿主里；两个 map 查一下就能给出准确的 live/running。
        live: ctx.sessions.get(row.sessionId),
        agent: ctx.agents.get(row.sessionId),
        archived,
      })
      // workspace 过滤同时接受 id、标题与 cwd，调用方按哪种口径收敛都能命中。
      if (
        filter !== undefined &&
        record.workspace?.id !== filter &&
        record.workspace?.title !== filter &&
        record.cwd !== filter
      ) {
        continue
      }
      items.push(record)
    }
    items.sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
    return { ok: true, origin, count: items.length, limit, items: items.slice(0, limit) }
  }

  async function listSessions() {
    try {
      return await ctx.sessionController.list({}, liveSignal())
    } catch (error) {
      throw new HttpError(500, `DSH could not list sessions: ${describe(error)}`)
    }
  }

  /** GET /workspaces：列出已注册的 workspace（durable 顺序，与 DSH 界面一致）。 */
  function workspaces() {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new HttpError(503, 'this DSH deployment has no workspace registry')
    let entries
    try {
      entries = registry.list()
    } catch (error) {
      throw new HttpError(500, `DSH could not list workspaces: ${describe(error)}`)
    }
    return {
      ok: true,
      origin,
      defaultCwd: ctx.get('workingDirectory')?.defaultDirectory ?? null,
      count: entries.length,
      items: entries.map((workspace) => ({
        id: String(workspace.id),
        title: workspace.title ?? null,
        path: workspace.path ?? null,
        ...(workspace.createdAt === undefined ? {} : { createdAt: workspace.createdAt }),
        ...(workspace.updatedAt === undefined ? {} : { updatedAt: workspace.updatedAt }),
        // sessionIds 已由 DSH 按 canonical cwd 过滤，这里只是计数。
        sessions: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
      })),
    }
  }

  /** GET /models：列出可选模型与各自支持的推理等级，并给出部署默认。 */
  async function models() {
    let catalog
    try {
      catalog = await ctx.sessionController.modelCatalog()
    } catch (error) {
      throw new HttpError(500, `DSH could not read the model catalog: ${describe(error)}`)
    }
    const groups = catalog?.groups ?? []
    return {
      ok: true,
      origin,
      default: modelView(catalog?.default) ?? null,
      routableProviders: catalog?.routableProviders ?? [],
      count: groups.reduce((total, group) => total + (group.models?.length ?? 0), 0),
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name ?? null,
        models: (group.models ?? []).map((entry) => ({
          id: entry.id,
          name: entry.name ?? null,
          ...(entry.description === undefined ? {} : { description: entry.description }),
          reasoningEfforts: (entry.reasoning?.efforts ?? []).map((effort) => effort.id),
          ...(entry.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: entry.reasoning.defaultEffort }),
        })),
      })),
      failures: catalog?.failures ?? [],
    }
  }

  /**
   * GET /turns：逐轮给出耗时。
   * 时间戳一律取自事件自身的 time（DSH 落日志的毫秒数），所以同一轮在 DSH UI 里
   * 与这里看到的是同一段时间，不受桥进程何时被叫醒影响。
   */
  async function turns(params) {
    const sessionId = requireId(params.get('sessionId'))
    const limit = clampNumber(params.get('limit'), options.listLimit, 1, MAX_LIST_LIMIT)
    const header = await knownHeader(sessionId)
    const records = foldTurns(await readTimeline(sessionId))
    const closed = records.filter((record) => record.open !== true && typeof record.durationMs === 'number')
    const totalDurationMs = closed.reduce((total, record) => total + record.durationMs, 0)
    const pending = records.at(-1)?.open === true ? records.at(-1) : undefined
    return {
      ok: true,
      origin,
      sessionId,
      cwd: header?.cwd ?? null,
      count: records.length,
      limit,
      totalDurationMs,
      averageDurationMs: closed.length === 0 ? null : Math.round(totalDurationMs / closed.length),
      // 末尾未闭合的轮次正在跑，单列出来，别混进平均耗时。
      ...(pending === undefined ? {} : { pending }),
      items: records.slice(-limit).reverse(),
    }
  }

  /** 取一份按 seq 升序的事件列表：live 会话读内存日志，冷会话读持久化前缀。 */
  async function readTimeline(sessionId) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const head = Number(live.seq)
      const events = []
      for (let seq = 0; seq < head; seq++) {
        const event = live.eventAt(seq)
        if (event !== undefined) events.push(event)
      }
      return events
    }
    const inspected = await inspectSession(sessionId)
    return [...(inspected?.events ?? [])].sort((left, right) => Number(left?.seq ?? 0) - Number(right?.seq ?? 0))
  }

  /**
   * 把事件折叠成"每轮一条"：turn/start 记开始时间，turn/end 记结束并算差。
   * DSH 的 user/message 不带轮次号，所以每轮的提示取该轮开始前最后一条人工消息。
   * 末尾没有 turn/end 的轮次按 open 返回，给 elapsedMs，不混进平均耗时。
   */
  function foldTurns(events) {
    const records = []
    let prompt = ''
    let open
    for (const event of events) {
      if (event?.type === 'user/message') {
        const source = event.data?.source ?? event.data?.message?.source
        if (source?.kind === 'user') prompt = textOfMessage(event.data?.message ?? event.data)
        continue
      }
      if (event?.type === 'turn/start') {
        open = {
          turn: Number(event.data?.turn ?? records.length + 1),
          startedAt: typeof event.time === 'number' ? event.time : null,
          prompt: prompt === '' ? null : previewText(prompt),
          steps: 0,
        }
        continue
      }
      if (event?.type === 'step/start' && open !== undefined) {
        open.steps += 1
        continue
      }
      if (event?.type === 'turn/end' && open !== undefined) {
        const endedAt = typeof event.time === 'number' ? event.time : null
        records.push({
          ...open,
          endedAt,
          durationMs: endedAt === null || open.startedAt === null ? null : endedAt - open.startedAt,
          open: false,
          reason: event.data?.reason?.kind ?? null,
        })
        open = undefined
      }
    }
    if (open !== undefined) {
      records.push({
        ...open,
        endedAt: null,
        durationMs: null,
        elapsedMs: open.startedAt === null ? null : Date.now() - open.startedAt,
        open: true,
        reason: null,
      })
    }
    return records
  }

  async function status(rawSessionId) {
    const sessionId = requireId(rawSessionId)
    const live = ctx.sessions.get(sessionId)
    const header = await knownHeader(sessionId)
    // 会话头里没有 title/workspace/model，这三项只能来自投影与注册表。
    const record = await sessionRow(sessionId, header)
    if (live !== undefined) {
      const agent = ctx.agents.get(sessionId)
      return {
        ...record,
        ok: true,
        sessionId,
        live: true,
        running: agent?.status === 'running',
        seq: Number(live.seq),
        // sinceSeq 是"最后观测到的序号"：紧接着写入的 turn/end（seq === seq）仍算在它之后。
        sinceSeq: Number(live.seq) - 1,
        ...tailOfSession(live),
      }
    }
    const inspected = await inspectSession(sessionId)
    const lastSeq = inspected?.events?.at(-1)?.seq ?? -1
    return {
      ...record,
      ok: true,
      sessionId,
      live: false,
      running: false,
      seq: lastSeq + 1,
      sinceSeq: lastSeq,
      ...tailOfEvents(inspected?.events),
    }
  }

  // --------------------------------------------------------- automation tasks

  /**
   * 自动化任务（宿主 ctx.schedule 服务）。
   * - 默认新建一个专用会话承载投递，与 DSH 自动化任务页的「新建」流程同形；
   * - 只有调用方显式给 sessionId 时才绑定到已有会话（DSH 原生工具只能绑调用者自己的会话）；
   * - 读（列表 / 目录 / 历史）始终可用，写（新建 / 编辑 / 删除）受 allowScheduleWrite 控制。
   * 注意宿主语义：任务比会话活得久，归档带活动任务的会话会被拒绝；同一会话到期的
   * 周期任务会被合并成一条消息；回执只证明投递进收件箱，不表示模型执行完成。
   */
  async function schedules(params) {
    const service = scheduleService()
    const sessionId = optionalText(params.get('sessionId'))
    const includeInactive = params.get('includeInactive') === 'true'
    try {
      // 单会话默认只列活动任务（与 DSH 的 schedule_list 口径一致）；
      // 要连未运行一起看，走 includeInactive=true 从全机 catalog 里筛。
      if (sessionId !== undefined && !includeInactive) {
        const items = await service.list({ sessionId })
        return {
          ok: true,
          origin,
          scope: 'session',
          sessionId,
          count: items.length,
          items: items.map((record) => scheduleView({ ...record, sessionId, status: 'active' })),
        }
      }
      const entries = await service.catalog()
      const filtered = sessionId === undefined ? entries ?? [] : (entries ?? []).filter((entry) => String(entry.sessionId) === sessionId)
      return {
        ok: true,
        origin,
        scope: sessionId === undefined ? 'all' : 'session',
        ...(sessionId === undefined ? {} : { sessionId }),
        count: filtered.length,
        items: filtered.map(scheduleView),
      }
    } catch (error) {
      throw scheduleError(error)
    }
  }

  async function scheduleHistory(params) {
    const service = scheduleService()
    const id = requireText(params.get('id'), 'id')
    const hint = optionalText(params.get('sessionId'))
    // history 需要 (sessionId, id) 二元组；只给 id 时先从 catalog 反查绑定会话。
    const sessionId = hint ?? (await locateSchedule(id)).sessionId
    const limit = clampNumber(params.get('limit'), 20, 1, 100)
    const before = optionalText(params.get('before'))
    let result
    try {
      result = await service.history({ sessionId, id, limit, ...(before === undefined ? {} : { before }) })
    } catch (error) {
      throw scheduleError(error)
    }
    if (result?.code !== undefined) throw new HttpError(404, `schedule/${result.code}: no delivery history for ${id}`)
    return { ok: true, origin, sessionId, id, ...result }
  }

  async function scheduleCreate(body) {
    assertScheduleWrite()
    const service = scheduleService()
    const title = requireTitle(body?.title)
    const prompt = requireText(body?.prompt, 'prompt')
    const selector = scheduleSelector(body)
    const bindTo = optionalText(body?.sessionId)
    let sessionId = bindTo
    let sessionCreated = false
    let workspace
    if (bindTo === undefined) {
      // 默认路径：给这条任务建一个专用会话。workspace/cwd/model 都沿用 /task 的口径。
      const target = await resolveWorkspaceTarget(body)
      workspace = target.workspace
      const preset = optionalText(body?.agentPreset) ?? options.agentPreset
      sessionId = await createSession({
        cwd: target.cwd,
        preset,
        title: `${options.scheduleSessionPrefix}${title}`.slice(0, SCHEDULE_TITLE_LIMIT),
        workspace: target.workspace,
      })
      sessionCreated = true
      try {
        await applyModel(sessionId, body)
      } catch (error) {
        // 会话已经建出来了：模型选失败也要把它的 id 交出去，别留无声垃圾。
        throw new HttpError(400, `${describe(error)}（已为它建了专用会话 ${sessionId}，可删除或改作他用）`)
      }
    } else {
      rejectWorkspaceFields(body)
      const { header } = await describeSession(bindTo)
      assertResumable(bindTo, header)
    }
    let record
    try {
      record = await service.create(sessionId, { title, prompt, ...selector })
    } catch (error) {
      if (sessionCreated) {
        // 会话已经建出来了，别把它悄悄留下：错误里带上 id，让调用方能收拾。
        throw new HttpError(400, `${describeScheduleRefusal(error)}（已为这条任务建了专用会话 ${sessionId}，可在 DSH 里删除或改作他用）`)
      }
      throw scheduleError(error)
    }
    log(`schedule created ${record?.id} (${record?.kind}) bound to ${sessionId}${sessionCreated ? ' [new session]' : ''}`)
    return {
      ok: true,
      origin,
      mode: sessionCreated ? 'new-session' : 'session',
      sessionId,
      sessionCreated,
      ...(workspace === undefined ? {} : { workspace: workspaceView(workspace) }),
      schedule: scheduleView({ ...record, sessionId, status: 'active' }),
    }
  }

  async function scheduleUpdate(body) {
    assertScheduleWrite()
    const service = scheduleService()
    const id = requireText(body?.id, 'id')
    const title = optionalText(body?.title)
    const prompt = optionalText(body?.prompt)
    const change = scheduleChange(body)
    // update 是整条记录的 compare-and-set：expected 必须是"改前那一刻"的记录，
    // 所以先按 id 把当前记录读出来，绝不接受调用方自带的 expected。
    const entry = await locateSchedule(id, optionalText(body?.sessionId))
    let result
    try {
      result = await service.update({
        sessionId: String(entry.sessionId),
        id,
        expected: scheduleRecordOf(entry),
        ...(change === undefined ? {} : { change }),
        ...(title === undefined ? {} : { title }),
        ...(prompt === undefined ? {} : { prompt }),
      })
    } catch (error) {
      throw scheduleError(error)
    }
    if (result?.updated === true) {
      log(`schedule updated ${id} in ${entry.sessionId}`)
      return {
        ok: true,
        origin,
        sessionId: String(entry.sessionId),
        schedule: scheduleView({ ...result.record, sessionId: String(entry.sessionId), status: 'active' }),
      }
    }
    if (result?.updated === false) {
      // DSH 对"什么都没改"的 no-op 也回 updated:false，但会带上记录且不给错误码；
      // 那是有结果的成功，不是冲突。
      if (result.code === undefined && result.record !== undefined) {
        return {
          ok: true,
          origin,
          sessionId: String(entry.sessionId),
          unchanged: true,
          schedule: scheduleView({ ...result.record, sessionId: String(entry.sessionId), status: 'active' }),
        }
      }
      const code = result.code ?? 'schedule_conflict'
      throw new HttpError(code === 'schedule_not_found' ? 404 : 409, `schedule/${code}: ${id} was not updated`)
    }
    throw scheduleError(result ?? new Error('the schedule service returned no result'))
  }

  async function scheduleDelete(body) {
    assertScheduleWrite()
    const service = scheduleService()
    const id = requireText(body?.id, 'id')
    const entry = await locateSchedule(id, optionalText(body?.sessionId))
    let result
    try {
      result = await service.delete({ sessionId: String(entry.sessionId), id })
    } catch (error) {
      throw scheduleError(error)
    }
    if (result?.deleted !== true) {
      throw new HttpError(404, `schedule/${result?.code ?? 'schedule_not_found'}: ${id} was not deleted`)
    }
    log(`schedule deleted ${id} from ${entry.sessionId}`)
    return { ok: true, origin, sessionId: String(entry.sessionId), id, deleted: true }
  }

  function scheduleService() {
    const service = ctx.get('schedule')
    if (service === undefined) throw new HttpError(503, 'this DSH deployment has no schedule service')
    return service
  }

  function assertScheduleWrite() {
    if (!options.allowScheduleWrite) {
      throw new HttpError(403, 'schedule writes are disabled here: set allowScheduleWrite: true in the claude-call plugin config')
    }
  }

  /**
   * 一条任务只带 id 时反查它的绑定会话：catalog 是全机视图（含未运行任务），
   * 正好用来定位；list 只能按会话查，做不到这一步。
   */
  async function locateSchedule(id, sessionIdHint) {
    const service = scheduleService()
    let entries
    try {
      entries = await service.catalog()
    } catch (error) {
      throw scheduleError(error)
    }
    const entry = (entries ?? []).find(
      (candidate) => String(candidate.id) === id && (sessionIdHint === undefined || String(candidate.sessionId) === sessionIdHint),
    )
    if (entry === undefined) {
      throw new HttpError(
        404,
        `schedule/schedule_not_found: no task ${id}${sessionIdHint === undefined ? '' : ` in session ${sessionIdHint}`}`,
      )
    }
    return entry
  }

  /** catalog 条目 = 记录 + 宿主附加字段；update 的 expected 只接受纯记录。 */
  function scheduleRecordOf(entry) {
    const { sessionId: _sessionId, status: _status, lastDelivery: _lastDelivery, deliveryHistory: _history, ...record } = entry
    return record
  }

  function scheduleView(entry) {
    if (entry === undefined || entry === null) return null
    const view = scheduleRecordOf(entry)
    if (entry.sessionId !== undefined) view.sessionId = String(entry.sessionId)
    if (entry.status !== undefined) view.status = entry.status
    if (entry.lastDelivery !== undefined) view.lastDelivery = entry.lastDelivery
    const at = Date.parse(view.scheduledAt ?? '')
    if (Number.isFinite(at)) view.scheduledInMs = Math.max(0, at - Date.now())
    return view
  }

  function scheduleSelector(body) {
    const present = SCHEDULE_SELECTORS.filter((key) => body?.[key] !== undefined && body?.[key] !== null)
    if (present.length === 0) {
      throw new HttpError(400, `a schedule needs exactly one timing selector: ${SCHEDULE_SELECTORS.join(', ')}`)
    }
    if (present.length > 1) {
      throw new HttpError(400, `a schedule takes exactly one timing selector, got ${present.join(' + ')}`)
    }
    return { [present[0]]: body[present[0]] }
  }

  /** 把 create 用的同一套选择器名翻译成宿主 update 的 ScheduleTimingChange。 */
  function scheduleChange(body) {
    if (body?.after_seconds !== undefined) {
      throw new HttpError(400, 'after_seconds is create-only; reschedule with at / every_seconds / daily / weekly / cron')
    }
    const present = SCHEDULE_UPDATE_SELECTORS.filter((key) => body?.[key] !== undefined && body?.[key] !== null)
    if (present.length === 0) return undefined
    if (present.length > 1) {
      throw new HttpError(400, `a reschedule takes exactly one timing selector, got ${present.join(' + ')}`)
    }
    const key = present[0]
    if (key === 'every_seconds') return { kind: 'every', every_seconds: body.every_seconds }
    return { kind: key, [key]: body[key] }
  }

  function requireTitle(value) {
    const title = optionalText(value)
    if (title === undefined) throw new HttpError(400, 'title must be a non-empty string')
    if (title.length > SCHEDULE_TITLE_LIMIT) {
      throw new HttpError(400, `title must be at most ${SCHEDULE_TITLE_LIMIT} characters (DSH limit)`)
    }
    return title
  }

  function describeScheduleRefusal(error) {
    const code = typeof error?.code === 'string' ? `schedule/${error.code}: ` : ''
    return `${code}${error instanceof Error ? error.message : String(error)}`
  }

  /** 服务用错误码（invalid_prompt / not_future / frequency_too_high / …）原样带给调用方。 */
  function scheduleError(error) {
    if (error instanceof HttpError) return error
    const message = error instanceof Error ? error.message : String(error)
    const code = typeof error?.code === 'string' ? error.code : undefined
    return new HttpError(400, code === undefined ? `DSH refused the schedule operation: ${message}` : `schedule/${code}: ${message}`)
  }

  // ------------------------------------------------------------ session work

  async function knownHeader(sessionId) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) return live.header
    return (await inspectSession(sessionId)).meta
  }

  /**
   * /send 需要三样东西：会话头（判断能不能续聊）、续聊扫描起点 nextSeq。
   * 冷会话只 inspect 一次就全拿到；nextSeq 取"下一个事件将用的序号"=旧日志长度，
   * 这样 resume 之后只扫新事件，也不会把整份历史重读一遍
   * （冷会话的 currentSeq() 是 -1，用它当起点会让游标回落到 0）。
   */
  async function describeSession(sessionId) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) return { live: true, header: live.header, nextSeq: Number(live.seq) }
    const inspected = await inspectSession(sessionId)
    const lastSeq = inspected?.events?.at(-1)?.seq
    return { live: false, header: inspected.meta, nextSeq: (lastSeq ?? -1) + 1 }
  }

  async function inspectSession(sessionId) {
    try {
      return await ctx.sessionController.inspect(sessionId)
    } catch (error) {
      throw new HttpError(404, `session not found: ${sessionId} (${describe(error)})`)
    }
  }

  async function createSession({ cwd, preset, title, workspace }) {
    const presetField = preset === '' ? {} : { agentPreset: preset }
    // 没有显式指定 workspace 时，仍按 cwd 找已注册的 workspace（原有行为）。
    const target = workspace ?? (await findWorkspace(cwd))
    let created
    try {
      created = await ctx.sessionController.create(
        target === undefined ? { ...presetField, cwd } : { ...presetField, workspaceId: target.id },
      )
    } catch (error) {
      if (target === undefined) throw new HttpError(400, `failed to create a DSH session: ${describe(error)}`)
      // The workspace may reject the attach; fall back to a plain cwd session.
      log(`session not attached to workspace ${target.id ?? target.path}: ${describe(error)}`)
      created = await ctx.sessionController.create({ ...presetField, cwd })
    }
    const sessionId = String(created.sessionId)
    if (title !== '') {
      try {
        await ctx.sessionController.rename({ sessionId, title })
      } catch (error) {
        log(`session ${sessionId} created without a title: ${describe(error)}`)
      }
    }
    return sessionId
  }

  async function admit(sessionId, text, requestId) {
    const abort = new AbortController()
    try {
      return await ctx.sessionController.prompt(
        { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
        abort.signal,
      )
    } catch (error) {
      throw new HttpError(409, `DSH refused the prompt: ${describe(error)}`)
    }
  }

  /**
   * Wait for the turn that carries `requestId` (or any turn after `afterSeq`)
   * to end. Reads the live Session log only; the durable log is truth.
   */
  async function waitForTurn(sessionId, { requestId, afterSeq }, limitMs) {
    const state = { requestId, afterSeq, messageSeq: -1, endSeq: -1, reason: undefined, text: '', turnStartAt: -1, turnMs: null }
    const deadline = Date.now() + limitMs
    let cursor = afterSeq >= 0 ? afterSeq : 0
    for (;;) {
      const session = ctx.sessions.get(sessionId)
      if (session !== undefined) {
        const head = Number(session.seq)
        if (head > cursor) {
          scan(session, cursor, head, state)
          cursor = head
        }
      }
      if (state.endSeq >= 0) break
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(300, Math.max(50, remaining)))
    }
    return {
      status: state.endSeq >= 0 ? 'done' : 'running',
      text: state.text,
      turnEndReason: state.reason?.kind ?? null,
      turnDurationMs: state.turnMs,
    }
  }

  function scan(session, from, to, state) {
    for (let seq = from; seq < to; seq++) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (event.type === 'user/message') {
        const rpcId = event.data?.source?.rpcId ?? event.data?.message?.source?.rpcId
        if (state.requestId !== '' && state.messageSeq < 0 && rpcId === state.requestId) {
          state.messageSeq = seq
        }
      } else if (event.type === 'assistant/message') {
        // 只认本次 prompt（或调用方给的游标）之后产出的文本：resume 过的会话会把整份
        // 历史重新喂给 scan()，旧答复不能当成本轮结果。
        const lower = state.requestId !== '' ? state.messageSeq : state.afterSeq
        if (lower < 0 || seq <= lower) continue
        const text = textOfMessage(event.data?.message)
        if (text !== '') state.text = text
      } else if (event.type === 'turn/start') {
        // 记下本轮开始时间，turn/end 到来时就能算出这一轮的模型耗时。
        if (typeof event.time === 'number') state.turnStartAt = event.time
      } else if (event.type === 'turn/end') {
        if (state.endSeq >= 0) continue
        if (state.requestId !== '') {
          if (state.messageSeq < 0 || seq <= state.messageSeq) continue
        } else if (seq <= state.afterSeq) {
          continue
        }
        state.endSeq = seq
        state.reason = event.data?.reason
        if (state.turnStartAt >= 0 && typeof event.time === 'number') state.turnMs = event.time - state.turnStartAt
      }
    }
  }

  function tailOfSession(session) {
    let text = ''
    let reason
    for (let seq = Number(session.seq) - 1; seq >= 0; seq--) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      if (text === '' && event.type === 'assistant/message') text = textOfMessage(event.data?.message)
      if (reason === undefined && event.type === 'turn/end') reason = event.data?.reason?.kind ?? 'unknown'
      if (text !== '' && reason !== undefined) break
    }
    return { lastAssistantText: text, lastTurnEndReason: reason ?? null }
  }

  function tailOfEvents(events) {
    let text = ''
    let reason
    for (let index = (events?.length ?? 0) - 1; index >= 0; index--) {
      const event = events[index]
      if (text === '' && event?.type === 'assistant/message') text = textOfMessage(event.data?.message)
      if (reason === undefined && event?.type === 'turn/end') reason = event.data?.reason?.kind ?? 'unknown'
      if (text !== '' && reason !== undefined) break
    }
    return { lastAssistantText: text, lastTurnEndReason: reason ?? null }
  }

  // --------------------------------------------------------------- utilities

  function currentSeq(sessionId) {
    const session = ctx.sessions.get(sessionId)
    return session === undefined ? -1 : Number(session.seq)
  }

  async function findWorkspace(cwd) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    try {
      return await registry.resolveByPath(cwd)
    } catch {
      return undefined
    }
  }

  /**
   * 解析 POST /task 的 workspace 目标：显式 workspace 优先，其次 cwd。
   * 优先级 workspaceId > workspacePath > workspaceTitle；workspacePath 可配
   * createWorkspace=true 就地注册一个新 workspace。
   */
  async function resolveWorkspaceTarget(body) {
    const workspaceId = optionalText(body?.workspaceId)
    const workspacePath = optionalText(body?.workspacePath)
    const workspaceTitle = optionalText(body?.workspaceTitle)
    const createWorkspace = body?.createWorkspace === true
    const cwd = body?.cwd === undefined ? undefined : await resolveDirectory(body.cwd)
    if (workspaceId === undefined && workspacePath === undefined && workspaceTitle === undefined) {
      return { workspace: undefined, cwd: cwd ?? (await resolveDirectory(undefined)) }
    }
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new HttpError(503, 'this DSH deployment has no workspace registry')
    let workspace
    if (workspaceId !== undefined) {
      workspace = registry.get(workspaceId)
      if (workspace === undefined) throw new HttpError(404, `workspace not found: ${workspaceId}`)
    } else if (workspacePath !== undefined) {
      const absolute = await resolveDirectory(workspacePath)
      workspace = await findWorkspace(absolute)
      if (workspace === undefined && createWorkspace) {
        try {
          workspace = workspaceTitle === undefined ? await registry.create(absolute) : await registry.create(absolute, workspaceTitle)
        } catch (error) {
          throw new HttpError(400, `DSH could not create the workspace: ${describe(error)}`)
        }
      }
      if (workspace === undefined) {
        throw new HttpError(404, `no workspace is registered for ${absolute}: pass createWorkspace: true to create one`)
      }
    } else {
      const matches = registry.list().filter((entry) => entry.title === workspaceTitle)
      if (matches.length === 0) throw new HttpError(404, `no workspace is titled "${workspaceTitle}"`)
      if (matches.length > 1) throw new HttpError(409, `workspace title is ambiguous: "${workspaceTitle}"`)
      workspace = matches[0]
    }
    if (cwd !== undefined && normalizePath(cwd) !== normalizePath(workspace.path)) {
      throw new HttpError(400, `cwd and workspace disagree: "${cwd}" is not "${workspace.path}"`)
    }
    return { workspace, cwd: workspace.path }
  }

  /**
   * 把请求里的 provider/model/reasoningEffort 落到会话上（selectModel）。
   * 三样都没给就完全不动，保持“不指定即默认”。注意 DSH 的 selectModel 会把
   * 这次选择顺带存成部署默认，这是它的原生行为，本插件不还原、不加开关。
   */
  async function applyModel(sessionId, body) {
    const provider = optionalText(body?.provider)
    const model = optionalText(body?.model)
    const reasoningEffort = optionalText(body?.reasoningEffort)
    if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined
    const current = modelView(currentSelection())
    const selection = { provider: provider ?? current?.provider, model: model ?? current?.model }
    const effort = reasoningEffort ?? current?.reasoningEffort
    if (effort !== undefined && effort !== null) selection.reasoningEffort = effort
    if (selection.provider === undefined || selection.model === undefined) {
      throw new HttpError(400, 'model selection needs a model: pass model, and provider when it is not the deployment default')
    }
    try {
      const value = await ctx.sessionController.selectModel({ sessionId, ...selection })
      return modelView(value?.selected) ?? selection
    } catch (error) {
      throw new HttpError(400, `DSH refused the model selection: ${describe(error)}`)
    }
  }

  /** /send 不接受 workspace 字段：会话的 workspace 在创建时就固定了。 */
  function rejectWorkspaceFields(body) {
    for (const field of ['workspaceId', 'workspacePath', 'workspaceTitle', 'createWorkspace']) {
      if (body?.[field] !== undefined) {
        throw new HttpError(
          400,
          `workspace/immutable: a session keeps the workspace it was created in; "${field}" is only accepted by POST /task`,
        )
      }
    }
  }

  /**
   * 归档会话与子代理会话都推不动：前者被 agent/pre-step 拒绝，后者不允许被
   * resume。提前给出明确错误，避免调用方发出提示后一直等到超时。
   */
  function assertResumable(sessionId, header) {
    if (header?.origin === 'subagent') {
      throw new HttpError(400, `session/not-resumable: "${sessionId}" belongs to a subagent and cannot be continued from here`)
    }
    if (isArchived(sessionId)) {
      throw new HttpError(400, `session/archived: "${sessionId}" is archived; unarchive it in DSH before sending another prompt`)
    }
  }

  /**
   * 把列表行与单会话精读折叠成同一个会话形状，避免两处口径漂移。
   * model 取投影的 next（该会话下一次请求会用的模型），与 lastUsed 不同时
   * 另带 modelLastUsed；投影缺失时两项都为 null，modelSource 为 unknown。
   */
  function sessionRecord({ sessionId, hints, row, header, live, agent, archived }) {
    const values = hints?.values ?? {}
    const selection = values.modelSelection
    const lastUsed = modelView(selection?.lastUsed)
    const next = modelView(selection?.next)
    const cwd = row?.cwd ?? header?.cwd ?? null
    const workspace = workspaceOfPath(cwd)
    const origin = row?.origin ?? header?.origin
    const parentSessionId = row?.parentSessionId ?? header?.parentSession
    const flagged = archived.has(String(sessionId))
    return {
      sessionId: String(sessionId),
      title: typeof values.title === 'string' && values.title !== '' ? values.title : null,
      cwd,
      workspace: workspace === undefined ? null : workspaceView(workspace),
      model: next ?? lastUsed ?? null,
      ...(lastUsed !== undefined && next !== undefined && !sameModelView(lastUsed, next) ? { modelLastUsed: lastUsed } : {}),
      modelSource: hints?.kind ?? 'unknown',
      live: live !== undefined,
      running: row?.running ?? agent?.status === 'running',
      agentAvailable: row?.agentAvailable ?? live !== undefined,
      blank: row?.blank ?? null,
      updatedAt: typeof row?.updatedAt === 'number' ? new Date(row.updatedAt).toISOString() : null,
      ...(parentSessionId === undefined ? {} : { parentSessionId }),
      ...(origin === undefined ? {} : { origin }),
      archived: flagged,
      resumable: origin !== 'subagent' && !flagged,
    }
  }

  async function sessionRow(sessionId, header) {
    const hints = await readProjections(sessionId)
    return sessionRecord({
      sessionId,
      hints,
      header,
      live: ctx.sessions.get(sessionId),
      agent: ctx.agents.get(sessionId),
      archived: archivedIds(),
    })
  }

  /** 单会话精读；投影只是加分项，读不到就少带 title/model 而不影响会话本身。 */
  async function readProjections(sessionId) {
    try {
      return await ctx.sessionController.projections({ sessionId }, liveSignal())
    } catch (error) {
      log(`projections for ${sessionId} unavailable: ${describe(error)}`)
      return undefined
    }
  }

  /** DSH 的 list() 回的是 {items}，不是数组；两种形状都接住，避免契约漂移时整端点 500。 */
  function sessionRows(value) {
    if (Array.isArray(value)) return value
    return Array.isArray(value?.items) ? value.items : []
  }

  /**
   * projections() 内部**无条件**调用 signal.throwIfAborted()：不传信号会直接
   * TypeError，被 readProjections 吞掉后表现为 title/model 永远是 null。
   * 这里给一个永不中止的信号（桥没有需要中途取消这些只读调用的路径）。
   */
  function liveSignal() {
    return new AbortController().signal
  }

  /**
   * 用 cwd 反查 workspace。故意先用 registry.list() 比对路径，而不是
   * resolveByPath：后者对不存在的路径会直接 reject（realpath 抛错）。
   */
  function workspaceOfPath(cwd) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || cwd === undefined || cwd === null) return undefined
    const wanted = normalizePath(cwd)
    try {
      return registry.list().find((workspace) => normalizePath(workspace.path) === wanted)
    } catch (error) {
      log(`workspace lookup failed: ${describe(error)}`)
      return undefined
    }
  }

  function workspaceView(workspace) {
    return { id: String(workspace.id), title: workspace.title ?? null, path: workspace.path ?? null }
  }

  function archivedIds() {
    const ids = ctx.get('workspaceRegistry')?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.map((id) => String(id)) : [])
  }

  function isArchived(sessionId) {
    return archivedIds().has(String(sessionId))
  }

  function currentSelection() {
    const defaults = ctx.get('agentDefaultModel')
    try {
      return defaults?.currentSelection?.()
    } catch (error) {
      log(`default model selection unavailable: ${describe(error)}`)
      return undefined
    }
  }

  function modelView(selection) {
    if (selection === undefined || selection === null) return undefined
    const provider = optionalText(selection.provider)
    const model = optionalText(selection.model)
    if (provider === undefined || model === undefined) return undefined
    return { provider, model, reasoningEffort: optionalText(selection.reasoningEffort) ?? null }
  }

  function sameModelView(left, right) {
    return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
  }

  async function resolveDirectory(input) {
    const raw = optionalText(input) ?? options.defaultCwd
    let directory
    if (raw === '') {
      directory = ctx.get('workingDirectory')?.defaultDirectory ?? process.cwd()
    } else {
      directory = isAbsolute(raw) ? raw : resolvePath(raw)
    }
    try {
      const info = await stat(directory)
      if (!info.isDirectory()) throw new HttpError(400, `cwd is not a directory: ${directory}`)
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(400, `cwd does not exist or is unreadable: ${directory}`)
    }
    return directory
  }

  function waitBudget(requested) {
    const raw = Number(requested)
    if (!Number.isFinite(raw) || raw <= 0) return options.waitTimeoutSeconds
    return Math.min(Math.max(1, raw), options.maxWaitSeconds)
  }

  function authorized(req) {
    const header = req.headers['x-claude-call-token'] ?? req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const provided = Buffer.from(String(header ?? ''), 'utf8')
    const expected = Buffer.from(token, 'utf8')
    return provided.length === expected.length && timingSafeEqual(provided, expected)
  }

  function respond(res, status, body) {
    if (res.writableEnded) return
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(`${JSON.stringify(body)}\n`)
  }
}

// ------------------------------------------------------------------ helpers

function normalizeOptions(config) {
  const source = config ?? {}
  const host = optionalText(source.host) ?? '127.0.0.1'
  if (!LOOPBACK.has(host)) throw new Error(`${NAME}: host must be a loopback address, got "${host}"`)
  return {
    endpointFile: expandHome(optionalText(source.endpointFile) || DEFAULT_ENDPOINT),
    host,
    port: clampNumber(source.port, 0, 0, 65535),
    defaultCwd: optionalText(source.defaultCwd) ?? '',
    agentPreset: optionalText(source.agentPreset) ?? '',
    // 单次同步等待压在 Node/undici 客户端默认的 ~300 秒响应头超时之内；
    // 更长的活请用 wait:false 派发，再靠 dsh_status / dsh_wait 轮询。
    waitTimeoutSeconds: clampNumber(source.waitTimeoutSeconds, 120, 1, 3600),
    maxWaitSeconds: clampNumber(source.maxWaitSeconds, 240, 1, 3600),
    listLimit: clampNumber(source.listLimit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT),
    // 自动化任务默认允许写（新建/编辑/删除），要收紧就显式 allowScheduleWrite: false。
    allowScheduleWrite: source.allowScheduleWrite !== false,
    // 保留用户写的空格：这里不能走 optionalText（它会 trim）。
    scheduleSessionPrefix:
      typeof source.scheduleSessionPrefix === 'string' && source.scheduleSessionPrefix.trim() !== ''
        ? source.scheduleSessionPrefix
        : '⏰ ',
    token: optionalText(source.token) ?? '',
  }
}

function expandHome(path) {
  const raw = String(path)
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

/** 比较路径时忽略结尾分隔符；Windows 上大小写不敏感。 */
function normalizePath(path) {
  const text = String(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? text.toLowerCase() : text
}

function clampNumber(value, fallback, min, max) {
  // 缺失的查询参数是 null（或空串），不能当成数字 0，否则 limit 会被夹到 1。
  if (value === undefined || value === null || String(value).trim() === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.trunc(number), min), max)
}

function optionalText(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}

function requireText(value, field) {
  const text = optionalText(value)
  if (text === undefined) throw new HttpError(400, `${field} must be a non-empty string`)
  return text
}

function requireId(value) {
  const id = optionalText(value)
  if (id === undefined) throw new HttpError(400, 'sessionId is required')
  return id
}

function titleFor(prompt) {
  const line = prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const compact = line.replace(/\s+/g, ' ')
  if (compact === '') return `Claude Code 任务 ${new Date().toISOString().slice(11, 19)}`
  return compact.length > 60 ? `${compact.slice(0, 59)}…` : compact
}

function newRequestId() {
  return `claude-call-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

function textOfMessage(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 把一段文本压成单行预览，避免 /turns 把整段 prompt 原样带出来。 */
function previewText(text, limit = 100) {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

function describe(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (error instanceof Error) {
    const code = typeof error.code === 'string' ? ` [${error.code}]` : ''
    return `${error.message}${code}`
  }
  return String(error)
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms))
    if (typeof timer.unref === 'function') timer.unref()
  })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body must be JSON')
  }
}
