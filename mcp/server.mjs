#!/usr/bin/env node
/**
 * dsh-claude-call — MCP stdio server for Claude Code.
 *
 * It exposes eight tools that drive the DSH bridge plugin over loopback HTTP:
 * list sessions, workspaces and models, dispatch a task into a brand-new DSH
 * session (optionally into a chosen workspace and with a chosen model), continue
 * an existing session, wait for a turn, read its state, or cancel it.
 *
 * The server is dependency-free on purpose: Claude Code spawns it with plain
 * Node, and nothing has to be installed. Protocol messages are newline
 * delimited JSON-RPC 2.0 over stdin/stdout; diagnostics go to stderr.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.2.0'
const ENDPOINT_FILE =
  process.env.DSH_CLAUDE_CALL_ENDPOINT ??
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-call', 'endpoint.json')
const DEFAULT_WAIT_SECONDS = 40
const MAX_WAIT_SECONDS = 300
const MAX_LIST_LIMIT = 200
const HTTP_SLACK_MS = 20_000

const INSTRUCTIONS = `These tools drive DSH (DeepSeek Harness), a separate coding agent running on this machine.
Use dsh_task to hand DSH a self-contained task in a new session; DSH keeps working in its own session log and
tool sandbox, independent of this Claude Code process. Prefer dsh_task when the work is long, should run in
parallel with your own work, or should continue after this turn. The default call waits briefly and returns
DSH's final answer; if status is "running", call dsh_wait with the returned sessionId and sinceSeq to collect it later.
Use dsh_sessions to find earlier DSH work and continue it with dsh_send, or to read which workspace and model a
session uses. dsh_workspaces and dsh_models list the folders and models you can pass to dsh_task. A session keeps
the workspace it was created in, so choose the workspace and model at dsh_task time; omit them to use DSH defaults.`

const TOOLS = [
  {
    name: 'dsh_task',
    description:
      'Create a new DSH session on this machine and give it a task. DSH is a separate coding agent with its own tools and workspace, so the session keeps running after this call returns. By default the call waits up to timeoutSeconds and returns DSH\'s final answer; when it is still running you get the sessionId plus sinceSeq and can call dsh_wait. Use this to hand off long or parallel work, or to run work in another repository. The workspace and the model are fixed when the session is created: pass workspaceId or workspacePath (see dsh_workspaces) and model/reasoningEffort (see dsh_models) here, or leave them out to use the DSH defaults.',
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
        workspaceId: {
          type: 'string',
          description:
            'Optional DSH workspace id from dsh_workspaces. The session is created in that workspace and its cwd becomes the workspace folder. Cannot be changed later.',
        },
        workspacePath: {
          type: 'string',
          description:
            'Optional absolute folder of a registered DSH workspace, as an alternative to workspaceId. With createWorkspace: true the folder is registered first when no workspace exists for it.',
        },
        workspaceTitle: {
          type: 'string',
          description:
            'Optional workspace title, as an alternative to workspaceId/workspacePath. It has to match exactly one workspace.',
        },
        createWorkspace: {
          type: 'boolean',
          description: 'With workspacePath: register that folder as a new DSH workspace when none exists for it. Defaults to false.',
        },
        provider: {
          type: 'string',
          description: 'Optional model provider for this session, from dsh_models. Defaults to the deployment default.',
        },
        model: {
          type: 'string',
          description: 'Optional model id for this session, from dsh_models. Omit to keep the deployment default model.',
        },
        reasoningEffort: {
          type: 'string',
          description:
            'Optional reasoning effort id supported by that model, from dsh_models. Omit to use the model default. Asking for a model here also updates the DSH deployment default model, which is native DSH behaviour.',
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
      'Send another prompt to an existing DSH session and continue its conversation. Same wait behavior as dsh_task. The workspace of a session cannot change, but you may switch its model here. Pass the sessionId from dsh_task, dsh_sessions or dsh_status.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session to continue (from dsh_task, dsh_sessions or dsh_status).' },
        prompt: { type: 'string', description: 'The follow-up instruction for DSH.' },
        provider: { type: 'string', description: 'Optional model provider to switch this session to, from dsh_models.' },
        model: { type: 'string', description: 'Optional model id to switch this session to, from dsh_models.' },
        reasoningEffort: {
          type: 'string',
          description:
            'Optional reasoning effort id for that model. Omit to keep the current one. Switching the model here also updates the DSH deployment default model, which is native DSH behaviour.',
        },
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
      'Block until the next DSH turn in a session finishes, then return its latest answer. Use the sinceSeq returned by dsh_task or dsh_status. Returns status "running" if the budget expires first, so you can call it again.',
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
      required: ['sessionId'],
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
  {
    name: 'dsh_sessions',
    description:
      'List earlier DSH sessions, newest first: session id, title, working directory, workspace, model and reasoning effort, and whether the session is still running or can be continued. Call this before dsh_send when you need to continue work started in an earlier conversation. Pass sessionId to inspect one session in detail instead of listing.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional: inspect this one session in detail instead of listing.' },
        limit: {
          type: 'number',
          description: `How many sessions to list, newest first (1-${MAX_LIST_LIMIT}, default 20).`,
        },
        workspace: {
          type: 'string',
          description: 'Optional filter: a workspace id, a workspace title, or an exact working directory.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_workspaces',
    description:
      'List the DSH workspaces registered on this machine (id, title, folder). Pass an id or folder to dsh_task to create the session inside that workspace.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'dsh_models',
    description:
      'List the models DSH can run, grouped by provider, with the reasoningEffort ids each model supports and the current deployment default. Use these ids with dsh_task or dsh_send.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
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
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
      ...(args.workspacePath === undefined ? {} : { workspacePath: args.workspacePath }),
      ...(args.workspaceTitle === undefined ? {} : { workspaceTitle: args.workspaceTitle }),
      ...(args.createWorkspace === undefined ? {} : { createWorkspace: args.createWorkspace === true }),
      ...modelFields(args),
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
      ...modelFields(args),
    }
    const timeoutMs = (wait ? timeoutSeconds : 10) * 1000 + HTTP_SLACK_MS
    return formatOutcome(await call('/send', { method: 'POST', body, timeoutMs }))
  },

  async dsh_wait(args) {
    const timeoutSeconds = clampSeconds(args.timeoutSeconds, 45)
    const body = {
      sessionId: args.sessionId,
      timeoutSeconds,
      ...(Number.isFinite(args.sinceSeq) ? { sinceSeq: Number(args.sinceSeq) } : {}),
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

  async dsh_sessions(args) {
    const query = {
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(Number.isFinite(args.limit) ? { limit: Math.round(Number(args.limit)) } : {}),
      ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
    }
    // 单会话精读要读冷会话日志，给它更宽的预算；列表走缓存投影，很快。
    const timeoutMs = args.sessionId === undefined ? 30_000 : 60_000
    return formatSessions(await call('/sessions', { method: 'GET', query, timeoutMs }))
  },

  async dsh_workspaces() {
    return formatWorkspaces(await call('/workspaces', { method: 'GET', timeoutMs: 30_000 }))
  },

  async dsh_models() {
    return formatModels(await call('/models', { method: 'GET', timeoutMs: 30_000 }))
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
  const timer = setTimeout(() => controller.abort(new Error(`DSH bridge did not answer within ${timeoutMs} ms`)), timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'x-claude-call-token': endpoint.token },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
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
  if (value.workspace) lines.push(`workspace: ${formatWorkspace(value.workspace)}`)
  if (value.model) lines.push(`model: ${formatModel(value.model)}`)
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

// ------------------------------------------------------- read-only rendering

/** 只把调用方真正给了的模型字段放进请求体，没给就交给 DSH 的默认值。 */
function modelFields(args) {
  return {
    ...(args.provider === undefined ? {} : { provider: args.provider }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.reasoningEffort === undefined ? {} : { reasoningEffort: args.reasoningEffort }),
  }
}

