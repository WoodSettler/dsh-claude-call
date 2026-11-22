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
 *   maxWaitSeconds       hard cap for one wait (default 240)
 *   token                fixed token instead of a random per-process one
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'

const NAME = 'claude-call'
const VERSION = '0.1.1'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const DEFAULT_ENDPOINT = join(DSH_HOME, 'claude-call', 'endpoint.json')
const BODY_LIMIT = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

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
    const cwd = await resolveDirectory(body?.cwd)
    const preset = optionalText(body?.agentPreset) ?? options.agentPreset
    const title = optionalText(body?.title) ?? titleFor(prompt)
    const sessionId = await createSession({ cwd, preset, title })
    const scanFrom = currentSeq(sessionId)
    const requestId = newRequestId()
    await admit(sessionId, prompt, requestId)
    // The prompt may start a turn before this line; sinceSeq must cover it.
    const sinceSeq = Math.max(scanFrom, currentSeq(sessionId) - 1)
    return finish({ sessionId, title, scanFrom, sinceSeq, requestId, body, wait: body?.wait !== false })
  }

  async function send(body) {
    const sessionId = requireId(body?.sessionId)
    const prompt = requireText(body?.prompt, 'prompt')
    const known = await describeSession(sessionId)
    // A cold session resumes inside prompt(), so the pre-admission cursor is
    // the persisted log length, not -1.
    const scanFrom = known.nextSeq
    const requestId = newRequestId()
    await admit(sessionId, prompt, requestId)
    const sinceSeq = Math.max(scanFrom, currentSeq(sessionId) - 1)
    const title = optionalText(body?.title) ?? ''
    return finish({ sessionId, title, scanFrom, sinceSeq, requestId, body, wait: body?.wait !== false })
  }

  async function finish({ sessionId, title, scanFrom, sinceSeq, requestId, body, wait }) {
    const base = {
      ok: true,
      sessionId,
      ...(title === '' ? {} : { title }),
      sinceSeq,
      requestId,
      origin,
    }
    if (!wait) return { ...base, status: 'dispatched', text: '', turnEndReason: null }
    const limitMs = waitBudget(body?.timeoutSeconds) * 1000
    const outcome = await waitForTurn(sessionId, { requestId, afterSeq: scanFrom }, limitMs)
    return { ...base, ...outcome }
  }

  async function wait(body) {
    const sessionId = requireId(body?.sessionId)
    await describeSession(sessionId)
    const rawSinceSeq = body?.sinceSeq
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

  async function status(rawSessionId) {
    const sessionId = requireId(rawSessionId)
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const agent = ctx.agents.get(sessionId)
      const head = Number(live.seq)
      return {
        ok: true,
        sessionId,
        live: true,
        running: agent?.status === 'running',
        seq: head,
        // Last observed event index: a turn/end appended next (seq === head)
        // still satisfies "ends after sinceSeq".
        sinceSeq: head - 1,
        ...tailOfSession(live),
      }
    }
    try {
      const inspected = await ctx.sessionController.inspect(sessionId)
      const lastSeq = inspected.events.at(-1)?.seq ?? -1
      return {
        ok: true,
        sessionId,
        live: false,
        running: false,
        seq: lastSeq + 1,
        sinceSeq: lastSeq,
        ...tailOfEvents(inspected.events),
      }
    } catch (error) {
      throw new HttpError(404, `session not found: ${sessionId} (${describe(error)})`)
    }
  }

  // ------------------------------------------------------------ session work

  /**
   * Resolve one session without activating it. `nextSeq` is the seq the next
   * appended event will carry, which is the correct scan cursor for a prompt
   * that is about to resume this session.
   */
  async function describeSession(sessionId) {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) return { live: true, nextSeq: Number(live.seq) }
    try {
      const inspected = await ctx.sessionController.inspect(sessionId)
      const lastSeq = inspected.events.at(-1)?.seq
      return { live: false, nextSeq: (lastSeq ?? -1) + 1 }
    } catch (error) {
      throw new HttpError(404, `session not found: ${sessionId} (${describe(error)})`)
    }
  }

  async function createSession({ cwd, preset, title }) {
    const presetField = preset === '' ? {} : { agentPreset: preset }
    const workspace = await findWorkspace(cwd)
    let created
    try {
      created = await ctx.sessionController.create(
        workspace === undefined ? { ...presetField, cwd } : { ...presetField, workspaceId: workspace.id },
      )
    } catch (error) {
      if (workspace === undefined) throw new HttpError(400, `failed to create a DSH session: ${describe(error)}`)
      // The workspace may reject the attach; fall back to a plain cwd session.
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
        // Only text produced after our prompt (or after the caller's cursor)
        // counts: a resumed session replays its whole history through scan().
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
    // One synchronous wait stays under the ~300 s response-header timeout that
    // Node/undici clients apply; longer work uses wait:false + polling.
    waitTimeoutSeconds: clampNumber(source.waitTimeoutSeconds, 120, 1, 3600),
    maxWaitSeconds: clampNumber(source.maxWaitSeconds, 240, 1, 3600),
    token: optionalText(source.token) ?? '',
  }
}

function expandHome(path) {
  const raw = String(path)
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2))
  return raw
}

function clampNumber(value, fallback, min, max) {
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
