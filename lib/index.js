/**
 * dsh-clawd — host half.
 *
 * Owns everything that needs the Node side of the Harness:
 *   * folds `session/event` into the pet's single dominant state (via `./machine.js`),
 *   * discovers, validates and serves theme manifests and artwork,
 *   * persists the pet's settings and position under `$DSH_HOME/dsh-clawd/`,
 *   * exposes one read-only state feed and two guarded write routes under
 *     `/dsh-clawd/`, which is all the browser half needs.
 *
 * The browser half (`./client.js`) renders and nothing else: it has no copy of
 * the state table and computes no state of its own.
 *
 * The host half deliberately imports **nothing but Node built-ins**, so the
 * plugin works when installed with `link:` from a checkout that has no
 * `node_modules` of its own.
 *
 * @module dsh-clawd
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { ClawdMachine } from './machine.js'
import { DEFAULT_TIMINGS, resolveTimings } from './state.js'
import { discoverThemes, filesForState, poseFileFor, resolveArtFile, themeFiles, tierFilesFor } from './theme.js'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_VERSION = readPackageVersion()

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(DSH_HOME, 'dsh-clawd')
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json')

/**
 * The route mount and the URL prefix are deliberately different strings: the
 * web server's prefix table matches `pathname === prefix || startsWith(prefix + '/')`
 * (dsh-host-webserver `matchPrefix`), so mounting with a trailing slash would
 * only ever answer the bare `/dsh-clawd/` and 404 everything below it.
 */
const ROUTE_MOUNT = '/dsh-clawd'
const ROUTE_PREFIX = `${ROUTE_MOUNT}/`
const SETTINGS_VERSION = 1
const MAX_BODY_BYTES = 16 * 1024
const SSE_HEARTBEAT_MS = 15000
const PUBLISH_DEBOUNCE_MS = 40

/** Values a settings write may carry, with the clamp each one gets. */
const SETTINGS_SHAPE = Object.freeze({
  enabled: { kind: 'boolean', fallback: true },
  theme: { kind: 'string', fallback: null, nullable: true },
  size: { kind: 'number', fallback: 64, min: 48, max: 480, integer: true },
  opacity: { kind: 'number', fallback: 1, min: 0.2, max: 1 },
  sounds: { kind: 'boolean', fallback: false },
  showStatus: { kind: 'boolean', fallback: true },
  position: { kind: 'position', fallback: null, nullable: true },
})

const CONTENT_TYPES = Object.freeze({
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // APNG is a PNG extension: image/png is what every browser decodes, and the
  // animation still plays. image/apng is the RFC-correct type but less portable.
  '.apng': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
})

/** Hard dependency: without the browser carrier there is nothing to render into. */
export const inject = ['webServer']

/**
 * Host half entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] - the row's `config` from `cordis.patch.yml`.
 */
