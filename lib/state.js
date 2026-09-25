/**
 * The ONE state table of dsh-clawd.
 *
 * Every part of the plugin reads its state vocabulary, priorities, one-shot
 * rules and timings from this module: the host half folds session events with
 * it, the theme validator checks themes against it, and the scripts report on
 * it. There is deliberately **no second copy** anywhere — not in `lib/client.js`
 * (the browser half renders whatever state name the host publishes), not in the
 * theme files (they only map a state name to artwork).
 *
 * Vocabulary provenance: the state names, their priority order and the one-shot
 * set follow the protocol of the `clawd-on-desk` desktop pet, so community
 * themes and the habits of its users carry over. The mapping from DeepSeek
 * Harness signals to these states is our own (see `HARNESS_EVENT_STATES`), and
 * this file is an independent implementation: no code is copied from that
 * project (see PROVENANCE.md).
 *
 * @module dsh-clawd/state
 */

/** Theme manifest schema version understood by this build. */
export const SCHEMA_VERSION = 1

/**
 * Display priority. Higher wins when several signals are live at once; the
 * dominant state is the maximum over every session and every pending one-shot.
 * @type {Readonly<Record<string, number>>}
 */
export const STATE_PRIORITY = Object.freeze({
  error: 8,
  notification: 7,
  sweeping: 6,
  attention: 5,
  carrying: 4,
  juggling: 4,
  working: 3,
  thinking: 2,
  waking: 1,
  idle: 1,
  roam: 1,
  yawning: 0,
  dozing: 0,
  collapsing: 0,
  sleeping: 0,
})

/** States a theme must provide artwork for. */
export const REQUIRED_STATES = Object.freeze(['idle', 'working', 'thinking'])

/**
 * States that show once and then fall back: they are queued with a minimum
 * display time and an automatic return, and they never preempt a higher
 * priority state.
 */
export const ONESHOT_STATES = Object.freeze([
  'attention',
  'error',
  'sweeping',
  'notification',
  'carrying',
  'waking',
])

/** States whose `fallbackTo` may legally point at another state. */
export const FALLBACK_STATES = Object.freeze([
  'attention',
  'error',
  'notification',
  'sweeping',
  'carrying',
  'sleeping',
  'roam',
])

/** The sleep chain, entered from a long idle and left by any activity. */
export const SLEEP_SEQUENCE = Object.freeze(['yawning', 'dozing', 'collapsing', 'sleeping'])

/** Every state name this build knows. */
export const ALL_STATES = Object.freeze(Object.keys(STATE_PRIORITY))

/**
 * How a DeepSeek Harness session event maps onto a session's logical state.
 *
 * This table only names the *continuous* signals. One-shot states are raised by
 * `oneshotOfEvent()` below, because they depend on event payloads rather than on
 * the event name alone.
 *
 * @type {Readonly<Record<string, 'thinking'|'working'|'idle'>>}
 */
export const HARNESS_EVENT_STATES = Object.freeze({
  'turn/start': 'thinking',
  'step/start': 'thinking',
  'user/message': 'thinking',
  'tool/call': 'working',
  'turn/end': 'idle',
})

/**
 * Default timings, in milliseconds. A theme may override any of them through
 * its `timings` object; the validator merges the theme's values over these.
 */
export const DEFAULT_TIMINGS = Object.freeze({
  /** Minimum time a one-shot state stays on screen. */
  minDisplay: Object.freeze({
    attention: 4000,
    error: 5000,
    sweeping: 5500,
    notification: 2500,
    carrying: 3000,
    waking: 1500,
    working: 1000,
    thinking: 1000,
  }),
  /** Time after which a one-shot state returns to the underlying state. */
  autoReturn: Object.freeze({
    attention: 4000,
    error: 5000,
    sweeping: 300000,
    notification: 2500,
    carrying: 3000,
    waking: 1500,
  }),
  /** Idle time before the sleep chain starts (yawning). */
  idleSleepMs: 180000,
  /** Time spent in each following sleep-chain state. */
  sleepStepMs: 30000,
  /** How long one `idle` animation plays before another is drawn. */
  idleAnimationMs: 12000,
  /** How long a click reaction holds the stage. */
  reactionMs: 2500,
})

