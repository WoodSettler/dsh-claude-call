/**
 * Standalone harness for the bridge: it mounts the plugin on a stub Cordis
 * context, so the HTTP surface, auth, session creation, wait/status and
 * endpoint-file lifecycle are testable without a running DSH.
 *
 * Run with: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../index.js'

function fakeSession(id) {
  return {
    id,
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

  const ctx = {
    logger: { info: (line) => logLines.push(line) },
    effect: (fn) => {
      const dispose = fn()
      disposers.push(dispose)
      return () => dispose()
    },
    get: (key) => {
      if (key === 'workingDirectory') return { defaultDirectory: directory }
      if (key === 'workspaceRegistry') return overrides.workspaceRegistry
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
      if (overrides.create) return overrides.create(request)
      const id = `session-${store.size + 1}`
      store.set(id, fakeSession(id))
      return { sessionId: id }
    },
    async rename(request) {
      return { title: request.title, seq: 0 }
    },
    async prompt(request, signal) {
      assert.ok(signal instanceof AbortSignal)
      if (overrides.prompt) return overrides.prompt(request, store)
      const session = store.get(request.sessionId)
      const text = request.content[0].text
      session.append('user/message', {
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: request.requestId },
      })
      const timer = setTimeout(() => {
        session.append('assistant/message', {
          message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] },
        })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      }, 120)
      timers.add(timer)
      return { accepted: true }
    },
    cancel() {
      return { accepted: true }
    },
    async inspect(id) {
      const session = store.get(id)
      if (session === undefined) throw new Error('session not found')
      return { events: session.events }
    },
  }

  ctx.sessionController = controller

  return {
    ctx,
    store,
    logLines,
    async dispose() {
      for (const timer of timers) clearTimeout(timer)
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

async function mount(t) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-call-test-'))
  const endpointFile = join(dir, 'endpoint.json')
  const harness = createHarness({ directory: dir })
  apply(harness.ctx, { endpointFile, port: 0 })
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
