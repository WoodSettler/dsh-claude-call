/**
 * Standalone harness for the bridge: it mounts the plugin on a stub Cordis
 * context, so the HTTP surface, auth, session creation, workspace and model
 * selection, session discovery, wait/status and endpoint-file lifecycle are
 * testable without a running DSH.
 *
 * Run with: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../index.js'

function fakeSession(id, options = {}) {
  return {
    id,
    header: { id, createdAt: Date.now(), isSeeded: false, cwd: options.cwd, origin: options.origin },
    events: [],
    get seq() {
      return this.events.length
    },
    eventAt(seq) {
      return this.events[seq]
    },
    append(type, data) {
      this.events.push({ type, seq: this.events.length, time: Date.now(), data })
    },
  }
}

function createHarness(overrides = {}) {
  const directory = overrides.directory ?? 'C:\\work\\demo'
  const store = new Map()
  const timers = new Set()
  const disposers = []
  const logLines = []
  const created = []
  const selections = []
  const renames = []

  // workspace 注册表的替身：路径比较、archived 标记与 create 都按 DSH 的形状提供。
  const workspaces = overrides.workspaces ?? []
  const registry =
    overrides.workspaceRegistry === undefined
      ? {
          list: () => workspaces,
          get: (id) => workspaces.find((workspace) => workspace.id === id),
          resolveByPath: async (path) => workspaces.find((workspace) => workspace.path === path),
          async create(path, title) {
            const workspace = { id: `workspace-${workspaces.length + 1}`, title: title ?? path, path, sessionIds: [] }
            workspaces.push(workspace)
            return workspace
          },
          archivedSessionIds: overrides.archivedSessionIds ?? [],
        }
      : overrides.workspaceRegistry

  const ctx = {
    logger: { info: (line) => logLines.push(line) },
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => dispose()
    },
    get: (key) => {
      if (key === 'workingDirectory') return { defaultDirectory: directory }
      if (key === 'workspaceRegistry') return registry
      if (key === 'agentDefaultModel') {
        return overrides.agentDefaultModel ?? { currentSelection: () => ({ provider: 'sst', model: 'deepseek-flash', reasoningEffort: 'xhigh' }) }
      }
      if (key === 'schedule') return overrides.schedule
      return undefined
    },
    sessions: {
      list: () => [...store.values()],
      get: (id) => store.get(id),
    },
    agents: {
      get: (id) => (store.has(id) ? { status: 'idle' } : undefined),
    },
  }

  const controller = {
    async create(request) {
      created.push(request)
      if (overrides.create) return overrides.create(request, store)
      const id = `session-${store.size + 1}`
      store.set(id, fakeSession(id, { cwd: request.cwd ?? (request.workspaceId === undefined ? undefined : directory), origin: overrides.sessionOrigin }))
      return { sessionId: id }
    },
    async list() {
      if (overrides.list) return overrides.list()
      // 真实 sessionController.list() 回的是 {items}（不是裸数组），替身必须同形，
      // 否则"桥按数组处理"这类契约漂移会被测试放过。
      return {
        items: [...store.values()].map((session) => ({
          sessionId: session.id,
          cwd: session.header.cwd,
          running: false,
          agentAvailable: true,
          blank: false,
          updatedAt: Date.now(),
        })),
      }
    },
    async projections(request, signal) {
      // 真实实现在这里无条件 signal.throwIfAborted()：桥漏传信号就抛 TypeError，
      // 被 readProjections 吞掉后表现为 title/model 永远为 null。替身照抄这个门槛。
      if (signal === undefined) {
        throw new TypeError("Cannot read properties of undefined (reading 'throwIfAborted')")
      }
      return overrides.projections === undefined ? null : overrides.projections(request.sessionId)
    },
    async selectModel(request) {
      selections.push(request)
      return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }
    },
    async modelCatalog() {
      return overrides.modelCatalog ?? { default: null, routableProviders: [], groups: [], failures: [] }
    },
    async rename(request) {
      renames.push(request)
      return { title: request.title, seq: 0 }
    },
    async prompt(request, signal) {
      assert.ok(signal instanceof AbortSignal)
      let session = store.get(request.sessionId)
      if (session === undefined) {
        // 冷会话：DSH 会在 prompt 时从持久化日志 resume。这里按 cold 覆盖项重建同一段历史，
        // 让 live 会话的 seq 编号与 inspect 报出的旧日志接得上。
        session = fakeSession(request.sessionId, {
          cwd: overrides.cold?.meta?.cwd ?? overrides.directory,
          origin: overrides.cold?.meta?.origin,
        })
        for (const event of overrides.cold?.events ?? []) session.events.push(event)
        store.set(request.sessionId, session)
      }
      if (overrides.prompt) return overrides.prompt(request, session, store)
      const text = request.content[0].text
      session.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: request.requestId },
      })
      const turn = session.events.filter((event) => event.type === 'turn/start').length + 1
      session.append('turn/start', { turn })
      const timer = setTimeout(() => {
        session.append('assistant/message', {
          turn,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
          stream: [],
        })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }, 120)
      timers.add(timer)
      return { accepted: true }
    },
    cancel() {
      return { accepted: true }
    },
    async inspect(id) {
      if (overrides.cold !== undefined && overrides.cold.meta.id === id) {
        return { meta: overrides.cold.meta, events: overrides.cold.events }
      }
      const session = store.get(id)
      if (session === undefined) throw new Error('session not found')
      return { meta: session.header, events: session.events }
    },
  }

  ctx.sessionController = controller

  return {
    ctx,
    store,
    logLines,
    created,
    selections,
    renames,
    workspaces,
    schedule: overrides.schedule,
    async dispose() {
      for (const timer of timers) clearTimeout(timer)
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

async function mount(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-call-test-'))
  const endpointFile = join(dir, 'endpoint.json')
  // schedule: null mounts the plugin without a schedule service (503 path).
  const schedule = overrides.schedule === null ? undefined : (overrides.schedule ?? createScheduleStub())
  const harness = createHarness({ ...overrides, schedule, directory: overrides.directory ?? dir })
  apply(harness.ctx, { endpointFile, port: 0, ...(overrides.config ?? {}) })
  t.after(async () => {
    await harness.dispose()
    await rm(dir, { recursive: true, force: true })
  })

  let endpoint
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(endpointFile)) {
      endpoint = JSON.parse(await readFile(endpointFile, 'utf8'))
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(endpoint, 'endpoint file was published')
  assert.match(endpoint.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(endpoint.token.length >= 32)

  const call = async (path, { method = 'GET', body, token = endpoint.token } = {}) => {
    const response = await fetch(`${endpoint.origin}${path}`, {
      method,
      headers: token === null ? {} : { 'x-claude-call-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }

  return { endpoint, endpointFile, harness, call, dir }
}

test('exports a mountable host plugin', () => {
  assert.equal(name, 'claude-call')
  assert.equal(typeof apply, 'function')
  assert.deepEqual(inject, ['sessionController', 'sessions', 'agents'])
})

test('health requires the token', async (t) => {
  const { call } = await mount(t)
  const denied = await call('/health', { token: null })
  assert.equal(denied.status, 401)
  assert.equal(denied.body.ok, false)

  const healthy = await call('/health')
  assert.equal(healthy.status, 200, JSON.stringify(healthy.body))
  assert.equal(healthy.body.ok, true)
  assert.equal(healthy.body.name, 'claude-call')
})

test('task creates a session, waits for the turn, and returns the answer', async (t) => {
  const { call, harness, endpoint } = await mount(t)
  const result = await call('/task', {
    method: 'POST',
    body: { prompt: '请只回复 pong', timeoutSeconds: 5 },
  })
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.status, 'done')
  assert.equal(result.body.turnEndReason, 'completed')
  assert.equal(result.body.text, 'pong')
  assert.equal(result.body.title, '请只回复 pong')
  assert.equal(result.body.origin, endpoint.origin)
  assert.equal(harness.store.size, 1)
})

test('task with wait=false dispatches immediately', async (t) => {
  const { call, dir } = await mount(t)
  const result = await call('/task', {
    method: 'POST',
    body: { prompt: '后台任务', wait: false, cwd: dir },
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.status, 'dispatched')
  assert.equal(result.body.text, '')
  assert.ok(Number.isInteger(result.body.sinceSeq))
})

test('wait and status read the same turn', async (t) => {
  const { call } = await mount(t)
  const dispatched = await call('/task', { method: 'POST', body: { prompt: '继续', wait: false } })
  await new Promise((resolve) => setTimeout(resolve, 250))

  const waited = await call('/wait', {
    method: 'POST',
    body: { sessionId: dispatched.body.sessionId, sinceSeq: dispatched.body.sinceSeq, timeoutSeconds: 2 },
  })
  assert.equal(waited.body.status, 'done')
  assert.equal(waited.body.text, 'pong')

  const status = await call(`/status?sessionId=${dispatched.body.sessionId}`)
  assert.equal(status.body.running, false)
  assert.equal(status.body.lastAssistantText, 'pong')
  assert.equal(status.body.lastTurnEndReason, 'completed')
})

test('send continues an existing session', async (t) => {
  const { call } = await mount(t)
  const first = await call('/task', { method: 'POST', body: { prompt: '第一轮', timeoutSeconds: 5 } })
  const second = await call('/send', {
    method: 'POST',
    body: { sessionId: first.body.sessionId, prompt: '第二轮', timeoutSeconds: 5 },
  })
  assert.equal(second.body.status, 'done')
  assert.equal(second.body.text, 'pong')
  assert.equal(second.body.sessionId, first.body.sessionId)
})

test('unknown sessions and routes are reported', async (t) => {
  const { call } = await mount(t)
  const missing = await call('/status?sessionId=session-does-not-exist')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)

  const unknown = await call('/nope')
  assert.equal(unknown.status, 404)
})

test('disposal removes the endpoint file', async (t) => {
  const { endpointFile, harness } = await mount(t)
  assert.equal(existsSync(endpointFile), true)
  await harness.dispose()
  assert.equal(existsSync(endpointFile), false)
})

test('sessions list reports workspace, model and resume state', async (t) => {
  const workspaces = [{ id: 'ws-1', title: 'dsh-claude-call', path: 'C:\\work\\demo', sessionIds: ['session-new'] }]
  const rows = [
    {
      sessionId: 'session-new',
      cwd: 'C:\\work\\demo',
      running: false,
      agentAvailable: true,
      blank: false,
      updatedAt: Date.parse('2026-01-02T03:04:05Z'),
      projections: {
        kind: 'cached',
        asOfSeq: 7,
        values: {
          title: '新会话',
          modelSelection: {
            lastUsed: { provider: 'sst', model: 'deepseek-flash', reasoningEffort: 'xhigh' },
            next: { provider: 'sst', model: 'glm-5.3', reasoningEffort: 'max' },
          },
        },
      },
    },
    { sessionId: 'session-old', cwd: 'C:\\elsewhere', origin: 'subagent', updatedAt: Date.parse('2026-01-01T00:00:00Z') },
  ]
  const { call } = await mount(t, { workspaces, list: async () => ({ items: rows }) })

  const listed = await call('/sessions')
  assert.equal(listed.status, 200, JSON.stringify(listed.body))
  assert.equal(listed.body.count, 2)
  const [newest, oldest] = listed.body.items
  assert.equal(newest.sessionId, 'session-new')
  assert.equal(newest.title, '新会话')
  assert.deepEqual(newest.workspace, { id: 'ws-1', title: 'dsh-claude-call', path: 'C:\\work\\demo' })
  assert.deepEqual(newest.model, { provider: 'sst', model: 'glm-5.3', reasoningEffort: 'max' })
  assert.deepEqual(newest.modelLastUsed, { provider: 'sst', model: 'deepseek-flash', reasoningEffort: 'xhigh' })
  assert.equal(newest.modelSource, 'cached')
  assert.equal(newest.resumable, true)
  assert.equal(newest.archived, false)
  assert.equal(newest.cwd, 'C:\\work\\demo')

  assert.equal(oldest.sessionId, 'session-old')
  assert.equal(oldest.origin, 'subagent')
  assert.equal(oldest.resumable, false)
  assert.equal(oldest.model, null)
  assert.equal(oldest.workspace, null)
  assert.equal(oldest.modelSource, 'unknown')

  const filtered = await call('/sessions?workspace=ws-1')
  assert.equal(filtered.body.count, 1)
  assert.equal(filtered.body.items[0].sessionId, 'session-new')
})

test('sessions can be read one at a time', async (t) => {
  const { call } = await mount(t, {
    projections: (sessionId) => ({
      kind: 'sequenced',
      asOfSeq: 4,
      values: { title: '单会话', modelSelection: { lastUsed: null, next: { provider: 'sst', model: 'kimi-k3' } } },
    }),
  })
  const created = await call('/task', { method: 'POST', body: { prompt: '细看这个会话', wait: false } })

  const detail = await call(`/sessions?sessionId=${created.body.sessionId}`)
  assert.equal(detail.status, 200, JSON.stringify(detail.body))
  assert.equal(detail.body.items.length, 1)
  assert.equal(detail.body.items[0].sessionId, created.body.sessionId)
  assert.equal(detail.body.items[0].title, '单会话')
  assert.deepEqual(detail.body.items[0].model, { provider: 'sst', model: 'kimi-k3', reasoningEffort: null })
  assert.equal(detail.body.items[0].live, true)

  const missing = await call('/sessions?sessionId=session-does-not-exist')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)
})

test('workspaces and models describe the DSH deployment', async (t) => {
  const workspaces = [{ id: 'ws-1', title: 'demo', path: 'C:\\work\\demo', sessionIds: ['a', 'b'] }]
  const modelCatalog = {
    default: { provider: 'sst', model: 'deepseek-flash', reasoningEffort: 'xhigh' },
    routableProviders: ['sst'],
    groups: [
      {
        id: 'sst',
        name: 'SST',
        models: [
          {
            id: 'glm-5.3',
            name: 'GLM 5.3',
            reasoning: { efforts: [{ id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
          },
        ],
      },
    ],
    failures: [],
  }
  const { call } = await mount(t, { workspaces, modelCatalog })

  const listed = await call('/workspaces')
  assert.equal(listed.status, 200, JSON.stringify(listed.body))
  assert.equal(listed.body.count, 1)
  assert.equal(listed.body.items[0].id, 'ws-1')
  assert.equal(listed.body.items[0].sessions, 2)

  const catalog = await call('/models')
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body))
  assert.deepEqual(catalog.body.default, { provider: 'sst', model: 'deepseek-flash', reasoningEffort: 'xhigh' })
  assert.deepEqual(catalog.body.groups[0].models[0].reasoningEfforts, ['high', 'max'])
  assert.equal(catalog.body.groups[0].models[0].defaultEffort, 'high')
  assert.equal(catalog.body.routableProviders[0], 'sst')
})

test('task can pick a workspace and a model, and omits both by default', async (t) => {
  const workspaces = [{ id: 'ws-7', title: 'demo', path: 'C:\\work\\demo', sessionIds: [] }]
  const { call, harness, dir } = await mount(t, { workspaces })

  const plain = await call('/task', { method: 'POST', body: { prompt: '默认就好', wait: false } })
  assert.equal(plain.status, 200, JSON.stringify(plain.body))
  assert.equal(plain.body.model, undefined)
  assert.equal(plain.body.workspace, undefined)
  assert.equal(harness.selections.length, 0)
  assert.equal(harness.created[0].workspaceId, undefined)

  const chosen = await call('/task', {
    method: 'POST',
    body: { prompt: '指定环境与模型', title: '环境', workspaceId: 'ws-7', model: 'glm-5.3', reasoningEffort: 'high', wait: false },
  })
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body))
  assert.equal(chosen.body.workspace.id, 'ws-7')
  assert.deepEqual(chosen.body.model, { provider: 'sst', model: 'glm-5.3', reasoningEffort: 'high' })
  assert.equal(harness.created[1].workspaceId, 'ws-7')
  assert.deepEqual(harness.selections, [
    { sessionId: chosen.body.sessionId, provider: 'sst', model: 'glm-5.3', reasoningEffort: 'high' },
  ])

  // 给出真实存在但还没注册的目录，createWorkspace 才就地新建 workspace。
  const fresh = join(dir, 'fresh-workspace')
  await mkdir(fresh, { recursive: true })
  const created = await call('/task', {
    method: 'POST',
    body: { prompt: '新 workspace', workspacePath: fresh, workspaceTitle: '新环境', createWorkspace: true, wait: false },
  })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  assert.equal(harness.workspaces.length, 2)
  assert.equal(created.body.workspace.title, '新环境')

  const missing = await call('/task', { method: 'POST', body: { prompt: '不存在的 workspace', workspaceId: 'ws-nope', wait: false } })
  assert.equal(missing.status, 404)
})

test('send keeps the workspace, refuses workspace fields, and can switch the model', async (t) => {
  const { call, harness } = await mount(t, {})
  const first = await call('/task', { method: 'POST', body: { prompt: '第一轮', wait: false } })

  const rejected = await call('/send', {
    method: 'POST',
    body: { sessionId: first.body.sessionId, prompt: '第二轮', workspaceId: 'ws-1', wait: false },
  })
  assert.equal(rejected.status, 400)
  assert.match(rejected.body.error, /workspace\/immutable/)

  const switched = await call('/send', {
    method: 'POST',
    body: { sessionId: first.body.sessionId, prompt: '第三轮', model: 'kimi-k3', wait: false },
  })
  assert.equal(switched.status, 200, JSON.stringify(switched.body))
  assert.deepEqual(switched.body.model, { provider: 'sst', model: 'kimi-k3', reasoningEffort: 'xhigh' })
  assert.equal(harness.selections.length, 1)
})

test('send refuses archived and subagent sessions', async (t) => {
  // 归档会话仍然存在，只是 agent/pre-step 会拒绝它，所以先建出来再判。
  const archivedHarness = await mount(t, { archivedSessionIds: ['session-1'] })
  const created = await archivedHarness.call('/task', { method: 'POST', body: { prompt: '稍后归档', wait: false } })
  assert.equal(created.body.sessionId, 'session-1')
  const archived = await archivedHarness.call('/send', {
    method: 'POST',
    body: { sessionId: 'session-1', prompt: '还能继续吗', wait: false },
  })
  assert.equal(archived.status, 400)
  assert.match(archived.body.error, /session\/archived/)

  const subagent = await mount(t, { sessionOrigin: 'subagent' })
  const spawned = await subagent.call('/task', { method: 'POST', body: { prompt: '子代理会话', wait: false } })
  const refused = await subagent.call('/send', {
    method: 'POST',
    body: { sessionId: spawned.body.sessionId, prompt: '继续子代理', wait: false },
  })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /session\/not-resumable/)
})

test('send resumes a cold session without rescanning its old log', async (t) => {
  // 冷会话：不在 ctx.sessions 里，只有持久化日志；DSH 会在 prompt 时按 cwd 从日志 resume。
  const history = Array.from({ length: 6 }, (_, index) => ({
    type: 'assistant/message',
    seq: index,
    time: Date.now(),
    data: { message: { role: 'assistant', content: [{ type: 'text', text: `旧答复 ${index}` }] } },
  }))
  const cold = {
    meta: { id: 'session-cold', createdAt: Date.now(), isSeeded: false, cwd: 'C:\\work\\demo' },
    events: history,
  }
  const { call, harness } = await mount(t, { cold })

  const sent = await call('/send', {
    method: 'POST',
    body: { sessionId: 'session-cold', prompt: '接着上次说', timeoutSeconds: 5 },
  })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.equal(sent.body.status, 'done')
  assert.equal(sent.body.text, 'pong')
  // 起点是旧日志长度（下一个事件的序号），不再是冷会话的 currentSeq() = -1：
  // 上报的 sinceSeq 只会落在旧日志之后，不会回落到 0 让调用方重扫整份历史。
  assert.ok(sent.body.sinceSeq >= history.length, `sinceSeq=${sent.body.sinceSeq}`)
  // 旧日志 + prompt/user + turn/start + assistant + turn/end
  assert.equal(harness.store.get('session-cold').events.length, history.length + 4)
})

test('a resumed cold session never reports the old answer as the new one', async (t) => {
  const history = [
    {
      type: 'assistant/message',
      seq: 0,
      time: Date.now(),
      data: { message: { role: 'assistant', content: [{ type: 'text', text: '旧答复' }] } },
    },
  ]
  const cold = {
    meta: { id: 'session-cold', createdAt: Date.now(), isSeeded: false, cwd: 'C:\\work\\demo' },
    events: history,
  }
  const { call } = await mount(t, {
    cold,
    // 本轮只落 turn/end、不产出新文本：旧答复绝不能被当成本轮结果。
    prompt(request, session) {
      session.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text: request.content[0].text }],
        source: { kind: 'user', rpcId: request.requestId },
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return { accepted: true }
    },
  })

  const sent = await call('/send', {
    method: 'POST',
    body: { sessionId: 'session-cold', prompt: '接着上次', timeoutSeconds: 5 },
  })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  assert.equal(sent.body.status, 'done')
  assert.equal(sent.body.text, '')
})

test('status reports a sinceSeq that still catches the next turn', async (t) => {
  const { call } = await mount(t, {})
  const first = await call('/task', { method: 'POST', body: { prompt: '第一轮', timeoutSeconds: 5 } })
  assert.equal(first.body.status, 'done')

  const state = await call(`/status?sessionId=${first.body.sessionId}`)
  assert.equal(state.status, 200, JSON.stringify(state.body))
  // sinceSeq 是"最后观测到的序号"，比 seq 小一，所以紧接着写入的 turn/end 仍算在它之后。
  assert.equal(state.body.sinceSeq, state.body.seq - 1)
  assert.equal(state.body.lastAssistantText, 'pong')
})

test('wait refuses a missing sinceSeq', async (t) => {
  const { call } = await mount(t, {})
  const created = await call('/task', { method: 'POST', body: { prompt: '第一轮', wait: false } })

  const refused = await call('/wait', {
    method: 'POST',
    body: { sessionId: created.body.sessionId, timeoutSeconds: 1 },
  })
  assert.equal(refused.status, 400)
  assert.match(refused.body.error, /sinceSeq is required/)
})

test('task and send report how long the dispatch took', async (t) => {
  const { call } = await mount(t, {})
  const task = await call('/task', { method: 'POST', body: { prompt: '第一轮', timeoutSeconds: 5 } })
  assert.equal(task.body.status, 'done')
  // 桥侧墙钟：至少盖住 stub 里 120ms 的"模型思考"。
  assert.ok(task.body.durationMs >= 100, JSON.stringify(task.body))
  // 轮耗时来自 turn/start 与 turn/end 的事件时间差。
  assert.ok(task.body.turnDurationMs >= 100, JSON.stringify(task.body))

  const sent = await call('/send', {
    method: 'POST',
    body: { sessionId: task.body.sessionId, prompt: '第二轮', timeoutSeconds: 5 },
  })
  assert.equal(sent.body.status, 'done')
  assert.ok(sent.body.durationMs >= 100)
})

test('turns list every finished turn newest first', async (t) => {
  const { call } = await mount(t, {})
  const first = await call('/task', { method: 'POST', body: { prompt: '第一轮：先说 pong', timeoutSeconds: 5 } })
  const second = await call('/send', {
    method: 'POST',
    body: { sessionId: first.body.sessionId, prompt: '第二轮：再说一次', timeoutSeconds: 5 },
  })
  assert.equal(second.body.status, 'done')

  const turns = await call(`/turns?sessionId=${first.body.sessionId}`)
  assert.equal(turns.status, 200, JSON.stringify(turns.body))
  assert.equal(turns.body.count, 2)
  assert.equal(turns.body.items.length, 2)
  // 最新的一轮排在最前面。
  assert.equal(turns.body.items[0].turn, 2)
  assert.equal(turns.body.items[0].reason, 'completed')
  assert.equal(turns.body.items[0].prompt, '第二轮：再说一次')
  assert.equal(turns.body.items[1].turn, 1)
  for (const item of turns.body.items) {
    assert.equal(item.open, false)
    assert.ok(item.durationMs >= 100, JSON.stringify(item))
    assert.ok(item.endedAt > item.startedAt)
  }
  assert.ok(turns.body.totalDurationMs >= 200)
  assert.equal(turns.body.averageDurationMs, Math.round(turns.body.totalDurationMs / 2))
  assert.equal(turns.body.pending, undefined)
})

test('turns report a running turn as pending, not as an average', async (t) => {
  const { call } = await mount(t, {
    // 只开始这一轮、永不结束：模拟派发后还在跑。
    prompt(request, session) {
      session.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text: request.content[0].text }],
        source: { kind: 'user', rpcId: request.requestId },
      })
      session.append('turn/start', { turn: 1 })
      return { accepted: true }
    },
  })
  const created = await call('/task', { method: 'POST', body: { prompt: '长活', wait: false } })

  const turns = await call(`/turns?sessionId=${created.body.sessionId}`)
  assert.equal(turns.status, 200, JSON.stringify(turns.body))
  assert.equal(turns.body.count, 1)
  assert.equal(turns.body.items[0].open, true)
  assert.equal(turns.body.items[0].durationMs, null)
  assert.ok(typeof turns.body.items[0].elapsedMs === 'number')
  assert.equal(turns.body.totalDurationMs, 0)
  // 未闭合的轮次不算进平均耗时。
  assert.equal(turns.body.averageDurationMs, null)
  assert.equal(turns.body.pending.turn, 1)
})

test('turns read a cold session from its persisted log', async (t) => {
  const base = Date.now() - 60_000
  const cold = {
    meta: { id: 'session-cold', createdAt: base, isSeeded: false, cwd: 'C:\\work\\demo' },
    events: [
      {
        type: 'user/message',
        seq: 0,
        time: base,
        data: { role: 'user', content: [{ type: 'text', text: '旧任务' }], source: { kind: 'user' } },
      },
      { type: 'turn/start', seq: 1, time: base + 1_000, data: { turn: 1 } },
      {
        type: 'assistant/message',
        seq: 2,
        time: base + 5_000,
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '旧答复' }] } },
      },
      { type: 'turn/end', seq: 3, time: base + 6_000, data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  const { call } = await mount(t, { cold })

  const turns = await call('/turns?sessionId=session-cold')
  assert.equal(turns.status, 200, JSON.stringify(turns.body))
  assert.equal(turns.body.count, 1)
  assert.equal(turns.body.items[0].durationMs, 5_000)
  assert.equal(turns.body.items[0].prompt, '旧任务')
  assert.equal(turns.body.averageDurationMs, 5_000)
})

test('turns report an unknown session', async (t) => {
  const { call } = await mount(t, {})
  const missing = await call('/turns?sessionId=session-nope')
  assert.equal(missing.status, 404)
  assert.match(missing.body.error, /session not found/)
})

// ------------------------------------------------------------ automation tasks

/**
 * ctx.schedule 的替身：实现桥用到的六个方法，并保留 DSH 的错误码语义
 * （标题必填、恰好一个时间选择器、update 是整条记录的 compare-and-set、
 * 删除后从 catalog 消失）。它只服务于本文件的断言，不模拟真实定时器。
 */
