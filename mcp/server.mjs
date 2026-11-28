#!/usr/bin/env node
/**
 * dsh-claude-call — MCP stdio server for Claude Code.
 *
 * It exposes nine tools that drive the DSH bridge plugin over loopback HTTP:
 * list sessions, workspaces and models, read the per-turn timings of a session,
 * dispatch a task into a brand-new DSH session (optionally into a chosen
 * workspace and with a chosen model), continue an existing session, wait for a
 * turn, read its state, or cancel it.
 *
 * The server is dependency-free on purpose: Claude Code spawns it with plain
 * Node, and nothing has to be installed. Protocol messages are newline
 * delimited JSON-RPC 2.0 over stdin/stdout; diagnostics go to stderr.
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.3.0'
const ENDPOINT_FILE =
  process.env.DSH_CLAUDE_CALL_ENDPOINT ??
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'claude-call', 'endpoint.json')
const DEFAULT_WAIT_SECONDS = 40
// 单次同步等待必须短于 Node/undici 客户端默认的 ~300 秒响应头超时，否则 fetch 会先中止。
const MAX_WAIT_SECONDS = 240
const MAX_LIST_LIMIT = 200
const HTTP_SLACK_MS = 20_000

const INSTRUCTIONS = `These tools drive DSH (DeepSeek Harness), a separate coding agent running on this machine.
Use dsh_task to hand DSH a self-contained task in a new session; DSH keeps working in its own session log and
tool sandbox, independent of this Claude Code process. Prefer dsh_task when the work is long, should run in
parallel with your own work, or should continue after this turn. The default call waits briefly and returns
DSH's final answer; if status is "running", call dsh_wait with the returned sessionId and sinceSeq to collect it later.
Use dsh_sessions to find earlier DSH work and continue it with dsh_send, or to read which workspace and model a
session uses. dsh_workspaces and dsh_models list the folders and models you can pass to dsh_task. A session keeps
the workspace it was created in, so choose the workspace and model at dsh_task time; omit them to use DSH defaults.
Use dsh_turns to see how long each turn of a session took.
Use dsh_schedules to see the automation tasks (saved prompts DSH delivers on a schedule) and
dsh_schedule_create / dsh_schedule_update / dsh_schedule_delete to manage them. A created task is
bound to exactly one session: by default the bridge creates a dedicated session for it; pass sessionId
to bind it to an existing session instead. Tasks keep firing unattended until deleted, so treat create,
update and delete as persistent changes to the user's machine.`

/** Timing selectors shared by the schedule tools; DSH accepts exactly one per request. */
const TIMING_PROPERTIES = {
  after_seconds: {
    type: 'number',
    description: 'Fire once this many seconds after creation (create only).',
  },
  at: {
    description:
      'Fire once at an absolute instant: an ISO-8601 string with an offset (for example 2026-12-01T09:00:00+08:00), or {date, time, time_zone} for a local wall time.',
    oneOf: [
      { type: 'string' },
      {
        type: 'object',
        properties: { date: { type: 'string' }, time: { type: 'string' }, time_zone: { type: 'string' } },
        required: ['date', 'time', 'time_zone'],
        additionalProperties: false,
      },
    ],
  },
  every_seconds: { type: 'number', description: 'Repeat every N seconds (minimum 60).' },
  daily: {
    type: 'object',
    properties: {
      time: { type: 'string', description: 'Local wall time, HH:MM or HH:MM:SS.' },
      time_zone: { type: 'string', description: 'IANA zone, for example Asia/Shanghai.' },
    },
    required: ['time', 'time_zone'],
    additionalProperties: false,
  },
  weekly: {
    type: 'object',
    properties: {
      time: { type: 'string', description: 'Local wall time, HH:MM or HH:MM:SS.' },
      time_zone: { type: 'string', description: 'IANA zone, for example Asia/Shanghai.' },
      weekdays: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: 7 },
        description: 'ISO weekdays: Monday 1 … Sunday 7.',
      },
    },
    required: ['time', 'time_zone', 'weekdays'],
    additionalProperties: false,
  },
  cron: {
    type: 'object',
    properties: {
      expression: { type: 'string', description: 'Five-field cron expression.' },
      time_zone: { type: 'string', description: 'IANA zone the expression is read in.' },
    },
    required: ['expression', 'time_zone'],
    additionalProperties: false,
  },
}

/** Selector properties for one tool; `after_seconds` is create-only in DSH. */
function timingProperties({ allowAfter = true } = {}) {
  const entries = Object.entries(TIMING_PROPERTIES).filter(([key]) => allowAfter || key !== 'after_seconds')
  return Object.fromEntries(entries)
}