/** Merge a theme's partial timings over the defaults. */
export function resolveTimings(themeTimings) {
  const source = themeTimings && typeof themeTimings === 'object' ? themeTimings : {}
  const merge = (key) => ({ ...DEFAULT_TIMINGS[key], ...(source[key] || {}) })
  return {
    minDisplay: merge('minDisplay'),
    autoReturn: merge('autoReturn'),
    idleSleepMs: numberOr(source.idleSleepMs, DEFAULT_TIMINGS.idleSleepMs),
    sleepStepMs: numberOr(source.sleepStepMs, DEFAULT_TIMINGS.sleepStepMs),
    idleAnimationMs: numberOr(source.idleAnimationMs, DEFAULT_TIMINGS.idleAnimationMs),
    reactionMs: numberOr(source.reactionMs, DEFAULT_TIMINGS.reactionMs),
  }
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Priority of a state name; unknown states sink below everything. */
export function priorityOf(state) {
  const value = STATE_PRIORITY[state]
  return typeof value === 'number' ? value : -1
}

/** True when the state shows once and then falls back. */
export function isOneshot(state) {
  return ONESHOT_STATES.includes(state)
}

/** Pick the highest-priority state out of a list of candidates. */
export function dominantState(candidates) {
  let best = null
  let bestPriority = -1
  for (const candidate of candidates) {
    if (!candidate) continue
    const priority = priorityOf(candidate)
    if (priority > bestPriority) {
      best = candidate
      bestPriority = priority
    }
  }
  return best
}

/**
 * The one-shot state a session event raises, if any.
 *
 * @param {string} type - session event type.
 * @param {object} data - the event's `data` payload.
 * @returns {{state: string, minDisplay?: number} | null}
 */
export function oneshotOfEvent(type, data) {
  const payload = data && typeof data === 'object' ? data : {}
  switch (type) {
    case 'tool/result':
      return payload.error || payload.message?.isError ? { state: 'error' } : null
    case 'turn/end': {
      const kind = payload.reason?.kind
      if (kind === 'completed' || kind === 'max-tokens') return { state: 'attention' }
      if (kind === 'error' || kind === 'blocked') return { state: 'error' }
      return null
    }
    default:
      return null
  }
}

/**
 * Fold one session event into a session record. Pure: it returns the same
 * record when the event carries no relevant signal, so callers can compare by
 * identity to skip work.
 *
 * @param {object} record - the session's activity record (see `createSessionRecord`).
 * @param {{type: string, seq: number, time: number, data: object}} event
 * @returns {object} the updated record.
 */
export function foldSessionEvent(record, event) {
  const type = event?.type
  const data = event?.data && typeof event.data === 'object' ? event.data : {}
  const at = typeof event?.time === 'number' ? event.time : Date.now()

  switch (type) {
    case 'turn/start':
      return { ...record, active: true, thinking: true, working: false, turn: data.turn ?? record.turn, toolCalls: new Set(), lastActivityAt: at }
    case 'step/start':
      return { ...record, active: true, thinking: true, lastActivityAt: at }
    case 'user/message':
      return { ...record, active: true, thinking: true, lastActivityAt: at }
    case 'assistant/message':
      return { ...record, thinking: false, active: true, lastActivityAt: at }
    case 'tool/call': {
      const toolCalls = new Set(record.toolCalls)
      if (data.callId !== undefined) toolCalls.add(String(data.callId))
      return { ...record, active: true, thinking: false, toolCalls, lastToolName: data.name ?? record.lastToolName, lastActivityAt: at }
    }
    case 'tool/result': {
      const toolCalls = new Set(record.toolCalls)
      if (data.message?.toolCallId !== undefined) toolCalls.delete(String(data.message.toolCallId))
      else toolCalls.clear()
      const failed = Boolean(data.error || data.message?.isError)
      return {
        ...record,
        active: true,
        toolCalls,
        thinking: toolCalls.size === 0,
        lastErrorAt: failed ? at : record.lastErrorAt,
        lastActivityAt: at,
      }
    }
    case 'turn/end':
      return { ...record, active: false, thinking: false, working: false, toolCalls: new Set(), lastTurnEndAt: at, lastActivityAt: at }
    case 'approval/asked': {
      const approvals = new Set(record.approvals)
      if (data.id !== undefined) approvals.add(String(data.id))
      return { ...record, approvals, approvalTool: data.toolName ?? record.approvalTool, lastActivityAt: at }
    }
    case 'approval/decided': {
      const approvals = new Set(record.approvals)
      if (data.id !== undefined) approvals.delete(String(data.id))
      return { ...record, approvals, lastActivityAt: at }
    }
    case 'compaction/start':
      return { ...record, compacting: true, lastActivityAt: at }
    case 'compaction/end':
    case 'compaction/summary':
      return { ...record, compacting: type === 'compaction/start', lastActivityAt: at }
    case 'session/title':
      return { ...record, title: data.title ?? record.title }
    default:
      return record
  }
}

/** A fresh activity record for one session. */
export function createSessionRecord(session) {
  const header = session?.header
  return {
    id: String(session?.id ?? header?.id ?? 'unknown'),
    title: undefined,
    cwd: header?.cwd,
    origin: header?.origin === 'subagent' ? 'subagent' : 'root',
    depth: header?.delegationDepth ?? 0,
    active: false,
    thinking: false,
    working: false,
    compacting: false,
    toolCalls: new Set(),
    approvals: new Set(),
    approvalTool: undefined,
    lastToolName: undefined,
    lastActivityAt: 0,
    lastTurnEndAt: 0,
    lastErrorAt: 0,
    turn: 0,
  }
}

/**
 * The state a single session currently implies, ignoring one-shot states.
 * @returns {string}
 */
export function sessionState(record) {
  if (record.approvals?.size) return 'notification'
  if (record.compacting) return 'sweeping'
  if (record.origin === 'subagent' && record.active) return 'juggling'
  if (record.toolCalls?.size) return 'working'
  if (record.active && record.thinking) return 'thinking'
  if (record.active) return 'working'
  return 'idle'
}

/** True while the record implies the agent is busy (used for tier counts). */
export function isBusy(record) {
  return Boolean(record.active)
}