function createScheduleStub() {
  const tasks = new Map()
  const seen = { creates: [], expected: [] }
  let counter = 0

  function refusal(code, message) {
    const error = new Error(message)
    error.code = code
    return error
  }

  function selectorKey(request) {
    const present = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'].filter(
      (key) => request?.[key] !== undefined && request?.[key] !== null,
    )
    if (present.length !== 1) throw refusal('invalid_selector', `exactly one timing selector is required, got ${present.length}`)
    return present[0]
  }

  function buildRecord(request, key) {
    const record = {
      id: `schedule-${++counter}`,
      kind: key === 'after_seconds' ? 'after' : key === 'every_seconds' ? 'every' : key,
      title: request.title,
      prompt: request.prompt,
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    }
    if (key === 'after_seconds') record.afterSeconds = request.after_seconds
    if (key === 'every_seconds') record.everySeconds = request.every_seconds
    if (key === 'daily') {
      record.time = request.daily.time
      record.timeZone = request.daily.time_zone
    }
    if (key === 'weekly') {
      record.time = request.weekly.time
      record.timeZone = request.weekly.time_zone
      record.weekdays = request.weekly.weekdays
    }
    if (key === 'cron') {
      record.expression = request.cron.expression
      record.timeZone = request.cron.time_zone
    }
    return record
  }

  return {
    tasks,
    seen,
    async create(sessionId, request) {
      seen.creates.push({ sessionId, request })
      if (typeof request?.title !== 'string' || request.title.trim() === '') throw refusal('invalid_prompt', 'a title is required')
      if (typeof request?.prompt !== 'string' || request.prompt.trim() === '') throw refusal('invalid_prompt', 'a prompt is required')
      const record = buildRecord(request, selectorKey(request))
      tasks.set(record.id, { sessionId, record, status: 'active', deliveries: [] })
      return { ...record }
    },
    async list(request) {
      return [...tasks.values()]
        .filter((task) => task.sessionId === request.sessionId && task.status === 'active')
        .map((task) => ({ ...task.record }))
    },
    async catalog() {
      return [...tasks.values()].map((task) => ({
        ...task.record,
        sessionId: task.sessionId,
        status: task.status,
        ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
      }))
    },
    async history(request) {
      const task = tasks.get(request.id)
      if (task === undefined || task.sessionId !== request.sessionId) return { id: request.id, code: 'schedule_not_found' }
      return {
        id: request.id,
        records: task.deliveries.slice(-request.limit).reverse(),
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
      }
    },
    async update(request) {
      seen.expected.push(request.expected)
      const task = tasks.get(request.id)
      if (task === undefined || task.sessionId !== request.sessionId) {
        return { id: request.id, updated: false, code: 'schedule_not_found' }
      }
      if (task.status !== 'active') return { id: request.id, updated: false, code: 'schedule_ended' }
      // 只有"改前那一刻"的记录才对得上；这正是桥必须自己回读的原因。
      if (request.expected?.scheduledAt !== task.record.scheduledAt) {
        return { id: request.id, updated: false, code: 'schedule_conflict' }
      }
      const changed = request.title !== undefined || request.prompt !== undefined || request.change !== undefined
      // 真实服务对 no-op 也回 updated:false，但带记录、不带错误码。
      if (!changed) return { id: task.record.id, updated: false, record: { ...task.record } }
      const next = { ...task.record }
      if (request.title !== undefined) next.title = request.title
      if (request.prompt !== undefined) next.prompt = request.prompt
      if (request.change !== undefined) {
        next.kind = request.change.kind
        next.scheduledAt = new Date(Date.now() + 7_200_000).toISOString()
      }
      task.record = next
      return { id: next.id, updated: true, record: { ...next } }
    },
    async delete(request) {
      const task = tasks.get(request.id)
      if (task === undefined || task.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      tasks.delete(request.id)
      return { id: request.id, deleted: true }
    },
  }
}

