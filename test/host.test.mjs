#!/usr/bin/env node
/**
 * Integration tests for the host half.
 *
 * `lib/index.js` is a plain Cordis plugin: `apply(ctx, config)` registers one
 * prefix route plus a handful of event listeners. This suite gives it a stub
 * context (route capture, listener table, effect tracking) and a real HTTP
 * server, then exercises every route the browser half uses — no Harness and no
 * profile install required.
 *
 * Run with `npm test`.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-clawd-home-'))
process.env.DSH_HOME = sandboxHome

const { apply, sanitizeSettings } = await import('../lib/index.js')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A stub Cordis context: enough surface for a Web plugin, nothing more. */
function stubContext() {
  const listeners = new Map()
  const disposers = []
  const routes = []
  return {
    ctx: {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      get: () => undefined,
      on(name, listener) {
        if (!listeners.has(name)) listeners.set(name, [])
        listeners.get(name).push(listener)
        return () => {}
      },
      effect(callback) {
        const disposer = callback()
        if (typeof disposer === 'function') disposers.push(disposer)
        return () => {}
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
        tapIndex: () => () => {},
      },
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
    routes,
    dispose() {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
}

async function startServer(routes) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    for (const route of routes) {
      // Mirrors dsh-host-webserver's matchPrefix: `pathname === prefix ||
      // pathname.startsWith(prefix + '/')`.
      const matches =
        route.kind === 'prefix'
          ? url.pathname === route.path || url.pathname.startsWith(`${route.path}/`)
          : url.pathname === route.path
      if (matches) {
        void route.handler(req, res)
        return
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

const session = (id, origin) => ({ id, header: { id, origin, cwd: '/tmp/project' } })
const event = (type, data = {}) => ({ type, time: Date.now(), data })

/** `fetch` refuses to set a forbidden header such as Host, so forge it with raw http. */
function rawStatus(base, pathname, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(base)
    const request = http.request(
      { hostname: target.hostname, port: target.port, path: pathname, method: 'GET', headers },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      },
    )
    request.on('error', reject)
    request.end()
  })
}

test('the host half serves state, artwork, settings and a live feed', async (t) => {
  const harness = stubContext()
  apply(harness.ctx, { theme: 'placeholder', size: 120 })
  assert.equal(harness.routes.length, 1, 'exactly one prefix route is registered')
  assert.equal(harness.routes[0].path, '/dsh-clawd', "the mount carries no trailing slash: the web server's prefix rule appends its own")

  const { server, base } = await startServer(harness.routes)
  t.after(() => {
    server.close()
    harness.dispose()
  })

  await t.test('state.json describes the pet, the theme and its artwork', async () => {
    const response = await fetch(`${base}/dsh-clawd/state.json`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const payload = await response.json()
    assert.equal(payload.state, 'idle')
    assert.equal(payload.theme.id, 'placeholder')
    assert.equal(payload.settings.size, 120)
    assert.match(payload.asset.url, /^\/dsh-clawd\/art\/placeholder\/.+\.svg\?rev=[0-9a-f]+$/)
    assert.ok(payload.themes.some((theme) => theme.id === 'placeholder'))
    assert.ok(payload.preload.length > 0)
    assert.equal(payload.counts.sessions, 0)
  })

  await t.test('artwork is served from the manifest table, never from the request path', async () => {
    const response = await fetch(`${base}/dsh-clawd/art/placeholder/idle.svg`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/svg+xml')
    assert.match(response.headers.get('cache-control'), /immutable/)
    const body = await response.text()
    assert.match(body, /^<svg /)

    for (const attempt of [
      '/dsh-clawd/art/placeholder/%2e%2e%2f%2e%2e%2ftheme.json',
      '/dsh-clawd/art/placeholder/theme.json',
      '/dsh-clawd/art/placeholder/../../package.json',
      '/dsh-clawd/art/nope/idle.svg',
    ]) {
      const denied = await fetch(`${base}${attempt}`)
      assert.equal(denied.status, 404, `${attempt} must not resolve`)
    }
  })

  await t.test('the trust fence refuses a forged Host and a cross-site Origin', async () => {
    assert.equal(await rawStatus(base, '/dsh-clawd/state.json', { Host: 'evil.example.com' }), 403)
    assert.equal(await rawStatus(base, '/dsh-clawd/state.json', { Host: '127.0.0.1.evil.example.com' }), 403)

    const crossOrigin = await fetch(`${base}/dsh-clawd/state.json`, { headers: { Origin: 'http://evil.example.com' } })
    assert.equal(crossOrigin.status, 403)

    const crossSite = await fetch(`${base}/dsh-clawd/state.json`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(crossSite.status, 403)
  })

  await t.test('session events move the pet', async () => {
    harness.emit('session/created', session('s-1'))
    harness.emit('session/event', session('s-1'), event('turn/start', { turn: 1 }))
    await wait(120)
    let payload = await (await fetch(`${base}/dsh-clawd/state.json`)).json()
    assert.equal(payload.state, 'thinking')
    assert.equal(payload.counts.busy, 1)

    harness.emit('session/event', session('s-1'), event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read' }))
    await wait(120)
    payload = await (await fetch(`${base}/dsh-clawd/state.json`)).json()
    assert.equal(payload.state, 'working')
    assert.equal(payload.counts.working, 1)

    harness.emit('session/event', session('s-1'), event('approval/asked', { id: 'a1', toolName: 'bash' }))
    await wait(120)
    payload = await (await fetch(`${base}/dsh-clawd/state.json`)).json()
    assert.equal(payload.state, 'notification')

    harness.emit('session/event', session('s-1'), event('approval/decided', { id: 'a1', outcome: 'allowed-once' }))
    harness.emit('session/event', session('s-1'), event('turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await wait(120)
    payload = await (await fetch(`${base}/dsh-clawd/state.json`)).json()
    assert.equal(payload.state, 'attention')

    harness.emit('session/disposed', session('s-1'))
    await wait(120)
  })

  await t.test('the live route streams the same payload as SSE', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/dsh-clawd/live`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const reader = response.body.getReader()
    const { value } = await reader.read()
    const text = new TextDecoder().decode(value)
    assert.match(text, /^retry: 2000\n\n/)
    const dataLine = text.split('\n').find((line) => line.startsWith('data: '))
    assert.ok(dataLine, 'a first frame arrives immediately')
    const payload = JSON.parse(dataLine.slice(6))
    assert.equal(payload.theme.id, 'placeholder')
    controller.abort()
  })

  await t.test('settings writes are clamped and persisted, reactions are theme-driven', async () => {
    const written = await fetch(`${base}/dsh-clawd/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: 9999, opacity: 0.5, theme: 'placeholder', position: { x: 12.4, y: -3.6 }, junk: true }),
    })
    assert.equal(written.status, 200)
    const result = await written.json()
    assert.equal(result.settings.size, 480, 'size is clamped to the schema maximum')
    assert.equal(result.settings.opacity, 0.5)
    assert.deepEqual(result.settings.position, { x: 12, y: -4 })
    assert.equal('junk' in result.settings, false)

    const onDisk = JSON.parse(fs.readFileSync(path.join(sandboxHome, 'dsh-clawd', 'settings.json'), 'utf8'))
    assert.equal(onDisk.version, 1)
    assert.equal(onDisk.size, 480)

    const reaction = await fetch(`${base}/dsh-clawd/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'clickLeft' }),
    })
    assert.equal(reaction.status, 200)
    const reacted = await reaction.json()
    assert.equal(reacted.ok, true, 'the placeholder theme declares a clickLeft reaction')
    assert.equal(reacted.payload.asset.kind, 'reaction')

    // A drag pose is held: it must survive any theme duration and end on release.
    const held = await (
      await fetch(`${base}/dsh-clawd/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'drag', phase: 'hold' }),
      })
    ).json()
    assert.equal(held.held, true)
    assert.equal(held.payload.asset.kind, 'reaction')
    assert.match(held.payload.asset.file, /carrying\.svg$/)

    const released = await (
      await fetch(`${base}/dsh-clawd/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'drag', phase: 'release' }),
      })
    ).json()
    assert.equal(released.ok, true)
    assert.equal(released.payload.asset.kind, 'state', 'the pet returns to its state after the drag')

    const broken = await fetch(`${base}/dsh-clawd/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.equal(broken.status, 400)
  })

  await t.test('themes.json lists what was discovered, and refresh re-reads the roots', async () => {
    const listed = await (await fetch(`${base}/dsh-clawd/themes.json`)).json()
    assert.equal(listed.active, 'placeholder', 'the configured theme wins over the built-in default order')
    assert.ok(listed.themes.some((theme) => theme.id === 'placeholder'))
    // Local-only artwork may or may not be linked on this machine.
    assert.ok(listed.themes.every((theme) => ['builtin', 'local', 'user'].includes(theme.source)))
    assert.deepEqual(listed.diagnostics, [])

    const refreshed = await fetch(`${base}/dsh-clawd/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(refreshed.status, 200)
    assert.deepEqual((await refreshed.json()).theme, 'placeholder')
  })

  await t.test('unknown routes answer 404 with an explanation', async () => {
    const response = await fetch(`${base}/dsh-clawd/nope`)
    assert.equal(response.status, 404)
    assert.match((await response.json()).error, /no dsh-clawd route/)
  })
})

test('sanitizeSettings is the single gate for stored configuration', () => {
  assert.deepEqual(sanitizeSettings({ enabled: 'yes', size: 'big', theme: '  ', position: { x: 1 } }), {})
  assert.deepEqual(sanitizeSettings({ theme: 'clawd', sounds: true, position: null }), { theme: 'clawd', sounds: true, position: null })
  assert.deepEqual(sanitizeSettings(null), {})
})