function formatModel(model) {
  if (!model) return 'deployment default (nothing recorded for this session yet)'
  const effort = model.reasoningEffort ? ` reasoningEffort=${model.reasoningEffort}` : ''
  return `${model.provider}/${model.model}${effort}`
}

function formatWorkspace(workspace) {
  if (!workspace) return 'none registered for its directory'
  return `${workspace.title ?? '(untitled)'} (id ${workspace.id}, path ${workspace.path ?? 'unknown'})`
}

function formatSessions(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  if (items.length === 0) return 'No DSH sessions were found.'
  const total = typeof value?.count === 'number' ? value.count : items.length
  const head =
    total > items.length
      ? `DSH sessions (showing ${items.length} of ${total} matching, newest first):`
      : `DSH sessions (${items.length}, newest first):`
  const lines = [head]
  for (const item of items) {
    const flags = [item.running === true ? 'running' : 'idle']
    if (item.live !== true) flags.push('cold')
    if (item.archived === true) flags.push('archived')
    if (item.resumable === false) flags.push('not resumable')
    lines.push('', `- ${item.sessionId}  [${flags.join(', ')}]`)
    lines.push(`  title: ${item.title ?? '(untitled)'}`)
    lines.push(`  cwd: ${item.cwd ?? '(unknown)'}`)
    lines.push(`  workspace: ${formatWorkspace(item.workspace)}`)
    lines.push(`  model: ${formatModel(item.model)}`)
    if (item.modelLastUsed !== undefined) lines.push(`  model used by the last turn: ${formatModel(item.modelLastUsed)}`)
    if (typeof item.updatedAt === 'string') lines.push(`  updated: ${item.updatedAt}`)
    if (typeof item.parentSessionId === 'string') {
      lines.push(`  parent session: ${item.parentSessionId}${item.origin ? ` (${item.origin})` : ''}`)
    }
    if (item.resumable === false) {
      lines.push('  note: this session cannot be continued (it is archived, or it belongs to a subagent).')
    }
  }
  return lines.join('\n')
}