test('schedule create defaults to a dedicated session', async (t) => {
  const { call, harness } = await mount(t)
  const result = await call('/schedule', {
    method: 'POST',
    body: {
      title: '每日站会摘要',
      prompt: '整理今天的会议纪要并给出待办',
      daily: { time: '09:00', time_zone: 'Asia/Shanghai' },
    },
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.mode, 'new-session')
  assert.equal(result.body.sessionCreated, true)
  assert.equal(result.body.schedule.kind, 'daily')
  assert.equal(result.body.schedule.status, 'active')
  assert.equal(result.body.schedule.sessionId, result.body.sessionId)
  assert.equal(result.body.schedule.time, '09:00')
  assert.equal(result.body.schedule.timeZone, 'Asia/Shanghai')
  // 专用会话确实建了，而且标题带前缀
  assert.equal(harness.created.length, 1)
  assert.deepEqual(harness.renames.at(-1), { sessionId: result.body.sessionId, title: '⏰ 每日站会摘要' })
  // 全机 catalog 能反查到同一条任务
  const all = await call('/schedules')
  assert.equal(all.status, 200, JSON.stringify(all.body))
  assert.equal(all.body.scope, 'all')
  assert.equal(all.body.count, 1)
  assert.equal(all.body.items[0].id, result.body.schedule.id)
  assert.equal(typeof all.body.items[0].scheduledInMs, 'number')
})

test('schedule create can bind to an existing session', async (t) => {
  const { call, harness } = await mount(t)
  const task = await call('/task', { method: 'POST', body: { prompt: '第一轮', wait: false } })
  const result = await call('/schedule', {
    method: 'POST',
    body: { title: '两小时后继续', prompt: '接着处理上一步', after_seconds: 7200, sessionId: task.body.sessionId },
  })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.mode, 'session')
  assert.equal(result.body.sessionCreated, false)
  assert.equal(result.body.sessionId, task.body.sessionId)
  assert.equal(result.body.schedule.kind, 'after')
  assert.equal(result.body.schedule.afterSeconds, 7200)
  // 没有多建会话：只有 /task 那一个
  assert.equal(harness.created.length, 1)
  const scoped = await call(`/schedules?sessionId=${task.body.sessionId}`)
  assert.equal(scoped.body.scope, 'session')
  assert.equal(scoped.body.count, 1)
  assert.equal(scoped.body.items[0].status, 'active')
})

