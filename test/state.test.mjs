#!/usr/bin/env node
/**
 * Behavioural tests for the state table and the state machine.
 *
 * Run with `npm test` (`node --test test/`). The machine takes an injected clock
 * and timer, so every timing rule below is asserted without waiting.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ClawdMachine } from '../lib/machine.js'
import { foldSessionEvent, createSessionRecord, sessionState, priorityOf } from '../lib/state.js'

/** A machine whose clock is ours to move and whose timers never fire on their own. */
function bench() {
  const state = { now: 1_000_000 }
  const snapshots = []
  const machine = new ClawdMachine({
    now: () => state.now,
    setTimeout: () => 0,
    clearTimeout: () => {},
    onChange: (snapshot) => snapshots.push(snapshot),
  })
  return {
    machine,
    snapshots,
    at: () => state.now,
    advance(ms) {
      state.now += ms
      machine.recompute()
    },
  }
}

const session = (id, origin) => ({ id, header: { id, origin, cwd: '/tmp' } })
const event = (type, data = {}) => ({ type, time: 1_000_000, data })

test('session folding: a turn walks thinking -> working -> idle', () => {
  let record = createSessionRecord(session('s1'))
  assert.equal(sessionState(record), 'idle')

  record = foldSessionEvent(record, event('turn/start', { turn: 1 }))
  assert.equal(sessionState(record), 'thinking')

  record = foldSessionEvent(record, event('tool/call', { callId: 'c1', name: 'read' }))
  assert.equal(sessionState(record), 'working')
  assert.equal(record.lastToolName, 'read')

  const concurrent = foldSessionEvent(record, event('tool/call', { callId: 'c2', name: 'grep' }))
  assert.equal(concurrent.toolCalls.size, 2)

  const afterOne = foldSessionEvent(concurrent, event('tool/result', { message: { toolCallId: 'c1' } }))
  assert.equal(sessionState(afterOne), 'working')

  const done = foldSessionEvent(afterOne, event('tool/result', { message: { toolCallId: 'c2' } }))
  assert.equal(sessionState(done), 'thinking')

  const ended = foldSessionEvent(done, event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(sessionState(ended), 'idle')
})

test('folding is identity-preserving for irrelevant events', () => {
  const record = createSessionRecord(session('s1'))
  assert.equal(foldSessionEvent(record, event('request/header', {})), record)
})

test('turn/end completed raises a one-shot attention that returns to idle', () => {
  const b = bench()
  b.machine.sessionCreated(session('s1'))
  b.machine.sessionEvent(session('s1'), event('turn/start', { turn: 1 }))
  assert.equal(b.machine.snapshot().state, 'thinking')

  b.machine.sessionEvent(session('s1'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(b.machine.snapshot().state, 'attention')
  assert.equal(b.machine.snapshot().oneshot, true)

  b.advance(1500)
  assert.equal(b.machine.snapshot().state, 'attention', 'minDisplay holds the state')

  b.advance(4000)
  assert.equal(b.machine.snapshot().state, 'idle')
})

test('a failing tool result raises error, which outranks a pending attention', () => {
  const b = bench()
  b.machine.sessionCreated(session('s1'))
  b.machine.sessionEvent(session('s1'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  assert.equal(b.machine.snapshot().state, 'attention')

  b.machine.sessionEvent(session('s1'), event('tool/result', { error: { name: 'E', code: 'x' } }))
  assert.equal(b.machine.snapshot().state, 'error')

  b.advance(5000)
  assert.equal(b.machine.snapshot().state, 'thinking', 'the failed tool call left the session mid-turn')
})

test('a turn that ends in error shows error, not attention', () => {
  const b = bench()
  b.machine.sessionCreated(session('s1'))
  b.machine.sessionEvent(session('s1'), event('turn/start', { turn: 1 }))
  b.machine.sessionEvent(session('s1'), event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } }))
  assert.equal(b.machine.snapshot().state, 'error')
})

test('approval/asked holds notification until approval/decided', () => {
  const b = bench()
  b.machine.sessionCreated(session('s1'))
  b.machine.sessionEvent(session('s1'), event('turn/start', { turn: 1 }))
  b.machine.sessionEvent(session('s1'), event('tool/call', { callId: 'c1', name: 'bash' }))
  assert.equal(b.machine.snapshot().state, 'working')

  b.machine.sessionEvent(session('s1'), event('approval/asked', { id: 'a1', toolName: 'bash' }))
  assert.equal(b.machine.snapshot().state, 'notification')
  b.advance(60000)
  assert.equal(b.machine.snapshot().state, 'notification', 'a held state does not expire')

  b.machine.sessionEvent(session('s1'), event('approval/decided', { id: 'a1', outcome: 'allowed-once' }))
  assert.equal(b.machine.snapshot().state, 'working')
})

test('compaction holds sweeping, and a subagent session shows juggling', () => {
  const b = bench()
  b.machine.sessionCreated(session('parent'))
  b.machine.sessionEvent(session('parent'), event('turn/start', { turn: 1 }))
  b.machine.sessionEvent(session('parent'), event('compaction/start', { compactionId: 'k1', turn: 1 }))
  assert.equal(b.machine.snapshot().state, 'sweeping')

  b.machine.sessionEvent(session('child', 'subagent'), event('turn/start', { turn: 1 }))
  assert.equal(b.machine.snapshot().subagentCount, 1)
  assert.equal(b.machine.snapshot().state, 'sweeping', 'sweeping outranks juggling')

  b.machine.sessionEvent(session('parent'), event('compaction/end', { compactionId: 'k1' }))
  assert.equal(b.machine.snapshot().state, 'juggling')
})

test('the dominant state is the highest priority over every session', () => {
  const b = bench()
  b.machine.sessionCreated(session('a'))
  b.machine.sessionCreated(session('b'))
  b.machine.sessionEvent(session('a'), event('tool/call', { callId: 'c1', name: 'read' }))
  b.machine.sessionEvent(session('b'), event('turn/start', { turn: 1 }))
  const snapshot = b.machine.snapshot()
  assert.equal(snapshot.state, 'working')
  assert.equal(snapshot.counts?.sessions ?? snapshot.sessionCount, 2)
  assert.equal(priorityOf('working') > priorityOf('thinking'), true)
})

test('idle drifts through the sleep chain and any activity wakes it', () => {
  const b = bench({})
  b.machine.sessionCreated(session('s1'))
  b.machine.sessionEvent(session('s1'), event('turn/start', { turn: 1 }))
  b.machine.sessionEvent(session('s1'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
  b.advance(5000)
  assert.equal(b.machine.snapshot().state, 'idle')

  b.advance(180000)
  assert.equal(b.machine.snapshot().state, 'yawning')
  b.advance(30000)
  assert.equal(b.machine.snapshot().state, 'dozing')
  b.advance(30000)
  assert.equal(b.machine.snapshot().state, 'collapsing')
  b.advance(30000)
  assert.equal(b.machine.snapshot().state, 'sleeping')
  b.advance(600000)
  assert.equal(b.machine.snapshot().state, 'sleeping')

  b.machine.sessionEvent(session('s1'), event('turn/start', { turn: 2 }))
  assert.equal(b.machine.snapshot().state, 'thinking', 'waking is outranked by real work')
})

test('a session that leaves the store stops counting', () => {
  const b = bench()
  b.machine.sessionCreated(session('s1'))
  b.machine.sessionEvent(session('s1'), event('tool/call', { callId: 'c1', name: 'read' }))
  assert.equal(b.machine.snapshot().state, 'working')
  b.machine.sessionDisposed(session('s1'))
  assert.equal(b.machine.snapshot().state, 'idle')
})

test('reactions never cover an urgent state', () => {
  const b = bench()
  b.machine.sessionCreated(session('s1'))
  b.machine.sessionEvent(session('s1'), event('approval/asked', { id: 'a1', toolName: 'bash' }))
  b.machine.react('clawd-react-left.svg', 2000)
  assert.equal(b.machine.snapshot().reaction, null)

  b.machine.sessionEvent(session('s1'), event('approval/decided', { id: 'a1', outcome: 'rejected' }))
  b.machine.react('clawd-react-left.svg', 2000)
  assert.equal(b.machine.snapshot().reaction?.file, 'clawd-react-left.svg')
  b.advance(2100)
  assert.equal(b.machine.snapshot().reaction, null)
})
