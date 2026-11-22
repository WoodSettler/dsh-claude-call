#!/usr/bin/env node
/**
 * dsh-claude-call — MCP stdio server for Claude Code.
 *
 * It exposes five tools that drive the DSH bridge plugin over loopback HTTP:
 * dispatch a task into a brand-new DSH session, continue an existing session,
 * wait for a turn, read its state, or cancel it.
 *
 * The server is dependency-free on purpose: Claude Code spawns it with plain
 * Node, and nothing has to be installed. Protocol messages are newline
 * delimited JSON-RPC 2.0 over stdin/stdout; diagnostics go to stderr.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.1.1'
const ENDPOINT_FILE =
  process.env.DSH_CLAUDE_CALL_ENDPOINT ??
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-call', 'endpoint.json')
const DEFAULT_WAIT_SECONDS = 40
// Keep one synchronous wait under the ~300 s default HTTP header timeout used
// by Node/undici clients (fetch aborts before a longer response head arrives).
const MAX_WAIT_SECONDS = 240
const HTTP_SLACK_MS = 20_000

const INSTRUCTIONS = `These tools drive DSH (DeepSeek Harness), a separate coding agent running on this machine.
Use dsh_task to hand DSH a self-contained task in a new session; DSH keeps working in its own session log and
tool sandbox, independent of this Claude Code process. Prefer dsh_task when the work is long, should run in
parallel with your own work, or should continue after this turn. The default call waits briefly and returns
DSH's final answer; if status is "running", call dsh_wait with the returned sessionId and sinceSeq to collect it later.`

const TOOLS = [
  {
    name: 'dsh_task',
    description:
      'Create a new DSH session on this machine and give it a task. DSH is a separate coding agent with its own tools and workspace, so the session keeps running after this call returns. By default the call waits up to timeoutSeconds and returns DSH\'s final answer; when it is still running you get the sessionId plus sinceSeq and can call dsh_wait. Use this to hand off long or parallel work, or to run work in another repository.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The task for DSH. Write it as a self-contained instruction: the new session sees only this text, not this conversation.',
        },
        cwd: {
          type: 'string',
          description:
            'Absolute working directory for the new DSH session. Defaults to the DSH default directory. Prefer the repository or folder the work belongs to.',
        },
        title: {
          type: 'string',
          description: 'Optional short title for the session, shown in the DSH UI.',
        },
        agentPreset: {
          type: 'string',
          description: 'Optional DSH agent preset id. Omit unless the user asks for a specific preset.',
        },
        wait: {
          type: 'boolean',
          description: 'Wait for the turn to finish before returning. Defaults to true.',
        },
        timeoutSeconds: {
          type: 'number',
          description: `Wait budget in seconds (1-${MAX_WAIT_SECONDS}). Defaults to ${DEFAULT_WAIT_SECONDS}.`,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_send',
    description:
      'Send another prompt to an existing DSH session and continue its conversation. Same wait behavior as dsh_task.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session to continue (from dsh_task or dsh_status).' },
        prompt: { type: 'string', description: 'The follow-up instruction for DSH.' },
        wait: { type: 'boolean', description: 'Wait for the turn to finish before returning. Defaults to true.' },
        timeoutSeconds: {
          type: 'number',
          description: `Wait budget in seconds (1-${MAX_WAIT_SECONDS}). Defaults to ${DEFAULT_WAIT_SECONDS}.`,
        },
      },
      required: ['sessionId', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_wait',
    description:
      'Block until the next DSH turn in a session finishes, then return its latest answer. Requires the sinceSeq returned by dsh_task or dsh_status: only a turn that ends after that sequence counts, so an old turn is never reported as the answer. Returns status "running" if the budget expires first, so you can call it again.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session to wait on.' },
        sinceSeq: {
          type: 'number',
          description: 'Wait for a turn that ends after this session sequence. Use the sinceSeq from dsh_task or dsh_status.',
        },
        timeoutSeconds: {
          type: 'number',
          description: `Wait budget in seconds (1-${MAX_WAIT_SECONDS}). Defaults to 45.`,
        },
      },
      required: ['sessionId', 'sinceSeq'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_status',
    description:
      'Read a DSH session without waiting: whether it is running, its latest answer text, and sinceSeq for dsh_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session to inspect.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_cancel',
    description: 'Cancel the turn currently running in a DSH session. Pending queued messages are kept.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session whose turn should be cancelled.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
]

const HANDLERS = {
  async dsh_task(args) {
    const wait = args.wait !== false
    const timeoutSeconds = clampSeconds(args.timeoutSeconds, DEFAULT_WAIT_SECONDS)
    const body = {
      prompt: args.prompt,
      wait,
      timeoutSeconds,
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.title === undefined ? {} : { title: args.title }),
      ...(args.agentPreset === undefined ? {} : { agentPreset: args.agentPreset }),
    }
    const timeoutMs = (wait ? timeoutSeconds : 10) * 1000 + HTTP_SLACK_MS
    return formatOutcome(await call('/task', { method: 'POST', body, timeoutMs }))
  },

  async dsh_send(args) {
    const wait = args.wait !== false
    const timeoutSeconds = clampSeconds(args.timeoutSeconds, DEFAULT_WAIT_SECONDS)
    const body = {
      sessionId: args.sessionId,
      prompt: args.prompt,
      wait,
      timeoutSeconds,
    }
    const timeoutMs = (wait ? timeoutSeconds : 10) * 1000 + HTTP_SLACK_MS
    return formatOutcome(await call('/send', { method: 'POST', body, timeoutMs }))
  },

  async dsh_wait(args) {
    const sinceSeq = Number(args.sinceSeq)
    if (!Number.isFinite(sinceSeq)) {
      throw new Error('sinceSeq is required: pass the sinceSeq returned by dsh_task or dsh_status')
    }
    const timeoutSeconds = clampSeconds(args.timeoutSeconds, 45)
    const body = {
      sessionId: args.sessionId,
      sinceSeq,
      timeoutSeconds,
    }
    const outcome = await call('/wait', { method: 'POST', body, timeoutMs: timeoutSeconds * 1000 + HTTP_SLACK_MS })
    return formatOutcome(outcome)
  },

  async dsh_status(args) {
    const value = await call('/status', { method: 'GET', query: { sessionId: args.sessionId }, timeoutMs: 30_000 })
    const lines = [
      `DSH session: ${value.sessionId}`,
      `state: ${value.running ? 'running' : 'idle'}${value.live ? '' : ' (cold)'}`,
      `sinceSeq: ${value.sinceSeq ?? 0}`,
    ]
    if (value.lastTurnEndReason) lines.push(`last turn end: ${value.lastTurnEndReason}`)
    if (value.lastAssistantText) lines.push('', '--- latest answer ---', value.lastAssistantText)
    else lines.push('', '(no assistant text yet)')
    return lines.join('\n')
  },

  async dsh_cancel(args) {
    const value = await call('/cancel', { method: 'POST', body: { sessionId: args.sessionId }, timeoutMs: 30_000 })
    return `Cancellation requested for DSH session ${value.sessionId}.`
  },
}

// --------------------------------------------------------------- transport

async function call(path, { method = 'GET', body, query, timeoutMs = 60_000 }) {
  const endpoint = await readEndpoint()
  const url = new URL(`${endpoint.route}${path}`, endpoint.origin)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    let response
    try {
      response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', 'x-claude-call-token': endpoint.token },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) {
        throw new Error(
          `DSH bridge did not answer within ${timeoutMs} ms. The turn is probably still running: ` +
            'call dsh_status to read the session, then dsh_wait with a fresh sinceSeq.',
        )
      }
      throw new Error(
        `Cannot reach the DSH bridge at ${endpoint.origin} (${error?.message ?? error}). ` +
          'Is DSH running with the dsh-claude-call plugin enabled?',
      )
    }
    const text = await response.text()
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new Error(`DSH bridge returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`)
    }
    if (!response.ok || payload?.ok === false) {
      throw new Error(payload?.error ?? `DSH bridge HTTP ${response.status}`)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

async function readEndpoint() {
  let raw
  try {
    raw = await readFile(ENDPOINT_FILE, 'utf8')
  } catch (error) {
    throw new Error(
      `DSH bridge is not reachable: cannot read ${ENDPOINT_FILE} (${error.message}). ` +
        'Start DSH Desktop and confirm the dsh-claude-call plugin is enabled.',
    )
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`DSH bridge endpoint file is not valid JSON: ${ENDPOINT_FILE}`)
  }
  if (typeof value?.origin !== 'string' || typeof value?.token !== 'string') {
    throw new Error(`DSH bridge endpoint file is incomplete: ${ENDPOINT_FILE}`)
  }
  return { origin: value.origin.replace(/\/+$/, ''), token: value.token, route: value.route ?? '/claude-call' }
}

function formatOutcome(value) {
  const lines = [`DSH session: ${value.sessionId}`]
  if (value.title) lines.push(`title: ${value.title}`)
  lines.push(`status: ${value.status}${value.turnEndReason ? ` (turn end: ${value.turnEndReason})` : ''}`)
  if (value.status === 'running' || value.status === 'dispatched') {
    lines.push(
      `DSH is still working. Call dsh_wait with sessionId="${value.sessionId}" and sinceSeq=${value.sinceSeq ?? 0} to collect the answer.`,
    )
  }
  if (typeof value.text === 'string' && value.text !== '') {
    lines.push('', '--- DSH answer ---', value.text)
  } else if (value.status === 'done') {
    lines.push('', '(the turn ended without a text answer)')
  }
  return lines.join('\n')
}

function clampSeconds(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(Math.max(Math.round(number), 1), MAX_WAIT_SECONDS)
}

// ------------------------------------------------------------- MCP protocol

const readline = createInterface({ input: process.stdin, crlfDelay: Infinity })
readline.on('line', (line) => {
  if (line.trim() === '') return
  void handleLine(line)
})

async function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  const isNotification = message.id === undefined && typeof message.method === 'string'
  try {
    const result = await dispatch(message)
    if (!isNotification && message.id !== undefined && result !== undefined) {
      write({ jsonrpc: '2.0', id: message.id, result })
    }
  } catch (error) {
    if (!isNotification && message.id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: error?.rpcCode ?? -32603, message: String(error?.message ?? error) },
      })
    }
  }
}

async function dispatch(message) {
  const method = message?.method
  const params = message?.params ?? {}
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-claude-call', version: VERSION },
        instructions: INSTRUCTIONS,
      }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return await callTool(params)
    default: {
      const error = new Error(`method not supported: ${method}`)
      error.rpcCode = -32601
      throw error
    }
  }
}

async function callTool(params) {
  const name = params?.name
  const handler = HANDLERS[name]
  if (handler === undefined) {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
  try {
    const text = await handler(params.arguments ?? {})
    return { content: [{ type: 'text', text }], isError: false }
  } catch (error) {
    return { content: [{ type: 'text', text: `DSH bridge error: ${error?.message ?? error}` }], isError: true }
  }
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

process.on('uncaughtException', (error) => {
  process.stderr.write(`dsh-claude-call: uncaught exception: ${error?.stack ?? error}\n`)
})
process.on('unhandledRejection', (error) => {
  process.stderr.write(`dsh-claude-call: unhandled rejection: ${error?.stack ?? error}\n`)
})