test('schedule create validates the title and the timing selectors', async (t) => {
  const { call, harness } = await mount(t)
  const noSelector = await call('/schedule', { method: 'POST', body: { title: 'x', prompt: 'y' } })
  assert.equal(noSelector.status, 400, JSON.stringify(noSelector.body))
  assert.match(noSelector.body.error, /exactly one timing selector/)

  const twoSelectors = await call('/schedule', {
    method: 'POST',
    body: { title: 'x', prompt: 'y', every_seconds: 3600, daily: { time: '09:00', time_zone: 'Asia/Shanghai' } },
  })
  assert.equal(twoSelectors.status, 400)
  assert.match(twoSelectors.body.error, /every_seconds \+ daily/)

  const noTitle = await call('/schedule', { method: 'POST', body: { prompt: 'y', every_seconds: 3600 } })
  assert.equal(noTitle.status, 400)
  assert.match(noTitle.body.error, /title must be a non-empty string/)

  const longTitle = await call('/schedule', {
    method: 'POST',
    body: { title: 'x'.repeat(121), prompt: 'y', every_seconds: 3600 },
  })
  assert.equal(longTitle.status, 400)
  assert.match(longTitle.body.error, /at most 120 characters/)

  // 校验失败不该顺手建会话
  assert.equal(harness.created.length, 0)
})