function formatWorkspaces(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  if (items.length === 0) return 'No DSH workspaces are registered.'
  const lines = [`DSH workspaces (${items.length}):`]
  for (const item of items) {
    lines.push('', `- ${item.title ?? '(untitled)'}`)
    lines.push(`  id: ${item.id}`)
    lines.push(`  path: ${item.path ?? '(unknown)'}`)
    lines.push(`  sessions: ${item.sessions ?? 0}`)
  }
  if (typeof value?.defaultCwd === 'string') {
    lines.push('', `default directory for sessions created without cwd: ${value.defaultCwd}`)
  }
  return lines.join('\n')
}

function formatModels(value) {
  const lines = [`DSH default model: ${formatModel(value?.default)}`]
  const groups = Array.isArray(value?.groups) ? value.groups : []
  if (groups.length === 0) lines.push('', 'No model is available from the configured providers.')
  for (const group of groups) {
    lines.push('', `${group.name ?? group.id} (provider id: ${group.id}):`)
    for (const model of group.models ?? []) {
      const efforts =
        Array.isArray(model.reasoningEfforts) && model.reasoningEfforts.length > 0 ? model.reasoningEfforts.join('/') : 'none'
      const fallback = model.defaultEffort ? `, default ${model.defaultEffort}` : ''
      const label = model.name && model.name !== model.id ? ` (${model.name})` : ''
      lines.push(`  - ${model.id}${label}  reasoningEffort: ${efforts}${fallback}`)
    }
  }
  const failures = Array.isArray(value?.failures) ? value.failures : []
  if (failures.length > 0) {
    lines.push('', 'Providers that did not answer:')
    for (const failure of failures) lines.push(`  - ${failure.name ?? failure.id}: ${failure.message}`)
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