export function apply(ctx, config = {}) {
  const log = (level, message) => {
    const logger = ctx.logger
    const text = `[dsh-clawd] ${message}`
    if (logger && typeof logger[level] === 'function') logger[level](text)
    else if (level !== 'debug' && level !== 'info') console.warn(text)
  }

  const settings = loadSettings(config)
  let themeRegistry = loadThemes()
  let settingsRev = 1
  let rev = 0
  let fingerprint = ''
  let pendingPublish = null
  let lastPayload = null
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set()

  const machine = new ClawdMachine({
    // The pet's own scheduler must never be the reason a Node process stays
    // alive: a host that only holds this plugin open (an installer, a verifier,
    // a CLI) should exit on its own.
    setTimeout: (callback, ms) => {
      const timer = setTimeout(callback, ms)
      timer.unref?.()
      return timer
    },
    clearTimeout: (timer) => clearTimeout(timer),
    onChange: () => schedulePublish(),
    timings: activeTheme()?.manifest?.timings,
    idleAnimationCount: activeTheme()?.manifest?.idleAnimations?.length ?? 1,
  })

  // ---------------------------------------------------------------- themes ---

  function themeRoots() {
    return [
      { dir: path.join(PACKAGE_ROOT, 'assets', 'themes'), source: 'builtin' },
      { dir: path.join(PACKAGE_ROOT, 'assets', 'local-themes'), source: 'local' },
      { dir: path.join(STATE_DIR, 'themes'), source: 'user' },
      { dir: path.join(DSH_HOME, 'dsh-clawd-themes'), source: 'user' },
    ]
  }

  /** Discover themes and build the artwork table the routes serve from. */
  function loadThemes() {
    const { themes, diagnostics } = discoverThemes(themeRoots())
    const table = new Map()
    for (const theme of themes.values()) {
      const files = new Map()
      let rev = createHash('sha1').update(JSON.stringify(theme.manifest)).digest('hex').slice(0, 12)
      for (const file of themeFiles(theme.manifest)) {
        const abs = resolveArtFile(theme, file)
        if (!abs) continue
        let stat
        try {
          stat = fs.statSync(abs)
        } catch {
          continue
        }
        const contentType = CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream'
        files.set(file, { abs, contentType, size: stat.size, mtimeMs: stat.mtimeMs })
        rev = createHash('sha1').update(`${rev}:${file}:${stat.size}:${stat.mtimeMs}`).digest('hex').slice(0, 12)
      }
      theme.rev = rev
      theme.files = files
      table.set(theme.id, theme)
    }
    for (const diagnostic of diagnostics) {
      log('warn', `theme "${diagnostic.id}" ignored: ${diagnostic.errors.join('; ')}`)
    }
    return { themes: table, diagnostics }
  }

  /** The theme in force: the configured one when it exists, else the first discovered. */
  function activeTheme() {
    const wanted = settings.theme
    if (wanted && themeRegistry.themes.has(wanted)) return themeRegistry.themes.get(wanted)
    const first = themeRegistry.themes.values().next()
    return first.done ? null : first.value
  }

  function refreshThemes(reason) {
    themeRegistry = loadThemes()
    const theme = activeTheme()
    machine.setTheme({ timings: theme?.manifest?.timings, idleAnimationCount: theme?.manifest?.idleAnimations?.length ?? 1 })
    log('info', `themes reloaded (${reason}): ${[...themeRegistry.themes.keys()].join(', ') || 'none'}`)
    publish(true)
    return theme
  }

  // -------------------------------------------------------------- settings ---

  function loadSettings(rowConfig) {
    const fromRow = sanitizeSettings(rowConfig)
    let fromDisk = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.version === SETTINGS_VERSION) fromDisk = sanitizeSettings(parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT') log('warn', `settings file ignored: ${error.message}`)
    }
    return { ...defaultsOf(), ...fromRow, ...fromDisk }
  }

  function persistSettings() {
    const body = JSON.stringify({ version: SETTINGS_VERSION, ...settings }, null, 2)
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      const staging = `${SETTINGS_FILE}.${process.pid}.tmp`
      fs.writeFileSync(staging, body, 'utf8')
      fs.renameSync(staging, SETTINGS_FILE)
    } catch (error) {
      log('warn', `settings could not be saved: ${error.message}`)
    }
  }

  function updateSettings(patch) {
    const next = sanitizeSettings(patch)
    let changed = false
    for (const [key, value] of Object.entries(next)) {
      if (JSON.stringify(settings[key]) !== JSON.stringify(value)) {
        settings[key] = value
        changed = true
      }
    }
    if (!changed) return false
    settingsRev += 1
    persistSettings()
    if (next.theme !== undefined) {
      const theme = activeTheme()
      machine.setTheme({ timings: theme?.manifest?.timings, idleAnimationCount: theme?.manifest?.idleAnimations?.length ?? 1 })
    }
    publish(true)
    return true
  }

  // --------------------------------------------------------------- payload ---

  /** Rotate the idle pool from `pick`, so a broken pool entry is skipped. */
  function rotate(list, pick) {
    if (list.length < 2) return [...list]
    const start = Math.abs(pick) % list.length
    return [...list.slice(start), ...list.slice(0, start)]
  }

  /** The first candidate that this theme can actually show. */
  function firstUsable(theme, candidates) {
    const blocked = theme.unrenderable ?? new Set()
    return candidates.find((file) => file && !blocked.has(file)) ?? candidates.find(Boolean)
  }

  function assetOf(snapshot) {
    const theme = activeTheme()
    if (!theme || !settings.enabled) return null
    if (snapshot.reaction?.file) return assetFor(theme, firstUsable(theme, [snapshot.reaction.file]), 'reaction')

    // Busy states may wear tier artwork (1 / 2 / 3+ sessions); a theme without
    // tiers, or below the lowest threshold, falls back to the state's own file.
    const count = snapshot.state === 'juggling' ? snapshot.subagentCount : snapshot.workingCount
    // A tool the theme dresses specifically — `job_output` reading versus parked
    // on a long poll — outranks the generic busy artwork, and falls through to
    // it whenever the theme has nothing for that tool.
    const pose =
      snapshot.state === 'working'
        ? poseFileFor(theme.manifest, snapshot.tool, { longWaitMs: resolveTimings(theme.manifest.timings).longWaitMs })
        : undefined
    const candidates = [
      pose,
      ...tierFilesFor(theme.manifest, snapshot.state, count),
      ...(snapshot.state === 'idle' ? rotate((theme.manifest.idleAnimations ?? []).map((entry) => entry.file), snapshot.idlePick) : []),
      ...rotate(filesForState(theme.manifest, snapshot.state), snapshot.idlePick),
      // A theme that maps no artwork — or only artwork an audit measured as
      // painting nothing — must not make the pet vanish: show the idle pose.
      ...rotate(filesForState(theme.manifest, 'idle'), snapshot.idlePick),
    ]
    const asset = assetFor(theme, firstUsable(theme, candidates), 'state')
    return asset
  }

  function assetFor(theme, file, kind) {
    if (!file) return null
    const entry = theme.files.get(file)
    if (!entry) return null
    const box = theme.manifest.viewBox ?? { x: 0, y: 0, width: 64, height: 64 }
    return {
      kind,
      file,
      theme: theme.id,
      url: `${ROUTE_PREFIX}art/${encodeURIComponent(theme.id)}/${encodeURIComponent(file)}?rev=${theme.rev}`,
      width: box.width,
      height: box.height,
      aspect: box.width / box.height,
    }
  }

  function preloadOf(theme) {
    if (!theme) return []
    const urls = new Set()
    for (const state of ['idle', 'thinking', 'working', 'attention', 'error', 'notification']) {
      const candidates = [...filesForState(theme.manifest, state), ...filesForState(theme.manifest, 'idle')]
      const asset = assetFor(theme, firstUsable(theme, candidates), 'state')
      if (asset) urls.add(asset.url)
    }
    return [...urls]
  }

  function payload() {
    const snapshot = machine.snapshot()
    const theme = activeTheme()
    const timings = { ...DEFAULT_TIMINGS, ...(theme?.manifest?.timings ?? {}) }
    return {
      rev,
      state: snapshot.state,
      since: snapshot.since,
      oneshot: snapshot.oneshot,
      idlePick: snapshot.idlePick,
      counts: {
        sessions: snapshot.sessionCount,
        busy: snapshot.busyCount,
        working: snapshot.workingCount,
        subagents: snapshot.subagentCount,
      },
      sessions: snapshot.sessions,
      theme: theme
        ? {
            id: theme.id,
            name: theme.manifest.name ?? theme.id,
            source: theme.source,
            rev: theme.rev,
            objectScale: theme.manifest.objectScale ?? null,
            viewBox: theme.manifest.viewBox ?? null,
            contentBox: theme.manifest.contentBox ?? null,
          }
        : null,
      themes: [...themeRegistry.themes.values()].map((entry) => ({ id: entry.id, name: entry.manifest.name ?? entry.id, source: entry.source })),
      asset: assetOf(snapshot),
      preload: preloadOf(theme),
      settings: { ...settings },
      timings: { reactionMs: timings.reactionMs, idleAnimationMs: timings.idleAnimationMs },
      owner: typeof process.env.HDSL_ACCOUNT_NAME === 'string' && process.env.HDSL_ACCOUNT_NAME ? process.env.HDSL_ACCOUNT_NAME : null,
      version: PACKAGE_VERSION,
    }
  }

  /** Publish when the rendered result changed; `force` also bumps the revision. */
  function publish(force = false) {
    const next = payload()
    const print = JSON.stringify([next.state, next.asset?.url ?? null, next.settings, next.theme?.rev ?? null, next.counts, next.sessions])
    if (!force && print === fingerprint) {
      lastPayload = next
      return
    }
    fingerprint = print
    rev += 1
    next.rev = rev
    lastPayload = next
    broadcast(next)
  }

  function schedulePublish() {
    if (pendingPublish !== null) return
    pendingPublish = setTimeout(() => {
      pendingPublish = null
      publish()
    }, PUBLISH_DEBOUNCE_MS)
    pendingPublish.unref?.()
  }

  function broadcast(next) {
    const frame = `data: ${JSON.stringify(next)}\n\n`
    for (const stream of streams) {
      try {
        stream.write(frame)
      } catch {
        streams.delete(stream)
      }
    }
  }

  // ---------------------------------------------------------------- routes ---

  /**
   * Why a request to `/dsh-clawd/*` must be refused, or undefined when it may
   * proceed. A plugin route is *not* behind the host's `/api` fence, so it
   * borrows the host's own check and falls back to a loopback + same-origin
   * check when that service is absent.
   */
  function refusalOf(req) {
    const headers = req?.headers ?? {}
    const host = typeof headers.host === 'string' ? headers.host : ''
    let hostUrl
    try {
      hostUrl = new URL(`http://${host}`)
    } catch {
      return 403
    }
    if (!isLoopback(hostUrl.hostname)) return 403
    const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
    if (site === 'cross-site') return 403
    if (typeof headers.origin === 'string' && headers.origin && headers.origin !== 'null') {
      try {
        if (new URL(headers.origin).host !== hostUrl.host) return 403
      } catch {
        return 403
      }
    }
    try {
      const connection = ctx.get('connection')
      if (typeof connection?.requestRejection === 'function') {
        const code = connection.requestRejection(req)
        if (code !== undefined && code !== null && code !== false) return typeof code === 'number' ? code : 403
      }
    } catch (error) {
      log('warn', `trust fence failed, refusing the request: ${error?.message ?? error}`)
      return 403
    }
    return undefined
  }

  async function route(req, res) {
    try {
      await dispatch(req, res)
    } catch (error) {
      // A route must never take the web server down with it.
      log('warn', `route ${req.method} ${req.url} failed: ${error?.stack ?? error}`)
      try {
        if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
        else res.end()
      } catch {
        /* the response is already gone */
      }
    }
  }

  async function dispatch(req, res) {
    const rejection = refusalOf(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const rest = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : ''
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (rest === 'state.json') return sendJson(res, 200, payload(), req.method === 'HEAD')
      if (rest === 'live') return openStream(req, res)
      if (rest === 'themes.json') {
        return sendJson(res, 200, {
          active: activeTheme()?.id ?? null,
          diagnostics: themeRegistry.diagnostics,
          themes: [...themeRegistry.themes.values()].map((theme) => ({
            id: theme.id,
            name: theme.manifest.name ?? theme.id,
            author: theme.manifest.author ?? null,
            version: theme.manifest.version ?? null,
            description: theme.manifest.description ?? null,
            source: theme.source,
            rev: theme.rev,
            states: Object.keys(theme.manifest.states ?? {}),
          })),
        })
      }
      if (rest.startsWith('art/')) return sendArt(res, rest.slice(4), req.method === 'HEAD')
    }
    if (req.method === 'POST') {
      if (rest === 'settings') return handleWrite(req, res, (body) => {
        if (body?.reset === true) {
          updateSettings({ ...defaultsOf(), theme: settings.theme })
          return { ok: true, settings: { ...settings } }
        }
        updateSettings(body ?? {})
        return { ok: true, settings: { ...settings } }
      })
      if (rest === 'react') return handleWrite(req, res, (body) => {
        const theme = activeTheme()
        const kind = typeof body?.kind === 'string' ? body.kind : 'click'
        const phase = typeof body?.phase === 'string' ? body.phase : 'play'
        const entry = theme?.manifest?.reactions?.[kind]
        const file = Array.isArray(entry) ? entry[0] : (entry?.file ?? (Array.isArray(entry?.files) ? entry.files[0] : null))
        // `hold`/`release` model a reaction that lasts as long as the user holds
        // something (a drag pose), so its length is the gesture's: the reference
        // theme declares no `duration` for `drag` while every click reaction has
        // one. A declared duration is therefore ignored here — the machine's own
        // safety cap covers a pointerup the browser never delivers.
        if (phase === 'release') {
          const released = machine.releaseReact(kind)
          return { ok: released, held: false, state: machine.snapshot().state }
        }
        if (phase === 'hold') {
          if (file) machine.holdReact(file, kind)
          return { ok: Boolean(file), held: Boolean(file), state: machine.snapshot().state }
        }
        const duration = entry?.duration ?? DEFAULT_TIMINGS.reactionMs
        if (file) machine.react(file, duration, kind)
        return { ok: Boolean(file), held: false, state: machine.snapshot().state }
      })
      if (rest === 'refresh') return handleWrite(req, res, () => {
        const theme = refreshThemes('requested by the settings panel')
        return { ok: true, theme: theme?.id ?? null }
      })
    }
    sendJson(res, 404, { error: `no dsh-clawd route for ${req.method} ${url.pathname}` })
  }

  function sendArt(res, key, headOnly) {
    const slash = key.indexOf('/')
    if (slash < 0) return sendJson(res, 404, { error: 'art key must be <theme>/<file>' })
    let themeId
    let file
    try {
      themeId = decodeURIComponent(key.slice(0, slash))
      file = decodeURIComponent(key.slice(slash + 1))
    } catch {
      return sendJson(res, 404, { error: 'art key is not valid percent-encoding' })
    }
    // The request never contributes a path: it looks a *name* up in the table
    // built from the theme manifests at load time.
    const entry = themeRegistry.themes.get(themeId)?.files.get(file)
    if (!entry) return sendJson(res, 404, { error: `theme "${themeId}" declares no artwork "${file}"` })
    let bytes
    try {
      bytes = fs.readFileSync(entry.abs)
    } catch (error) {
      return sendJson(res, 500, { error: `artwork unreadable: ${error.message}` })
    }
    res.writeHead(200, {
      'Content-Type': entry.contentType,
      'Content-Length': String(bytes.length),
      // Immutable: the URL carries the theme revision, which changes with the file.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(headOnly ? undefined : bytes)
  }

  function openStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write(`retry: 2000\n\n`)
    res.write(`data: ${JSON.stringify(payload())}\n\n`)
    streams.add(res)
    const drop = () => streams.delete(res)
    req.on('close', drop)
    res.on('close', drop)
  }

  function handleWrite(req, res, action) {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => sendJson(res, 400, { error: 'request stream failed' }))
    req.on('end', () => {
      let body = {}
      if (size > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
          return sendJson(res, 400, { error: `body is not JSON: ${error.message}` })
        }
      }
      try {
        const result = action(body) ?? {}
        const next = payload()
        broadcast(next)
        return sendJson(res, 200, { ...result, payload: next })
      } catch (error) {
        return sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    })
  }

  // ----------------------------------------------------------------- events ---

  ctx.on('session/event', (session, event) => machine.sessionEvent(session, event))
  ctx.on('session/created', (session) => machine.sessionCreated(session))
  ctx.on('session/disposed', (session) => machine.sessionDisposed(session))
  ctx.on('agent/error', (payload) => {
    machine.trigger('error')
    log('debug', `agent error observed: ${String(payload?.error?.message ?? payload?.error ?? 'unknown')}`)
  })

  ctx.effect(() => {
    const disposer = ctx.webServer.register({ kind: 'prefix', path: ROUTE_MOUNT, handler: route })
    return () => {
      disposer?.()
      for (const stream of streams) {
        try {
          stream.end()
        } catch {
          /* already gone */
        }
      }
      streams.clear()
    }
  })

  ctx.effect(() => {
    const heartbeat = setInterval(() => {
      for (const stream of streams) {
        try {
          stream.write(`: ping ${Date.now()}\n\n`)
        } catch {
          streams.delete(stream)
        }
      }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
    return () => clearInterval(heartbeat)
  })

  ctx.effect(() => () => {
    if (pendingPublish !== null) clearTimeout(pendingPublish)
    machine.dispose()
  })

  const theme = activeTheme()
  log('info', `clawd awake — theme ${theme ? `"${theme.id}" (${theme.source}, rev ${theme.rev})` : 'MISSING'}, ${themeRegistry.themes.size} theme(s), state feed at ${ROUTE_PREFIX}state.json`)
  if (!theme) log('warn', `no theme found; looked in ${themeRoots().map((root) => root.dir).join(', ')}`)
  publish(true)
}

// ------------------------------------------------------------------ helpers ---

function defaultsOf() {
  const defaults = {}
  for (const [key, shape] of Object.entries(SETTINGS_SHAPE)) defaults[key] = shape.fallback
  return defaults
}

/** Keep only known keys, coerce to the declared kind, and clamp numbers. */
export function sanitizeSettings(input) {
  const out = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [key, shape] of Object.entries(SETTINGS_SHAPE)) {
    if (!(key in input)) continue
    const value = input[key]
    if (value === null && shape.nullable) {
      out[key] = null
      continue
    }
    if (shape.kind === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
      continue
    }
    if (shape.kind === 'string') {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim()
      continue
    }
    if (shape.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      let next = Math.min(shape.max ?? value, Math.max(shape.min ?? value, value))
      if (shape.integer) next = Math.round(next)
      out[key] = next
      continue
    }
    if (shape.kind === 'position') {
      if (value && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y)) {
        out[key] = { x: Math.round(value.x), y: Math.round(value.y) }
      } else if (value === null) {
        out[key] = null
      }
    }
  }
  return out
}

function sendJson(res, status, body, headOnly = false) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(headOnly ? undefined : text)
}

function isLoopback(hostname) {
  const name = String(hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!name) return false
  if (name === 'localhost' || name.endsWith('.localhost') || name === '::1') return true
  const parts = name.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => part !== '' && Number(part) <= 255)
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