test('schedule refuses to bind to an archived session', async (t) => {
  const { call, harness } = await mount(t, { archivedSessionIds: ['session-1'] })
  const task = await call('/task', { method: 'POST', body: { prompt: '先建一个会话', wait: false } })
  assert.equal(task.body.sessionId, 'session-1')
  const result = await call('/schedule', {
    method: 'POST',
    body: { title: 'x', prompt: 'y', every_seconds: 3600, sessionId: 'session-1' },
  })
  assert.equal(result.status, 400, JSON.stringify(result.body))
  assert.match(result.body.error, /session\/archived/)
  assert.equal(harness.schedule.tasks.size, 0)
})

test('schedule update renames through compare-and-set, and delete removes the task', async (t) => {
  const { call, harness } = await mount(t)
  const created = await call('/schedule', {
    method: 'POST',
    body: { title: '旧名字', prompt: '老指令', every_seconds: 3600 },
  })
  const id = created.body.schedule.id

  const updated = await call('/schedule/update', {
    method: 'POST',
    body: { id, title: '新名字', prompt: '新指令', daily: { time: '08:30', time_zone: 'Asia/Shanghai' } },
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.body))
  assert.equal(updated.body.schedule.title, '新名字')
  assert.equal(updated.body.schedule.prompt, '新指令')
  assert.equal(updated.body.schedule.kind, 'daily')

  // expected 必须是"改前那一刻的纯记录"：不带宿主附加字段
  const expected = harness.schedule.seen.expected.at(-1)
  assert.equal(expected.sessionId, undefined)
  assert.equal(expected.status, undefined)
  assert.equal(expected.title, '旧名字')

  const history = await call(`/schedules/history?id=${id}`)
  assert.equal(history.status, 200, JSON.stringify(history.body))
  assert.deepEqual(history.body.records, [])
  assert.equal(history.body.retention.records, 200)

  const removed = await call('/schedule/delete', { method: 'POST', body: { id } })
  assert.equal(removed.status, 200, JSON.stringify(removed.body))
  assert.equal(removed.body.deleted, true)
  const after = await call('/schedules')
  assert.equal(after.body.count, 0)
  const again = await call('/schedule/delete', { method: 'POST', body: { id } })
  assert.equal(again.status, 404)
})

