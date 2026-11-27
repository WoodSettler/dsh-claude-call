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
 *   token                fixed token instead of a random per-process one
 *
 * Read-only discovery (GET /sessions, /workspaces, /models) answers from DSH
 * views and projections only, so a caller can find the session, workspace or
 * model it wants before it dispatches work. The projections supply the session
 * title and the model it is using, which the session header does not carry.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

const NAME = 'claude-call'
const VERSION = '0.2.0'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_ENDPOINT = join(DSH_HOME, 'claude-call', 'endpoint.json')
const BODY_LIMIT = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200

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
    })
  }

  async function send(body) {
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
    return finish({ sessionId, title, scanFrom: nextSeq, sinceSeq, requestId, body, wait: body?.wait !== false, model })
  }

  async function finish({ sessionId, title, scanFrom, sinceSeq, requestId, body, wait, model, workspace }) {
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
    if (!wait) return { ...base, status: 'dispatched', text: '', turnEndReason: null }
    const limitMs = waitBudget(body?.timeoutSeconds) * 1000
    const outcome = await waitForTurn(sessionId, { requestId, afterSeq: scanFrom }, limitMs)
    return { ...base, ...outcome }
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
    if (sessionId !== undefined) {
      const header = await knownHeader(sessionId)
      return { ok: true, origin, items: [await sessionRow(sessionId, header)] }
    }
    const limit = clampNumber(params.get('limit'), options.listLimit, 1, MAX_LIST_LIMIT)
    const filter = optionalText(params.get('workspace'))
    const archived = archivedIds()
    let rows
    try {
      rows = await ctx.sessionController.list({})
    } catch (error) {
      throw new HttpError(500, `DSH could not list sessions: ${describe(error)}`)
    }
    const items = []
    for (const row of rows ?? []) {
      if (row?.sessionId === undefined) continue
      const record = sessionRecord({ sessionId: row.sessionId, hints: row.projections, row, archived })
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
    const state = { requestId, afterSeq, messageSeq: -1, endSeq: -1, reason: undefined, text: '' }
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
      } else if (event.type === 'turn/end') {
        if (state.endSeq >= 0) continue
        if (state.requestId !== '') {
          if (state.messageSeq < 0 || seq <= state.messageSeq) continue
        } else if (seq <= state.afterSeq) {
          continue
        }
        state.endSeq = seq
        state.reason = event.data?.reason
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
      return await ctx.sessionController.projections({ sessionId })
    } catch (error) {
      log(`projections for ${sessionId} unavailable: ${describe(error)}`)
      return undefined
    }
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
