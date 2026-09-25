/**
 * The pet's runtime state machine.
 *
 * It is the only stateful part of the plugin: it folds DeepSeek Harness session
 * events (see `./state.js`) into per-session activity records, raises one-shot
 * states, runs the idle -> sleep chain, and resolves the single **dominant**
 * state the pet should wear. Everything is driven through an injectable clock
 * and timer so the whole thing is testable without a Harness.
 *
 * @module dsh-clawd/machine
 */

import {
  SLEEP_SEQUENCE,
  createSessionRecord,
  dominantState,
  foldSessionEvent,
  oneshotOfEvent,
  priorityOf,
  resolveTimings,
  sessionState,
} from './state.js'

/**
 * Priority at or below which a click reaction may take the stage. Reactions are
 * user-initiated, so they may cover routine states — including the transient
 * `attention` — but never compaction, a pending approval, or an error.
 */
const REACTION_CEILING = 5

export class ClawdMachine {
  #sessions = new Map()
  #oneshots = []
  #reaction = null
  #sleepIndex = 0
  #wasAsleep = false
  #idlePick = 0
  #idleAt = 0
  #idleAnimationCount = 1
  #timer = null
  #lastState = null
  #stateSince = 0
  #last = null
  #bootAt = 0
  #disposed = false

  /**
   * @param {object} [options]
   * @param {() => number} [options.now] injectable clock.
   * @param {(fn: () => void, ms: number) => unknown} [options.setTimeout] injectable timer.
   * @param {(id: unknown) => void} [options.clearTimeout] injectable cancel.
   * @param {(snapshot: object) => void} [options.onChange] called after every recomputation.
   * @param {(count: number) => number} [options.pickIdle] chooses the idle animation index.
   * @param {object} [options.timings] theme timings.
   */
  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now())
    this._setTimeout = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimeout = options.clearTimeout ?? ((id) => clearTimeout(id))
    this.onChange = options.onChange ?? (() => {})
    this.pickIdle = options.pickIdle ?? ((count) => Math.floor(Math.random() * count))
    this.timings = resolveTimings(options.timings)
    this.#bootAt = this.now()
    this.#stateSince = this.#bootAt
  }

  /** Install a theme's timings and idle-animation count. */
  setTheme({ timings, idleAnimationCount } = {}) {
    this.timings = resolveTimings(timings)
    const count = Number(idleAnimationCount)
    if (Number.isFinite(count) && count >= 1) this.#idleAnimationCount = Math.floor(count)
    this.recompute()
  }

  /** Register a live session (its header tells us whether it is a subagent). */
  sessionCreated(session) {
    const record = createSessionRecord(session)
    if (!this.#sessions.has(record.id)) this.#sessions.set(record.id, record)
    this.recompute()
  }

  /** Forget a session that left the store. */
  sessionDisposed(session) {
    const id = String(session?.id ?? session?.header?.id ?? '')
    if (id && this.#sessions.delete(id)) this.recompute()
  }

  /**
   * Fold one appended session event.
   * @param {object} session - the session whose log grew.
   * @param {{type: string, time?: number, data?: object}} event - the appended event.
   */
  sessionEvent(session, event) {
    if (this.#disposed) return
    const id = String(session?.id ?? session?.header?.id ?? 'unknown')
    const record = this.#sessions.get(id) ?? createSessionRecord(session)
    const next = foldSessionEvent(record, event)
    if (next !== record) this.#sessions.set(id, next)

    this.wake()
    const oneshot = oneshotOfEvent(event?.type, event?.data)
    if (oneshot) this.trigger(oneshot.state)
    else this.recompute()
  }

  /** Raise a one-shot state; a lower-priority one never preempts a fresh higher one. */
  trigger(state, overrides = {}) {
    if (!state) return
    const now = this.now()
    const minDisplay = overrides.minDisplay ?? this.timings.minDisplay[state] ?? 0
    const autoReturn = overrides.autoReturn ?? this.timings.autoReturn[state] ?? minDisplay
    const current = this.#topOneshot()
    if (current && priorityOf(current.state) > priorityOf(state) && now - current.at < current.minDisplay) return
    this.#oneshots = this.#oneshots.filter((entry) => entry.state !== state)
    this.#oneshots.push({ state, at: now, minDisplay, autoReturn })
    this.recompute()
  }

  /**
   * Show a click/drag reaction (artwork outside the state vocabulary) for a
   * moment, but never on top of an urgent state.
   */
  react(file, durationMs, kind = 'click') {
    if (!file) return
    this.#reaction = { file, kind, until: this.now() + (durationMs || this.timings.reactionMs) }
    this.recompute()
  }

  /** Any activity ends the sleep chain and plays `waking` once. */
  wake() {
    if (!this.#wasAsleep) return
    this.#wasAsleep = false
    this.#sleepIndex = 0
    const waking = this.timings.minDisplay.waking ?? 1500
    this.#oneshots = this.#oneshots.filter((entry) => entry.state !== 'waking')
    this.#oneshots.push({ state: 'waking', at: this.now(), minDisplay: waking, autoReturn: waking })
  }

  /** Recompute the dominant state, re-arm the timer, and publish a snapshot. */
  recompute() {
    if (this.#disposed) return
    const now = this.now()
    const snapshot = this.#resolve(now)
    if (snapshot.state !== this.#lastState) {
      this.#lastState = snapshot.state
      this.#stateSince = now
    }
    snapshot.since = this.#stateSince
    this.#last = snapshot
    this.#arm(now)
    this.onChange(snapshot)
  }

  /** The most recent snapshot; computes one on first use. */
  snapshot() {
    if (!this.#last) this.recompute()
    return this.#last
  }

  #resolve(now) {
    this.#oneshots = this.#oneshots.filter((entry) => now - entry.at < entry.autoReturn)
    if (this.#reaction && now >= this.#reaction.until) this.#reaction = null

    const records = [...this.#sessions.values()]
    const sessionCandidates = records.map(sessionState)
    const busyCount = records.filter((record) => record.active).length
    const workingCount = records.filter((record) => record.toolCalls?.size).length
    const subagentCount = records.filter((record) => record.origin === 'subagent' && record.active).length
    const lastActivityAt = records.reduce((max, record) => Math.max(max, record.lastActivityAt || 0), 0)
    // A machine that just started is not "idle since forever": the chain starts
    // counting from boot, so a fresh page load does not open asleep.
    const idleSince = Math.max(lastActivityAt, this.#bootAt)

    // --- idle -> sleep chain, computed from the idle age so it needs no timers of its own.
    const quiet = !sessionCandidates.some((state) => priorityOf(state) > 1)
    let sleepState = null
    if (quiet) {
      const idleAge = now - idleSince
      if (idleAge >= this.timings.idleSleepMs) {
        const step = Math.floor((idleAge - this.timings.idleSleepMs) / this.timings.sleepStepMs)
        this.#sleepIndex = Math.min(1 + step, SLEEP_SEQUENCE.length)
        sleepState = SLEEP_SEQUENCE[this.#sleepIndex - 1]
        this.#wasAsleep = true
      } else {
        this.#sleepIndex = 0
      }
    } else {
      this.#sleepIndex = 0
    }

    // --- idle animation rotation
    if (now - this.#idleAt >= this.timings.idleAnimationMs) {
      this.#idleAt = now
      this.#idlePick = this.#idleAnimationCount > 1 ? this.pickIdle(this.#idleAnimationCount) : 0
    }

    const oneshot = this.#topOneshot()
    // One-shots come first so that a priority tie (waking vs idle) favours them.
    const candidates = oneshot ? [oneshot.state, ...sessionCandidates] : [...sessionCandidates]
    let state = dominantState(candidates) ?? 'idle'
    // The sleep chain replaces a plain idle — it is what "idle" looks like after
    // a long quiet stretch, not a lower-priority competitor.
    if (sleepState && (state === 'idle' || state === 'roam')) state = sleepState

    const reaction = this.#reaction && priorityOf(state) <= REACTION_CEILING ? this.#reaction : null

    return {
      state,
      oneshot: Boolean(oneshot && oneshot.state === state),
      held: Boolean(oneshot && now - oneshot.at < oneshot.minDisplay),
      reaction: reaction ? { file: reaction.file, kind: reaction.kind } : null,
      idlePick: this.#idlePick,
      sleepIndex: this.#sleepIndex,
      busyCount,
      workingCount,
      subagentCount,
      sessionCount: records.length,
      sessions: records
        .filter((record) => record.active || record.approvals?.size)
        .slice(0, 8)
        .map((record) => ({
          id: record.id,
          title: record.title,
          origin: record.origin,
          state: sessionState(record),
          tool: record.lastToolName,
        })),
    }
  }

  #topOneshot() {
    let best = null
    for (const entry of this.#oneshots) {
      if (!best || priorityOf(entry.state) > priorityOf(best.state)) best = entry
    }
    return best
  }

  /** Arm one timer for the nearest upcoming transition. */
  #arm(now) {
    if (this.#timer !== null) {
      this._clearTimeout(this.#timer)
      this.#timer = null
    }
    const deadlines = []
    for (const entry of this.#oneshots) deadlines.push(entry.at + entry.autoReturn)
    if (this.#reaction) deadlines.push(this.#reaction.until)
    deadlines.push(this.#idleAt + this.timings.idleAnimationMs)

    const records = [...this.#sessions.values()]
    const quiet = !records.some((record) => priorityOf(sessionState(record)) > 1)
    if (quiet) {
      const lastActivityAt = Math.max(
        records.reduce((max, record) => Math.max(max, record.lastActivityAt || 0), 0),
        this.#bootAt,
      )
      deadlines.push(lastActivityAt + this.timings.idleSleepMs + this.#sleepIndex * this.timings.sleepStepMs)
    }

    const next = deadlines.filter((value) => Number.isFinite(value) && value > now).sort((a, b) => a - b)[0]
    if (next === undefined) return
    this.#timer = this._setTimeout(() => {
      this.#timer = null
      this.recompute()
    }, Math.max(50, Math.min(next - now, 60000)))
  }

  /** Stop the machine and release its timer. */
  dispose() {
    this.#disposed = true
    if (this.#timer !== null) {
      this._clearTimeout(this.#timer)
      this.#timer = null
    }
  }
}