test('schedule update with no fields reports an unchanged task', async (t) => {
  const { call } = await mount(t)
  const created = await call('/schedule', { method: 'POST', body: { title: 'x', prompt: 'y', every_seconds: 3600 } })
  const result = await call('/schedule/update', { method: 'POST', body: { id: created.body.schedule.id } })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  assert.equal(result.body.unchanged, true)
  assert.equal(result.body.schedule.title, 'x')
})

test('schedule update refuses after_seconds and unknown ids', async (t) => {
  const { call } = await mount(t)
  const created = await call('/schedule', { method: 'POST', body: { title: 'x', prompt: 'y', every_seconds: 3600 } })
  const createOnly = await call('/schedule/update', {
    method: 'POST',
    body: { id: created.body.schedule.id, after_seconds: 600 },
  })
  assert.equal(createOnly.status, 400, JSON.stringify(createOnly.body))
  assert.match(createOnly.body.error, /create-only/)

  const unknown = await call('/schedule/update', { method: 'POST', body: { id: 'schedule-nope', title: 'z' } })
  assert.equal(unknown.status, 404)
  assert.match(unknown.body.error, /schedule_not_found/)
})

test('schedule writes can be disabled by config, reads stay open', async (t) => {
  const { call } = await mount(t, { config: { allowScheduleWrite: false } })
  const created = await call('/schedule', {
    method: 'POST',
    body: { title: 'x', prompt: 'y', every_seconds: 3600 },
  })
  assert.equal(created.status, 403, JSON.stringify(created.body))
  assert.match(created.body.error, /allowScheduleWrite/)

  const listed = await call('/schedules')
  assert.equal(listed.status, 200, JSON.stringify(listed.body))
  assert.equal(listed.body.count, 0)
})

test('schedule routes report a deployment without the service', async (t) => {
  const { call } = await mount(t, { schedule: null })
  const listed = await call('/schedules')
  assert.equal(listed.status, 503)
  assert.match(listed.body.error, /no schedule service/)

  const created = await call('/schedule', {
    method: 'POST',
    body: { title: 'x', prompt: 'y', every_seconds: 3600 },
  })
  assert.equal(created.status, 503)
})

test('a refused create reports the session it already created', async (t) => {
  const stub = createScheduleStub()
  stub.create = async () => {
    const error = new Error('that instant is not in the future')
    error.code = 'not_future'
    throw error
  }
  const { call, harness } = await mount(t, { schedule: stub })
  const result = await call('/schedule', {
    method: 'POST',
    body: { title: 'x', prompt: 'y', at: '2020-01-01T00:00:00+08:00' },
  })
  assert.equal(result.status, 400, JSON.stringify(result.body))
  assert.match(result.body.error, /schedule\/not_future/)
  // 会话已经建出来了，错误里必须带上它的 id，避免悄悄留垃圾
  assert.match(result.body.error, /session-1/)
  assert.equal(harness.created.length, 1)
})