const SCHEDULE_TARGET_PROPERTIES = {
  sessionId: {
    type: 'string',
    description:
      'Bind the task to this existing DSH session (from dsh_sessions) instead of creating a dedicated one. The prompt is delivered into that session, so its history and its workspace are shared with the task.',
  },
  workspaceId: {
    type: 'string',
    description: 'With no sessionId: create the task session in this DSH workspace (from dsh_workspaces).',
  },
  workspacePath: {
    type: 'string',
    description: 'With no sessionId: absolute folder of a registered workspace for the task session.',
  },
  workspaceTitle: {
    type: 'string',
    description: 'With no sessionId: workspace title for the task session; it has to match exactly one workspace.',
  },
  createWorkspace: {
    type: 'boolean',
    description: 'With workspacePath and no sessionId: register that folder as a workspace when none exists.',
  },
  cwd: {
    type: 'string',
    description: 'With no sessionId: absolute working directory for the task session (defaults to the DSH default directory).',
  },
  agentPreset: {
    type: 'string',
    description: 'With no sessionId: optional DSH agent preset for the task session.',
  },
}

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
  {
    name: 'dsh_turns',
    description:
      'List the turns of one DSH session with their elapsed time, newest first. The durations come from the DSH event log (turn start to turn end), so they show how long the model actually worked on each turn; the newest turn is reported as pending while it is still running. Use it to tell where a dispatched session spent its time.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session whose turns should be listed.' },
        limit: {
          type: 'integer',
          description: `How many recent turns to return, newest first (1-${MAX_LIST_LIMIT}, default 20).`,
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedules',
    description:
      'List DSH automation tasks: saved prompts that DSH delivers into a session at a scheduled time, unattended. Without sessionId it returns every task on the machine from the host catalog, including tasks that already ran (status "inactive"); with sessionId it returns that session\'s active tasks. Use it to find the id before editing or deleting, and to see what is already scheduled.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional: only this session\'s tasks.' },
        includeInactive: {
          type: 'boolean',
          description: 'With sessionId: also include tasks that already ran or ended. Defaults to false.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_create',
    description:
      'Create a DSH automation task: a saved prompt that DSH delivers into a session at the scheduled time, with nobody watching. By default the bridge creates a dedicated session for it (titled "⏰ <title>") and binds the task there — pass sessionId to bind it to an existing session instead. Exactly one timing selector is required and title is required (max 120 characters). The task persists on the machine until dsh_schedule_delete; recurring tasks keep firing, and a run that needs an approval can stall until the user acts in DSH.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title, max 120 characters (required).' },
        prompt: {
          type: 'string',
          description: 'The instruction DSH delivers when the task fires (required). Write it self-contained.',
        },
        ...TIMING_PROPERTIES,
        ...SCHEDULE_TARGET_PROPERTIES,
        ...{
          provider: { type: 'string', description: 'With no sessionId: optional model provider for the task session.' },
          model: { type: 'string', description: 'With no sessionId: optional model for the task session.' },
          reasoningEffort: { type: 'string', description: 'With no sessionId: optional reasoning effort for that model.' },
        },
      },
      required: ['title', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_update',
    description:
      'Edit one DSH automation task: rename it, replace its instruction, change when it runs, or any combination. Only active tasks can be edited, and after_seconds is create-only — reschedule with at / every_seconds / daily / weekly / cron. Identify the task by id from dsh_schedules; sessionId is optional and only narrows the lookup.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from dsh_schedules (required).' },
        sessionId: { type: 'string', description: 'Optional: the session the task is bound to.' },
        title: { type: 'string', description: 'New title (max 120 characters). Omit to keep the current one.' },
        prompt: { type: 'string', description: 'New instruction. Omit to keep the current one.' },
        ...timingProperties({ allowAfter: false }),
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_delete',
    description:
      'Delete one DSH automation task permanently; its saved delivery history goes with it and it stops firing. The session it was bound to is left untouched. Get the id from dsh_schedules.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from dsh_schedules (required).' },
        sessionId: { type: 'string', description: 'Optional: the session the task is bound to.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_schedule_history',
    description:
      'List the saved deliveries of one DSH automation task, newest first: when each run was scheduled and when the reminder reached the session inbox. A receipt proves delivery into the inbox, not that the model ran or finished. Get the id from dsh_schedules.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Task id from dsh_schedules (required).' },
        sessionId: { type: 'string', description: 'Optional: the session the task is bound to.' },
        limit: { type: 'integer', description: 'How many deliveries to return, 1-100 (default 20).' },
        before: { type: 'string', description: 'Optional message id cursor: return deliveries older than it.' },
      },
      required: ['id'],
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
    const sinceSeq = Number(args.sinceSeq)
    if (!Number.isFinite(sinceSeq)) {
      throw new Error('sinceSeq is required: pass the sinceSeq returned by dsh_task or dsh_status')
    }
    const timeoutSeconds = clampSeconds(args.timeoutSeconds, 45)
    const body = { sessionId: args.sessionId, sinceSeq, timeoutSeconds }
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

  async dsh_turns(args) {
    const query = {
      sessionId: args.sessionId,
      ...(Number.isFinite(args.limit) ? { limit: Math.round(Number(args.limit)) } : {}),
    }
    // 冷会话要把持久化日志读一遍，给更宽的预算。
    return formatTurns(await call('/turns', { method: 'GET', query, timeoutMs: 60_000 }))
  },

  async dsh_schedules(args) {
    const query = {
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(args.includeInactive === true ? { includeInactive: 'true' } : {}),
    }
    return formatScheduleList(await call('/schedules', { method: 'GET', query, timeoutMs: 30_000 }))
  },

  async dsh_schedule_create(args) {
    const value = await call('/schedule', { method: 'POST', body: scheduleCreateBody(args), timeoutMs: 60_000 })
    return [
      `Automation task created in DSH session ${value.sessionId}${
        value.sessionCreated ? ' (a dedicated session was created for it)' : ' (bound to that existing session)'
      }.`,
      '',
      formatSchedule(value.schedule),
      '',
      'It now fires unattended until deleted; use dsh_schedule_delete to remove it.',
    ].join('\n')
  },

  async dsh_schedule_update(args) {
    const value = await call('/schedule/update', { method: 'POST', body: scheduleUpdateBody(args), timeoutMs: 30_000 })
    return ['Automation task updated.', '', formatSchedule(value.schedule)].join('\n')
  },

  async dsh_schedule_delete(args) {
    const value = await call('/schedule/delete', {
      method: 'POST',
      body: { id: args.id, ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }) },
      timeoutMs: 30_000,
    })
    return `Automation task ${value.id} deleted (it was bound to session ${value.sessionId}). The session itself is untouched.`
  },

  async dsh_schedule_history(args) {
    const query = {
      id: args.id,
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
      ...(Number.isFinite(args.limit) ? { limit: Math.round(Number(args.limit)) } : {}),
      ...(args.before === undefined ? {} : { before: args.before }),
    }
    return formatScheduleHistory(await call('/schedules/history', { method: 'GET', query, timeoutMs: 30_000 }))
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
      // 超时和"桥根本没起来"是两件不同的事，给调用方的提示也不同。
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
  if (value.workspace) lines.push(`workspace: ${formatWorkspace(value.workspace)}`)
  if (value.model) lines.push(`model: ${formatModel(value.model)}`)
  lines.push(`status: ${value.status}${value.turnEndReason ? ` (turn end: ${value.turnEndReason})` : ''}`)
  if (typeof value.turnDurationMs === 'number') lines.push(`turn took: ${formatDuration(value.turnDurationMs)}`)
  if (typeof value.durationMs === 'number') lines.push(`call took: ${formatDuration(value.durationMs)}`)
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

const SCHEDULE_SELECTOR_KEYS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron']
const SCHEDULE_TARGET_KEYS = ['sessionId', 'workspaceId', 'workspacePath', 'workspaceTitle', 'cwd', 'agentPreset']

function scheduleCreateBody(args) {
  const body = { title: args.title, prompt: args.prompt }
  for (const key of [...SCHEDULE_SELECTOR_KEYS, ...SCHEDULE_TARGET_KEYS]) {
    if (args[key] !== undefined) body[key] = args[key]
  }
  if (args.createWorkspace !== undefined) body.createWorkspace = args.createWorkspace === true
  return { ...body, ...modelFields(args) }
}

function scheduleUpdateBody(args) {
  const body = { id: args.id }
  // after_seconds 是 create-only：schema 里已经不给它，这里也不透传。
  for (const key of ['title', 'prompt', 'sessionId', 'at', 'every_seconds', 'daily', 'weekly', 'cron']) {
    if (args[key] !== undefined) body[key] = args[key]
  }
  return body
}

/** 把一条任务的重复规则渲染成一句人话（与 DSH 记录字段一一对应）。 */
function scheduleRule(record) {
  if (record === undefined || record === null) return ''
  if (typeof record.everySeconds === 'number') return `every ${formatDuration(record.everySeconds * 1000)}`
  if (typeof record.afterSeconds === 'number') return `once, ${formatDuration(record.afterSeconds * 1000)} after creation`
  if (typeof record.expression === 'string') return `cron ${record.expression} (${record.timeZone ?? '?'})`
  if (Array.isArray(record.weekdays)) return `weekly on ${record.weekdays.join(',')} at ${record.time} (${record.timeZone ?? '?'})`
  if (typeof record.time === 'string') return `daily at ${record.time} (${record.timeZone ?? '?'})`
  return record.kind === 'at' ? 'once, at a fixed instant' : ''
}

function formatSchedule(record) {
  if (record === undefined || record === null) return '(no task)'
  const lines = [`task: ${record.id} [${record.status ?? 'active'}]`, `title: ${record.title}`, `kind: ${record.kind}`]
  const rule = scheduleRule(record)
  if (rule !== '') lines.push(`rule: ${rule}`)
  if (record.scheduledAt) {
    const relative = typeof record.scheduledInMs === 'number' ? ` (in ${formatDuration(record.scheduledInMs)})` : ''
    lines.push(`next run: ${record.scheduledAt}${relative}`)
  }
  if (record.sessionId) lines.push(`session: ${record.sessionId}`)
  if (record.lastDelivery) lines.push(`last delivery: ${record.lastDelivery.deliveredAt}`)
  lines.push('', 'prompt:', record.prompt ?? '')
  return lines.join('\n')
}

function formatScheduleList(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  const scope = value?.scope === 'all' ? 'on this machine' : `in session ${value?.sessionId ?? '?'}`
  const lines = [`DSH automation tasks ${scope}: ${items.length}`]
  if (items.length === 0) {
    lines.push('(none)')
    return lines.join('\n')
  }
  for (const item of items) {
    lines.push('', `- ${item.id} [${item.status ?? 'active'}] ${item.title}`)
    lines.push(`  ${scheduleRule(item) || item.kind}; next run ${item.scheduledAt}`)
    if (item.sessionId) lines.push(`  session ${item.sessionId}`)
    if (item.lastDelivery) lines.push(`  last delivery ${item.lastDelivery.deliveredAt}`)
  }
  return lines.join('\n')
}

function formatScheduleHistory(value) {
  const records = Array.isArray(value?.records) ? value.records : []
  const lines = [`Delivery history for ${value?.id} (session ${value?.sessionId}): ${records.length} record(s), newest first`]
  if (records.length === 0) lines.push('(no deliveries yet)')
  for (const record of records) {
    lines.push(`- scheduled ${record.scheduledAt} -> delivered ${record.deliveredAt}`)
  }
  if (value?.earlierRecordsPruned === true || value?.earlierRecordsUnavailable === true) {
    lines.push('(older records are no longer available)')
  }
  lines.push('', 'A receipt means the reminder reached the session inbox; it does not prove the model ran or finished.')
  return lines.join('\n')
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

/** 毫秒转人读时长：不足 1 秒给毫秒，不足 1 分钟给秒，再长给分秒。 */
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'unknown'
  const value = Math.max(0, Math.round(ms))
  const totalSeconds = Math.round(value / 1000)
  // 一分钟以内保留一位小数，够看清一轮模型耗时；超过就按 天/时/分/秒 拼。
  if (totalSeconds < 60) return `${(value / 1000).toFixed(1)}s`
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join('')
}

function clockOf(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : '??:??:??'
}

function formatTurns(value) {
  const items = Array.isArray(value?.items) ? value.items : []
  const head = `DSH turns for ${value?.sessionId ?? 'session'}`
  if (items.length === 0) return `${head}: no turn is recorded yet.`
  const total = typeof value?.count === 'number' ? value.count : items.length
  const lines = [`${head} (${items.length} of ${total} shown, newest first):`]
  const summary = []
  if (typeof value.averageDurationMs === 'number') summary.push(`average ${formatDuration(value.averageDurationMs)}`)
  if (typeof value.totalDurationMs === 'number') summary.push(`total ${formatDuration(value.totalDurationMs)}`)
  if (summary.length > 0) lines.push(summary.join(' over finished turns, '))
  if (value.pending) {
    lines.push(`now: turn ${value.pending.turn} still running (${formatDuration(value.pending.elapsedMs)} so far)`)
  }
  for (const item of items) {
    const timing =
      item.open === true
        ? `running ${formatDuration(item.elapsedMs)}`
        : `${formatDuration(item.durationMs)}${item.reason ? ` (${item.reason})` : ''}`
    const window =
      item.open === true
        ? `started ${clockOf(item.startedAt)}`
        : `${clockOf(item.startedAt)} to ${clockOf(item.endedAt)}`
    const steps = item.steps > 0 ? ` · ${item.steps} step${item.steps === 1 ? '' : 's'}` : ''
    lines.push('', `- turn ${item.turn}: ${timing} · ${window}${steps}`)
    if (typeof item.prompt === 'string' && item.prompt !== '') lines.push(`  prompt: ${item.prompt}`)
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
